import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { ChannelType, PermissionFlagsBits, type Client, type VoiceBasedChannel } from 'discord.js';

import { config, projectRoot } from '../config.ts';
import { logger } from '../logger.ts';
import { collectDiagnostics } from '../commands.ts';
import { listDshowDevices } from '../audio/encoder.ts';
import { captureBackend, isAudioTapBuilt, listDevices, listProcesses } from '../audio/tap.ts';
import { IS_WINDOWS } from '../platform.ts';
import {
  allSessions,
  endSession,
  getSession,
  startOrRetarget,
  type SessionStatus,
  type SourceSpec,
} from '../voice/session.ts';
import { readConfig, writeConfig, RESTART_REQUIRED_KEYS, type EditableKey } from './envFile.ts';
import { authStatus, signIn } from '../signin.ts';
import { remoteAccessInfo } from '../remote/server.ts';
import { registerCommands } from '../registration.ts';

const log = logger('api');

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

const OPUS_MIN_BITRATE = 8_000;
const OPUS_MAX_BITRATE = 510_000;

export interface GuildView {
  id: string;
  name: string;
  iconUrl: string | null;
  premiumTier: number;
  maximumBitrate: number;
  channels: {
    id: string;
    name: string;
    bitrate: number;
    userLimit: number;
    members: number;
    joinable: boolean;
  }[];
}

export interface Snapshot {
  bot: {
    ready: boolean;
    tag: string | null;
    avatarUrl: string | null;
    wsPing: number | null;
    guildCount: number;
    /** False before the first successful sign-in; the panel prompts for setup. */
    hasToken: boolean;
    signingIn: boolean;
    signInError: string | null;
  };
  sessions: SessionStatus[];
  capabilities: {
    platform: NodeJS.Platform;
    /** 'wasapi' on Windows, 'pipewire' on Linux, null when no per-app backend is usable. */
    captureBackend: string | null;
    audioTapBuilt: boolean;
    audioTapPath: string;
    ffmpegPath: string;
    logFile: string | null;
  };
  defaults: {
    vbr: string;
    complexity: number;
    bufferMs: number;
    bitrateOverride: number | undefined;
  };
}

export async function buildSnapshot(client: Client): Promise<Snapshot> {
  const auth = authStatus();
  const backend = captureBackend();

  return {
    bot: {
      ready: client.isReady(),
      tag: client.user?.tag ?? null,
      avatarUrl: client.user?.displayAvatarURL({ size: 64 }) ?? null,
      wsPing: client.isReady() ? Math.round(client.ws.ping) : null,
      guildCount: client.guilds.cache.size,
      hasToken: auth.hasToken,
      signingIn: auth.attempting,
      signInError: auth.error,
    },
    sessions: allSessions().map((session) => session.status()),
    capabilities: {
      platform: process.platform,
      captureBackend: backend,
      audioTapBuilt: backend !== null,
      audioTapPath: config.paths.audioTap,
      ffmpegPath: config.paths.ffmpeg,
      logFile: config.paths.logFile ?? null,
    },
    defaults: {
      vbr: config.opus.vbr,
      complexity: config.opus.complexity,
      bufferMs: config.capture.bufferMs,
      bitrateOverride: config.opus.bitrate,
    },
  };
}

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new ApiError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return {} as T;

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new ApiError(400, 'Body was not valid JSON.');
  }
}

function requireChannel(client: Client, guildId: string, channelId: string): VoiceBasedChannel {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new ApiError(404, 'That server is not one the bot is in.');

  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) throw new ApiError(404, 'That is not a voice channel.');

  const me = guild.members.me;
  if (!me) throw new ApiError(500, 'The bot is not fully loaded in that server yet.');

  const permissions = me.permissionsIn(channel);
  const missing = [
    permissions.has(PermissionFlagsBits.Connect) ? null : 'Connect',
    permissions.has(PermissionFlagsBits.Speak) ? null : 'Speak',
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new ApiError(403, `The bot is missing ${missing.join(' and ')} on #${channel.name}.`);
  }

  return channel;
}

