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
import { ChannelType, type VoiceBasedChannel } from 'discord.js';

import { config, DISCORD_AUDIO } from '../config.ts';
import { logger } from '../logger.ts';
import { OpusEncoder, probeDshowFormat, type DshowFormat, type EncoderInput } from '../audio/encoder.ts';
import { startCapture, type CaptureTap, type TapStats } from '../audio/tap.ts';
import { IS_WINDOWS } from '../platform.ts';

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
  bitrateCeiling: number;
  gainDb: number;
  muted: boolean;
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
const STABLE_PIPELINE_MS = 30_000;

/**
 * One guild's bridge: a WASAPI tap feeding an ffmpeg/libopus encoder feeding a Discord voice
 * connection. Owns the lifetime of all three and rebuilds the audio half if it dies underneath us.
 */
export class BridgeSession {
  readonly guildId: string;
  readonly channelId: string;
  readonly channelName: string;

  #connection: VoiceConnection;
  #channel: VoiceBasedChannel;
  #player: AudioPlayer;
  #source: SourceSpec;
  #bitrate: number;
  #gainDb: number;
  #muted = false;
  #mutation: Promise<void> = Promise.resolve();

  #tap: CaptureTap | null = null;
  #encoder: OpusEncoder | null = null;
  #captureFormat = 'starting';
  #qualityNote: string | null = null;
  #startedAt = Date.now();
  #restarts = 0;
  #restarting = false;
  #changingAudio = false;
  #destroyed = false;
  #stableTimer: NodeJS.Timeout | undefined;

  private constructor(channel: VoiceBasedChannel, connection: VoiceConnection, source: SourceSpec, bitrate: number, gainDb: number) {
    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.channelName = channel.name;
    this.#channel = channel;
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
    const started = performance.now();
    log.info('joining voice channel', {
      guild: channel.guild.id,
      channel: channel.id,
      channelName: channel.name,
      sourceKind: source.kind,
      bitrate: options.bitrate,
    });
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

    log.info('voice connection ready', {
      guild: channel.guild.id,
      channel: channel.id,
      durationMs: Math.round(performance.now() - started),
    });
    if (channel.type === ChannelType.GuildStageVoice) {
      try {
        await channel.guild.members.me?.voice.setSuppressed(false);
        log.info('bot promoted to speaker in Stage channel', {
          guild: channel.guild.id,
          channel: channel.id,
        });
      } catch (error) {
        connection.destroy();
        throw new Error(
          `Joined ${channel.name}, but Discord would not make the bot a Stage speaker. ` +
            'Grant Mute Members in that Stage channel.',
          { cause: error },
        );
      }
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

  get bitrateCeiling(): number {
    return Math.min(this.#channel.bitrate, this.#channel.guild.maximumBitrate);
  }

  get muted(): boolean {
    return this.#muted;
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#mutation.then(operation, operation);
    this.#mutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Rebuilds the audio pipeline against a new source without leaving the channel. */
  async setSource(source: SourceSpec): Promise<void> {
    return this.#mutate(async () => {
      log.info('retargeting stream source', {
        guild: this.guildId,
        from: this.#source.kind,
        to: source.kind,
        label: source.label,
      });
      this.#source = source;
      this.#restarts = 0;
      await this.#replaceAudio();
    });
  }

  /** Re-encodes at a new bitrate. Requires an encoder restart; the connection is untouched. */
  async setBitrate(bitrate: number): Promise<void> {
    return this.#mutate(async () => {
      if (!Number.isFinite(bitrate)) throw new RangeError('Bitrate must be a finite number.');
      const target = Math.min(this.bitrateCeiling, Math.max(8_000, Math.round(bitrate)));
      if (target === this.#bitrate) {
        log.debug('encoder bitrate is already at target', { guild: this.guildId, bitrate: target });
        return;
      }
      log.info('changing encoder bitrate', { guild: this.guildId, from: this.#bitrate, to: target });
      this.#bitrate = target;
      await this.#replaceAudio();
    });
  }

  /**
   * Applied inside the tap when possible, which is before any format conversion and therefore
   * free. dshow sources have no tap, so they need a full restart to change the ffmpeg filter.
   */
  async setGain(db: number): Promise<void> {
    return this.#mutate(async () => {
      if (!Number.isFinite(db) || db < -60 || db > 20) {
        throw new RangeError('Gain must be between -60 and +20 dB.');
      }
      if (db === this.#gainDb) {
        log.debug('capture gain is already at target', { guild: this.guildId, db });
        return;
      }
      log.info('changing capture gain', { guild: this.guildId, from: this.#gainDb, to: db });
      this.#gainDb = db;
      if (this.#tap?.format.gainAppliedInTap) {
        this.#tap.setGain(db);
        return;
      }
      // DirectShow and integer PCM cannot be scaled live in AudioTap; rebuild with ffmpeg volume.
      await this.#replaceAudio();
    });
  }

  /** Updates Discord's own self-mute flag without stopping capture or leaving the channel. */
  async setMuted(muted: boolean): Promise<void> {
    return this.#mutate(async () => {
      if (muted === this.#muted) return;
      if (
        !this.#connection.rejoin({
          channelId: this.channelId,
          selfDeaf: true,
          selfMute: muted,
        })
      ) {
        throw new Error('Discord rejected the voice-state mute update.');
      }
      this.#muted = muted;
      await entersState(this.#connection, VoiceConnectionStatus.Ready, 10_000);
      log.info(muted ? 'bot muted in voice channel' : 'bot unmuted in voice channel', {
        guild: this.guildId,
        channel: this.channelId,
      });
    });
  }

