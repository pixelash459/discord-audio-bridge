import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { config, DISCORD_AUDIO } from '../config.ts';
import { logger } from '../logger.ts';
import type { RawFormat } from './tap.ts';

const log = logger('opus');
const encoderChildren = new Set<ChildProcessWithoutNullStreams>();

export interface DshowFormat {
  sampleRate: number;
  bits: number;
  channels: number;
}

export type EncoderInput =
  | { kind: 'pipe'; format: RawFormat }
  | { kind: 'dshow'; name: string; format?: DshowFormat };

export interface EncoderOptions {
  input: EncoderInput;
  /** Opus target bitrate in bits per second. */
  bitrate: number;
  vbr?: 'off' | 'on' | 'constrained';
  complexity?: number;
  /** Only applied for inputs the tap cannot pre-scale (i.e. dshow). */
  gainDb?: number;
}

export interface DshowDevice {
  name: string;
  alternativeName?: string;
}

/**
 * Builds the ffmpeg command line.
 *
 * The important decisions, in order of how much they matter:
 *
 *  - `-page_duration 20000`. The Ogg muxer defaults to one-second pages, which would hold ~50
 *    Opus packets hostage before flushing anything. Discord's player would starve, declare the
 *    resource dead and stop. One page per 20ms packet keeps the stream continuous.
 *  - `-f f32le` in, `libopus` out, and nothing lossy in between. libopus accepts float natively,
 *    so the samples go from the Windows audio engine into the encoder without a 16-bit round trip
 *    and without any risk of clipping intersample peaks.
 *  - `-application audio` and `-compression_level 10`: the music-oriented Opus mode at maximum
 *    encoder effort.
 *  - `soxr` resampling, and only when the source is genuinely not 48kHz. Opus is a 48kHz codec,
 *    so a resample is unavoidable for a 44.1kHz source - this makes it a good one.
 */
export function buildArgs(options: EncoderOptions): string[] {
  const { input, bitrate } = options;
  const vbr = options.vbr ?? config.opus.vbr;
  const complexity = options.complexity ?? config.opus.complexity;

  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-nostats'];

  let sourceRate: number = DISCORD_AUDIO.sampleRate;
  let sourceChannels: number = DISCORD_AUDIO.channels;

  if (input.kind === 'pipe') {
    sourceRate = input.format.sampleRate;
    sourceChannels = input.format.channels;
    args.push(
      '-f', input.format.sampleFormat,
      '-ar', String(sourceRate),
      '-ac', String(sourceChannels),
      '-i', 'pipe:0',
    );
  } else {
    args.push('-f', 'dshow', '-audio_buffer_size', '50');

    // DirectShow negotiates whatever it feels like unless told otherwise, and its default is
    // rarely the device's best. Virtual cables in particular advertise a ladder that tops out
    // well below 48kHz float, so pinning the best rung is worth a probe.
    if (input.format) {
      sourceRate = input.format.sampleRate;
      sourceChannels = input.format.channels;
      args.push(
        '-sample_rate', String(input.format.sampleRate),
        '-sample_size', String(input.format.bits),
        '-channels', String(input.format.channels),
      );
    }

    args.push('-i', `audio=${input.name}`);
  }

  const filters: string[] = [];
  if (sourceRate !== DISCORD_AUDIO.sampleRate) {
    filters.push(
      `aresample=resampler=soxr:precision=28:osf=fltp:osr=${DISCORD_AUDIO.sampleRate}:dither_method=triangular`,
    );
  }
  if (sourceChannels !== DISCORD_AUDIO.channels) {
    filters.push('aformat=channel_layouts=stereo');
  }
  if (options.gainDb) {
    filters.push(`volume=${options.gainDb}dB`);
  }
  if (filters.length > 0) args.push('-af', filters.join(','));

  args.push(
    '-c:a', 'libopus',
    '-application', 'audio',
    '-b:a', String(bitrate),
    '-vbr', vbr,
    '-compression_level', String(complexity),
    '-frame_duration', String(DISCORD_AUDIO.frameDurationMs),
    '-packet_loss', '0',
    '-fec', '0',
    '-ar', String(DISCORD_AUDIO.sampleRate),
    '-ac', String(DISCORD_AUDIO.channels),
    '-f', 'ogg',
    '-page_duration', '20000',
    '-flush_packets', '1',
    'pipe:1',
  );

  return args;
}

/** A running ffmpeg encoder. `stream` is Ogg-encapsulated Opus, ready for @discordjs/voice. */
export class OpusEncoder {
  readonly stream: Readable;
  readonly args: string[];

  #child: ChildProcessWithoutNullStreams;
  #closed = false;
  #exited: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams, args: string[]) {
    this.#child = child;
    this.args = args;
    this.stream = child.stdout;
    this.#exited =
      child.exitCode !== null
        ? Promise.resolve()
        : once(child, 'close').then(([code, signal]) => {
            const details = { pid: child.pid, code, signal };
            if (this.#closed || code === 0) log.info('ffmpeg exited', details);
            else log.warn('ffmpeg exited unexpectedly', details);
          });
  }

