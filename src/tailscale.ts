import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { logger } from './logger.ts';

const execFileAsync = promisify(execFile);
const log = logger('tailscale');
const cache = new Map<string, { valid: boolean; expires: number }>();

export function isTailscaleAddress(address?: string | null): boolean {
  const normalized = (address ?? '').replace(/^::ffff:/i, '').toLowerCase();
  if (normalized.startsWith('fd7a:115c:a1e0:')) return true;
  const octets = normalized.split('.').map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

/**
 * Ask the local Tailscale daemon to authenticate a peer instead of trusting the broad CGNAT range.
 * A short cache avoids spawning the CLI for dashboard polling. Failure is closed; token auth still
 * works when Tailscale is absent or its CLI is not on PATH.
 */
export async function isAuthenticatedTailscalePeer(
  localAddress?: string | null,
  remoteAddress?: string | null,
): Promise<boolean> {
  if (!isTailscaleAddress(localAddress) || !isTailscaleAddress(remoteAddress)) return false;
  const address = (remoteAddress ?? '').replace(/^::ffff:/i, '');
  const cached = cache.get(address);
  if (cached && cached.expires > Date.now()) return cached.valid;

  let valid = false;
  try {
    const { stdout } = await execFileAsync('tailscale', ['whois', '--json', address], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const response = JSON.parse(stdout) as { Node?: { Addresses?: string[] } };
    valid = Boolean(
      response.Node?.Addresses?.some((candidate) => candidate.split('/')[0] === address),
    );
  } catch (error) {
    log.debug('Tailscale peer verification failed; requiring the remote token', error);
  }
  cache.set(address, { valid, expires: Date.now() + (valid ? 5 * 60_000 : 15_000) });
  return valid;
}