  status(): SessionStatus {
    return {
      guildId: this.guildId,
      channelId: this.channelId,
      channelName: this.channelName,
      source: this.#source,
      bitrate: this.#bitrate,
      bitrateCeiling: this.bitrateCeiling,
      gainDb: this.#gainDb,
      muted: this.#channel.guild.members.me?.voice.selfMute ?? this.#muted,
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
    if (sessions.get(this.guildId) === this) sessions.delete(this.guildId);
    log.info('ending bridge session', { guild: this.guildId, channel: this.channelId });

    this.#player.stop(true);
    await this.#stopAudio();

    if (this.#connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.#connection.destroy();
    }
    log.info('bridge session ended', { guild: this.guildId, channel: this.channelId });
  }

  async #startAudio(): Promise<void> {
    if (this.#destroyed) return;
    log.debug('starting audio pipeline', {
      guild: this.guildId,
      sourceKind: this.#source.kind,
      bitrate: this.#bitrate,
      gainDb: this.#gainDb,
    });

    let input: EncoderInput;
    let pcm: CaptureTap['stream'] | undefined;

    if (this.#source.kind === 'dshow') {
      if (!IS_WINDOWS) {
        throw new Error('DirectShow sources are Windows-only. On Linux, capture an app or a device.');
      }
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
      const tap = await startCapture(
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
        gainDb: input.kind === 'dshow' || !input.format.gainAppliedInTap ? this.#gainDb : 0,
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
      // An intentionally replaced encoder can report its final pipe error after the new one starts.
      if (this.#encoder !== encoder || this.#changingAudio) return;
      log.error('encoder stream error', error);
      void this.#restartAudio();
    });

    // The capture stream dying must restart the pipeline too. Without this listener the error
    // would be unhandled on a piped stream and could take the whole process down.
    pcm?.once('error', (error: Error) => {
      if (this.#changingAudio || this.#restarting) return;
      log.error('capture stream error', error);
      void this.#restartAudio();
    });

    this.#player.play(resource);
    this.#startedAt = Date.now();
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#stableTimer = setTimeout(() => {
      if (this.#encoder === encoder && !this.#destroyed) {
        if (this.#restarts > 0) log.info('audio pipeline remained stable; restart budget restored');
        this.#restarts = 0;
      }
    }, STABLE_PIPELINE_MS);
    log.info(`streaming ${this.#source.label} at ${Math.round(this.#bitrate / 1000)} kbps`, {
      guild: this.guildId,
      capture: this.#captureFormat,
    });
  }

  async #stopAudio(): Promise<void> {
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
    const [tap, encoder] = [this.#tap, this.#encoder];
    this.#tap = null;
    this.#encoder = null;
    if (tap || encoder) log.debug('stopping audio pipeline', { guild: this.guildId });

    // Encoder first: closing it releases the pipe the tap is writing into.
    await encoder?.close();
    await tap?.close();
    if (tap || encoder) log.debug('audio pipeline stopped', { guild: this.guildId });
  }

  async #replaceAudio(): Promise<void> {
    this.#changingAudio = true;
    try {
      await this.#stopAudio();
      await this.#startAudio();
    } finally {
      this.#changingAudio = false;
    }
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

    // A startup failure has no stream left to emit another error. Re-enter the bounded backoff
    // loop explicitly so a transient device/ffmpeg failure still gets all configured attempts.
    if (!this.#destroyed && this.#encoder === null) void this.#restartAudio();
  }

  #wirePlayer(): void {
    this.#player.on('error', (error) => {
      log.error('player error', error);
      void this.#restartAudio();
    });

