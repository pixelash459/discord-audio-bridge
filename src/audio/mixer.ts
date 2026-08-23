import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';

import { logger } from '../logger.ts';
import type { TapStats } from './tap.ts';

const log = logger('mixer');

const TICK_MS = 20;
/** Buffer beyond this much per input is drift, not jitter; the oldest audio is dropped. */
const DRIFT_CAP_MS = 240;
const METER_INTERVAL_MS = 200;
const SILENCE_FLOOR_DB = -100;

export interface MixerInput {
  /** Raw f32le at the mix format, already paced at real time by its own tap. */
  stream: Readable;
  label: string;
  gainDb?: number;
}

export interface MixerOptions {
  sampleRate: number;
  channels: number;
}

export interface MixInputStats {
  label: string;
  /** Buffered audio for this input, in ms. Persistently zero means the input is dead or silent. */
  bufferMs: number;
  /** Milliseconds this input has been silence-filled because it had nothing to give. */
  starvedMs: number;
  live: boolean;
  gainDb: number;
}

interface Lane {
  label: string;
  stream: Readable;
  chunks: Buffer[];
  buffered: number;
  carry?: Buffer;
  gain: number;
  gainDb: number;
  starvedBytes: number;
  live: boolean;
}

/**
 * Sums several already-paced capture streams into one.
 *
 * Every input arrives at exactly real time - AudioTap's PacedWriter does that on Windows and the
 * Pacer does it on Linux - so this stage does not need a clock of its own to be correct, only to be
 * regular. It takes the same slice from every lane on each tick, sums in float, and treats a lane
 * with nothing to give as silence rather than stalling the whole mix behind it. That is the
 * behaviour that matters: pausing Spotify must not also mute the game.
 *
 * Float summing can exceed unity when several loud sources coincide. Nothing is clamped here - the
 * true-peak limiter in the encoder is the right place for that, and clipping in float is recoverable
 * until it reaches the encoder.
 */
export class Mixer extends EventEmitter {
  readonly stream = new PassThrough({ highWaterMark: 512 * 1024 });

  #lanes: Lane[];
  #frameBytes: number;
  #channels: number;
  #bytesPerMs: number;
  #tickBytes: number;
  #driftCapBytes: number;
  #timer: NodeJS.Timeout;
  #backpressured = false;
  #closed = false;
  #nextTickAt = performance.now();
  #lastMeterAt = performance.now();
  #windowPeak: number[];
  #windowSumSq: number[];
  #windowFrames = 0;
  #streamedMs = 0;
  #meterStats: TapStats;

  constructor(inputs: MixerInput[], options: MixerOptions) {
    super();
    this.#channels = options.channels;
    this.#frameBytes = options.channels * 4;
    this.#bytesPerMs = (options.sampleRate * options.channels * 4) / 1000;
    this.#tickBytes = this.#align(Math.round(TICK_MS * this.#bytesPerMs));
    this.#driftCapBytes = this.#align(Math.round(DRIFT_CAP_MS * this.#bytesPerMs));
    this.#windowPeak = new Array(options.channels).fill(0);
    this.#windowSumSq = new Array(options.channels).fill(0);
    this.#meterStats = {
      bufferMs: 0,
      targetMs: 0,
      streamedMs: 0,
      paddedMs: 0,
      droppedMs: 0,
      trimmedMs: 0,
      primed: false,
      peakDb: new Array(options.channels).fill(SILENCE_FLOOR_DB),
      rmsDb: new Array(options.channels).fill(SILENCE_FLOOR_DB),
      clipping: false,
      silent: true,
    };

    this.#lanes = inputs.map((input) => {
      const gainDb = input.gainDb ?? 0;
      const lane: Lane = {
        label: input.label,
        stream: input.stream,
        chunks: [],
        buffered: 0,
        gain: Math.pow(10, gainDb / 20),
        gainDb,
        starvedBytes: 0,
        live: true,
      };

