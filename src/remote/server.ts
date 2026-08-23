import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { extname, join, normalize, resolve, sep, dirname } from 'node:path';
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type VoiceBasedChannel,
} from 'discord.js';

import { listDshowDevices } from '../audio/encoder.ts';
import { nowPlaying, nowPlayingSummary } from '../audio/monitor.ts';
import { pipewireDiscoveryError } from '../audio/pipewire.ts';
import { isAudioTapBuilt, listDevices, listProcesses } from '../audio/tap.ts';
import { config, projectRoot, runtimeRoot } from '../config.ts';
import { logger } from '../logger.ts';
import { IS_WINDOWS, restrictPrivateFile } from '../platform.ts';
import {
  bearerToken,
  hardenServer,
  hasExpectedHost,
  hasTrustedOrigin,
  methodAllowed,
  RateLimiter,
  securityHeaders,
} from '../httpSecurity.ts';
import { isAuthenticatedTailscalePeer, isTailscaleAddress } from '../tailscale.ts';
import { finiteNumber, OPUS_MAX_BITRATE, OPUS_MIN_BITRATE, validateSources } from '../validation.ts';
import {
  allSessions,
  endSession,
  getSession,
  startOrRetarget,
  type SourceSpec,
} from '../voice/session.ts';

const log = logger('remote');
const webRoot = resolve(projectRoot, 'remote');
// Runtime root rather than project root: packaged installs cannot write into /usr/share.
const tokenPath = join(runtimeRoot, '.remote-token');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // Installing the dashboard to a phone's home screen is the difference between a tab you have to
  // find again and an app you open. That needs a manifest served with the right type.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
    if (!/^[A-Za-z0-9._~-]{24,256}$/.test(configured)) {
      throw new Error('REMOTE_TOKEN must be 24-256 token-safe characters.');
    }
    return configured;
  }

  if (existsSync(tokenPath)) {
    const saved = readFileSync(tokenPath, 'utf8').trim();
    if (/^[A-Za-z0-9._~-]{24,256}$/.test(saved)) {
      chmodSync(tokenPath, 0o600);
      restrictPrivateFile(tokenPath);
      return saved;
    }
  }

  const token = randomBytes(32).toString('base64url');
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  restrictPrivateFile(tokenPath);
  return token;
}

export interface RemoteAccessInfo {
  enabled: boolean;
  trustTailscale: boolean;
  tokenPath: string;
  urls: string[];
}

let activeRemoteServer: RemoteServer | undefined;

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
    channel.type === ChannelType.GuildStageVoice && !permissions.has(PermissionFlagsBits.MuteMembers)
      ? 'Mute Members (needed to become a Stage speaker)'
      : null,
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

async function remoteOptions(client: Client): Promise<unknown> {
  let sourceError: string | null = null;
  const [processes, devices, dshow] = await Promise.all([
    isAudioTapBuilt()
      ? listProcesses().catch((error) => {
          log.warn('remote process source enumeration failed', error);
          if (!IS_WINDOWS) sourceError = pipewireDiscoveryError(error);
          return [];
        })
      : Promise.resolve([]),
    isAudioTapBuilt()
      ? listDevices().catch((error) => {
          log.warn('remote device source enumeration failed', error);
          if (!IS_WINDOWS) sourceError = pipewireDiscoveryError(error);
          return [];
        })
      : Promise.resolve([]),
    listDshowDevices().catch((error) => {
      log.debug('remote DirectShow source enumeration failed', error);
      return [];
    }),
  ]);
  return {
    platform: process.platform,
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
            const missing = [
              permissions?.has(PermissionFlagsBits.Connect) ? null : 'Connect',
              permissions?.has(PermissionFlagsBits.Speak) ? null : 'Speak',
              channel.type === ChannelType.GuildStageVoice && !permissions?.has(PermissionFlagsBits.MuteMembers)
                ? 'Mute Members for Stage audio'
                : null,
            ].filter(Boolean);
            return {
              id: voice.id,
              name: voice.name,
              bitrate: voice.bitrate,
              members: voice.members.size,
              joinable: missing.length === 0,
              unavailableReason: missing.length > 0 ? `Missing ${missing.join(', ')}` : null,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }),
    sources: { processes, devices, dshow, audioTapBuilt: isAudioTapBuilt(), sourceError },
  };
}

