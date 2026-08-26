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
import type { Readable } from 'node:stream';

import { config, DISCORD_AUDIO, type LoudnessMode } from '../config.ts';
import { logger } from '../logger.ts';
import { OpusEncoder, probeDshowFormat, type DshowFormat, type EncoderInput } from '../audio/encoder.ts';
import { Mixer, type MixInputStats } from '../audio/mixer.ts';
import { nowPlayingSummary, type NowPlaying } from '../audio/monitor.ts';
import { Preview } from '../audio/preview.ts';
import { resolveProcessByName, startCapture, type CaptureTap, type TapStats } from '../audio/tap.ts';
import { IS_WINDOWS } from '../platform.ts';

const log = logger('session');

export type SourceSpec =
  | {
      kind: 'process';
      pid: number;
      /** Executable name, kept so a restarted app can be found again under its new PID. */
      processName?: string | undefined;
      label: string;
      exclude: boolean;
      /** Trim for this input inside a mix. Ignored for a lone source, which uses session gain. */
      gainDb?: number;
    }
  | { kind: 'device'; id: string; label: string; gainDb?: number }
  | { kind: 'dshow'; name: string; label: string; gainDb?: number };

export interface SessionStatus {
  guildId: string;
  channelId: string;
  channelName: string;
  /** The first source. Retained so older clients keep working; prefer `sources`. */
  source: SourceSpec;
  sources: SourceSpec[];
  /** Per-input mixer telemetry, present only while more than one source is being summed. */
  mix: MixInputStats[] | null;
  bitrate: number;
  bitrateCeiling: number;
  gainDb: number;
  loudness: LoudnessMode;
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
  /** How many listeners are actually in the channel; drives the leave-when-empty timer. */
  listeners: number;
  /** Track metadata for whatever the host is playing, when it could be read. */
  nowPlaying: NowPlaying | null;
  /** True while the encoded stream is also being played back on this machine. */
  previewing: boolean;
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
  #sources: SourceSpec[];
  #bitrate: number;
  #gainDb: number;
  #loudness: LoudnessMode;
  #muted = false;
  #mutation: Promise<void> = Promise.resolve();

  #taps: CaptureTap[] = [];
  #mixer: Mixer | null = null;
  #encoder: OpusEncoder | null = null;
  #preview: Preview | null = null;
  #captureFormat = 'starting';
  #qualityNote: string | null = null;
  #startedAt = Date.now();
  #restarts = 0;
  #restarting = false;
  #changingAudio = false;
  #destroyed = false;
  #stableTimer: NodeJS.Timeout | undefined;

