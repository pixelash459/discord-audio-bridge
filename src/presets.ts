import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runtimeRoot } from './config.ts';
import { logger } from './logger.ts';
import { restrictPrivateFile } from './platform.ts';
import { finiteNumber, OPUS_MAX_BITRATE, OPUS_MIN_BITRATE, validateSources } from './validation.ts';
import type { LoudnessMode } from './config.ts';
import type { SourceSpec } from './voice/session.ts';

const log = logger('presets');
const storePath = join(runtimeRoot, 'routes.json');

export const MAX_PRESETS = 24;

export interface Route {
  guildId: string;
  channelId: string;
  sources: SourceSpec[];
  bitrate?: number;
  gainDb?: number;
  loudness?: LoudnessMode;
}

export interface Preset extends Route {
  id: string;
  name: string;
  /** Epoch ms, so the panel can show and sort by "last used". */
  usedAt: number;
}

interface Store {
  /** The route in use when the bridge last shut down, for AUTO_RESUME. */
  last?: Route;
  presets: Preset[];
}

let cache: Store | undefined;

/**
 * Named routes, so a setup you use every week is one click instead of four.
 *
 * "Source + destination + bitrate + gain" is the entire configuration of a stream, and it is
 * currently retyped from scratch on every launch - nothing about a route survives a restart. This
 * keeps them in a small JSON file next to the other runtime state, alongside the last route used so
 * the bridge can optionally pick up exactly where it left off.
 *
 * Everything is validated on the way in *and* on the way out: the file is user-editable, and a
 * hand-edited source must not reach a capture subprocess unchecked just because it came from disk.
 */
function read(): Store {
  if (cache) return cache;

  if (!existsSync(storePath)) {
    cache = { presets: [] };
    return cache;
  }

  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as Partial<Store>;
    cache = {
      ...(parsed.last ? { last: sanitize(parsed.last) } : {}),
      presets: Array.isArray(parsed.presets)
        ? parsed.presets
            .flatMap((entry) => {
              try {
                return [sanitizePreset(entry)];
              } catch (error) {
                log.warn('discarding an unreadable saved route', error);
                return [];
              }
            })
            .slice(0, MAX_PRESETS)
        : [],
    };
  } catch (error) {
    log.warn('saved routes could not be read; starting a fresh list', error);
    cache = { presets: [] };
  }

  return cache;
}

function write(store: Store): void {
  try {
    mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash mid-write must not leave a truncated file that loses every preset.
    const temporary = `${storePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, storePath);
    restrictPrivateFile(storePath);
    cache = store;
  } catch (error) {
    log.warn('saved routes could not be written', error);
    throw new Error('Saved routes could not be written.', { cause: error });
  }
}

function snowflake(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{15,22}$/.test(value)) {
    throw new Error(`${field} is not a Discord ID.`);
  }
  return value;
}

function sanitize(route: Partial<Route>): Route {
  const sources = validateSources({ sources: route.sources });
  return {
    guildId: snowflake(route.guildId, 'guildId'),
    channelId: snowflake(route.channelId, 'channelId'),
    sources,
    ...(route.bitrate === undefined
      ? {}
      : { bitrate: Math.round(finiteNumber(route.bitrate, 'Bitrate', OPUS_MIN_BITRATE, OPUS_MAX_BITRATE)) }),
    ...(route.gainDb === undefined ? {} : { gainDb: finiteNumber(route.gainDb, 'Gain', -60, 20) }),
    ...(route.loudness && ['off', 'limit', 'match'].includes(route.loudness)
      ? { loudness: route.loudness }
      : {}),
  };
}

function sanitizePreset(entry: Partial<Preset>): Preset {
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!name || name.length > 60) throw new Error('A saved route needs a name of 1-60 characters.');
  return {
    ...sanitize(entry),
    id: typeof entry.id === 'string' && entry.id.length <= 64 ? entry.id : randomUUID(),
    name,
    usedAt: typeof entry.usedAt === 'number' && Number.isFinite(entry.usedAt) ? entry.usedAt : 0,
  };
}

export function listPresets(): Preset[] {
  return [...read().presets].sort((a, b) => b.usedAt - a.usedAt);
}

export function lastRoute(): Route | undefined {
  return read().last;
}

/** Remembers the route currently in use, for AUTO_RESUME on the next start. */
export function rememberRoute(route: Route): void {
  const store = read();
  try {
    write({ ...store, last: sanitize(route) });
  } catch (error) {
    log.debug('route not remembered', error);
  }
}

export function forgetRoute(): void {
  const store = read();
  const { last: _discarded, ...rest } = store;
  write({ ...rest, presets: store.presets });
}

/** Creates a preset, or replaces one that already has this name. */
export function savePreset(name: string, route: Route): Preset {
  const store = read();
  const preset = sanitizePreset({ ...route, name, id: randomUUID(), usedAt: Date.now() });

  const others = store.presets.filter(
    (candidate) => candidate.name.toLowerCase() !== preset.name.toLowerCase(),
  );
  if (others.length >= MAX_PRESETS) {
    throw new Error(`You already have ${MAX_PRESETS} saved routes. Delete one first.`);
  }

  write({ ...store, presets: [...others, preset] });
  log.info(`saved route "${preset.name}"`);
  return preset;
}

export function deletePreset(id: string): boolean {
  const store = read();
  const remaining = store.presets.filter((preset) => preset.id !== id);
  if (remaining.length === store.presets.length) return false;
  write({ ...store, presets: remaining });
  return true;
}

/** Marks a preset as just-used so the list stays ordered by recency. */
export function touchPreset(id: string): Preset | undefined {
  const store = read();
  const preset = store.presets.find((candidate) => candidate.id === id);
  if (!preset) return undefined;
  const updated = { ...preset, usedAt: Date.now() };
  write({ ...store, presets: store.presets.map((c) => (c.id === id ? updated : c)) });
  return updated;
}

export function getPreset(id: string): Preset | undefined {
  return read().presets.find((preset) => preset.id === id);
}
