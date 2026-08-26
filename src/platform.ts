import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** This product targets Windows only. Other platforms are unsupported. */
export const IS_WINDOWS = process.platform === 'win32';

/**
 * Restrict a state file to the current Windows account.
 *
 * Node's chmod only toggles the DOS read-only bit on Windows, so a Unix-looking 0600 mode does not
 * protect tokens there. icacls is part of Windows and accepts an argument vector without a shell;
 * failures stay best-effort so an unusual enterprise ACL cannot stop the bridge from starting.
 */
export function restrictPrivateFile(path: string): boolean {
  if (!IS_WINDOWS) return true;
  try {
    const who = spawnSync('whoami.exe', [], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    const identity = who.status === 0 ? who.stdout.trim() : '';
    if (!identity) return false;
    const acl = spawnSync(
      'icacls.exe',
      [path, '/inheritance:r', '/grant:r', `${identity}:(F)`, '/c', '/q'],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    return acl.status === 0;
  } catch {
    return false;
  }
}

/** Best-effort "open this URL in a browser"; never throws, because startup must not die on it. */
export function openUrl(url: string): void {
  const command = spawn('cmd', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  command.once('error', () => undefined);
  command.unref();
}

export function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-user directory for state the bot writes at runtime (tokens, logs, the packaged .env).
 *
 * A development checkout is writable, so state simply lives in the repo. A packaged install under
 * Program Files is not, and quietly failing to write the control-panel token there would break the
 * panel — so packaged installs fall back here.
 */
export function userStateDir(): string {
  return join(process.env['APPDATA'] ?? homedir(), 'discord-audio-bridge');
}
