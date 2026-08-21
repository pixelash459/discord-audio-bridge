import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { config, DISCORD_AUDIO } from '../config.ts';
import { logger } from '../logger.ts';

const log = logger('tap');

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
    const child = spawn(config.paths.audioTap, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`AudioTap ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`AudioTap exited ${code}: ${stderr.trim() || '(no output)'}`));
    });
  });
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

  private constructor(child: ChildProcessWithoutNullStreams, format: RawFormat) {
    this.#child = child;
    this.format = format;
    this.stream = child.stdout;
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
      const check = setInterval(() => {
        if (format) {
          clearInterval(check);
          resolve(format);
        }
      }, 10);
      const timer = setTimeout(() => {
        clearInterval(check);
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

    const negotiated = await started;
    rejectStart = undefined;
    log.info('capture started', negotiated);

    tap = new Tap(child, negotiated);
    return tap;
  }

  get stats(): TapStats | null {
    return this.#stats;
  }

  setGain(db: number): void {
    if (this.#closed) return;
    this.#child.stdin.write(`gain ${db}\n`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    // "quit" lets it stop the WASAPI client cleanly; the kill is only a backstop.
    try {
      this.#child.stdin.write('quit\n');
      this.#child.stdin.end();
    } catch {
      /* already gone */
    }

    const exited = once(this.#child, 'close');
    const timer = setTimeout(() => this.#child.kill(), 2_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