    this.#player.on(AudioPlayerStatus.Idle, () => {
      // A live source should never end. If it does, ffmpeg or the tap died.
      if (this.#destroyed || this.#changingAudio || this.#restarting) return;
      log.warn('audio resource ended unexpectedly');
      void this.#restartAudio();
    });

    this.#player.on(AudioPlayerStatus.Playing, () => {
      log.info('audio player is receiving packets', { guild: this.guildId });
    });

    this.#player.on('stateChange', (before, after) => {
      log.debug('audio player state changed', {
        guild: this.guildId,
        from: before.status,
        to: after.status,
      });
    });
  }

  #wireConnection(): void {
    this.#connection.on('stateChange', (before, after) => {
      log.debug('voice connection state changed', {
        guild: this.guildId,
        from: before.status,
        to: after.status,
      });
    });

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
const guildOperations = new Map<string, Promise<unknown>>();

function withGuildLock<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
  const previous = guildOperations.get(guildId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  guildOperations.set(guildId, next);
  void next
    .finally(() => {
      if (guildOperations.get(guildId) === next) guildOperations.delete(guildId);
    })
    .catch(() => undefined);
  return next;
}

function sameSource(a: SourceSpec, b: SourceSpec): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'process' && b.kind === 'process') return a.pid === b.pid && a.exclude === b.exclude;
  if (a.kind === 'device' && b.kind === 'device') return a.id === b.id;
  return a.kind === 'dshow' && b.kind === 'dshow' && a.name === b.name;
}

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
  return withGuildLock(channel.guild.id, async () => {
    const existing = sessions.get(channel.guild.id);

    if (existing && existing.channelId === channel.id) {
      log.debug('reusing existing voice connection', { guild: channel.guild.id, channel: channel.id });
      if (!sameSource(existing.source, source)) await existing.setSource(source);
      if (existing.bitrate !== bitrate) await existing.setBitrate(bitrate);
      return existing;
    }

    if (existing) await endSessionUnlocked(channel.guild.id);

    const session = await BridgeSession.create(channel, source, { bitrate });
    sessions.set(session.guildId, session);
    return session;
  });
}

export function setSession(session: BridgeSession): void {
  sessions.set(session.guildId, session);
}

export async function endSession(guildId: string): Promise<boolean> {
  return withGuildLock(guildId, () => endSessionUnlocked(guildId));
}

async function endSessionUnlocked(guildId: string): Promise<boolean> {
  const session = sessions.get(guildId);
  if (!session) return false;
  sessions.delete(guildId);
  await session.destroy();
  return true;
}

export async function endAllSessions(): Promise<void> {
  if (sessions.size > 0) log.info('ending all bridge sessions', { count: sessions.size });
  await Promise.allSettled([...sessions.keys()].map((id) => endSession(id)));
}
