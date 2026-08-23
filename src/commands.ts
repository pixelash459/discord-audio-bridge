import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type VoiceBasedChannel,
} from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';

import { config } from './config.ts';
import { logger } from './logger.ts';
import { listDshowDevices } from './audio/encoder.ts';
import { captureBackend, isAudioTapBuilt, listDevices, listProcesses } from './audio/tap.ts';
import { endSession, getSession, startOrRetarget, type SourceSpec } from './voice/session.ts';
import { IS_WINDOWS } from './platform.ts';

const log = logger('commands');

export interface Command {
  data: { toJSON(): unknown; name: string };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

/** Opus is defined up to 510 kbps; Discord's own ceiling is far lower but the codec allows it. */
const OPUS_MIN_BITRATE = 8_000;
const OPUS_MAX_BITRATE = 510_000;

function callerVoiceChannel(interaction: ChatInputCommandInteraction): VoiceBasedChannel {
  // Voice states are cached from the GuildVoiceStates intent, so this needs no privileged intent.
  const channel = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channel;
  if (!channel) throw new UserError('Join a voice channel first, then run this command again.');
  return channel;
}

/**
 * Without an explicit override, match the voice channel exactly. Sending materially more than the
 * channel is configured for wastes upstream bandwidth for no audible gain; sending less is a
 * pointless quality cut. The channel ceiling itself is set by the server's boost tier:
 * 96 kbps unboosted, 128/256/384 kbps at tiers 1/2/3.
 */
function resolveBitrate(channel: VoiceBasedChannel): number {
  const override = config.opus.bitrate;
  const ceiling = Math.min(channel.bitrate, channel.guild.maximumBitrate);
  if (override) return Math.min(ceiling, OPUS_MAX_BITRATE, Math.max(OPUS_MIN_BITRATE, override));
  return ceiling;
}

export class UserError extends Error {}

function ms(value: number): string {
  const total = Math.floor(value / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

async function startStream(
  interaction: ChatInputCommandInteraction,
  source: SourceSpec,
): Promise<void> {
  const channel = callerVoiceChannel(interaction);
  const bitrate = resolveBitrate(channel);

  await startOrRetarget(channel, source, bitrate);

  const started = getSession(interaction.guildId!)!.status();

  const embed = new EmbedBuilder()
    .setColor(started.qualityNote ? 0xfee75c : 0x57f287)
    .setTitle('Streaming')
    .setDescription(`**${source.label}** into **${channel.name}**`)
    .addFields(
      { name: 'Capture', value: started.captureFormat, inline: true },
      { name: 'Opus bitrate', value: `${Math.round(bitrate / 1000)} kbps`, inline: true },
      { name: 'VBR', value: `${config.opus.vbr}, cx ${config.opus.complexity}`, inline: true },
    )
    .setFooter({ text: 'Run /status for live pipeline numbers.' });

  if (started.qualityNote) {
    embed.addFields({ name: '⚠ Quality note', value: started.qualityNote });
  }

  await interaction.editReply({ embeds: [embed] });
}

const stream: Command = {
  data: new SlashCommandBuilder()
    .setName('stream')
    .setDescription('Stream audio from this machine into your voice channel')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('app')
        .setDescription('Capture one application, isolated from every other sound on the PC')
        .addStringOption((option) =>
          option
            .setName('target')
            .setDescription('The app to capture')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addBooleanOption((option) =>
          option
            .setName('invert')
            .setDescription('Capture everything EXCEPT this app (default: false)'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('device')
        .setDescription('Capture everything playing through one output device')
        .addStringOption((option) =>
          option
            .setName('target')
            .setDescription('Output device (default: your default playback device)')
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('dshow')
        .setDescription('Capture a DirectShow input, e.g. a virtual cable. No capture helper needed.')
        .addStringOption((option) =>
          option
            .setName('target')
            .setDescription('DirectShow audio input')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    ),

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase();
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'app') {
        const processes = await listProcesses();
        await interaction.respond(
          processes
            .filter((p) => p.name.toLowerCase().includes(typed) || p.displayName.toLowerCase().includes(typed))
            .slice(0, 25)
            .map((p) => ({
              name: `${p.state === 'Active' ? '▶ ' : ''}${p.name} (pid ${p.pid})`.slice(0, 100),
              value: `${p.pid}:${p.name}`,
            })),
        );
        return;
      }

      if (sub === 'device') {
        const devices = await listDevices();
        await interaction.respond(
          devices
            .filter((d) => d.name.toLowerCase().includes(typed))
            .slice(0, 25)
            .map((d) => ({
              name: `${d.isDefault ? '★ ' : ''}${d.name} (${d.sampleRate / 1000} kHz)`.slice(0, 100),
              value: d.id.slice(0, 100),
            })),
        );
        return;
      }

      const devices = await listDshowDevices();
      await interaction.respond(
        devices
          .filter((d) => d.name.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((d) => ({ name: d.name.slice(0, 100), value: d.name.slice(0, 100) })),
      );
    } catch (error) {
      log.debug('autocomplete failed', error);
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();

    if (sub === 'app') {
      if (!isAudioTapBuilt()) {
        throw new UserError(
          IS_WINDOWS
            ? 'Per-app capture needs the AudioTap helper. Run `npm run build:native` on the host (requires the .NET SDK), or use `/stream dshow` with a virtual cable instead.'
            : 'Per-app capture needs the PipeWire tools (pw-record). On Debian/Ubuntu run `apt install pipewire-bin`; on Fedora run `dnf install pipewire-utils`.',
        );
      }

      const raw = interaction.options.getString('target', true);
      const [pidText, ...rest] = raw.split(':');
      const pid = Number.parseInt(pidText ?? '', 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new UserError(`"${raw}" is not a process. Pick one from the autocomplete list.`);
      }

      const invert = interaction.options.getBoolean('invert') ?? false;
      const name = rest.join(':') || `pid ${pid}`;
      await startStream(interaction, {
        kind: 'process',
        pid,
        exclude: invert,
        label: invert ? `everything except ${name}` : name,
      });
      return;
    }

    if (sub === 'device') {
      if (!isAudioTapBuilt()) {
        throw new UserError(
          IS_WINDOWS
            ? 'Device capture needs the AudioTap helper. Run `npm run build:native` on the host, or use `/stream dshow` instead.'
            : 'Device capture needs the PipeWire tools (pw-record). On Debian/Ubuntu run `apt install pipewire-bin`; on Fedora run `dnf install pipewire-utils`.',
        );
      }

      const id = interaction.options.getString('target') ?? 'default';
      const devices = await listDevices().catch(() => []);
      const match = devices.find((d) => d.id === id);
      await startStream(interaction, {
        kind: 'device',
        id,
        label: match?.name ?? (id === 'default' ? 'default output device' : id),
      });
      return;
    }

    if (!IS_WINDOWS) {
      throw new UserError('DirectShow capture is Windows-only. On this host, use `/stream app` or `/stream device`.');
    }
    const name = interaction.options.getString('target', true);
    await startStream(interaction, { kind: 'dshow', name, label: name });
  },
};

const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop streaming and leave the voice channel')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.deferReply();
    const ended = await endSession(interaction.guildId!);
    await interaction.editReply(ended ? 'Stopped and left the channel.' : 'Nothing is streaming here.');
  },
};

const status: Command = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show live numbers for the current stream')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.deferReply();
    const session = getSession(interaction.guildId!);
    if (!session) throw new UserError('Nothing is streaming here. Start one with `/stream`.');

    const s = session.status();
    const embed = new EmbedBuilder()
      .setColor(s.playerState === 'playing' ? 0x57f287 : 0xfee75c)
      .setTitle(`${s.source.label} → ${s.channelName}`)
      .addFields(
        { name: 'Capture', value: s.captureFormat, inline: true },
        { name: 'Encode', value: `Opus ${Math.round(s.bitrate / 1000)} kbps, VBR ${s.vbr}, cx ${s.complexity}`, inline: true },
        { name: 'Player', value: s.playerState, inline: true },
        { name: 'Connection', value: s.connectionState, inline: true },
        { name: 'UDP ping', value: s.ping === null ? 'n/a' : `${s.ping} ms`, inline: true },
        { name: 'Uptime', value: ms(s.uptimeMs), inline: true },
      );

    if (s.tap) {
      embed.addFields({
        name: 'Jitter buffer',
        value:
          `${s.tap.bufferMs.toFixed(0)} / ${s.tap.targetMs.toFixed(0)} ms` +
          (s.tap.primed ? '' : ' (priming)') +
          `\nsilence filled: ${(s.tap.paddedMs / 1000).toFixed(1)}s` +
          `\ndrift trimmed: ${s.tap.trimmedMs.toFixed(0)} ms` +
          (s.tap.droppedMs > 0 ? `\noverruns: ${s.tap.droppedMs.toFixed(0)} ms` : ''),
      });
    }

    if (s.qualityNote) {
      embed.addFields({ name: '⚠ Quality note', value: s.qualityNote });
    }

    if (s.restarts > 0) {
      embed.setFooter({ text: `${s.restarts} pipeline restart(s) since the last clean start` });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

const gain: Command = {
  data: new SlashCommandBuilder()
    .setName('gain')
    .setDescription('Adjust capture gain in dB (applied before encoding)')
    .setContexts(InteractionContextType.Guild)
    .addNumberOption((option) =>
      option
        .setName('db')
        .setDescription('Decibels, -60 to +20. 0 = untouched.')
        .setRequired(true)
        .setMinValue(-60)
        .setMaxValue(20),
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const session = getSession(interaction.guildId!);
    if (!session) throw new UserError('Nothing is streaming here.');

    const db = interaction.options.getNumber('db', true);
    await session.setGain(db);
    await interaction.editReply(
      db === 0
        ? 'Gain reset to 0 dB (samples pass through untouched).'
        : `Gain set to ${db > 0 ? '+' : ''}${db} dB.` +
            (db > 0 ? ' Positive gain can clip - back off if it sounds harsh.' : ''),
    );
  },
};

const bitrate: Command = {
  data: new SlashCommandBuilder()
    .setName('bitrate')
    .setDescription('Change the Opus bitrate for the running stream')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((option) =>
      option
        .setName('kbps')
        .setDescription('Leave empty to match the voice channel')
        .setMinValue(OPUS_MIN_BITRATE / 1000)
        .setMaxValue(OPUS_MAX_BITRATE / 1000),
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const session = getSession(interaction.guildId!);
    if (!session) throw new UserError('Nothing is streaming here.');

    const channel = interaction.guild?.channels.cache.get(session.channelId);
    const requested = interaction.options.getInteger('kbps');
    const target =
      requested !== null
        ? Math.min(requested * 1000, session.bitrateCeiling)
        : channel && channel.isVoiceBased()
          ? Math.min(channel.bitrate, interaction.guild!.maximumBitrate)
          : session.bitrate;

    await session.setBitrate(target);

    const warning =
      requested !== null && requested * 1000 > target
        ? `\nCapped at this channel's ${Math.round(target / 1000)} kbps ceiling.`
        : '';

    await interaction.editReply(`Re-encoding at ${Math.round(target / 1000)} kbps.${warning}`);
  },
};

const quality: Command = {
  data: new SlashCommandBuilder()
    .setName('quality')
    .setDescription("Inspect (or raise) the voice channel's own bitrate ceiling")
    .setContexts(InteractionContextType.Guild)
    .addBooleanOption((option) =>
      option
        .setName('maximize')
        .setDescription('Actually set this channel to the server maximum (needs Manage Channels)'),
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const channel = callerVoiceChannel(interaction);
    const guild = interaction.guild!;
    const max = guild.maximumBitrate;

    const summary =
      `**${channel.name}** is set to **${Math.round(channel.bitrate / 1000)} kbps**.\n` +
      `This server's ceiling is **${Math.round(max / 1000)} kbps** (boost tier ${guild.premiumTier}).\n\n` +
      'Boost tiers set the ceiling: 96 kbps unboosted, then 128 / 256 / 384 kbps at tiers 1 / 2 / 3.';

    if (!interaction.options.getBoolean('maximize')) {
      await interaction.editReply(
        channel.bitrate >= max
          ? `${summary}\n\nAlready at the ceiling.`
          : `${summary}\n\nRe-run with \`maximize: true\` to raise it.`,
      );
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      throw new UserError('You need the Manage Channels permission to change a channel bitrate.');
    }
    if (!guild.members.me?.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels)) {
      throw new UserError('I need the Manage Channels permission on that channel to change its bitrate.');
    }
    if (channel.bitrate >= max) {
      await interaction.editReply(`${summary}\n\nAlready at the ceiling; nothing changed.`);
      return;
    }

    const before = channel.bitrate;
    await channel.edit({ bitrate: max, reason: `Raised by ${interaction.user.tag} via /quality` });
    await interaction.editReply(
      `Raised **${channel.name}** from ${Math.round(before / 1000)} to **${Math.round(max / 1000)} kbps**.\n` +
        'Run `/bitrate` to re-encode the live stream at the new ceiling.',
    );
  },
};

const sources: Command = {
  data: new SlashCommandBuilder()
    .setName('sources')
    .setDescription('List what can be captured on the host machine')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Capture sources');

    if (isAudioTapBuilt()) {
      const [processes, devices] = await Promise.all([
        listProcesses().catch(() => []),
        listDevices().catch(() => []),
      ]);

      embed.addFields(
        {
          name: 'Applications playing audio',
          value:
            processes
              .slice(0, 15)
              .map((p) => `${p.state === 'Active' ? '▶' : '□'} \`${p.pid}\` ${p.name}`)
              .join('\n') || '_none right now - start playback and try again_',
        },
        {
          name: 'Output devices',
          value:
            devices
              .slice(0, 10)
              .map((d) => `${d.isDefault ? '★' : '·'} ${d.name} — ${d.sampleRate / 1000} kHz ${d.sampleFormat}`)
              .join('\n') || '_none_',
        },
      );
    } else {
      embed.addFields({
        name: 'Applications and devices',
        value: IS_WINDOWS
          ? 'Unavailable — AudioTap is not built. Run `npm run build:native` on the host.'
          : 'Unavailable — the PipeWire tools are missing. Install `pipewire-bin` on Debian/Ubuntu or `pipewire-utils` on Fedora.',
      });
    }

    if (IS_WINDOWS) {
      const dshow = await listDshowDevices().catch(() => []);
      embed.addFields({
        name: 'DirectShow inputs',
        value: dshow.map((d) => `· ${d.name}`).join('\n') || '_none_',
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

const diagnose: Command = {
  data: new SlashCommandBuilder()
    .setName('diagnose')
    .setDescription('Report the state of every dependency in the audio path')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const report = await collectDiagnostics();
    await interaction.editReply(`\`\`\`\n${report.slice(0, 1_900)}\n\`\`\``);
  },
};

export async function collectDiagnostics(): Promise<string> {
  const { spawnSync } = await import('node:child_process');

  const ffmpeg = spawnSync(config.paths.ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
  const ffmpegLine = ffmpeg.error
    ? `NOT FOUND at "${config.paths.ffmpeg}"`
    : (ffmpeg.stdout.split('\n')[0] ?? 'unknown');

  const opus = spawnSync(config.paths.ffmpeg, ['-hide_banner', '-h', 'encoder=libopus'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const hasLibopus = !opus.error && opus.stdout.includes('libopus');

  const backend = captureBackend();

  // The capture half of the report is the one part that genuinely differs per OS.
  const capture: string[] = [];
  if (IS_WINDOWS) {
    capture.push(
      `AudioTap    ${backend === 'wasapi' ? config.paths.audioTap : `NOT BUILT (expected ${config.paths.audioTap}) - run npm run build:native`}`,
    );
    // `dotnet` on PATH only proves the runtime is there. Building AudioTap needs the SDK, and
    // the host reports its absence by failing --version with "No .NET SDKs were found".
    const dotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true });
    const dotnetVersion = dotnet.stdout.trim();
    const dotnetMajor = Number.parseInt(dotnetVersion.split('.')[0] ?? '', 10);
    const helperBundled = backend === 'wasapi';
    capture.push(
      `dotnet SDK  ${
        dotnet.error
          ? helperBundled
            ? 'not installed (optional; the bundled AudioTap is self-contained)'
            : 'not installed (needed to build AudioTap: winget install Microsoft.DotNet.SDK.10)'
          : dotnet.status === 0 && dotnetVersion
            ? dotnetMajor >= 10
              ? dotnetVersion
              : helperBundled
                ? `${dotnetVersion} (optional; SDK 10 is needed only to rebuild AudioTap)`
                : `${dotnetVersion} - TOO OLD (install Microsoft.DotNet.SDK.10 to build AudioTap)`
            : helperBundled
              ? 'runtime only (optional; the bundled AudioTap is self-contained)'
              : 'runtime present but NO SDK (install Microsoft.DotNet.SDK.10 to build AudioTap)'
      }`,
    );
  } else {
    const pw = spawnSync(config.paths.pwRecord, ['--version'], { encoding: 'utf8', windowsHide: true });
    const pwVersion = pw.error ? undefined : pw.stdout.trim().split('\n').at(-1)?.trim();
    capture.push(
      `pw-record   ${
        pwVersion ??
        `NOT FOUND at "${config.paths.pwRecord}" - install pipewire-bin (Debian/Ubuntu) or pipewire-utils (Fedora)`
      }`,
    );
  }

  return [
    '--- host ---',
    `node        ${process.version} (${process.platform}/${process.arch})`,
    `ffmpeg      ${ffmpegLine}`,
    `libopus     ${hasLibopus ? 'available' : 'MISSING - ffmpeg build has no libopus encoder'}`,
    ...capture,
    `log file    ${config.paths.logFile ?? 'disabled'}`,
    `remote UI   ${config.remote.port > 0 ? `${config.remote.host}:${config.remote.port}` : 'disabled'}`,
    '',
    '--- @discordjs/voice ---',
    generateDependencyReport(),
  ].join('\n');
}

export const commands: Command[] = [stream, stop, status, gain, bitrate, quality, sources, diagnose];

export const commandsByName = new Map(commands.map((command) => [command.data.name, command]));

export const requiredChannelType = ChannelType.GuildVoice;
