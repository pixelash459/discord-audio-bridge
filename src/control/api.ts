import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { ChannelType, PermissionFlagsBits, type Client, type VoiceBasedChannel } from 'discord.js';

import { config, projectRoot, type LoudnessMode } from '../config.ts';
import { logger } from '../logger.ts';
import { collectReport, renderReport } from '../diagnostics.ts';
import { listDshowDevices } from '../audio/encoder.ts';
import { nowPlaying, nowPlayingSummary, sourceMonitor, type NowPlaying } from '../audio/monitor.ts';
import { captureBackend, isAudioTapBuilt, listDevices, listProcesses } from '../audio/tap.ts';
import {
  deletePreset,
  getPreset,
  listPresets,
  savePreset,
  touchPreset,
  type Route,
} from '../presets.ts';
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
import {
  finiteNumber,
  OPUS_MAX_BITRATE,
  OPUS_MIN_BITRATE,
  validateSources,
} from '../validation.ts';

const log = logger('api');

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

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
    unavailableReason: string | null;
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
    loudness: LoudnessMode;
    targetLufs: number;
  };
  /** Whatever the host is playing right now, independent of what is being captured. */
  nowPlaying: NowPlaying | null;
  /** An OAuth2 URL with exactly the permissions this bot needs, or null before sign-in. */
  inviteUrl: string | null;
  automation: {
    leaveWhenEmptySeconds: number;
    resumeLastRoute: boolean;
  };
}

/**
 * Every permission the bridge actually uses, so the panel can hand out an invite URL that works
 * first time. Set Voice Channel Status is the one people miss: it is absent from most older invite
 * links, which is why the status line silently never appears.
 */
const REQUIRED_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.Connect |
  PermissionFlagsBits.Speak |
  PermissionFlagsBits.UseVAD |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.MuteMembers |
  PermissionFlagsBits.SetVoiceChannelStatus |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks;

function inviteUrl(client: Client): string | null {
  const id = client.application?.id ?? client.user?.id ?? process.env['DISCORD_APP_ID']?.trim();
  if (!id) return null;
  const scopes = encodeURIComponent('bot applications.commands');
  return `https://discord.com/oauth2/authorize?client_id=${id}&scope=${scopes}&permissions=${REQUIRED_PERMISSIONS}`;
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
      loudness: config.audio.loudness,
      targetLufs: config.audio.targetLufs,
    },
    nowPlaying: nowPlayingSummary(),
    inviteUrl: inviteUrl(client),
    automation: {
      leaveWhenEmptySeconds: config.automation.leaveWhenEmptySeconds,
      resumeLastRoute: config.automation.resumeLastRoute,
    },
  };
}

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new ApiError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return {} as T;
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'Request body must use application/json.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ApiError(400, 'Body was not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'JSON body must be an object.');
  }
  return parsed as T;
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
    channel.type === ChannelType.GuildStageVoice && !permissions.has(PermissionFlagsBits.MuteMembers)
      ? 'Mute Members (needed to become a Stage speaker)'
      : null,
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
          const missing = [
            permissions?.has(PermissionFlagsBits.Connect) ? null : 'Connect',
            permissions?.has(PermissionFlagsBits.Speak) ? null : 'Speak',
            channel.type === ChannelType.GuildStageVoice && !permissions?.has(PermissionFlagsBits.MuteMembers)
              ? 'Mute Members (needed to become a Stage speaker)'
              : null,
          ].filter(Boolean);
          return {
            id: voice.id,
            name: voice.name,
            bitrate: voice.bitrate,
            userLimit: 'userLimit' in voice ? voice.userLimit : 0,
            members: voice.members.size,
            joinable: missing.length === 0,
            unavailableReason: missing.length > 0 ? `Missing ${missing.join(', ')}` : null,
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

interface StreamRequest {
  guildId?: string;
  channelId?: string;
  source?: SourceSpec;
  sources?: SourceSpec[];
  bitrate?: number;
  loudness?: LoudnessMode;
  gainDb?: number;
}

const LOUDNESS_MODES: LoudnessMode[] = ['off', 'limit', 'match'];

/**
 * The one place a stream is started, shared by the stream route and by applying a saved route.
 *
 * Both accept either a single `source` or a `sources` array; a saved route always uses the array
 * form. Validation happens here rather than at either call site so a hand-edited routes.json gets
 * exactly the same scrutiny as a request off the wire.
 */
async function startFromRequest(client: Client, input: StreamRequest) {
  if (!input.guildId || !input.channelId) throw new ApiError(400, 'guildId and channelId are required.');

  let sources: SourceSpec[];
  try {
    sources = validateSources(input);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : String(error));
  }

  if (sources.some((source) => source.kind === 'dshow') && !IS_WINDOWS) {
    throw new ApiError(400, 'DirectShow sources are Windows-only. Capture an app or a device instead.');
  }
  if (sources.some((source) => source.kind !== 'dshow') && !isAudioTapBuilt()) {
    throw new ApiError(
      409,
      IS_WINDOWS
        ? 'AudioTap is not built, so only DirectShow sources work. Build it from the Setup tab.'
        : 'The PipeWire capture tools are missing, so nothing is capturable. Install pipewire-bin on Debian/Ubuntu or pipewire-utils on Fedora.',
    );
  }

  if (input.bitrate !== undefined) {
    try {
      finiteNumber(input.bitrate, 'Bitrate', OPUS_MIN_BITRATE, OPUS_MAX_BITRATE);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : String(error));
    }
  }
  if (input.loudness !== undefined && !LOUDNESS_MODES.includes(input.loudness)) {
    throw new ApiError(400, `Loudness must be one of ${LOUDNESS_MODES.join(', ')}.`);
  }

  const channel = requireChannel(client, input.guildId, input.channelId);
  const bitrate = resolveBitrate(channel, input.bitrate);
  const session = await startOrRetarget(
    channel,
    sources,
    bitrate,
    input.loudness ? { loudness: input.loudness } : {},
  );

  if (input.gainDb !== undefined) {
    try {
      await session.setGain(finiteNumber(input.gainDb, 'Gain', -60, 20));
    } catch (error) {
      log.debug('could not apply the requested gain', error);
    }
  }

  log.info('stream request completed', {
    guild: input.guildId,
    channel: input.channelId,
    sources: sources.map((source) => source.kind),
    bitrate,
  });
  return session;
}