function resolveBitrate(channel: VoiceBasedChannel, requested?: number): number {
  const ceiling = Math.min(channel.bitrate, channel.guild.maximumBitrate);
  if (requested) {
    return Math.min(ceiling, OPUS_MAX_BITRATE, Math.max(OPUS_MIN_BITRATE, Math.round(requested)));
  }
  if (config.opus.bitrate) {
    return Math.min(ceiling, OPUS_MAX_BITRATE, Math.max(OPUS_MIN_BITRATE, config.opus.bitrate));
  }
  return ceiling;
}

function guilds(client: Client): GuildView[] {
  return client.guilds.cache.map((guild) => {
    const me = guild.members.me;

    return {
      id: guild.id,
      name: guild.name,
      iconUrl: guild.iconURL({ size: 64 }),
      premiumTier: guild.premiumTier,
      maximumBitrate: guild.maximumBitrate,
      channels: guild.channels.cache
        .filter((channel) => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
        .map((channel) => {
          const voice = channel as VoiceBasedChannel;
          const permissions = me?.permissionsIn(voice);
          return {
            id: voice.id,
            name: voice.name,
            bitrate: voice.bitrate,
            userLimit: 'userLimit' in voice ? voice.userLimit : 0,
            members: voice.members.size,
            joinable: Boolean(
              permissions?.has(PermissionFlagsBits.Connect) && permissions.has(PermissionFlagsBits.Speak),
            ),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/** Runs a project npm script and streams its output into the log, for the Setup panel buttons. */
function runScript(script: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    const started = performance.now();
    if (script === 'build:native' && !IS_WINDOWS) {
      done({ ok: false, output: 'Building AudioTap is Windows-only. On Linux, install pipewire-bin (Debian/Ubuntu) or pipewire-utils (Fedora) instead.' });
      return;
    }
    log.info(`starting npm script: ${script}`);
    const child = spawn('npm', ['run', script], {
      cwd: projectRoot,
      shell: true,
      windowsHide: true,
    });

    let output = '';
    const capture = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) log.info(`[${script}] ${line.trim()}`);
      }
    };

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => {
      log.error(`could not start npm script: ${script}`, error);
      done({ ok: false, output: `${output}\n${error.message}` });
    });
    child.on('close', (code) => {
      log.info(`npm script finished: ${script}`, {
        code,
        durationMs: Math.round(performance.now() - started),
      });
      done({ ok: code === 0, output: output.slice(-8000) });
    });
  });
}

export async function handleApi(client: Client, req: IncomingMessage, url: URL): Promise<unknown> {
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/state':
      return buildSnapshot(client);

    case 'GET /api/guilds':
      return { guilds: guilds(client) };

    case 'GET /api/sources': {
      const [processes, devices, dshow] = await Promise.all([
        isAudioTapBuilt()
          ? listProcesses().catch((error) => {
              log.debug('process source enumeration failed', error);
              return [];
            })
          : Promise.resolve([]),
        isAudioTapBuilt()
          ? listDevices().catch((error) => {
              log.debug('device source enumeration failed', error);
              return [];
            })
          : Promise.resolve([]),
        listDshowDevices().catch((error) => {
          log.debug('DirectShow source enumeration failed', error);
          return [];
        }),
      ]);
      return { processes, devices, dshow, audioTapBuilt: isAudioTapBuilt() };
    }

    case 'POST /api/stream': {
      const input = await body<{
        guildId: string;
        channelId: string;
        source: SourceSpec;
        bitrate?: number;
      }>(req);

      if (!input.guildId || !input.channelId) throw new ApiError(400, 'guildId and channelId are required.');
      if (!input.source?.kind) throw new ApiError(400, 'A source is required.');
      if (input.source.kind === 'dshow' && !IS_WINDOWS) {
        throw new ApiError(400, 'DirectShow sources are Windows-only. Capture an app or a device instead.');
      }
      if (input.source.kind !== 'dshow' && !isAudioTapBuilt()) {
        throw new ApiError(
          409,
          IS_WINDOWS
            ? 'AudioTap is not built, so only DirectShow sources work. Build it from the Setup tab.'
            : 'The PipeWire capture tools are missing, so nothing is capturable. Install pipewire-bin on Debian/Ubuntu or pipewire-utils on Fedora.',
        );
      }

      const channel = requireChannel(client, input.guildId, input.channelId);
      const bitrate = resolveBitrate(channel, input.bitrate);
      const session = await startOrRetarget(channel, input.source, bitrate);
      log.info('stream request completed', {
        guild: input.guildId,
        channel: input.channelId,
        sourceKind: input.source.kind,
        bitrate,
      });
      return { session: session.status() };
    }

    case 'POST /api/stop': {
      const { guildId } = await body<{ guildId: string }>(req);
      if (!guildId) throw new ApiError(400, 'guildId is required.');
      const stopped = await endSession(guildId);
      log.info('stop request completed', { guild: guildId, stopped });
      return { stopped };
    }

    case 'POST /api/gain': {
      const { guildId, db } = await body<{ guildId: string; db: number }>(req);
      const session = getSession(guildId);
      if (!session) throw new ApiError(404, 'Nothing is streaming in that server.');
      if (typeof db !== 'number' || db < -60 || db > 20) {
        throw new ApiError(400, 'Gain must be between -60 and +20 dB.');
      }
      await session.setGain(db);
      log.info('gain changed', { guild: guildId, db });
      return { session: session.status() };
    }

    case 'POST /api/mute': {
      const { guildId, muted } = await body<{ guildId: string; muted: boolean }>(req);
      const session = getSession(guildId);
      if (!session) throw new ApiError(404, 'Nothing is streaming in that server.');
      if (typeof muted !== 'boolean') throw new ApiError(400, 'muted must be true or false.');
      await session.setMuted(muted);
      log.info('voice mute changed', { guild: guildId, muted });
      return { session: session.status() };
    }

    case 'POST /api/bitrate': {
      const { guildId, bitrate } = await body<{ guildId: string; bitrate: number }>(req);
      const session = getSession(guildId);
      if (!session) throw new ApiError(404, 'Nothing is streaming in that server.');
      if (typeof bitrate !== 'number' || bitrate < OPUS_MIN_BITRATE || bitrate > OPUS_MAX_BITRATE) {
        throw new ApiError(400, `Bitrate must be between ${OPUS_MIN_BITRATE} and ${OPUS_MAX_BITRATE}.`);
      }
      await session.setBitrate(Math.round(bitrate));
      log.info('stream bitrate changed', { guild: guildId, bitrate: Math.round(bitrate) });
      return { session: session.status() };
    }

    case 'POST /api/channel-bitrate': {
      const { guildId, channelId, bitrate } = await body<{
        guildId: string;
        channelId: string;
        bitrate: number;
      }>(req);

      const channel = requireChannel(client, guildId, channelId);
      const max = channel.guild.maximumBitrate;
      const target = Math.min(bitrate || max, max);

      if (!channel.guild.members.me?.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels)) {
        throw new ApiError(403, `The bot needs Manage Channels on #${channel.name} to change its bitrate.`);
      }

      await channel.edit({ bitrate: target, reason: 'Changed from the bridge control panel' });
      log.info('voice channel bitrate changed', { guild: guildId, channel: channelId, bitrate: target });
      return { bitrate: target, maximum: max };
    }

    case 'POST /api/signin': {
      // Reachable before the bot has ever signed in - that is the whole point of it.
      await signIn(client);
      return { ready: client.isReady(), tag: client.user?.tag ?? null };
    }

    case 'GET /api/diagnostics':
      return { report: await collectDiagnostics() };

    case 'GET /api/config':
      return { ...readConfig(), restartRequired: RESTART_REQUIRED_KEYS };

    case 'GET /api/remote':
      return remoteAccessInfo();

    case 'POST /api/config': {
      const updates = await body<Partial<Record<EditableKey, string>>>(req);
      writeConfig(updates);
      log.info(`configuration updated: ${Object.keys(updates).join(', ')}`);
      return {
        ...readConfig(),
        restartRequired: Object.keys(updates).filter((key) => RESTART_REQUIRED_KEYS.includes(key)),
      };
    }

    case 'POST /api/setup/build-native':
      return runScript('build:native');

    case 'POST /api/setup/register-commands':
      try {
        const result = await registerCommands();
        return {
          ok: true,
          output: `Registered ${result.count} commands ${result.scope}: ${result.names.join(', ')}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('command registration failed', error);
        return { ok: false, output: message };
      }

    default:
      throw new ApiError(404, `No route for ${route}.`);
  }
}
