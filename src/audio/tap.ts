import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { config, DISCORD_AUDIO } from '../config.ts';
import { logger } from '../logger.ts';

const log = logger('tap');
const captureChildren = new Set<ChildProcessWithoutNullStreams>();

export interface RawFormat {
  sampleRate: number;
  channels: number;
  /** An ffmpeg raw-PCM demuxer name: f32le, s16le, s32le, ... */
  sampleFormat: string;
  bitsPerSample: number;
  encoding: string;
  latencyMs: number;
  source: string;
  gainAppliedInTap: boolean;
}

export interface TapStats {
  bufferMs: number;
  targetMs: number;
  streamedMs: number;
  paddedMs: number;
  droppedMs: number;
  trimmedMs: number;
  primed: boolean;
  /** Per-channel peak over the last interval, in dBFS. -100 stands in for digital silence. */
  peakDb: number[];
  /** Per-channel RMS over the last interval, in dBFS. */
  rmsDb: number[];
  clipping: boolean;
  silent: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  sampleRate: number;
  channels: number;
  sampleFormat: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  displayName: string;
  state: 'Active' | 'Inactive' | 'Expired' | string;
  peak: number;
  deviceId: string;
}

export class AudioTapUnavailableError extends Error {
  constructor() {
    super(
      `AudioTap.exe was not found at ${config.paths.audioTap}. ` +
        `Build it with "npm run build:native" (needs the .NET SDK), or use a dshow source instead.`,
    );
    this.name = 'AudioTapUnavailableError';
  }
}

export function isAudioTapBuilt(): boolean {
  return existsSync(config.paths.audioTap);
}

