import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The two desktop platforms this bridge supports. Everything else (including macOS, whose per-app
 * capture would need Core Audio Tap) is unsupported rather than silently broken.
 */
export const IS_WINDOWS = process.platform === 'win32';
export const IS_LINUX = process.platform === 'linux';

/** Best-effort "open this URL in a browser"; never throws, because startup must not die on it. */
export function openUrl(url: string): void {
  const command = IS_WINDOWS
    ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
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
 * A development checkout is writable, so state simply lives in the repo. A packaged install
 * (/usr/share on Linux, Program Files on Windows) is not, and quietly failing to write the
 * control-panel token there would break the panel — so packaged installs fall back here.
 */
export function userStateDir(): string {
  if (IS_WINDOWS) return join(process.env['APPDATA'] ?? homedir(), 'discord-audio-bridge');
  if (process.env['XDG_STATE_HOME']) return join(process.env['XDG_STATE_HOME'], 'discord-audio-bridge');
  return join(homedir(), '.local', 'state', 'discord-audio-bridge');
}
