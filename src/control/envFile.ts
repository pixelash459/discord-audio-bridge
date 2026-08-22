import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  const values = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equals = trimmed.indexOf('=');
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }

  return values;
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
  const entries = Object.entries(updates).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return;

  const original = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const lines = original.split(/\r?\n/);
  const pending = new Map(entries);

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    const equals = trimmed.indexOf('=');
    if (equals === -1) return line;

    const key = trimmed.slice(0, equals).trim();
    if (!pending.has(key)) return line;

    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });

  // Anything not already present gets appended.
  const additions = [...pending.entries()]
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`);

  if (additions.length > 0) {
    if (rewritten.at(-1)?.trim() !== '') rewritten.push('');
    rewritten.push(...additions);
  }

  mkdirSync(dirname(envPath), { recursive: true });
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
