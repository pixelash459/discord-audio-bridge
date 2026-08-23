import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { IS_WINDOWS } from '../platform.ts';
import type { DeviceInfo, ProcessInfo } from './tap.ts';

const log = logger('monitor');

export interface NowPlaying {
  title: string;
  artist: string;
  album: string;
  /** The application's user-model ID, e.g. "Spotify.exe". */
  appId: string;
  status: string;
  /** Base64 PNG of the album art, when the media session provided one. */
  artwork?: string | null;
}

interface MonitorEvents {
  sources: [];
  track: [NowPlaying | null];
}

const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

/**
 * A single resident AudioTap process that pushes source-list and now-playing changes.
 *
 * The alternative - which this replaces - was the panel re-running `--list-processes` on a ten
 * second timer. That spawned a helper process forever, showed a list that was up to ten seconds
 * stale, and still could not tell you what track was playing. One long-lived child answers all
 * three problems, and it degrades honestly: if the installed helper is older than this feature it
 * exits with a usage error, the monitor disables itself, and the callers fall back to the one-shot
 * enumeration path they have always had.
 */
class SourceMonitor extends EventEmitter<MonitorEvents> {
  #child: ChildProcessWithoutNullStreams | undefined;
  #processes: ProcessInfo[] | undefined;
  #devices: DeviceInfo[] | undefined;
  #track: NowPlaying | null = null;
  #failures = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  /** Latched when the helper cannot support this mode, so we stop trying. */
  #unsupported = false;
  #unsupportedVersion: string | undefined;
  #stopped = false;

  get supported(): boolean {
    return !this.#unsupported && this.#processes !== undefined;
  }

  get processes(): ProcessInfo[] | undefined {
    return this.#processes;
  }

  get devices(): DeviceInfo[] | undefined {
    return this.#devices;
  }

  get track(): NowPlaying | null {
    return this.#track;
  }

  start(): void {
    if (!IS_WINDOWS || this.#child || this.#stopped) return;
    if (!existsSync(config.paths.audioTap)) return;
    if (this.#unsupported) {
      const version = this.#helperVersion();
      if (version === this.#unsupportedVersion) return;
      this.#unsupported = false;
      this.#unsupportedVersion = undefined;
      log.info('AudioTap changed; retrying resident source monitor');
    }

    const args = ['--monitor', '--with-icons', '--poll-ms', '1500'];
    log.debug('starting resident source monitor', { args });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.paths.audioTap, args, { windowsHide: true });
    } catch (error) {
      log.debug('source monitor could not be spawned', error);
      this.#unsupported = true;
      this.#unsupportedVersion = this.#helperVersion();
      return;
    }
    this.#child = child;

    // A child can exit between an exitCode check and stdin.write. Observe the asynchronous EPIPE
    // so a monitor restart never becomes an uncaught exception for the whole bridge.
    child.stdin.on('error', (error) => log.debug('source monitor stdin closed', error));

    // stdout is free in this mode (no PCM), so events arrive there as line-delimited JSON.
    const events = createInterface({ input: child.stdout });
    events.on('line', (line) => this.#handle(line));

    const diagnostics = createInterface({ input: child.stderr });
    diagnostics.on('line', (line) => log.debug(`AudioTap monitor: ${line}`));

    child.once('error', (error) => {
      log.debug('source monitor failed to start', error);
      this.#unsupported = true;
      this.#unsupportedVersion = this.#helperVersion();
      this.#child = undefined;
    });

    child.once('close', (code) => {
      events.close();
      diagnostics.close();
      this.#child = undefined;
      if (this.#stopped) return;

      // Exit code 2 is AudioTap's "bad arguments", which means the installed helper predates
      // --monitor. Retrying that forever would be pointless noise.
      if (code === 2 && this.#processes === undefined) {
        log.info('installed AudioTap has no --monitor mode; using periodic enumeration instead');
        this.#unsupported = true;
        this.#unsupportedVersion = this.#helperVersion();
        return;
      }

      const delay = RESTART_BACKOFF_MS[Math.min(this.#failures, RESTART_BACKOFF_MS.length - 1)]!;
      this.#failures += 1;
      log.warn(`source monitor exited (${code}); restarting in ${delay}ms`);
      this.#restartTimer = setTimeout(() => this.start(), delay);
      this.#restartTimer.unref();
    });
  }

  #helperVersion(): string | undefined {
    try {
      const stat = statSync(config.paths.audioTap);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return undefined;
    }
  }

  /** Asks for an immediate re-publish, e.g. when someone presses Refresh. */
  refresh(): boolean {
    // Setup can build AudioTap after the first start attempt. Pick it up without a bridge restart.
    if (!this.#child) this.start();
    if (!this.#child || this.#child.exitCode !== null || this.#child.stdin.destroyed) return false;
    try {
      this.#child.stdin.write('refresh\n');
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin.write('quit\n');
      child.stdin.end();
    } catch {
      /* already exiting */
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 1_000).unref();
  }

  #handle(line: string): void {
    let parsed: { event: string; data: unknown };
    try {
      parsed = JSON.parse(line) as { event: string; data: unknown };
    } catch {
      log.debug(`AudioTap monitor: ${line}`);
      return;
    }

    switch (parsed.event) {
      case 'ready':
        this.#failures = 0;
        log.info('resident source monitor connected');
        break;
      case 'processes':
        this.#processes = parsed.data as ProcessInfo[];
        this.emit('sources');
        break;
      case 'devices':
        this.#devices = parsed.data as DeviceInfo[];
        this.emit('sources');
        break;
      case 'nowPlaying':
        this.#track = (parsed.data as NowPlaying | null) ?? null;
        this.emit('track', this.#track);
        break;
      default:
        log.debug(`AudioTap monitor ${parsed.event}`, parsed.data);
    }
  }
}

export const sourceMonitor = new SourceMonitor();

/** Current track, or null when nothing is playing or the host cannot report one. */
export function nowPlaying(): NowPlaying | null {
  return config.presence.nowPlaying ? sourceMonitor.track : null;
}

/** Metadata safe to include in frequently-polled snapshots. Artwork is fetched on track changes. */
export function nowPlayingSummary(): NowPlaying | null {
  const track = nowPlaying();
  return track ? { ...track, artwork: null } : null;
}

/** A single line for a channel status or presence string, trimmed to Discord's limits. */
export function describeTrack(track: NowPlaying | null, max = 128): string | null {
  if (!track?.title) return null;
  const text = track.artist ? `${track.artist} - ${track.title}` : track.title;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