  static start(options: EncoderOptions, pcm?: Readable): OpusEncoder {
    const args = buildArgs(options);
    log.debug('spawning ffmpeg', { args });

    const child = spawn(config.paths.ffmpeg, args, { windowsHide: true });
    encoderChildren.add(child);
    child.once('close', () => encoderChildren.delete(child));
    log.debug('ffmpeg process spawned', { pid: child.pid });

    const lines = createInterface({ input: child.stderr });
    lines.on('line', (line) => {
      if (/error|failed|invalid|no such/i.test(line)) log.error(line);
      else log.debug(line);
    });

    child.on('error', (error) => {
      log.error('ffmpeg failed to start', error);
      child.stdout.emit('error', error);
    });

    if (pcm) {
      pcm.pipe(child.stdin);
      // The tap is a real-time source: if ffmpeg dies we want the error surfaced, not an EPIPE
      // crash from a write into a closed pipe.
      child.stdin.on('error', () => pcm.unpipe(child.stdin));
    }

    return new OpusEncoder(child, args);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    log.debug('stopping ffmpeg', { pid: this.#child.pid });

    if (this.#child.exitCode === null) this.#child.kill('SIGTERM');
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 2_000);
    try {
      await this.#exited;
    } catch {
      /* already gone */
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Asks a DirectShow device what it can actually do, and picks the best rung.
 *
 * Preference order is stereo first, then sample rate, then bit depth: for music, losing a channel
 * costs far more than losing a few kHz. Returns null if the device refuses to enumerate, in which
 * case ffmpeg is left to negotiate on its own.
 *
 * Worth running because virtual audio cables are usually the weakest link. VB-Audio Voicemeeter's
 * outputs, for instance, advertise nothing above 16-bit/44.1kHz — so a dshow capture of one cannot
 * reach the 48kHz float that a per-process tap gets for free.
 */
export async function probeDshowFormat(name: string): Promise<DshowFormat | null> {
  const args = ['-hide_banner', '-f', 'dshow', '-list_options', 'true', '-i', `audio=${name}`];
  const started = performance.now();
  log.debug('probing DirectShow format', { name });
  const child = spawn(config.paths.ffmpeg, args, { windowsHide: true });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  child.on('error', () => undefined);

  await once(child, 'close');

  const options: DshowFormat[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = /ch=\s*(\d+),\s*bits=\s*(\d+),\s*rate=\s*(\d+)/.exec(line);
    if (match) {
      options.push({
        channels: Number(match[1]),
        bits: Number(match[2]),
        sampleRate: Number(match[3]),
      });
    }
  }

  if (options.length === 0) {
    log.warn('DirectShow device reported no usable formats', { name });
    return null;
  }

  options.sort((a, b) => score(b) - score(a));
  const selected = options[0]!;
  log.debug('DirectShow format probe completed', {
    name,
    selected,
    options: options.length,
    durationMs: Math.round(performance.now() - started),
  });
  return selected;
}

/**
 * Ranks one rung of a DirectShow format ladder for our specific purpose.
 *
 * The ordering that matters is *not* "biggest numbers win". Opus is a 48 kHz codec, so a device
 * offering 48 kHz beats the same device offering 96 kHz: the higher rate buys nothing and costs a
 * resample. Beyond that, stereo dominates everything, and above 16 bits is irrelevant because the
 * quantisation noise is already far below what Opus itself contributes at these bitrates.
 */
function score(format: DshowFormat): number {
  const stereo = format.channels === 2 ? 1_000_000 : 0;

  const rate =
    format.sampleRate === DISCORD_AUDIO.sampleRate
      ? 100_000 // exact match: no resampling at all
      : format.sampleRate > DISCORD_AUDIO.sampleRate
        ? 50_000 - (format.sampleRate - DISCORD_AUDIO.sampleRate) / 1_000 // downsampling is clean
        : format.sampleRate / 100; // upsampling never recovers what is missing

  return stereo + rate + Math.min(format.bits, 24);
}

/**
 * Enumerates DirectShow audio inputs. This is the escape hatch for machines without the .NET SDK:
 * pair it with a virtual cable (VB-CABLE) or "Stereo Mix" and no capture helper is needed.
 */
export async function listDshowDevices(): Promise<DshowDevice[]> {
  const args = ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
  const child = spawn(config.paths.ffmpeg, args, { windowsHide: true });
  const started = performance.now();

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));

  await once(child, 'close'); // this invocation always "fails"; the listing is the point

  const devices: DshowDevice[] = [];
  let current: DshowDevice | undefined;

  for (const line of stderr.split(/\r?\n/)) {
    const entry = /"([^"]+)"\s+\((audio|video)\)/.exec(line);
    if (entry) {
      current = entry[2] === 'audio' ? { name: entry[1]! } : undefined;
      if (current) devices.push(current);
      continue;
    }

    const alternative = /Alternative name\s+"([^"]+)"/.exec(line);
    if (alternative && current) current.alternativeName = alternative[1];
  }

  log.debug('DirectShow devices enumerated', {
    count: devices.length,
    durationMs: Math.round(performance.now() - started),
  });
  return devices;
}

/** Final shutdown backstop for an encoder orphaned by an unexpected pipeline failure. */
export async function closeAllEncoders(): Promise<void> {
  const children = [...encoderChildren];
  if (children.length === 0) return;
  log.warn('cleaning up remaining ffmpeg processes', { count: children.length });
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null) return;
      await Promise.race([once(child, 'close'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  );
}