function routeFrom(session: SessionStatus): Route {
  return {
    guildId: session.guildId,
    channelId: session.channelId,
    sources: session.sources,
    bitrate: session.bitrate,
    gainDb: session.gainDb,
    loudness: session.loudness,
  };
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
        source?: SourceSpec;
        sources?: SourceSpec[];
        bitrate?: number;
        loudness?: LoudnessMode;
      }>(req);
      const session = await startFromRequest(client, input);
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
      try {
        finiteNumber(db, 'Gain', -60, 20);
      } catch (error) {
        throw new ApiError(400, error instanceof Error ? error.message : String(error));
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
      try {
        finiteNumber(bitrate, 'Bitrate', OPUS_MIN_BITRATE, OPUS_MAX_BITRATE);
      } catch (error) {
        throw new ApiError(400, error instanceof Error ? error.message : String(error));
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
      if (typeof bitrate !== 'number' || !Number.isFinite(bitrate) || (bitrate !== 0 && bitrate < 8_000)) {
        throw new ApiError(400, 'Channel bitrate must be 0 (maximum) or at least 8000.');
      }
      const target = Math.min(Math.round(bitrate || max), max);

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

    case 'GET /api/diagnostics': {
      const report = collectReport();
      // `report` is the plain-text rendering, kept so the copy button and older clients still work.
      return { ...report, report: renderReport(report) };
    }

    case 'GET /api/now-playing':
      return { nowPlaying: nowPlaying() };

    case 'POST /api/sources/refresh':
      // Nudges the resident monitor. Falls back to reporting that there is nothing to nudge, in
      // which case the client's own reload of /api/sources does the job.
      return { refreshed: sourceMonitor.refresh() };

    case 'GET /api/presets':
      return { presets: listPresets() };

    case 'POST /api/presets': {
      const { name, guildId } = await body<{ name: string; guildId?: string }>(req);
      if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'A saved route needs a name.');

      // Saving captures whatever is live right now: that is the whole point, and it means the
      // panel never has to serialise its own form state.
      const sessions = allSessions();
      const session = guildId ? getSession(guildId) : sessions[0];
      if (!session) throw new ApiError(409, 'Start a stream first, then save it as a route.');

      try {
        return { preset: savePreset(name, routeFrom(session.status())) };
      } catch (error) {
        throw new ApiError(400, error instanceof Error ? error.message : String(error));
      }
    }

    case 'POST /api/presets/apply': {
      const { id } = await body<{ id: string }>(req);
      const preset = typeof id === 'string' ? getPreset(id) : undefined;
      if (!preset) throw new ApiError(404, 'That saved route no longer exists.');

      const session = await startFromRequest(client, {
        guildId: preset.guildId,
        channelId: preset.channelId,
        sources: preset.sources,
        ...(preset.bitrate === undefined ? {} : { bitrate: preset.bitrate }),
        ...(preset.gainDb === undefined ? {} : { gainDb: preset.gainDb }),
        ...(preset.loudness === undefined ? {} : { loudness: preset.loudness }),
      });
      touchPreset(preset.id);
      log.info(`applied saved route "${preset.name}"`);
      return { session: session.status(), presets: listPresets() };
    }

    case 'POST /api/presets/delete': {
      const { id } = await body<{ id: string }>(req);
      if (typeof id !== 'string') throw new ApiError(400, 'id is required.');
      return { deleted: deletePreset(id), presets: listPresets() };
    }

    case 'POST /api/loudness': {
      const { guildId, mode } = await body<{ guildId: string; mode: LoudnessMode }>(req);
      const session = getSession(guildId);
      if (!session) throw new ApiError(404, 'Nothing is streaming in that server.');
      if (!LOUDNESS_MODES.includes(mode)) {
        throw new ApiError(400, `Loudness must be one of ${LOUDNESS_MODES.join(', ')}.`);
      }
      await session.setLoudness(mode);
      return { session: session.status() };
    }

    case 'POST /api/input-gain': {
      const { guildId, index, db } = await body<{ guildId: string; index: number; db: number }>(req);
      const session = getSession(guildId);
      if (!session) throw new ApiError(404, 'Nothing is streaming in that server.');
      if (!Number.isInteger(index) || index < 0 || index >= session.sources.length) {
        throw new ApiError(400, 'That mix input does not exist.');
      }
      try {
        finiteNumber(db, 'Gain', -60, 20);
        await session.setInputGain(index, db);
      } catch (error) {
        throw new ApiError(400, error instanceof Error ? error.message : String(error));
      }
      return { session: session.status() };
    }

    case 'GET /api/config':
      return { ...readConfig(), restartRequired: RESTART_REQUIRED_KEYS };

    case 'GET /api/remote':
      return remoteAccessInfo();

    case 'POST /api/config': {
      const updates = await body<Partial<Record<EditableKey, string>>>(req);
      try {
        writeConfig(updates);
      } catch (error) {
        throw new ApiError(400, error instanceof Error ? error.message : String(error));
      }
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
