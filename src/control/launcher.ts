import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { runtimeRoot } from '../config.ts';

interface SavedControlToken {
  port: number;
  token: string;
}

export const controlTokenPath = join(runtimeRoot, '.control-token');

/**
 * Return the authenticated panel URL only when a running bridge answers with a valid snapshot.
 * A stale token file is normal after a crash and simply means the desktop launcher starts a new
 * bridge. The path and fetch implementation are injectable so the behavior can be smoke-tested.
 */
export async function findRunningControlPanel(
  tokenPath = controlTokenPath,
  request: typeof fetch = fetch,
): Promise<string | undefined> {
  if (!existsSync(tokenPath)) return undefined;

  try {
    const saved = JSON.parse(readFileSync(tokenPath, 'utf8')) as Partial<SavedControlToken>;
    if (
      !Number.isInteger(saved.port) ||
      (saved.port ?? 0) < 1 ||
      (saved.port ?? 0) > 65_535 ||
      typeof saved.token !== 'string' ||
      !/^[A-Za-z0-9_-]{24,256}$/.test(saved.token)
    ) {
      return undefined;
    }

    const panelUrl = new URL(`http://127.0.0.1:${saved.port}/`);
    panelUrl.hash = `token=${saved.token}`;
    const stateUrl = new URL('/api/state', panelUrl);

    const response = await request(stateUrl, {
      headers: { authorization: `Bearer ${saved.token}` },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return undefined;
    const snapshot = (await response.json()) as { bot?: unknown };
    return snapshot && typeof snapshot === 'object' && 'bot' in snapshot
      ? panelUrl.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Remove only this process's saved endpoint, never one written by a replacement process. */
export function removeSavedControlPanel(token: string, tokenPath = controlTokenPath): void {
  try {
    const saved = JSON.parse(readFileSync(tokenPath, 'utf8')) as Partial<SavedControlToken>;
    if (saved.token === token) rmSync(tokenPath, { force: true });
  } catch {
    // Missing, stale, or malformed state is already effectively removed.
  }
}