      input.stream.on('data', (chunk: Buffer) => this.#push(lane, chunk));
      input.stream.once('error', (error: Error) => this.#retire(lane, error.message));
      input.stream.once('end', () => this.#retire(lane, 'stream ended'));
      input.stream.once('close', () => {
        if (!input.stream.readableEnded) this.#retire(lane, 'stream closed');
      });
      return lane;
    });

    this.#nextTickAt = performance.now() + TICK_MS;
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
  }

  get stats(): MixInputStats[] {
    return this.#lanes.map((lane) => ({
      label: lane.label,
      bufferMs: Math.round(lane.buffered / this.#bytesPerMs),
      starvedMs: Math.round(lane.starvedBytes / this.#bytesPerMs),
      live: lane.live,
      gainDb: lane.gainDb,
    }));
  }

  /** Meter for the summed signal, after lane gains and before ffmpeg's limiter/encoder. */
  get meter(): TapStats {
    return this.#meterStats;
  }

  setGain(index: number, db: number): void {
    const lane = this.#lanes[index];
    if (!lane) throw new RangeError(`No mixer input at position ${index}.`);
    // Public master and lane trims are each constrained to -60..+20 dB. Their effective sum can
    // therefore reach -120..+40 dB, which is valid in float and is limited before encoding.
    if (!Number.isFinite(db) || db < -120 || db > 40) {
      throw new RangeError('Combined mixer gain must be between -120 and +40 dB.');
    }
    lane.gainDb = db;
    lane.gain = Math.pow(10, db / 20);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.stream.end();
    for (const lane of this.#lanes) lane.stream.destroy();
  }

  #align(bytes: number): number {
    return bytes - (bytes % this.#frameBytes);
  }

  /** A lane that dies becomes permanent silence; the mix only fails when every lane has gone. */
  #retire(lane: Lane, reason: string): void {
    if (!lane.live) return;
    lane.live = false;
    lane.chunks = [];
    lane.buffered = 0;
    log.warn(`mixer input stopped: ${lane.label} (${reason})`);
    this.emit('inputEnded', lane.label, reason);

    if (this.#lanes.every((candidate) => !candidate.live) && !this.#closed) {
      this.#closed = true;
      clearInterval(this.#timer);
      this.stream.destroy(new Error(`every mixer input stopped (last: ${lane.label} - ${reason})`));
    }
  }

  #push(lane: Lane, raw: Buffer): void {
    if (this.#closed || !lane.live) return;

    // Pipes split at arbitrary byte boundaries; only whole frames may enter the queue or a later
    // partial take would rotate the channel order for the rest of the session.
    let chunk = lane.carry ? Buffer.concat([lane.carry, raw]) : raw;
    lane.carry = undefined;
    const remainder = chunk.length % this.#frameBytes;
    if (remainder !== 0) {
      lane.carry = Buffer.from(chunk.subarray(chunk.length - remainder));
      chunk = chunk.subarray(0, chunk.length - remainder);
    }
    if (chunk.length === 0) return;

    lane.chunks.push(chunk);
    lane.buffered += chunk.length;

    while (lane.buffered > this.#driftCapBytes && lane.chunks.length > 0) {
      const head = lane.chunks[0]!;
      const excess = lane.buffered - this.#driftCapBytes;
      if (head.length <= excess) {
        lane.chunks.shift();
        lane.buffered -= head.length;
      } else {
        lane.chunks[0] = head.subarray(excess);
        lane.buffered -= excess;
      }
    }
  }

  #tick(): void {
    if (this.#closed || this.#backpressured) return;

    const now = performance.now();
    if (now - this.#nextTickAt > 500) this.#nextTickAt = now;

    while (now >= this.#nextTickAt) {
      this.#nextTickAt += TICK_MS;
      this.#emit();
      if (this.#backpressured) break;
    }
  }

  #emit(): void {
    const out = Buffer.alloc(this.#tickBytes);
    const sum = new Float32Array(out.buffer, out.byteOffset, this.#tickBytes >> 2);

    for (const lane of this.#lanes) {
      if (!lane.live) continue;
      const taken = this.#take(lane, this.#tickBytes);
      if (taken.length === 0) {
        lane.starvedBytes += this.#tickBytes;
        continue;
      }
      if (taken.length < this.#tickBytes) lane.starvedBytes += this.#tickBytes - taken.length;

      const samples = new Float32Array(taken.buffer, taken.byteOffset, taken.length >> 2);
      const gain = lane.gain;
      for (let i = 0; i < samples.length; i++) sum[i]! += samples[i]! * gain;
    }

    this.#measure(sum);
    this.#streamedMs += TICK_MS;

    this.#backpressured = !this.stream.write(out);
    if (this.#backpressured) {
      this.stream.once('drain', () => {
        this.#backpressured = false;
        // Do not replay everything missed while downstream was blocked as one burst.
        this.#nextTickAt = performance.now() + TICK_MS;
      });
    }
  }

  #measure(samples: Float32Array): void {
    for (let index = 0; index < samples.length; index++) {
      const value = samples[index]!;
      const channel = index % this.#channels;
      const magnitude = Math.abs(value);
      if (magnitude > this.#windowPeak[channel]!) this.#windowPeak[channel] = magnitude;
      this.#windowSumSq[channel]! += value * value;
    }
    this.#windowFrames += samples.length / this.#channels;

    const now = performance.now();
    if (now - this.#lastMeterAt < METER_INTERVAL_MS) return;
    this.#lastMeterAt = now;

    const peakDb: number[] = [];
    const rmsDb: number[] = [];
    let clipping = false;
    let silent = this.#windowFrames === 0;
    for (let channel = 0; channel < this.#channels; channel++) {
      const peak = this.#windowPeak[channel]!;
      const meanSquare = this.#windowFrames > 0 ? this.#windowSumSq[channel]! / this.#windowFrames : 0;
      peakDb.push(Math.max(20 * Math.log10(Math.max(peak, 1e-5)), SILENCE_FLOOR_DB));
      rmsDb.push(Math.max(20 * Math.log10(Math.max(Math.sqrt(meanSquare), 1e-5)), SILENCE_FLOOR_DB));
      if (peak >= 1) clipping = true;
      if (peak >= 1e-5) silent = false;
    }

    this.#meterStats = {
      bufferMs: this.#lanes.length
        ? this.#lanes.reduce((sum, lane) => sum + lane.buffered / this.#bytesPerMs, 0) / this.#lanes.length
        : 0,
      targetMs: 0,
      streamedMs: this.#streamedMs,
      paddedMs: Math.max(0, ...this.#lanes.map((lane) => lane.starvedBytes / this.#bytesPerMs)),
      droppedMs: 0,
      trimmedMs: 0,
      primed: this.#lanes.some((lane) => lane.live),
      peakDb,
      rmsDb,
      clipping,
      silent,
    };
    this.#windowPeak.fill(0);
    this.#windowSumSq.fill(0);
    this.#windowFrames = 0;
  }

  /** Returns up to `wanted` bytes from a lane, always 4-byte aligned and never pooled. */
  #take(lane: Lane, wanted: number): Buffer {
    if (lane.buffered === 0) return Buffer.alloc(0);

    const size = Math.min(wanted, lane.buffered);
    // allocUnsafeSlow keeps the result off the shared pool, so its byteOffset is 0 and a
    // Float32Array view over it is always correctly aligned.
    const out = Buffer.allocUnsafeSlow(size);
    let written = 0;

    while (written < size) {
      const head = lane.chunks[0]!;
      const needed = size - written;
      if (head.length <= needed) {
        head.copy(out, written);
        written += head.length;
        lane.chunks.shift();
      } else {
        head.copy(out, written, 0, needed);
        lane.chunks[0] = head.subarray(needed);
        written += needed;
      }
    }

    lane.buffered -= size;
    return out;
  }
}
