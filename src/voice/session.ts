import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';

import { config, DISCORD_AUDIO } from '../config.ts';
import { logger } from '../logger.ts';
import { OpusEncoder, probeDshowFormat, type DshowFormat, type EncoderInput } from '../audio/encoder.ts';
import { Tap, type TapStats } from '../audio/tap.ts';

const log = logger('session');

export type SourceSpec =
  | { kind: 'process'; pid: number; label: string; exclude: boolean }
  | { kind: 'device'; id: string; label: string }
  | { kind: 'dshow'; name: string; label: string };

export interface SessionStatus {
  guildId: string;
  channelId: string;
  channelName: string;
  source: SourceSpec;
  bitrate: number;
  vbr: string;
  complexity: number;
  captureFormat: string;
  /** Set when the capture path is a compromise, explaining what it costs. */
  qualityNote: string | null;
  playerState: string;
  connectionState: string;
  ping: number | null;
  uptimeMs: number;
  tap: TapStats | null;
  restarts: number;
}

/**
 * Explains, in plain terms, what a DirectShow device's best available format costs relative to the
 * per-process tap. Virtual cables routinely cap out below 48 kHz float, and that is worth saying
 * out loud rather than burying in a format string.
 */
function describeDshowCost(format: DshowFormat): string | null {
  const problems: string[] = [];

  if (format.channels < 2) problems.push('mono only');
  if (format.sampleRate !== DISCORD_AUDIO.sampleRate) {
    problems.push(`${format.sampleRate} Hz, so it must be resampled to 48 kHz for Opus`);
  }
  // 16-bit is deliberately not a complaint: ~96 dB of headroom is already well under the noise
  // Opus itself adds at these bitrates. Only genuinely lossy depths are worth flagging.
  if (format.bits < 16) problems.push(`${format.bits}-bit`);

  const routing =
    'Whatever feeds this device has already been through another app, which is where quality ' +
    'usually goes missing. `/stream app` taps the source directly at 48 kHz float.';

  return problems.length === 0 ? routing : `Best available format is ${problems.join('; ')}. ${routing}`;
}

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * One guild's bridge: a WASAPI tap feeding an ffmpeg/libopus encoder feeding a Discord voice
 * connection. Owns the lifetime of all three and rebuilds the audio half if it dies underneath us.
 */
export class BridgeSession {
  readonly guildId: string;
  readonly channelId: string;
  readonly channelName: string;

  #connection: VoiceConnection;
  #player: AudioPlayer;
  #source: SourceSpec;
  #bitrate: number;
  #gainDb: number;

  #tap: Tap | null = null;
  #encoder: OpusEncoder | null = null;
  #captureFormat = 'starting';
  #qualityNote: string | null = null;
  #startedAt = Date.now();
  #restarts = 0;
  #restarting = false;
  #destroyed = false;

