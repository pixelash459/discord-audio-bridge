import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envFile = join(projectRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

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

const defaultTapPath = join(projectRoot, 'native', 'AudioTap', 'bin', 'AudioTap.exe');

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
  paths: {
    ffmpeg: optional('FFMPEG_PATH') ?? 'ffmpeg',
    audioTap: optional('AUDIOTAP_PATH') ?? defaultTapPath,
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
