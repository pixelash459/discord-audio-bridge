import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';

import { config } from '../config.ts';
import { logger } from '../logger.ts';

const log = logger('preview');

/**
 * Beyond this much unwritten audio the player is not keeping up, so newer packets are dropped
 * rather than queued. A monitor that lags further and further behind is worse than one with a gap.
 */
const MAX_PENDING_BYTES = 512 * 1024;

/**
 * Local monitoring: hear exactly what the voice channel hears.
 *
 * Until now the only way to check a stream was to join the channel from a second account, which
 * means the one question people actually ask - "does this sound right?" - could not be answered
 * from the machine doing the streaming. This taps the *encoder output*, so what plays back has been
 * through the gain stage, the limiter, and a real libopus round trip. Monitoring the source instead
 * would prove nothing: the source is already audible, and everything that can go wrong happens
 * downstream of it.
 *
 * The tee is deliberately lossy. It observes the same chunks the voice connection receives, never
 * takes them, and drops rather than buffers when the player falls behind - the live stream must not
 * be able to stutter because a monitoring window is busy.
 */
export class Preview {
  #child: ChildProcessWithoutNullStreams | undefined;
  #source: Readable | undefined;
  #listener: ((chunk: Buffer) => void) | undefined;
  #pending = 0;
  #dropped = 0;
  #closed = false;

  get running(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null;
  }

  /** Bytes discarded because the player could not keep up. Non-zero is a slow machine, not a bug. */
  get droppedBytes(): number {
    return this.#dropped;
  }

  /**
   * Starts playback of `stream`, an Ogg/Opus feed straight from the encoder.
   *
   * ffplay is part of every full ffmpeg build but is occasionally packaged separately, so a missing
   * binary produces an explanation rather than a stack trace.
   */
  start(stream: Readable): void {
    if (this.#closed) throw new Error('This preview has already been closed.');
    if (this.running) {
      this.attach(stream);
      return;
    }

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-nodisp',
      '-autoexit',
      // Keep the monitor close to real time; a growing queue here is latency, not safety.
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-f', 'ogg',
      '-i', 'pipe:0',
    ];

    log.debug('starting local preview', { player: config.paths.ffplay });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.paths.ffplay, args, { windowsHide: true });
    } catch (error) {
      throw new Error(
        `Could not start the local preview player (${config.paths.ffplay}). It ships with a full ` +
          'ffmpeg build; set FFPLAY_PATH if yours lives elsewhere.',
        { cause: error },
      );
    }

    child.on('error', (error) => {
      log.warn('local preview player failed to start', error);
      this.stop();
    });
    child.stdin.on('error', () => {
      // The player exited, or the pipe closed under us. Tearing down is the whole response.
      this.stop();
    });
    child.stderr.on('data', (chunk: Buffer) => log.debug(`ffplay: ${chunk.toString().trim()}`));
    child.once('close', (code) => {
      log.info('local preview stopped', { code, droppedBytes: this.#dropped });
      this.#child = undefined;
      this.#detach();
    });

    this.#child = child;
    this.attach(stream);
    log.info('local preview started');
  }

  /** Points the tee at a new encoder, as happens whenever the pipeline is rebuilt. */
  attach(stream: Readable): void {
    if (!this.running || stream === this.#source) return;
    this.#detach();

    const child = this.#child!;
    const listener = (chunk: Buffer) => {
      if (!this.running) return;

      if (this.#pending > MAX_PENDING_BYTES) {
        this.#dropped += chunk.length;
        return;
      }

      this.#pending += chunk.length;
      // The callback form is what makes this safe: the live stream is never asked to wait, and the
      // only consequence of a slow player is a dropped chunk here.
      child.stdin.write(chunk, () => {
        this.#pending -= chunk.length;
      });
    };

    // An extra 'data' listener observes the same chunks the voice connection is already being
    // piped; it does not consume them.
    stream.on('data', listener);
    this.#source = stream;
    this.#listener = listener;
  }

  #detach(): void {
    if (this.#source && this.#listener) this.#source.off('data', this.#listener);
    this.#source = undefined;
    this.#listener = undefined;
    this.#pending = 0;
  }

  stop(): void {
    this.#detach();
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null) return;

    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    child.kill();
  }

  close(): void {
    this.#closed = true;
    this.stop();
  }
}