  private constructor(channel: VoiceBasedChannel, connection: VoiceConnection, source: SourceSpec, bitrate: number, gainDb: number) {
    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.channelName = channel.name;
    this.#connection = connection;
    this.#source = source;
    this.#bitrate = bitrate;
    this.#gainDb = gainDb;

    this.#player = createAudioPlayer({
      behaviors: {
        // Keep streaming even with nobody listening, so /status stays honest and rejoining a
        // channel does not require restarting the capture.
        noSubscriber: NoSubscriberBehavior.Play,
        // 20ms per frame: tolerate ~10s of upstream trouble before declaring the resource dead.
        maxMissedFrames: 500,
      },
    });

    connection.subscribe(this.#player);
    this.#wireConnection();
    this.#wirePlayer();
  }

  static async create(
    channel: VoiceBasedChannel,
    source: SourceSpec,
    options: { bitrate: number; gainDb?: number },
  ): Promise<BridgeSession> {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      connection.destroy();
      throw new Error(
        `Could not connect to ${channel.name} within 20s. ` +
          `Check that the bot has Connect and Speak permissions on that channel.`,
        { cause: error },
      );
    }

    const session = new BridgeSession(channel, connection, source, options.bitrate, options.gainDb ?? 0);
    await session.#startAudio();
    return session;
  }

  get source(): SourceSpec {
    return this.#source;
  }

  get bitrate(): number {
    return this.#bitrate;
  }

  /** Rebuilds the audio pipeline against a new source without leaving the channel. */
  async setSource(source: SourceSpec): Promise<void> {
    this.#source = source;
    this.#restarts = 0;
    await this.#stopAudio();
    await this.#startAudio();
  }

  /** Re-encodes at a new bitrate. Requires an encoder restart; the connection is untouched. */
  async setBitrate(bitrate: number): Promise<void> {
    this.#bitrate = bitrate;
    await this.#stopAudio();
    await this.#startAudio();
  }

  /**
   * Applied inside the tap when possible, which is before any format conversion and therefore
   * free. dshow sources have no tap, so they need a full restart to change the ffmpeg filter.
   */
  async setGain(db: number): Promise<void> {
    this.#gainDb = db;
    if (this.#tap) {
      this.#tap.setGain(db);
      return;
    }
    await this.#stopAudio();
    await this.#startAudio();
  }

  status(): SessionStatus {
    return {
      guildId: this.guildId,
      channelId: this.channelId,
      channelName: this.channelName,
      source: this.#source,
      bitrate: this.#bitrate,
      vbr: config.opus.vbr,
      complexity: config.opus.complexity,
      captureFormat: this.#captureFormat,
      qualityNote: this.#qualityNote,
      playerState: this.#player.state.status,
      connectionState: this.#connection.state.status,
      ping: this.#connection.ping.udp ?? null,
      uptimeMs: Date.now() - this.#startedAt,
      tap: this.#tap?.stats ?? null,
      restarts: this.#restarts,
    };
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;

    this.#player.stop(true);
    await this.#stopAudio();

    if (this.#connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.#connection.destroy();
    }
  }

  async #startAudio(): Promise<void> {
    if (this.#destroyed) return;

    let input: EncoderInput;
    let pcm: Tap['stream'] | undefined;

    if (this.#source.kind === 'dshow') {
      const probed = await probeDshowFormat(this.#source.name);
      input = { kind: 'dshow', name: this.#source.name, format: probed ?? undefined };

      if (probed) {
        this.#captureFormat = `${probed.sampleRate} Hz / ${probed.channels} ch / ${probed.bits}-bit`;
        this.#qualityNote = describeDshowCost(probed);
      } else {
        this.#captureFormat = 'dshow (format not reported)';
        this.#qualityNote = 'This device would not report its formats, so ffmpeg negotiated on its own.';
      }
    } else {
      const tap = await Tap.start(
        this.#source.kind === 'process'
          ? { pid: this.#source.pid, exclude: this.#source.exclude, gainDb: this.#gainDb }
          : { deviceId: this.#source.id, gainDb: this.#gainDb },
      );
      this.#tap = tap;
      pcm = tap.stream;
      input = { kind: 'pipe', format: tap.format };
      this.#captureFormat = `${tap.format.sampleRate} Hz / ${tap.format.channels} ch / ${tap.format.sampleFormat}`;
      this.#qualityNote =
        tap.format.sampleRate === DISCORD_AUDIO.sampleRate && tap.format.sampleFormat === 'f32le'
          ? null
          : `Capturing at ${tap.format.sampleRate} Hz ${tap.format.sampleFormat} rather than 48 kHz float, ` +
            'so ffmpeg has to convert. Set this endpoint to 48 kHz in Windows sound settings.';
    }

    const encoder = OpusEncoder.start(
      {
        input,
        bitrate: this.#bitrate,
        // A dshow source never passes through the tap, so gain has to happen in ffmpeg instead.
        gainDb: this.#source.kind === 'dshow' ? this.#gainDb : 0,
      },
      pcm,
    );
    this.#encoder = encoder;

    const resource: AudioResource = createAudioResource(encoder.stream, {
      inputType: StreamType.OggOpus,
      // Critical: inline volume would decode and re-encode every packet, turning a
      // pass-through into a second lossy generation. Gain is handled upstream instead.
      inlineVolume: false,
    });

    encoder.stream.once('error', (error: Error) => {
      log.error('encoder stream error', error);
      void this.#restartAudio();
    });

    this.#player.play(resource);
    this.#startedAt = Date.now();
    log.info(`streaming ${this.#source.label} at ${Math.round(this.#bitrate / 1000)} kbps`, {
      guild: this.guildId,
      capture: this.#captureFormat,
    });
  }

  async #stopAudio(): Promise<void> {
    const [tap, encoder] = [this.#tap, this.#encoder];
    this.#tap = null;
    this.#encoder = null;

    // Encoder first: closing it releases the pipe the tap is writing into.
    await encoder?.close();
    await tap?.close();
  }

  async #restartAudio(): Promise<void> {
    if (this.#destroyed || this.#restarting) return;
    this.#restarting = true;

    try {
      if (this.#restarts >= MAX_RESTART_ATTEMPTS) {
        log.error(`giving up after ${this.#restarts} restarts`, { guild: this.guildId });
        await this.destroy();
        return;
      }

      const delay = RESTART_BACKOFF_MS[Math.min(this.#restarts, RESTART_BACKOFF_MS.length - 1)]!;
      this.#restarts += 1;
      log.warn(`restarting audio pipeline (attempt ${this.#restarts}) in ${delay}ms`);

      await this.#stopAudio();
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.#destroyed) return;
      await this.#startAudio();
    } catch (error) {
      log.error('restart failed', error);
    } finally {
      this.#restarting = false;
    }
  }

  #wirePlayer(): void {
    this.#player.on('error', (error) => {
      log.error('player error', error);
      void this.#restartAudio();
    });

    this.#player.on(AudioPlayerStatus.Idle, () => {
      // A live source should never end. If it does, ffmpeg or the tap died.
      if (this.#destroyed) return;
      log.warn('audio resource ended unexpectedly');
      void this.#restartAudio();
    });

    this.#player.on(AudioPlayerStatus.Playing, () => {
      // Reaching Playing means packets are flowing; forgive the earlier failures.
      this.#restarts = 0;
    });
  }

  #wireConnection(): void {
    // The documented reconnect dance: a Disconnected connection is either moving to another
    // channel (recoverable) or genuinely gone (not).
    this.#connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.#connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.#connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        log.warn('voice connection lost for good, tearing down', { guild: this.guildId });
        await this.destroy();
      }
    });

    this.#connection.on('error', (error) => log.error('voice connection error', error));
  }
}

