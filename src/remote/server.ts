import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type VoiceBasedChannel,
} from 'discord.js';

import { listDshowDevices } from '../audio/encoder.ts';
import { isAudioTapBuilt, listDevices, listProcesses } from '../audio/tap.ts';
import { config, projectRoot } from '../config.ts';
import { logger } from '../logger.ts';
import {
  allSessions,
  endSession,
  getSession,
  startOrRetarget,
  type SourceSpec,
} from '../voice/session.ts';

const log = logger('remote');
const webRoot = resolve(projectRoot, 'remote');
const tokenPath = join(projectRoot, '.remote-token');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

class RemoteApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function loadToken(configured?: string): string {
  if (configured) {
    if (configured.length < 24) throw new Error('REMOTE_TOKEN must contain at least 24 characters.');
    return configured;
  }

  if (existsSync(tokenPath)) {
    const saved = readFileSync(tokenPath, 'utf8').trim();
    if (saved.length >= 24) return saved;
  }

  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export interface RemoteAccessInfo {
  enabled: boolean;
  trustTailscale: boolean;
  tokenPath: string;
  urls: string[];
}

function normalizedAddress(address?: string | null): string {
  return (address ?? '').replace(/^::ffff:/i, '').toLowerCase();
}

/** Tailscale IPv4 CGNAT range and the fixed Tailscale IPv6 ULA prefix. */
function isTailscaleAddress(address?: string | null): boolean {
  const normalized = normalizedAddress(address);
  if (normalized.startsWith('fd7a:115c:a1e0:')) return true;
  const octets = normalized.split('.').map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

function requireChannel(client: Client, guildId: string, channelId: string): VoiceBasedChannel {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new RemoteApiError(404, 'That server is not one the bot is in.');
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) throw new RemoteApiError(404, 'That is not a voice channel.');
  const me = guild.members.me;
  if (!me) throw new RemoteApiError(503, 'The bot is still loading that server. Try again shortly.');
  const permissions = me.permissionsIn(channel);
  const missing = [
    permissions.has(PermissionFlagsBits.Connect) ? null : 'Connect',
    permissions.has(PermissionFlagsBits.Speak) ? null : 'Speak',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new RemoteApiError(403, `The bot is missing ${missing.join(' and ')} on #${channel.name}.`);
  }
  return channel;
}

function resolveBitrate(channel: VoiceBasedChannel, requested?: number): number {
  const ceiling = Math.min(channel.bitrate, channel.guild.maximumBitrate, 510_000);
  const preferred = requested || config.opus.bitrate || ceiling;
  return Math.min(ceiling, Math.max(8_000, Math.round(preferred)));
}

function validateSource(value: unknown): SourceSpec {
  if (!value || typeof value !== 'object') throw new RemoteApiError(400, 'A source is required.');
  const source = value as Partial<SourceSpec> & Record<string, unknown>;
  if (source.kind === 'process') {
    if (!Number.isInteger(source.pid) || Number(source.pid) <= 0) {
      throw new RemoteApiError(400, 'The process source has an invalid pid.');
    }
    return {
      kind: 'process',
      pid: Number(source.pid),
      label: typeof source.label === 'string' ? source.label : `Process ${source.pid}`,
      exclude: source.exclude === true,
    };
  }
  if (source.kind === 'device' && typeof source.id === 'string' && source.id) {
    return { kind: 'device', id: source.id, label: typeof source.label === 'string' ? source.label : source.id };
  }
  if (source.kind === 'dshow' && typeof source.name === 'string' && source.name) {
    return { kind: 'dshow', name: source.name, label: typeof source.label === 'string' ? source.label : source.name };
  }
  throw new RemoteApiError(400, 'That capture source is invalid.');
}

async function remoteOptions(client: Client): Promise<unknown> {
  const [processes, devices, dshow] = await Promise.all([
    isAudioTapBuilt()
      ? listProcesses().catch((error) => {
          log.debug('remote process source enumeration failed', error);
          return [];
        })
      : Promise.resolve([]),
    isAudioTapBuilt()
      ? listDevices().catch((error) => {
          log.debug('remote device source enumeration failed', error);
          return [];
        })
      : Promise.resolve([]),
    listDshowDevices().catch((error) => {
      log.debug('remote DirectShow source enumeration failed', error);
      return [];
    }),
  ]);
  return {
    guilds: client.guilds.cache.map((guild) => {
      const me = guild.members.me;
      return {
        id: guild.id,
        name: guild.name,
        channels: guild.channels.cache
          .filter((channel) => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
          .map((channel) => {
            const voice = channel as VoiceBasedChannel;
            const permissions = me?.permissionsIn(voice);
            return {
              id: voice.id,
              name: voice.name,
              bitrate: voice.bitrate,
              members: voice.members.size,
              joinable: Boolean(
                permissions?.has(PermissionFlagsBits.Connect) && permissions.has(PermissionFlagsBits.Speak),
              ),
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }),
    sources: { processes, devices, dshow, audioTapBuilt: isAudioTapBuilt() },
  };
}

function urlsFor(host: string, port: number, token: string, trustTailscale: boolean): string[] {
  const hosts = new Set<string>();
  if (host === '0.0.0.0') {
    hosts.add('127.0.0.1');
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (!entry.internal && entry.family === 'IPv4') hosts.add(entry.address);
      }
    }
  } else {
    hosts.add(host);
  }
  return [...hosts].map((address) => {
    const base = `http://${address}:${port}/`;
    return trustTailscale && isTailscaleAddress(address) ? base : `${base}?token=${token}`;
  });
}

/** Protected local-control metadata used to copy a remote URL to another device. */
export function remoteAccessInfo(): RemoteAccessInfo {
  if (config.remote.port <= 0) {
    return { enabled: false, trustTailscale: config.remote.trustTailscale, tokenPath, urls: [] };
  }
  return {
    enabled: true,
    trustTailscale: config.remote.trustTailscale,
    tokenPath,
    urls: urlsFor(
      config.remote.host,
      config.remote.port,
      loadToken(config.remote.token),
      config.remote.trustTailscale,
    ),
  };
}

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new RemoteApiError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new RemoteApiError(400, 'Body was not valid JSON.');
  }
}

export class RemoteServer {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly trustTailscale: boolean;

  #client: Client;
  #http = createServer();

  constructor(
    client: Client,
    host: string,
    port: number,
    configuredToken: string | undefined,
    trustTailscale: boolean,
  ) {
    this.#client = client;
    this.host = host;
    this.port = port;
    this.token = loadToken(configuredToken);
    this.trustTailscale = trustTailscale;
  }

  accessUrls(): string[] {
    return urlsFor(this.host, this.port, this.token, this.trustTailscale);
  }

  async start(): Promise<void> {
    this.#http.on('request', (req, res) => void this.#route(req, res));
    await new Promise<void>((done, fail) => {
      this.#http.once('error', fail);
      this.#http.listen(this.port, this.host, () => {
        this.#http.removeListener('error', fail);
        done();
      });
    });
    log.info(`remote control listening on ${this.host}:${this.port}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => this.#http.close(() => done()));
    log.info('remote control stopped');
  }

  #authorized(req: IncomingMessage): boolean {
    if (
      this.trustTailscale &&
      isTailscaleAddress(req.socket.localAddress) &&
      isTailscaleAddress(req.socket.remoteAddress)
    ) {
      return true;
    }
    const url = new URL(req.url ?? '/', 'http://remote.local');
    const supplied =
      url.searchParams.get('token') ?? req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const actual = Buffer.from(this.token);
    const candidate = Buffer.from(supplied);
    return candidate.length === actual.length && timingSafeEqual(candidate, actual);
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://remote.local');
    res.once('finish', () =>
      log.debug(`${req.method ?? 'GET'} remote ${url.pathname}`, {
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
      }),
    );

    if (url.pathname.startsWith('/api/')) {
      if (!this.#authorized(req)) return json(res, 401, { error: 'Bad or missing remote token.' });
      try {
        return json(res, 200, await this.#api(req, url));
      } catch (error) {
        const status = error instanceof RemoteApiError ? error.status : 500;
        if (status >= 500) log.error(`${req.method} remote ${url.pathname} failed`, error);
        return json(res, status, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.#serveStatic(url.pathname, res);
  }

  async #api(req: IncomingMessage, url: URL): Promise<unknown> {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/state') {
      return {
        bot: {
          ready: this.#client.isReady(),
          tag: this.#client.user?.tag ?? null,
          ping: this.#client.isReady() ? Math.round(this.#client.ws.ping) : null,
        },
        sessions: allSessions().map((session) => session.status()),
      };
    }

    if (route === 'GET /api/options') return remoteOptions(this.#client);

    const input = await body<{
      guildId?: string;
      channelId?: string;
      source?: unknown;
      muted?: boolean;
      db?: number;
      bitrate?: number;
    }>(req);
    if (!input.guildId) throw new RemoteApiError(400, 'guildId is required.');

    if (route === 'POST /api/stream') {
      if (!input.channelId) throw new RemoteApiError(400, 'channelId is required.');
      const source = validateSource(input.source);
      if (source.kind !== 'dshow' && !isAudioTapBuilt()) {
        throw new RemoteApiError(409, 'AudioTap is not built, so only cable sources are available.');
      }
      const channel = requireChannel(this.#client, input.guildId, input.channelId);
      const session = await startOrRetarget(channel, source, resolveBitrate(channel, input.bitrate));
      log.info('remote stream route changed', {
        guild: input.guildId,
        channel: input.channelId,
        sourceKind: source.kind,
      });
      return { session: session.status() };
    }

    if (route === 'POST /api/stop') {
      return { stopped: await endSession(input.guildId) };
    }

    const session = getSession(input.guildId);
    if (!session) throw new RemoteApiError(404, 'That stream is no longer running.');

    if (route === 'POST /api/mute') {
      if (typeof input.muted !== 'boolean') throw new RemoteApiError(400, 'muted must be true or false.');
      await session.setMuted(input.muted);
    } else if (route === 'POST /api/gain') {
      if (typeof input.db !== 'number' || input.db < -60 || input.db > 20) {
        throw new RemoteApiError(400, 'Gain must be between -60 and +20 dB.');
      }
      await session.setGain(input.db);
    } else if (route === 'POST /api/bitrate') {
      if (typeof input.bitrate !== 'number' || input.bitrate < 8_000 || input.bitrate > 510_000) {
        throw new RemoteApiError(400, 'Bitrate must be between 8000 and 510000.');
      }
      await session.setBitrate(input.bitrate);
    } else {
      throw new RemoteApiError(404, `No remote route for ${route}.`);
    }

    return { session: session.status() };
  }

  #serveStatic(pathname: string, res: ServerResponse): void {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = resolve(webRoot, normalize(relative));
    if (target !== webRoot && !target.startsWith(webRoot + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (!existsSync(target)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
        "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    createReadStream(target).pipe(res);
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}
