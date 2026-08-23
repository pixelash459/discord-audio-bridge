import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

import { runtimeRoot } from '../config.ts';

// Development uses the checkout; read-only packages use the per-user runtime directory.
const envPath = join(runtimeRoot, '.env');

/** Keys the control panel is allowed to read and write. Anything else stays out of reach. */
export const EDITABLE_KEYS = [
  'DISCORD_TOKEN',
  'DISCORD_APP_ID',
  'DISCORD_GUILD_ID',
  'OPUS_BITRATE',
  'OPUS_VBR',
  'OPUS_COMPLEXITY',
  'CAPTURE_BUFFER_MS',
  'FFMPEG_PATH',
  'AUDIOTAP_PATH',
  'LOG_LEVEL',
  'LOG_FILE',
  'CONTROL_PORT',
  'REMOTE_HOST',
  'REMOTE_PORT',
  'REMOTE_TRUST_TAILSCALE',
] as const;

export type EditableKey = (typeof EDITABLE_KEYS)[number];

/** Never returned to a client, even a local one. Writing is allowed; reading back is not. */
const SECRET_KEYS = new Set<string>(['DISCORD_TOKEN']);

function parse(text: string): Map<string, string> {
  return new Map(
    Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function wholeNumber(key: string, value: string, min: number, max: number): string {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${key} must be a whole number between ${min} and ${max}.`);
  }
  return String(Number(value));
}

function validate(key: EditableKey, raw: string): string {
  const value = raw.trim();
  if (value === '') return '';
  if (value.length > 4_096 || /[\0\r\n]/.test(value)) throw new Error(`${key} contains invalid characters.`);

  switch (key) {
    case 'DISCORD_TOKEN':
      if (value.length < 24 || value.length > 256 || /\s/.test(value)) {
        throw new Error('DISCORD_TOKEN does not look like a Discord bot token.');
      }
      return value;
    case 'DISCORD_APP_ID':
    case 'DISCORD_GUILD_ID':
      if (!/^\d{15,22}$/.test(value)) throw new Error(`${key} must be a Discord numeric ID.`);
      return value;
    case 'OPUS_BITRATE':
      return wholeNumber(key, value, 8_000, 510_000);
    case 'OPUS_COMPLEXITY':
      return wholeNumber(key, value, 0, 10);
    case 'CAPTURE_BUFFER_MS':
      return wholeNumber(key, value, 20, 2_000);
    case 'CONTROL_PORT':
    case 'REMOTE_PORT':
      return wholeNumber(key, value, 0, 65_535);
    case 'OPUS_VBR':
      if (!['off', 'on', 'constrained'].includes(value)) throw new Error('OPUS_VBR is invalid.');
      return value;
    case 'LOG_LEVEL':
      if (!['error', 'warn', 'info', 'debug'].includes(value)) throw new Error('LOG_LEVEL is invalid.');
      return value;
    case 'REMOTE_TRUST_TAILSCALE':
      if (!['true', 'false'].includes(value.toLowerCase())) {
        throw new Error('REMOTE_TRUST_TAILSCALE must be true or false.');
      }
      return value.toLowerCase();
    case 'REMOTE_HOST': {
      const hostname = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;
      if (isIP(value) === 0 && !hostname.test(value)) throw new Error('REMOTE_HOST is not valid.');
      return value;
    }
    default:
      return value;
  }
}

function serialize(value: string): string {
  return JSON.stringify(value);
}

export interface ConfigView {
  values: Partial<Record<EditableKey, string>>;
  /** Which secret keys have a value, without revealing what it is. */
  secretsSet: Record<string, boolean>;
  path: string;
  exists: boolean;
}

export function readConfig(): ConfigView {
  const exists = existsSync(envPath);
  const parsed = exists ? parse(readFileSync(envPath, 'utf8')) : new Map<string, string>();

  const values: Partial<Record<EditableKey, string>> = {};
  const secretsSet: Record<string, boolean> = {};

  for (const key of EDITABLE_KEYS) {
    const value = parsed.get(key) ?? '';
    if (SECRET_KEYS.has(key)) {
      secretsSet[key] = value.length > 0;
    } else if (value) {
      values[key] = value;
    }
  }

  return { values, secretsSet, path: envPath, exists };
}

/**
 * Merges updates into .env, preserving comments, ordering, and any keys we do not manage.
 * An empty string removes a key rather than writing a blank one, so defaults keep applying.
 */
export function writeConfig(updates: Partial<Record<EditableKey, string>>): void {
  const allowed = new Set<string>(EDITABLE_KEYS);
  const entries = Object.entries(updates)
    .filter(([key]) => allowed.has(key))
    .map(([key, value]) => {
      if (typeof value !== 'string') throw new Error(`${key} must be text.`);
      return [key as EditableKey, validate(key as EditableKey, value)] as const;
    });
  if (entries.length === 0) return;

  const original = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const lines = original.split(/\r?\n/);
  const pending = new Map(entries);
  const changedKeys = new Set(entries.map(([key]) => key));

  const rewritten = lines.flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [line];

    const equals = trimmed.indexOf('=');
    if (equals === -1) return [line];

    const key = trimmed.slice(0, equals).trim();
    if (!allowed.has(key) || !changedKeys.has(key as EditableKey)) return [line];

    const editableKey = key as EditableKey;
    // Drop stale duplicates. dotenv semantics use the last value, so leaving one behind could make
    // a successful-looking save ineffective or resurrect a secret the user explicitly removed.
    if (!pending.has(editableKey)) return [];
    const value = pending.get(editableKey)!;
    pending.delete(editableKey);
    return value === '' ? [] : [`${key}=${serialize(value)}`];
  });

  // Anything not already present gets appended.
  const additions = [...pending.entries()]
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${serialize(value)}`);

  if (additions.length > 0) {
    if (rewritten.at(-1)?.trim() !== '') rewritten.push('');
    rewritten.push(...additions);
  }

  mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
  writeFileSync(envPath, `${rewritten.join('\n').replace(/\n+$/, '')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(envPath, 0o600);

  // Reflect the change in the running process so anything reading process.env sees it. Values that
  // config.ts froze at import time still need a restart, which the UI tells the user about.
  for (const [key, value] of entries) {
    if (value === '') delete process.env[key];
    else process.env[key] = value;
  }
}

/** Settings that config.ts reads once at import, so changing them needs a restart to take effect. */
export const RESTART_REQUIRED_KEYS: readonly string[] = [
  'DISCORD_TOKEN',
  'DISCORD_APP_ID',
  'OPUS_VBR',
  'OPUS_COMPLEXITY',
  'CAPTURE_BUFFER_MS',
  'FFMPEG_PATH',
  'AUDIOTAP_PATH',
  'LOG_LEVEL',
  'LOG_FILE',
  'CONTROL_PORT',
  'REMOTE_HOST',
  'REMOTE_PORT',
  'REMOTE_TRUST_TAILSCALE',
];