const sessions = new Map<string, BridgeSession>();

export function getSession(guildId: string): BridgeSession | undefined {
  return sessions.get(guildId);
}

export function allSessions(): BridgeSession[] {
  return [...sessions.values()];
}

/**
 * The single entry point for starting a stream, shared by the slash commands and the control API.
 * Retargeting an existing session in the same channel keeps the voice connection alive, which is
 * both faster and less disruptive than leaving and rejoining.
 */
export async function startOrRetarget(
  channel: VoiceBasedChannel,
  source: SourceSpec,
  bitrate: number,
): Promise<BridgeSession> {
  const existing = sessions.get(channel.guild.id);

  if (existing && existing.channelId === channel.id) {
    await existing.setSource(source);
    if (existing.bitrate !== bitrate) await existing.setBitrate(bitrate);
    return existing;
  }

  if (existing) await endSession(channel.guild.id);

  const session = await BridgeSession.create(channel, source, { bitrate });
  sessions.set(session.guildId, session);
  return session;
}

export function setSession(session: BridgeSession): void {
  sessions.set(session.guildId, session);
}

export async function endSession(guildId: string): Promise<boolean> {
  const session = sessions.get(guildId);
  if (!session) return false;
  sessions.delete(guildId);
  await session.destroy();
  return true;
}

export async function endAllSessions(): Promise<void> {
  await Promise.allSettled([...sessions.keys()].map((id) => endSession(id)));
}
