import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectRoot } from './config.ts';

/** Replaced by the bundler at build time; absent in a source checkout. */
declare const __BRIDGE_BUILD_VERSION__: string;

function packageVersion(): string | null {
  try {
    const raw = readFileSync(join(projectRoot, 'package.json'), 'utf8');
    const value = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The version of the code that is actually executing.
 *
 * Baked in when the release bundle is built, because that is the only value a running binary can
 * state about itself with authority. A checkout has no build step, so it falls back to the
 * package manifest, which in that case is the same tree.
 */
export const RUNNING_VERSION: string =
  typeof __BRIDGE_BUILD_VERSION__ === 'string' ? __BRIDGE_BUILD_VERSION__ : (packageVersion() ?? 'unknown');

export interface VersionInfo {
  /** Compiled into the running process. */
  running: string;
  /** Read from package.json next to the web assets being served, at request time. */
  assets: string | null;
  /** The two disagree: an old process is serving newer files. */
  stale: boolean;
}

/**
 * Detects a running process that is older than the files it is serving.
 *
 * The control panel is static HTML read from disk on every request, while the routes it calls are
 * compiled into the running executable. Upgrading in place therefore swaps the front end out from
 * under a server that keeps its old code until it is restarted - and the only symptom is a newer
 * panel calling endpoints the old server has never heard of, which surfaces as unexplained 404s
 * rather than as "restart me". Reporting both versions turns that into one legible sentence.
 */
export function versionInfo(): VersionInfo {
  const assets = packageVersion();
  return { running: RUNNING_VERSION, assets, stale: assets !== null && assets !== RUNNING_VERSION };
}
