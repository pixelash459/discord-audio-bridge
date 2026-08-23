import { PassThrough, type Readable } from 'node:stream';

import type { TapStats } from './tap.ts';

export interface PacerOptions {
  sampleRate: number;
  channels: number;
  /** Jitter-buffer target in ms; the pacer waits for this much before declaring itself primed. */
  targetMs: number;
}

const TICK_MS = 20;
const STATS_INTERVAL_MS = 500;
/** The pacing clock may lag this far behind before it stops catching up and resynchronises. */
const MAX_CATCHUP_MS = 500;
/** Trim buffered audio beyond target + this, which is what a drifting source clock produces. */
const DRIFT_MARGIN_MS = 250;
/** Anything quieter than this (dBFS) counts as digital silence in the stats. */
const SILENCE_FLOOR_DB = -100;

/**
 * Turns a capture process that only produces data while the source is audible into a perfectly
 * real-time stream that never stalls: float PCM in, float PCM out at exactly one second per
 * second, silence filled whenever the buffer runs dry, and oldest-first trimming whenever the
 * buffer drifts above its target.
 *
 * On Windows, AudioTap's PacedWriter does this job inside the capture helper. On Linux the
 * helper is stock `pw-record`, which has no pacing at all — PipeWire delivers bursts while the
 * target app renders and nothing at all while it is idle — so the same job happens here, in the
 * bot, before the samples reach ffmpeg. Metering rides along because every sample passes through.
 */
export class Pacer {
  readonly stream = new PassThrough({ highWaterMark: 256 * 1024 });

  #source: Readable;
  #bytesPerMs: number;
  #targetBytes: number;
  #driftCapBytes: number;
  #channels: number;
  #frameBytes: number;

  #chunks: Buffer[] = [];
  #buffered = 0;
  #carry: Buffer | undefined;
  #tickBytes: number;
  #nextTickAt = performance.now();
  #timer: NodeJS.Timeout;
  #backpressured = false;
  #closed = false;
  #primed = false;

  #gain = 1;

  // Stats window state: peaks and sums of squares per channel, reset each interval.
  #windowPeak: number[];
  #windowSumSq: number[];
  #windowFrames = 0;
  #lastStatsAt = performance.now();
  #paddedMs = 0;
  #trimmedMs = 0;
  #streamedMs = 0;
  #stats: TapStats;