function run(args: string[], timeoutMs = 15_000): Promise<string> {
  if (!isAudioTapBuilt()) return Promise.reject(new AudioTapUnavailableError());

  return new Promise((resolve, reject) => {
    const started = performance.now();
    log.debug('running AudioTap command', { args });
    const child = spawn(config.paths.audioTap, args, { windowsHide: true });
    captureChildren.add(child);
    child.once('close', () => captureChildren.delete(child));
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
      log.warn('AudioTap command timed out', { args, timeoutMs });
      reject(new Error(`AudioTap ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.on('error', (error) => {
      clearTimeout(timer);
      log.error('AudioTap command failed to start', { args, error });
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const details = { args, code, durationMs: Math.round(performance.now() - started) };
      if (code === 0) {
        log.debug('AudioTap command completed', details);
        resolve(stdout);
      } else {
        log.warn('AudioTap command exited unsuccessfully', details);
        reject(new Error(`AudioTap exited ${code}: ${stderr.trim() || '(no output)'}`));
      }
    });
  });
}

/** Final shutdown backstop for any capture child that lost its owning session reference. */
export async function closeAllTaps(): Promise<void> {
  const children = [...captureChildren];
  if (children.length === 0) return;
  log.warn('cleaning up remaining AudioTap processes', { count: children.length });
  await Promise.all(
    children.map(async (child) => {
      try {
        child.stdin.write('quit\n');
        child.stdin.end();
      } catch {
        /* already exiting */
      }
      if (child.exitCode !== null) return;
      await Promise.race([once(child, 'close'), new Promise((resolve) => setTimeout(resolve, 1_000))]);
      if (child.exitCode === null) child.kill();
    }),
  );
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  return JSON.parse(await run(['--list-processes'])) as ProcessInfo[];
}

export async function listDevices(): Promise<DeviceInfo[]> {
  return JSON.parse(await run(['--list-devices'])) as DeviceInfo[];
}

export interface TapOptions {
  /** Per-process loopback. */
  pid?: number;
  /** With `pid`, capture everything except that process tree. */
  exclude?: boolean;
  /** Endpoint loopback. Pass "default" for the default render device. */
  deviceId?: string;
  bufferMs?: number;
  gainDb?: number;
}

/**
 * A running AudioTap process. `stream` is raw PCM in `format`; it is paced at exactly real time,
 * with silence filled in whenever the source app goes quiet.
 */
export class Tap {
  readonly stream: Readable;
  readonly format: RawFormat;

  #child: ChildProcessWithoutNullStreams;
  #stats: TapStats | null = null;
  #closed = false;
  #exited: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams, format: RawFormat) {
    this.#child = child;
    this.format = format;
    this.stream = child.stdout;
    this.#exited =
      child.exitCode !== null
        ? Promise.resolve()
        : once(child, 'close').then(([code, signal]) => {
            log.info('AudioTap capture exited', { pid: child.pid, code, signal });
          });
  }

  static async start(options: TapOptions): Promise<Tap> {
    if (!isAudioTapBuilt()) throw new AudioTapUnavailableError();

    const args = ['--capture'];
    if (options.pid !== undefined) {
      args.push('--pid', String(options.pid));
      if (options.exclude) args.push('--exclude');
      // Only meaningful for process loopback, where there is no mix format to inherit.
      args.push('--rate', String(DISCORD_AUDIO.sampleRate), '--channels', String(DISCORD_AUDIO.channels));
    } else {
      args.push('--device', options.deviceId ?? 'default');
    }
    args.push('--buffer-ms', String(options.bufferMs ?? config.capture.bufferMs));
    if (options.gainDb) args.push('--gain-db', String(options.gainDb));

    log.debug('spawning AudioTap', { args });
    const child = spawn(config.paths.audioTap, args, { windowsHide: true });
    log.debug('AudioTap process spawned', { pid: child.pid });

    // stdout is binary PCM, so every diagnostic comes back on stderr as one JSON object per line.
    const events = createInterface({ input: child.stderr });
    let tap: Tap | undefined;
    let format: RawFormat | undefined;
    let rejectStart: ((error: Error) => void) | undefined;

    events.on('line', (line) => {
      let parsed: { event: string; data: Record<string, unknown> };
      try {
        parsed = JSON.parse(line);
      } catch {
        log.debug(`AudioTap: ${line}`);
        return;
      }

      switch (parsed.event) {
        case 'format':
          format = parsed.data as unknown as RawFormat;
          break;
        case 'stats':
          if (tap) tap.#stats = parsed.data as unknown as TapStats;
          break;
        case 'error': {
          const error = new Error(`AudioTap: ${String(parsed.data['message'])}`);
          if (rejectStart) rejectStart(error);
          else tap?.stream.emit('error', error);
          break;
        }
        default:
          log.debug(`AudioTap ${parsed.event}`, parsed.data);
      }
    });

    // Resolve once the tap reports its negotiated format, which happens before any PCM flows.
    const started = new Promise<RawFormat>((resolve, reject) => {
      rejectStart = reject;
      let timer: NodeJS.Timeout;
      const check = setInterval(() => {
        if (format) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(format);
        }
      }, 10);
      timer = setTimeout(() => {
        clearInterval(check);
        child.kill();
        reject(new Error('AudioTap did not report a capture format within 10s'));
      }, 10_000);
      child.once('close', (code) => {
        clearInterval(check);
        clearTimeout(timer);
        if (!format) reject(new Error(`AudioTap exited ${code} before reporting a format`));
      });
      child.once('error', (error) => {
        clearInterval(check);
        clearTimeout(timer);
        reject(error);
      });
    });

    let negotiated: RawFormat;
    try {
      negotiated = await started;
    } catch (error) {
      events.close();
      if (child.exitCode === null) child.kill();
      log.error('AudioTap capture failed during startup', error);
      throw error;
    }
    rejectStart = undefined;
    log.info('capture started', { pid: child.pid, ...negotiated });

    tap = new Tap(child, negotiated);
    return tap;
  }

  get stats(): TapStats | null {
    return this.#stats;
  }

  setGain(db: number): void {
    if (this.#closed) return;
    log.info('updating AudioTap gain', { pid: this.#child.pid, db });
    this.#child.stdin.write(`gain ${db}\n`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    log.debug('stopping AudioTap capture', { pid: this.#child.pid });

    // "quit" lets it stop the WASAPI client cleanly; the kill is only a backstop.
    try {
      this.#child.stdin.write('quit\n');
      this.#child.stdin.end();
    } catch {
      /* already gone */
    }

    const timer = setTimeout(() => this.#child.kill(), 2_000);
    try {
      await this.#exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
