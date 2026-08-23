import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';

import { IS_LINUX, isWritable, userStateDir } from './platform.ts';

/**
 * Where the project's files (web/, remote/, AudioTap) live.
 *
 * An explicit override (used by packages that separate the binary from its assets) is authoritative.
 * Without one, the running script/executable, standard Linux install root, and working directory
 * are searched upward for web/index.html. No import.meta here: the release build is a CommonJS
 * bundle, where it does not survive.
 */
export function findProjectRoot(
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
  linux = IS_LINUX,
): string {
  const argIndex = argv.indexOf('--project-root');
  const cliOverride = argIndex >= 0 ? argv[argIndex + 1]?.trim() ?? '' : '';
  const override = cliOverride || environment['BRIDGE_PROJECT_ROOT']?.trim() || '';

  // An explicit package/CLI root is authoritative. The old behavior discarded it when its probe
  // failed and silently served assets relative to the launcher's working directory, which turned
  // a packaging problem into an unhelpful plain "Not found" page.
  if (override) return resolve(override);

  const starts = [
    dirname(argv[1] ?? process.execPath),
    ...(linux ? ['/usr/share/discord-audio-bridge'] : []),
    currentDirectory,
  ];
  for (const start of starts) {
    if (!start) continue;
    let dir = resolve(start);
    for (let depth = 0; depth < 8; depth++) {
      if (existsSync(join(dir, 'web', 'index.html'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return currentDirectory;
}

export const projectRoot = findProjectRoot();

/**
 * Writable root for runtime state. Same as projectRoot in a checkout; a per-user state directory
 * when the install root is read-only (packaged installs under /usr/share or Program Files).
 */
export const runtimeRoot = process.env['BRIDGE_RUNTIME_ROOT']?.trim()
  ? resolve(process.env['BRIDGE_RUNTIME_ROOT'])
  : isWritable(projectRoot)
    ? projectRoot
    : userStateDir();

function loadEnvFiles(paths: string[]): void {
  // Preserve variables supplied by the launching environment, while allowing each later file to
  // override an earlier, lower-precedence file.
  const external = new Set(Object.keys(process.env));
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
      if (!external.has(key)) process.env[key] = value;
    }
  }
}

// A system-wide file for packaged installs, then the checkout's own .env. The checkout wins for
// keys present in both, and real environment variables beat everything.
loadEnvFiles([
  ...(IS_LINUX ? ['/etc/discord-audio-bridge/env'] : []),
  join(projectRoot, '.env'),
  ...(runtimeRoot !== projectRoot ? [join(runtimeRoot, '.env')] : []),
]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in (see the Setup section of README.md).`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be a whole number, got "${raw}"`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

function safePath(name: string, fallback: string): string {
  const value = optional(name) ?? fallback;
  if (value.length > 4_096 || /[\0\r\n]/.test(value)) throw new Error(`${name} contains invalid characters.`);
  return value;
}

function snowflake(name: string): string | undefined {
  const value = optional(name);
  if (value === undefined) return undefined;
  if (!/^\d{15,22}$/.test(value)) throw new Error(`${name} must be a Discord numeric ID, got "${value}"`);
  return value;
}

function remoteHost(): string {
  const host = optional('REMOTE_HOST') ?? '127.0.0.1';
  const hostname = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;
  if (isIP(host) === 0 && !hostname.test(host)) throw new Error(`REMOTE_HOST is invalid: "${host}"`);
  return host;
}

const vbrModes = ['off', 'on', 'constrained'] as const;
export type VbrMode = (typeof vbrModes)[number];

/**
 * Loudness handling, in increasing order of intervention.
 *
 * `limit` is the sane default: a true-peak limiter costs one filter and makes the +20 dB end of the
 * gain range safe. `match` adds single-pass EBU R128 normalisation so a quiet video and a loud game
 * arrive at the same perceived level - useful, but it upsamples to 192 kHz internally for true-peak
 * detection, so it is opt-in rather than automatic.
 */
const loudnessModes = ['off', 'limit', 'match'] as const;
export type LoudnessMode = (typeof loudnessModes)[number];

function loudness(): LoudnessMode {
  const raw = (optional('AUDIO_LOUDNESS') ?? 'limit') as LoudnessMode;
  if (!loudnessModes.includes(raw)) throw new Error(`AUDIO_LOUDNESS must be one of ${loudnessModes.join(' | ')}`);
  return raw;
}

function vbr(): VbrMode {
  const raw = (optional('OPUS_VBR') ?? 'on') as VbrMode;
  if (!vbrModes.includes(raw)) throw new Error(`OPUS_VBR must be one of ${vbrModes.join(' | ')}`);
  return raw;
}

const logLevels = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof logLevels)[number];

// The repo layout keeps the helper at native/AudioTap/bin; packaged installs drop AudioTap.exe
// next to the executable. Prefer whichever actually exists so both work unchanged.
function defaultAudioTapPath(): string {
  const repoPath = join(projectRoot, 'native', 'AudioTap', 'bin', 'AudioTap.exe');
  if (existsSync(repoPath)) return repoPath;
  return join(projectRoot, 'AudioTap.exe');
}

function logFile(): string | undefined {
  const raw = optional('LOG_FILE');
  if (raw?.toLowerCase() === 'off') return undefined;
  if (raw && (raw.length > 4_096 || /[\0\r\n]/.test(raw))) {
    throw new Error('LOG_FILE contains invalid characters.');
  }
  // Keep logs inside the writable runtime root. Besides making packaged installs predictable, this
  // prevents the control panel's LOG_FILE setting from becoming an arbitrary-file append target.
  const target = resolve(runtimeRoot, raw ?? join('logs', 'bridge.log'));
  const inside = relative(runtimeRoot, target);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('LOG_FILE must stay inside the writable runtime directory.');
  }
  return target;
}

function logLevel(): LogLevel {
  const raw = (optional('LOG_LEVEL') ?? 'info') as LogLevel;
  if (!logLevels.includes(raw)) throw new Error(`LOG_LEVEL must be one of ${logLevels.join(' | ')}`);
  return raw;
}

export const config = {
  // Validated lazily: `npm run doctor` and the source listings are useful before a token exists,
  // so demanding one at import time would break the tools people reach for while setting up.
  discord: {
    get token() {
      return required('DISCORD_TOKEN');
    },
    /**
     * Optional. The bot token already identifies its application, so this is only needed when the
     * two are deliberately different; command registration resolves it from the token otherwise.
     */
    get appId() {
      return optional('DISCORD_APP_ID');
    },
    get guildId() {
      return optional('DISCORD_GUILD_ID');
    },
  },
  opus: {
    /** undefined means "match whatever the voice channel is set to". */
    bitrate: optional('OPUS_BITRATE') ? integer('OPUS_BITRATE', 0, 8_000, 510_000) : undefined,
    vbr: vbr(),
    complexity: integer('OPUS_COMPLEXITY', 10, 0, 10),
  },
  capture: {
    bufferMs: integer('CAPTURE_BUFFER_MS', 120, 20, 2_000),
  },
  audio: {
    /** off | limit (true-peak limiter only) | match (limiter + EBU R128 normalisation). */
    loudness: loudness(),
    /** Integrated loudness target in LUFS, used only when loudness is "match". */
    targetLufs: integer('AUDIO_TARGET_LUFS', -14, -40, -5),
    /** True-peak ceiling in dBTP for both the limiter and the normaliser. */
    truePeakDb: integer('AUDIO_TRUE_PEAK_DB', -1, -9, 0),
  },
  presence: {
    /** Set the bot's "Listening to ..." activity from the live source or track. */
    activity: boolean('PRESENCE_ACTIVITY', true),
    /**
     * Write the live source into the voice channel's status line. Needs the Set Voice Channel
     * Status permission, which is not in most default invite URLs - the panel builds a correct one.
     */
    channelStatus: boolean('PRESENCE_CHANNEL_STATUS', true),
    /** Poll the Windows media session for track metadata (AudioTap --now-playing). */
    nowPlaying: boolean('PRESENCE_NOW_PLAYING', true),
  },
  automation: {
    /** Stop and disconnect after this many seconds alone in a channel. 0 disables. */
    leaveWhenEmptySeconds: integer('AUTO_LEAVE_SECONDS', 0, 0, 86_400),
    /** Restore the last route on startup once the bot signs in. */
    resumeLastRoute: boolean('AUTO_RESUME', false),
    /**
     * Move a live stream to whichever voice channel this user joins.
     *
     * Deliberately one named user rather than "whoever asked": the bridge is streaming a specific
     * machine's audio, so the person who owns that machine is the only one who should be able to
     * pull it around a server by walking between channels.
     */
    followUserId: snowflake('AUTO_FOLLOW_USER_ID'),
  },
  control: {
    /** Loopback-only control panel. Set CONTROL_PORT=0 to disable it entirely. */
    port: integer('CONTROL_PORT', 8787, 0, 65_535),
    autoOpen: boolean('CONTROL_OPEN', false),
  },
  remote: {
    /** Network-facing runtime controls only. Set REMOTE_PORT=0 to disable. */
    port: integer('REMOTE_PORT', 0, 0, 65_535),
    host: remoteHost(),
    token: optional('REMOTE_TOKEN'),
    /** Personal tailnets can use Tailscale's device authentication instead of another URL token. */
    trustTailscale: boolean('REMOTE_TRUST_TAILSCALE', false),
  },
  paths: {
    ffmpeg: safePath('FFMPEG_PATH', 'ffmpeg'),
    audioTap: safePath('AUDIOTAP_PATH', defaultAudioTapPath()),
    /** PipeWire CLI tools used as the Linux capture helper. */
    pwRecord: safePath('PWRECORD_PATH', 'pw-record'),
    pwDump: safePath('PWDUMP_PATH', 'pw-dump'),
    /** Player used for local monitoring. Ships with a full ffmpeg build. */
    ffplay: safePath('FFPLAY_PATH', 'ffplay'),
    /** Persistent UTF-8 JSON-lines log. Set LOG_FILE=off to keep logs in memory/console only. */
    logFile: logFile(),
  },
  logLevel: logLevel(),
} as const;

/**
 * Discord fixes the voice codec at 48kHz stereo Opus in 20ms frames. Nothing here is tunable;
 * they exist so the numbers are named rather than sprinkled through the pipeline.
 */
export const DISCORD_AUDIO = {
  sampleRate: 48_000,
  channels: 2,
  frameDurationMs: 20,
} as const;