  constructor(source: Readable, options: PacerOptions) {
    this.#source = source;
    this.#channels = options.channels;
    this.#frameBytes = options.channels * 4;
    // f32le in and out, so every frame is 4 bytes per channel.
    this.#bytesPerMs = (options.sampleRate * options.channels * 4) / 1000;
    this.#targetBytes =
      Math.round((options.targetMs * this.#bytesPerMs) / this.#frameBytes) * this.#frameBytes;
    this.#driftCapBytes =
      Math.round(
        ((options.targetMs + DRIFT_MARGIN_MS) * this.#bytesPerMs) / this.#frameBytes,
      ) * this.#frameBytes;
    this.#tickBytes =
      Math.round((TICK_MS * this.#bytesPerMs) / this.#frameBytes) * this.#frameBytes;
    this.#windowPeak = new Array<number>(options.channels).fill(0);
    this.#windowSumSq = new Array<number>(options.channels).fill(0);

    this.#stats = {
      bufferMs: 0,
      targetMs: options.targetMs,
      streamedMs: 0,
      paddedMs: 0,
      droppedMs: 0,
      trimmedMs: 0,
      primed: false,
      peakDb: new Array<number>(options.channels).fill(SILENCE_FLOOR_DB),
      rmsDb: new Array<number>(options.channels).fill(SILENCE_FLOOR_DB),
      clipping: false,
      silent: true,
    };

    source.on('data', (chunk: Buffer) => this.#push(chunk));
    source.once('error', (error: Error) => this.#fail(`capture stream failed: ${error.message}`));
    source.once('end', () => this.#fail('capture stream ended'));
    source.once('close', () => {
      if (!source.readableEnded) this.#fail('capture stream closed unexpectedly');
    });

    this.#nextTickAt = performance.now() + TICK_MS;
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
  }

  get stats(): TapStats {
    return this.#stats;
  }

  /** Live gain in dB, applied to float samples before anything else can touch them. */
  setGain(db: number): void {
    if (!Number.isFinite(db) || db < -60 || db > 20) throw new RangeError('Gain must be between -60 and +20 dB.');
    this.#gain = Math.pow(10, db / 20);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.stream.end();
    this.#source.destroy();
  }

  #push(raw: Buffer): void {
    if (this.#closed) return;
    // An OS pipe splits bytes at arbitrary boundaries, which can cut a multi-channel frame in
    // half. Stitch the carry back on and retain only complete frames so trimming never swaps the
    // left and right channels.
    let chunk = this.#carry ? Buffer.concat([this.#carry, raw]) : raw;
    this.#carry = undefined;
    const remainder = chunk.length % this.#frameBytes;
    if (remainder !== 0) {
      this.#carry = chunk.subarray(chunk.length - remainder);
      chunk = chunk.subarray(0, chunk.length - remainder);
    }
    if (chunk.length === 0) return;

    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    if (!this.#primed && this.#buffered >= this.#targetBytes) this.#primed = true;

    // A source clock running faster than real time (or a stall followed by a burst) grows the
    // buffer without bound; trimming the oldest audio keeps latency pinned at the target. This
    // is drift correction, not overrun handling — overruns cannot happen while we control pacing.
    if (this.#buffered > this.#driftCapBytes) {
      let excess = this.#buffered - this.#targetBytes;
      while (excess > 0 && this.#chunks.length > 0) {
        const head = this.#chunks[0]!;
        if (head.length <= excess) {
          excess -= head.length;
          this.#buffered -= head.length;
          this.#trimmedMs += head.length / this.#bytesPerMs;
          this.#chunks.shift();
        } else {
          this.#chunks[0] = head.subarray(excess);
          this.#buffered -= excess;
          this.#trimmedMs += excess / this.#bytesPerMs;
          excess = 0;
        }
      }
    }
  }

  #tick(): void {
    if (this.#closed || this.#backpressured) return;

    const now = performance.now();
    // A suspended machine or a starved event loop leaves the schedule far behind; catching up
    // would replay a burst of stale audio all at once. Resynchronise instead.
    if (now - this.#nextTickAt > MAX_CATCHUP_MS) this.#nextTickAt = now;

    while (now >= this.#nextTickAt) {
      this.#nextTickAt += TICK_MS;
      this.#emitTick();
      if (this.#backpressured) break;
    }

    if (now - this.#lastStatsAt >= STATS_INTERVAL_MS) {
      this.#lastStatsAt = now;
      this.#publishStats();
    }
  }

  #emitTick(): void {
    // Build the configured jitter reserve before consuming captured audio. Silence continues to
    // flow during priming so Discord never sees a gap. A later underrun re-enters this state.
    if (!this.#primed) {
      if (this.#buffered < this.#targetBytes) {
        this.#paddedMs += this.#tickBytes / this.#bytesPerMs;
        this.#write(Buffer.alloc(this.#tickBytes), false);
        return;
      }
      this.#primed = true;
    }

    let toWrite = this.#tickBytes;
    while (toWrite > 0) {
      if (this.#buffered === 0) {
        this.#primed = false;
        this.#paddedMs += toWrite / this.#bytesPerMs;
        this.#write(Buffer.alloc(toWrite), false);
        return;
      }

      const head = this.#chunks[0]!;
      if (head.length <= toWrite) {
        this.#chunks.shift();
        this.#buffered -= head.length;
        toWrite -= head.length;
        this.#write(head, true);
      } else {
        this.#chunks[0] = head.subarray(toWrite);
        this.#buffered -= toWrite;
        this.#write(head.subarray(0, toWrite), true);
        toWrite = 0;
      }
      if (this.#backpressured) return;
    }
  }

  #write(chunk: Buffer, meter: boolean): void {
    // The session attaches the error listener that turns this into a pipeline restart.
    if (this.#gain !== 1) chunk = this.#scale(chunk);
    if (meter) {
      this.#meter(chunk);
      this.#streamedMs += chunk.length / this.#bytesPerMs;
    }

    // Backpressure stops the clock until ffmpeg drains; the buffer upstream absorbs the pause
    // and the drift trim keeps it bounded, so no data is lost.
    this.#backpressured = !this.stream.write(chunk);
    if (this.#backpressured) {
      this.stream.once('drain', () => {
        this.#backpressured = false;
        // Do not replay every tick missed while downstream was blocked as one audio burst.
        this.#nextTickAt = performance.now() + TICK_MS;
      });
    }
  }

  #scale(chunk: Buffer): Buffer {
    const source = alignedCopy(chunk);
    const samples = new Float32Array(source.buffer, source.byteOffset, source.length >> 2);
    // Alignment is guaranteed by #push, but zero-initialising the tail keeps this helper safe if
    // a future caller ever passes a partial sample.
    const out = Buffer.alloc(chunk.length);
    const target = new Float32Array(out.buffer, 0, samples.length);
    for (let i = 0; i < samples.length; i++) target[i] = samples[i]! * this.#gain;
    return out;
  }

  #meter(chunk: Buffer): void {
    const source = chunk.byteOffset % 4 === 0 ? chunk : alignedCopy(chunk);
    const samples = new Float32Array(source.buffer, source.byteOffset, source.length >> 2);
    const channels = this.#channels;
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i]!;
      const magnitude = Math.abs(value);
      const channel = i % channels;
      if (magnitude > this.#windowPeak[channel]!) this.#windowPeak[channel] = magnitude;
      this.#windowSumSq[channel]! += value * value;
    }
    this.#windowFrames += samples.length / channels;
  }

  #publishStats(): void {
    const peakDb: number[] = [];
    const rmsDb: number[] = [];
    let clipping = false;
    let silent = this.#windowFrames === 0;

    for (let c = 0; c < this.#channels; c++) {
      const peak = this.#windowPeak[c]!;
      const meanSquare = this.#windowFrames > 0 ? this.#windowSumSq[c]! / this.#windowFrames : 0;
      // Floor the log inputs so digital silence reports as -100 dB rather than -Infinity.
      peakDb.push(Math.max(20 * Math.log10(Math.max(peak, 1e-5)), SILENCE_FLOOR_DB));
      rmsDb.push(Math.max(20 * Math.log10(Math.max(Math.sqrt(meanSquare), 1e-5)), SILENCE_FLOOR_DB));
      if (peak >= 1) clipping = true;
      if (peak >= 1e-5) silent = false;
    }

    this.#stats = {
      bufferMs: this.#buffered / this.#bytesPerMs,
      targetMs: this.#stats.targetMs,
      streamedMs: this.#streamedMs,
      paddedMs: this.#paddedMs,
      droppedMs: 0,
      trimmedMs: this.#trimmedMs,
      primed: this.#primed,
      peakDb,
      rmsDb,
      clipping,
      silent,
    };

    this.#windowPeak.fill(0);
    this.#windowSumSq.fill(0);
    this.#windowFrames = 0;
  }

  #fail(message: string): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    // destroy(err) surfaces the failure to the session's error listener, which restarts the
    // pipeline exactly as it does when AudioTap dies on Windows.
    this.stream.destroy(new Error(message));
    this.#source.destroy();
  }
}

/**
 * Float32Array demands a 4-byte-aligned base, and Node's buffer pool hands out chunks at
 * arbitrary offsets. Copying into a fresh (non-pooled, hence aligned) buffer is the cheap fix.
 */
function alignedCopy(chunk: Buffer): Buffer {
  const out = Buffer.allocUnsafeSlow(chunk.length);
  chunk.copy(out);
  return out;
}