  private constructor(
    channel: VoiceBasedChannel,
    connection: VoiceConnection,
    sources: SourceSpec[],
    bitrate: number,
    gainDb: number,
    loudness: LoudnessMode,
  ) {
    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.channelName = channel.name;
    this.#channel = channel;
    this.#connection = connection;
    this.#sources = sources;
    this.#bitrate = bitrate;
    this.#gainDb = gainDb;
    this.#loudness = loudness;

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
    sources: SourceSpec[],
    options: { bitrate: number; gainDb?: number; loudness?: LoudnessMode },
  ): Promise<BridgeSession> {
    const started = performance.now();
    log.info('joining voice channel', {
      guild: channel.guild.id,
      channel: channel.id,
      channelName: channel.name,
      sourceKinds: sources.map((source) => source.kind),
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
    const session = new BridgeSession(
      channel,
      connection,
      sources,
      options.bitrate,
      options.gainDb ?? 0,
      options.loudness ?? config.audio.loudness,
    );
    try {
      await session.#startAudio();
      return session;
    } catch (error) {
      // The session is not registered until its pipeline is live. Clean it up here so a failed
      // AudioTap/ffmpeg start cannot leave an untracked voice connection that /stop cannot find.
      await session.destroy().catch((cleanupError) =>
        log.debug('failed to clean up an incomplete session', cleanupError),
      );
      throw error;
    }
  }

  get source(): SourceSpec {
    return this.#sources[0]!;
  }

  get sources(): SourceSpec[] {
    return this.#sources;
  }

  /** One human-readable name for whatever this session is carrying. */
  get label(): string {
    return this.#sources.map((source) => source.label).join(' + ');
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

  /** Rebuilds the audio pipeline against a new source set without leaving the channel. */
  async setSources(sources: SourceSpec[]): Promise<void> {
    if (sources.length === 0) throw new RangeError('A session needs at least one source.');
    return this.#mutate(async () => {
      log.info('retargeting stream source', {
        guild: this.guildId,
        from: this.#sources.map((source) => source.label),
        to: sources.map((source) => source.label),
      });
      this.#sources = sources;
      this.#restarts = 0;
      await this.#replaceAudio();
    });
  }

  /**
   * Changes one input's trim inside a mix. Applied in the summing stage, which is live, so this
   * never interrupts the stream - unlike changing the source set, which has to rebuild ffmpeg.
   */
  async setInputGain(index: number, db: number): Promise<void> {
    return this.#mutate(async () => {
      const source = this.#sources[index];
      if (!source) throw new RangeError(`No source at position ${index}.`);
      if (!Number.isFinite(db) || db < -60 || db > 20) {
        throw new RangeError('Gain must be between -60 and +20 dB.');
      }

      source.gainDb = db;
      if (this.#mixer) {
        this.#mixer.setGain(index, db + this.#gainDb);
        log.info('changed mix input gain', { guild: this.guildId, index, db });
        return;
      }
      // A lone source has no summing stage, so its trim is the session gain.
      await this.#applyGain(db);
    });
  }

  /** Switches the loudness stage. Needs an encoder rebuild, since it is an ffmpeg filter. */
  async setLoudness(mode: LoudnessMode): Promise<void> {
    return this.#mutate(async () => {
      if (mode === this.#loudness) return;
      log.info('changing loudness mode', { guild: this.guildId, from: this.#loudness, to: mode });
      this.#loudness = mode;
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
      await this.#applyGain(db);
    });
  }

  /**
   * Master gain, applied as far upstream as each path allows.
   *
   * A mix has its own summing stage, so scaling every lane there is both live and free. A single
   * float tap can be scaled inside AudioTap, also live. Everything else - DirectShow, integer PCM -
   * has to go through ffmpeg's volume filter, which means rebuilding the encoder.
   */
  async #applyGain(db: number): Promise<void> {
    this.#gainDb = db;

    if (this.#mixer) {
      for (const [index, source] of this.#sources.entries()) {
        this.#mixer.setGain(index, (source.gainDb ?? 0) + db);
      }
      return;
    }

    const tap = this.#taps[0];
    if (tap?.format.gainAppliedInTap) {
      tap.setGain(db);
      return;
    }

    await this.#replaceAudio();
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
      await entersState(this.#connection, VoiceConnectionStatus.Ready, 10_000);
      // Commit local state only after Discord confirms the rejoin. A timeout must not make the
      // panel disagree with Discord's actual self-mute state.
      this.#muted = muted;
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
      source: this.#sources[0]!,
      sources: this.#sources,
      mix:
        this.#mixer?.stats.map((input, index) => ({
          ...input,
          // Expose the user's lane trim, not the internal lane+master effective gain.
          gainDb: this.#sources[index]?.gainDb ?? 0,
        })) ?? null,
      bitrate: this.#bitrate,
      bitrateCeiling: this.bitrateCeiling,
      gainDb: this.#gainDb,
      loudness: this.#loudness,
      muted: this.#channel.guild.members.me?.voice.selfMute ?? this.#muted,
      vbr: config.opus.vbr,
      complexity: config.opus.complexity,
      captureFormat: this.#captureFormat,
      qualityNote: this.#qualityNote,
      playerState: this.#player.state.status,
      connectionState: this.#connection.state.status,
      ping: this.#connection.ping.udp ?? null,
      uptimeMs: Date.now() - this.#startedAt,
      tap: this.#mixer?.meter ?? this.#taps[0]?.stats ?? null,
      restarts: this.#restarts,
      listeners: this.listeners,
      nowPlaying: nowPlayingSummary(),
      previewing: this.#preview?.running ?? false,
    };
  }

  /**
   * Plays the encoded stream back on this machine.
   *
   * Deliberately tees the encoder rather than the source: the source is already audible, so the
   * only useful monitor is one that has been through the gain stage, the limiter and a real Opus
   * round trip. Survives a pipeline rebuild by re-attaching in #startAudio.
   */
  async setPreview(enabled: boolean): Promise<void> {
    return this.#mutate(async () => {
      if (!enabled) {
        this.#preview?.close();
        this.#preview = null;
        log.info('local preview stopped', { guild: this.guildId });
        return;
      }

      const encoder = this.#encoder;
      if (!encoder) throw new Error('Nothing is encoding yet; try again once the stream is running.');

      this.#preview ??= new Preview();
      this.#preview.start(encoder.stream);
      log.info('local preview started', { guild: this.guildId });
    });
  }

  /** Humans in the channel, excluding the bot itself. Drives the leave-when-empty timer. */
  get listeners(): number {
    const members = this.#channel.members;
    let count = 0;
    for (const member of members.values()) if (!member.user.bot) count += 1;
    return count;
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (sessions.get(this.guildId) === this) sessions.delete(this.guildId);
    log.info('ending bridge session', { guild: this.guildId, channel: this.channelId });

    this.#preview?.close();
    this.#preview = null;
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
      sources: this.#sources.map((source) => source.label),
      bitrate: this.#bitrate,
      gainDb: this.#gainDb,
    });

    const primary = this.#sources[0]!;
    let input: EncoderInput;
    let pcm: Readable | undefined;

    if (primary.kind === 'dshow') {
      if (!IS_WINDOWS) {
        throw new Error('DirectShow sources are Windows-only.');
      }
      const probed = await probeDshowFormat(primary.name);
      input = { kind: 'dshow', name: primary.name, format: probed ?? undefined };

      if (probed) {
        this.#captureFormat = `${probed.sampleRate} Hz / ${probed.channels} ch / ${probed.bits}-bit`;
        this.#qualityNote = describeDshowCost(probed);
      } else {
        this.#captureFormat = 'dshow (format not reported)';
        this.#qualityNote = 'This device would not report its formats, so ffmpeg negotiated on its own.';
      }
    } else {
      const taps = await this.#startTaps();
      const format = taps[0]!.format;

      if (taps.length === 1) {
        pcm = taps[0]!.stream;
        this.#captureFormat = `${format.sampleRate} Hz / ${format.channels} ch / ${format.sampleFormat}`;
      } else {
        // Every tap is already paced at real time by its own helper, so the mixer only has to sum
        // matching slices. Mismatched formats would need per-lane resampling, which belongs in
        // ffmpeg, not here - so refuse the combination and say which input is the odd one out.
        const odd = taps.find(
          (tap) =>
            tap.format.sampleRate !== format.sampleRate ||
            tap.format.channels !== format.channels ||
            tap.format.sampleFormat !== format.sampleFormat,
        );
        if (odd) {
          throw new Error(
            `Cannot mix sources with different capture formats: "${odd.format.source}" reports ` +
              `${odd.format.sampleRate} Hz ${odd.format.channels} ch ${odd.format.sampleFormat} but the ` +
              `first source reports ${format.sampleRate} Hz ${format.channels} ch ${format.sampleFormat}. ` +
              'Set both endpoints to the same format, or capture them separately.',
          );
        }
        if (format.sampleFormat !== 'f32le') {
          throw new Error(
            `Mixing needs 32-bit float capture, but this source reports ${format.sampleFormat}. ` +
              'Set the endpoint to 48 kHz float in Windows sound settings.',
          );
        }

        const mixer = new Mixer(
          taps.map((tap, index) => ({
            stream: tap.stream,
            label: this.#sources[index]!.label,
            gainDb: (this.#sources[index]!.gainDb ?? 0) + this.#gainDb,
          })),
          { sampleRate: format.sampleRate, channels: format.channels },
        );
        mixer.on('inputEnded', (label: string, reason: string) => {
          log.warn(`mix input stopped: ${label} (${reason})`, { guild: this.guildId });
          // A dead lane should not become permanent silence. Rebuilding every lane also gives a
          // process-name source the chance to follow an application that restarted with a new PID.
          if (!this.#changingAudio && !this.#restarting) void this.#restartAudio();
        });
        this.#mixer = mixer;
        pcm = mixer.stream;
        this.#captureFormat =
          `${taps.length} sources mixed · ${format.sampleRate} Hz / ${format.channels} ch / ${format.sampleFormat}`;
      }

      this.#qualityNote =
        format.sampleRate === DISCORD_AUDIO.sampleRate && format.sampleFormat === 'f32le'
          ? null
          : `Capturing at ${format.sampleRate} Hz ${format.sampleFormat} rather than 48 kHz float, ` +
            'so ffmpeg has to convert. Set this endpoint to 48 kHz in Windows sound settings.';
      input = { kind: 'pipe', format };
    }

    // Gain has already been applied upstream whenever the path allowed it: inside AudioTap for a
    // lone float tap, inside the summing stage for a mix. Only the paths that could not do it
    // themselves fall through to ffmpeg's volume filter.
    const gainHandledUpstream =
      input.kind === 'pipe' && (this.#mixer !== null || input.format.gainAppliedInTap);

    const encoder = OpusEncoder.start(
      {
        input,
        bitrate: this.#bitrate,
        gainDb: gainHandledUpstream ? 0 : this.#gainDb,
        loudness: this.#loudness,
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
    // A rebuilt encoder is a new stream, so an active monitor has to follow it across.
    if (this.#preview?.running) this.#preview.attach(encoder.stream);
    this.#startedAt = Date.now();
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#stableTimer = setTimeout(() => {
      if (this.#encoder === encoder && !this.#destroyed) {
        if (this.#restarts > 0) log.info('audio pipeline remained stable; restart budget restored');
        this.#restarts = 0;
      }
    }, STABLE_PIPELINE_MS);
    log.info(`streaming ${this.label} at ${Math.round(this.#bitrate / 1000)} kbps`, {
      guild: this.guildId,
      capture: this.#captureFormat,
    });
  }

  /**
   * Opens one capture per source, re-resolving any that were chosen by name.
   *
   * A PID names a run of an application, not the application. When the user picked "Spotify" and
   * Spotify has since restarted, the honest reading of their intent is the new process, not a dead
   * handle - so a source that carries a process name gets looked up again before we give up on it.
   * If every tap cannot be opened the caller's restart budget still applies; this only removes the
   * most common reason that budget used to be spent.
   */
  async #startTaps(): Promise<CaptureTap[]> {
    const opened: CaptureTap[] = [];

    try {
      for (const source of this.#sources) {
        if (source.kind === 'dshow') {
          throw new Error('A DirectShow input cannot be part of a mix.');
        }

        if (source.kind === 'process' && source.processName) {
          const current = await resolveProcessByName(source.processName).catch(() => undefined);
          if (current && current.pid !== source.pid) {
            log.info('source application restarted; following it to its new process', {
              guild: this.guildId,
              name: source.processName,
              from: source.pid,
              to: current.pid,
            });
            source.pid = current.pid;
          }
        }

        // A mix scales every lane in the summing stage instead, so the tap stays at unity there.
        const gainDb = this.#sources.length > 1 ? 0 : this.#gainDb;
        opened.push(
          await startCapture(
            source.kind === 'process'
              ? { pid: source.pid, exclude: source.exclude, gainDb }
              : { deviceId: source.id, gainDb },
          ),
        );
      }
    } catch (error) {
      // Never leave half a mix running: a tap that opened before the failing one still owns a
      // helper process and a WASAPI client.
      await Promise.allSettled(opened.map((tap) => tap.close()));
      throw error;
    }

    this.#taps = opened;
    return opened;
  }

  async #stopAudio(): Promise<void> {
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
    const [taps, mixer, encoder] = [this.#taps, this.#mixer, this.#encoder];
    this.#taps = [];
    this.#mixer = null;
    this.#encoder = null;
    const running = taps.length > 0 || encoder !== null;
    if (running) log.debug('stopping audio pipeline', { guild: this.guildId });

    // Encoder first: closing it releases the pipe the mixer or tap is writing into.
    await encoder?.close();
    await mixer?.close();
    await Promise.allSettled(taps.map((tap) => tap.close()));
    if (running) log.debug('audio pipeline stopped', { guild: this.guildId });
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
const MAX_CONCURRENT_SESSIONS = 4;
const guildOperations = new Map<string, Promise<unknown>>();

export type SessionEvent = 'started' | 'stopped';
type SessionListener = (event: SessionEvent, session: BridgeSession) => void;
const sessionListeners = new Set<SessionListener>();

/**
 * Notifies when a stream starts or stops.
 *
 * The session layer has no business knowing about Discord presence, saved routes or the desktop
 * shell, and the three call sites that start a stream should not each have to remember to update
 * them. One hook, installed by the entry point, keeps that coupling in exactly one place.
 */
export function onSessionChange(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function announce(event: SessionEvent, session: BridgeSession): void {
  for (const listener of sessionListeners) {
    try {
      listener(event, session);
    } catch (error) {
      log.debug('session listener failed', error);
    }
  }
}

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
  if ((a.gainDb ?? 0) !== (b.gainDb ?? 0)) return false;
  if (a.kind === 'process' && b.kind === 'process') {
    return a.pid === b.pid && a.exclude === b.exclude && a.processName === b.processName;
  }
  if (a.kind === 'device' && b.kind === 'device') return a.id === b.id;
  return a.kind === 'dshow' && b.kind === 'dshow' && a.name === b.name;
}

/** Order matters: it decides which lane is which in the mixer, so a reorder is a real change. */
function sameSources(a: SourceSpec[], b: SourceSpec[]): boolean {
  return a.length === b.length && a.every((source, index) => sameSource(source, b[index]!));
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
  sources: SourceSpec | SourceSpec[],
  bitrate: number,
  options: { loudness?: LoudnessMode } = {},
): Promise<BridgeSession> {
  const wanted = Array.isArray(sources) ? sources : [sources];
  if (wanted.length === 0) throw new RangeError('A session needs at least one source.');

  return withGuildLock(channel.guild.id, async () => {
    const existing = sessions.get(channel.guild.id);

    if (existing && existing.channelId === channel.id) {
      log.debug('reusing existing voice connection', { guild: channel.guild.id, channel: channel.id });
      if (!sameSources(existing.sources, wanted)) await existing.setSources(wanted);
      if (existing.bitrate !== bitrate) await existing.setBitrate(bitrate);
      if (options.loudness) await existing.setLoudness(options.loudness);
      announce('started', existing);
      return existing;
    }

    if (existing) await endSessionUnlocked(channel.guild.id);

    if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(
        `This host is already streaming to ${MAX_CONCURRENT_SESSIONS} servers. Stop one before starting another.`,
      );
    }

    const session = await BridgeSession.create(channel, wanted, {
      bitrate,
      ...(options.loudness ? { loudness: options.loudness } : {}),
    });
    sessions.set(session.guildId, session);
    announce('started', session);
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
  announce('stopped', session);
  return true;
}

export async function endAllSessions(): Promise<void> {
  if (sessions.size > 0) log.info('ending all bridge sessions', { count: sessions.size });
  await Promise.allSettled([...sessions.keys()].map((id) => endSession(id)));
}