function urlsFor(host: string, port: number, token: string, trustTailscale: boolean): string[] {
  const hosts = new Set<string>();
  if (host === '0.0.0.0' || host === '::') {
    hosts.add(host === '::' ? '::1' : '127.0.0.1');
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (!entry.internal && (host === '::' || entry.family === 'IPv4')) hosts.add(entry.address);
      }
    }
  } else {
    hosts.add(host);
  }
  return [...hosts].map((address) => {
    const displayHost = isIP(address) === 6 ? `[${address}]` : address;
    const base = `http://${displayHost}:${port}/`;
    return trustTailscale && isTailscaleAddress(address) ? base : `${base}#token=${token}`;
  });
}

/** Protected local-control metadata used to copy a remote URL to another device. */
export function remoteAccessInfo(): RemoteAccessInfo {
  if (!activeRemoteServer) {
    return { enabled: false, trustTailscale: config.remote.trustTailscale, tokenPath, urls: [] };
  }
  return {
    enabled: true,
    trustTailscale: activeRemoteServer.trustTailscale,
    tokenPath,
    urls: activeRemoteServer.accessUrls(),
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
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new RemoteApiError(415, 'Request body must use application/json.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RemoteApiError(400, 'Body was not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RemoteApiError(400, 'JSON body must be an object.');
  }
  return parsed as T;
}

export class RemoteServer {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly trustTailscale: boolean;

  #client: Client;
  #http = createServer();
  #requests = new RateLimiter();

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
    hardenServer(this.#http);
  }

  accessUrls(): string[] {
    return urlsFor(this.host, this.port, this.token, this.trustTailscale);
  }

  async start(): Promise<void> {
    this.#http.on('request', (req, res) => {
      void this.#route(req, res).catch((error) => {
        log.error('unhandled remote request failure', error);
        if (!res.headersSent) json(res, 500, { error: 'Internal remote server error.' });
        else res.destroy();
      });
    });
    await new Promise<void>((done, fail) => {
      this.#http.once('error', fail);
      this.#http.listen(this.port, this.host, () => {
        this.#http.removeListener('error', fail);
        done();
      });
    });
    activeRemoteServer = this;
    log.info(`remote control listening on ${this.host}:${this.port}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => this.#http.close(() => done()));
    if (activeRemoteServer === this) activeRemoteServer = undefined;
    log.info('remote control stopped');
  }

  async #authorized(req: IncomingMessage): Promise<boolean> {
    if (
      this.trustTailscale &&
      (await isAuthenticatedTailscalePeer(req.socket.localAddress, req.socket.remoteAddress))
    ) return true;
    const supplied = bearerToken(req);
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
      const configuredHost = this.host === '0.0.0.0' || this.host === '::' ? [] : [this.host];
      if (!hasExpectedHost(req, [...configuredHost, hostname()]) || !hasTrustedOrigin(req)) {
        return json(res, 403, { error: 'Cross-origin request rejected.' });
      }
      const peer = req.socket.remoteAddress ?? 'unknown';
      const limit = req.method === 'GET' ? 240 : 60;
      if (!this.#requests.allow(`${peer}:${req.method}`, limit)) {
        return json(res, 429, { error: 'Too many remote requests. Wait a moment and try again.' });
      }
      if (!(await this.#authorized(req))) return json(res, 401, { error: 'Bad or missing remote token.' });
      try {
        return json(res, 200, await this.#api(req, url));
      } catch (error) {
        const status = error instanceof RemoteApiError ? error.status : 500;
        if (status >= 500) log.error(`${req.method} remote ${url.pathname} failed`, error);
        return json(res, status, {
          error:
            status >= 500
              ? 'Internal remote server error.'
              : error instanceof Error
                ? error.message
                : String(error),
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
        nowPlaying: nowPlayingSummary(),
      };
    }

    if (route === 'GET /api/now-playing') return { nowPlaying: nowPlaying() };

    if (route === 'GET /api/options') return remoteOptions(this.#client);

    const input = await body<{
      guildId?: string;
      channelId?: string;
      source?: unknown;
      sources?: unknown;
      index?: number;
      muted?: boolean;
      db?: number;
      bitrate?: number;
    }>(req);
    if (!input.guildId) throw new RemoteApiError(400, 'guildId is required.');

    if (route === 'POST /api/stream') {
      if (!input.channelId) throw new RemoteApiError(400, 'channelId is required.');
      let sources: SourceSpec[];
      try {
        sources = validateSources(input);
      } catch (error) {
        throw new RemoteApiError(400, error instanceof Error ? error.message : String(error));
      }
      if (sources.some((source) => source.kind === 'dshow') && !IS_WINDOWS) {
        throw new RemoteApiError(400, 'DirectShow sources are Windows-only.');
      }
      if (sources.some((source) => source.kind !== 'dshow') && !isAudioTapBuilt()) {
        throw new RemoteApiError(
          409,
          IS_WINDOWS
            ? 'AudioTap is not built, so only cable sources are available.'
            : 'The PipeWire capture tools are missing on the host, so nothing is capturable.',
        );
      }
      if (input.bitrate !== undefined) {
        try {
          finiteNumber(input.bitrate, 'Bitrate', OPUS_MIN_BITRATE, OPUS_MAX_BITRATE);
        } catch (error) {
          throw new RemoteApiError(400, error instanceof Error ? error.message : String(error));
        }
      }
      const channel = requireChannel(this.#client, input.guildId, input.channelId);
      const session = await startOrRetarget(channel, sources, resolveBitrate(channel, input.bitrate));
      log.info('remote stream route changed', {
        guild: input.guildId,
        channel: input.channelId,
        sourceKinds: sources.map((source) => source.kind),
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
      let db: number;
      try {
        db = finiteNumber(input.db, 'Gain', -60, 20);
      } catch (error) {
        throw new RemoteApiError(400, error instanceof Error ? error.message : String(error));
      }
      await session.setGain(db);
    } else if (route === 'POST /api/bitrate') {
      let bitrate: number;
      try {
        bitrate = finiteNumber(input.bitrate, 'Bitrate', OPUS_MIN_BITRATE, OPUS_MAX_BITRATE);
      } catch (error) {
        throw new RemoteApiError(400, error instanceof Error ? error.message : String(error));
      }
      await session.setBitrate(bitrate);
    } else if (route === 'POST /api/input-gain') {
      // Per-input trim inside a mix, so a phone can balance game against music from the sofa.
      const index = input.index;
      if (!Number.isInteger(index) || index === undefined || index < 0 || index >= session.sources.length) {
        throw new RemoteApiError(400, 'That mix input does not exist.');
      }
      try {
        await session.setInputGain(index, finiteNumber(input.db, 'Gain', -60, 20));
      } catch (error) {
        throw new RemoteApiError(400, error instanceof Error ? error.message : String(error));
      }
    } else {
      throw new RemoteApiError(404, `No remote route for ${route}.`);
    }

    return { session: session.status() };
  }

  #serveStatic(pathname: string, res: ServerResponse): void {
    const req = res.req;
    if (!methodAllowed(req, res, ['GET', 'HEAD'])) return;
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = resolve(webRoot, normalize(relative));
    if (target !== webRoot && !target.startsWith(webRoot + sep)) {
      res.writeHead(403, securityHeaders('text/plain; charset=utf-8')).end('Forbidden');
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404, securityHeaders('text/plain; charset=utf-8')).end('Not found');
      return;
    }
    res.writeHead(200, securityHeaders(MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(target);
    stream.once('error', (error) => {
      log.warn('remote control asset read failed', error);
      res.destroy(error);
    });
    stream.pipe(res);
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    ...securityHeaders('application/json; charset=utf-8'),
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
