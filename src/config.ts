import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { IS_LINUX, isWritable, userStateDir } from './platform.ts';

/**
 * Where the project's files (web/, remote/, AudioTap) live.
 *
 * Ordered so every way of running the bot works: an explicit override (used by packages that
 * separate the binary from its assets), the directory of the running script or single-file
 * executable, and the working directory — each walking upward to find web/index.html, which is
 * the one file that must sit at the root for the panels to serve. No import.meta here: the
 * release build is a CommonJS bundle, where it does not survive.
 */
export function findProjectRoot(): string {
  const argIndex = process.argv.indexOf('--project-root');
  const override =
    process.argv[argIndex + 1]?.trim() || process.env['BRIDGE_PROJECT_ROOT']?.trim() || '';

  const starts = [override, dirname(process.argv[1] ?? process.execPath), process.cwd()];
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
  return process.cwd();
}

export const projectRoot = findProjectRoot();

/**
 * Writable root for runtime state. Same as projectRoot in a checkout; a per-user state directory
 * when the install root is read-only (packaged installs under /usr/share or Program Files).
 */
export const runtimeRoot = isWritable(projectRoot) ? projectRoot : userStateDir();

function loadEnvFiles(paths: string[]): void {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    // Parsed by hand rather than process.loadEnvFile so real environment variables always win,
    // no matter which file is loaded first.
    for (const [key, value] of parseEnvFile(readFileSync(path, 'utf8'))) {
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

function parseEnvFile(text: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals === -1) continue;
    entries.push([trimmed.slice(0, equals).trim(), trimmed.slice(equals + 1).trim()]);
  }
  return entries;
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

function integer(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

const vbrModes = ['off', 'on', 'constrained'] as const;
export type VbrMode = (typeof vbrModes)[number];

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
  // Relative to the runtime root, so a read-only install still logs into the user's state dir.
  return resolve(runtimeRoot, raw ?? join('logs', 'bridge.log'));
}

export const config = {
  // Validated lazily: `npm run doctor` and the source listings are useful before a token exists,
  // so demanding one at import time would break the tools people reach for while setting up.
  discord: {
    get token() {
      return required('DISCORD_TOKEN');
    },
    get appId() {
      return required('DISCORD_APP_ID');
    },
    get guildId() {
      return optional('DISCORD_GUILD_ID');
    },
  },
  opus: {
    /** undefined means "match whatever the voice channel is set to". */
    bitrate: optional('OPUS_BITRATE') ? integer('OPUS_BITRATE', 0) : undefined,
    vbr: vbr(),
    complexity: Math.min(10, Math.max(0, integer('OPUS_COMPLEXITY', 10))),
  },
  capture: {
    bufferMs: Math.min(2000, Math.max(20, integer('CAPTURE_BUFFER_MS', 120))),
  },
  control: {
    /** Loopback-only control panel. Set CONTROL_PORT=0 to disable it entirely. */
    port: integer('CONTROL_PORT', 8787),
    autoOpen: (optional('CONTROL_OPEN') ?? 'false').toLowerCase() === 'true',
  },
  remote: {
    /** Network-facing runtime controls only. Set REMOTE_PORT=0 to disable. */
    port: integer('REMOTE_PORT', 8788),
    host: optional('REMOTE_HOST') ?? '0.0.0.0',
    token: optional('REMOTE_TOKEN'),
    /** Personal tailnets can use Tailscale's device authentication instead of another URL token. */
    trustTailscale: (optional('REMOTE_TRUST_TAILSCALE') ?? 'true').toLowerCase() === 'true',
  },
  paths: {
    ffmpeg: optional('FFMPEG_PATH') ?? 'ffmpeg',
    audioTap: optional('AUDIOTAP_PATH') ?? defaultAudioTapPath(),
    /** PipeWire CLI tools used as the Linux capture helper. */
    pwRecord: optional('PWRECORD_PATH') ?? 'pw-record',
    pwDump: optional('PWDUMP_PATH') ?? 'pw-dump',
    /** Persistent UTF-8 JSON-lines log. Set LOG_FILE=off to keep logs in memory/console only. */
    logFile: logFile(),
  },
  logLevel: ((): LogLevel => {
    const raw = (optional('LOG_LEVEL') ?? 'info') as LogLevel;
    return logLevels.includes(raw) ? raw : 'info';
  })(),
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
