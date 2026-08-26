import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  type AnyComponentBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type StringSelectMenuInteraction,
  type VoiceBasedChannel,
} from 'discord.js';

import { config } from './config.ts';
import { collectReport, renderReport } from './diagnostics.ts';
import { logger } from './logger.ts';
import { describeTrack, nowPlaying } from './audio/monitor.ts';
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

/** Discord's own limit on a select menu. */
const MAX_OPTIONS = 25;

function callerVoiceChannel(interaction: ChatInputCommandInteraction | MessageComponentInteraction): VoiceBasedChannel {
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

/* ── shared component surfaces ────────────────────────────────────────────── */

/**
 * Components V2 for the interactive replies.
 *
 * The old surface was an embed: a static snapshot that had to be re-run to see a newer number, and
 * a text option whose value was a PID pasted out of an autocomplete list. Containers with real
 * controls turn the same information into something you can act on - stop, mute and trim the gain
 * without leaving the message, and pick a source from a menu that shows what is actually playing.
 *
 * Every custom id carries the guild it belongs to, so a stale message in another channel cannot
 * quietly drive the wrong session.
 */
const ID = {
  source: (guildId: string) => `bridge:source:${guildId}`,
  stop: (guildId: string) => `bridge:stop:${guildId}`,
  mute: (guildId: string) => `bridge:mute:${guildId}`,
  gainDown: (guildId: string) => `bridge:gain-:${guildId}`,
  gainUp: (guildId: string) => `bridge:gain+:${guildId}`,
  refresh: (guildId: string) => `bridge:refresh:${guildId}`,
};

export function isBridgeComponent(customId: string): boolean {
  return customId.startsWith('bridge:');
}

function row<T extends AnyComponentBuilder>(...components: T[]): ActionRowBuilder<T> {
  return new ActionRowBuilder<T>().addComponents(...components);
}

/** The live control strip shown under a running session. */
function sessionControls(guildId: string, muted: boolean): ActionRowBuilder<ButtonBuilder> {
  return row(
    new ButtonBuilder()
      .setCustomId(ID.mute(guildId))
      .setLabel(muted ? 'Unmute' : 'Mute')
      .setStyle(muted ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ID.gainDown(guildId)).setLabel('−3 dB').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ID.gainUp(guildId)).setLabel('+3 dB').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ID.refresh(guildId)).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ID.stop(guildId)).setLabel('Stop').setStyle(ButtonStyle.Danger),
  );
}

function bar(db: number | undefined): string {
  // A dB number means little at a glance; twelve blocks from -60 to 0 reads instantly.
  if (db === undefined || !Number.isFinite(db) || db <= -60) return '▁'.repeat(12);
  const filled = Math.max(0, Math.min(12, Math.round(((db + 60) / 60) * 12)));
  return `${'█'.repeat(filled)}${'▁'.repeat(12 - filled)}`;
}

function statusContainer(guildId: string): ContainerBuilder {
  const session = getSession(guildId);
  if (!session) {
    return new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### Nothing is streaming\nStart one with `/stream`.'),
    );
  }

  const status = session.status();
  const track = describeTrack(status.nowPlaying);
  const tap = status.tap;

  const headline = track
    ? `### ${track}\n${status.source.label} → **${status.channelName}**`
    : `### ${session.label}\nstreaming into **${status.channelName}**`;

  const facts = [
    `**Opus** ${Math.round(status.bitrate / 1000)} kbps · VBR ${status.vbr} · cx ${status.complexity}`,
    `**Capture** ${status.captureFormat}`,
    `**Player** ${status.playerState} · **ping** ${status.ping === null ? 'n/a' : `${status.ping} ms`} · **up** ${ms(status.uptimeMs)}`,
    `**Gain** ${status.gainDb > 0 ? '+' : ''}${status.gainDb} dB · **loudness** ${status.loudness}` +
      `${status.listeners > 0 ? ` · **${status.listeners}** listening` : ''}`,
  ];

  if (tap) {
    facts.push(
      `\`L ${bar(tap.peakDb[0])}\`\n\`R ${bar(tap.peakDb[1])}\`` +
        (tap.clipping ? '  ⚠ **clipping**' : tap.silent ? '  · silent' : ''),
    );
  }

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(headline))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(facts.join('\n')));

  if (status.mix && status.mix.length > 1) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Mix**\n${status.mix
          .map((input) => `· ${input.label} — ${input.gainDb > 0 ? '+' : ''}${input.gainDb} dB${input.live ? '' : ' (stopped)'}`)
          .join('\n')}`,
      ),
    );
  }

  if (status.qualityNote) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`⚠️ ${status.qualityNote}`));
  }
  if (status.restarts > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`_${status.restarts} pipeline restart(s) since the last clean start._`),
    );
  }

  container.addActionRowComponents(sessionControls(guildId, status.muted));
  return container;
}

interface PickerItem {
  key: string;
  label: string;
  description: string;
  active: boolean;
  source: SourceSpec;
}

async function pickerItems(kind: 'process' | 'device' | 'dshow'): Promise<PickerItem[]> {
  if (kind === 'process') {
    const processes = await listProcesses().catch(() => []);
    return processes.slice(0, MAX_OPTIONS).map((process) => ({
      key: `process:${process.pid}`,
      label: (process.displayName || process.name).slice(0, 100),
      description: `PID ${process.pid}${process.state === 'Active' ? ' · playing now' : ''}`.slice(0, 100),
      active: process.state === 'Active',
      source: {
        kind: 'process',
        pid: process.pid,
        processName: process.name,
        exclude: false,
        label: process.displayName || process.name,
      },
    }));
  }

  if (kind === 'device') {
    const devices = await listDevices().catch(() => []);
    return devices.slice(0, MAX_OPTIONS).map((device) => ({
      key: `device:${device.id}`,
      label: `${device.isDefault ? '★ ' : ''}${device.name}`.slice(0, 100),
      description: `${device.sampleRate / 1000} kHz ${device.sampleFormat}`.slice(0, 100),
      active: device.isDefault,
      source: { kind: 'device', id: device.id, label: device.name },
    }));
  }

  const devices = await listDshowDevices().catch(() => []);
  return devices.slice(0, MAX_OPTIONS).map((device) => ({
    key: `dshow:${device.name}`,
    label: device.name.slice(0, 100),
    description: 'DirectShow input',
    active: false,
    source: { kind: 'dshow', name: device.name, label: device.name },
  }));
}

const pickerCache = new Map<string, PickerItem[]>();

async function sourcePicker(guildId: string, kind: 'process' | 'device' | 'dshow'): Promise<ContainerBuilder> {
  const items = await pickerItems(kind);
  pickerCache.set(guildId, items);

  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      items.length === 0
        ? '### Nothing to capture\nNo source is available right now. Start playback on the host and run `/stream` again.'
        : '### Pick a source\nChoose what everyone in your voice channel should hear.',
    ),
  );

  if (items.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(ID.source(guildId))
      .setPlaceholder('Choose a source')
      .addOptions(
        items.map((item) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(item.label)
            .setDescription(item.description)
            .setValue(item.key)
            .setEmoji(item.active ? '🔊' : '🔈'),
        ),
      );
    container.addActionRowComponents(row(menu));
  }

  return container;
}

/* ── commands ─────────────────────────────────────────────────────────────── */

async function startStream(
  interaction: ChatInputCommandInteraction | MessageComponentInteraction,
  source: SourceSpec,
): Promise<void> {
  const channel = callerVoiceChannel(interaction);
  await startOrRetarget(channel, source, resolveBitrate(channel));

  await interaction.editReply({
    components: [statusContainer(interaction.guildId!)],
    flags: MessageFlags.IsComponentsV2,
  });
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
            .setDescription('Leave empty to choose from a menu')
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
            .slice(0, MAX_OPTIONS)
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
            .slice(0, MAX_OPTIONS)
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
          .slice(0, MAX_OPTIONS)
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
    const raw = interaction.options.getString('target');

    if (sub === 'app' || sub === 'device') {
      if (!isAudioTapBuilt()) {
        throw new UserError(
          'Per-app capture needs the AudioTap helper. Run `npm run build:native` on the host (requires the .NET SDK), or use `/stream dshow` with a virtual cable instead.',
        );
      }
    } else if (!IS_WINDOWS) {
      throw new UserError('DirectShow capture is Windows-only.');
    }

    // No target given: show a menu of what is actually playing rather than making the caller
    // guess. This is the path the buttons and the select handler come back through.
    if (!raw) {
      const kind = sub === 'app' ? 'process' : sub === 'device' ? 'device' : 'dshow';
      await interaction.editReply({
        components: [await sourcePicker(interaction.guildId!, kind)],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (sub === 'app') {
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
        processName: rest.join(':') || undefined,
        exclude: invert,
        label: invert ? `everything except ${name}` : name,
      });
      return;
    }

    if (sub === 'device') {
      const devices = await listDevices().catch(() => []);
      const match = devices.find((d) => d.id === raw);
      await startStream(interaction, {
        kind: 'device',
        id: raw,
        label: match?.name ?? (raw === 'default' ? 'default output device' : raw),
      });
      return;
    }

    await startStream(interaction, { kind: 'dshow', name: raw, label: raw });
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
    .setDescription('Show live numbers for the current stream, with controls')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.deferReply();
    await interaction.editReply({
      components: [statusContainer(interaction.guildId!)],
      flags: MessageFlags.IsComponentsV2,
    });
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
    await interaction.editReply({
      components: [statusContainer(interaction.guildId!)],
      flags: MessageFlags.IsComponentsV2,
    });
  },
};

const loudness: Command = {
  data: new SlashCommandBuilder()
    .setName('loudness')
    .setDescription('Choose how levels are managed on the way out')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('How much to intervene')
        .setRequired(true)
        .addChoices(
          { name: 'off — send exactly what the app produces', value: 'off' },
          { name: 'limit — true-peak limiter only (recommended)', value: 'limit' },
          { name: 'match — normalise to a consistent loudness', value: 'match' },
        ),
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const session = getSession(interaction.guildId!);
    if (!session) throw new UserError('Nothing is streaming here.');

    const mode = interaction.options.getString('mode', true) as 'off' | 'limit' | 'match';
    await session.setLoudness(mode);
    await interaction.editReply({
      components: [statusContainer(interaction.guildId!)],
      flags: MessageFlags.IsComponentsV2,
    });
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
    await interaction.editReply({
      components: [statusContainer(interaction.guildId!)],
      flags: MessageFlags.IsComponentsV2,
    });
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

    const [processes, devices, dshow] = await Promise.all([
      isAudioTapBuilt() ? listProcesses().catch(() => []) : Promise.resolve([]),
      isAudioTapBuilt() ? listDevices().catch(() => []) : Promise.resolve([]),
      IS_WINDOWS ? listDshowDevices().catch(() => []) : Promise.resolve([]),
    ]);

    const sections = [
      `### Capture sources`,
      `**Applications playing audio**\n${
        processes
          .slice(0, 15)
          .map((p) => `${p.state === 'Active' ? '▶' : '□'} \`${p.pid}\` ${p.name}`)
          .join('\n') ||
        (isAudioTapBuilt()
          ? '_none right now — start playback and try again_'
          : '_unavailable — AudioTap is not built_')
      }`,
      `**Output devices**\n${
        devices
          .slice(0, 10)
          .map((d) => `${d.isDefault ? '★' : '·'} ${d.name} — ${d.sampleRate / 1000} kHz ${d.sampleFormat}`)
          .join('\n') || '_none_'
      }`,
    ];

    if (IS_WINDOWS) {
      sections.push(`**DirectShow inputs**\n${dshow.map((d) => `· ${d.name}`).join('\n') || '_none_'}`);
    }

    const track = describeTrack(nowPlaying());
    if (track) sections.push(`**Now playing on the host**\n${track}`);

    await interaction.editReply({
      components: [
        new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(sections.join('\n\n')),
        ),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  },
};

const diagnose: Command = {
  data: new SlashCommandBuilder()
    .setName('diagnose')
    .setDescription('Report the state of every dependency in the audio path')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const report = collectReport();
    const icon = { ok: '✅', warn: '⚠️', fail: '❌' } as const;

    const rows = report.checks
      .map((check) => `${icon[check.status]} **${check.label}** — ${check.detail}${check.remedy ? `\n> ${check.remedy}` : ''}`)
      .join('\n');

    await interaction.editReply({
      components: [
        new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### Diagnostics\n${report.summary.fail} failing · ${report.summary.warn} warnings · ${report.summary.ok} ok\n\n${rows}`.slice(
              0,
              3_900,
            ),
          ),
        ),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  },
};

/* ── component interactions ───────────────────────────────────────────────── */

/**
 * Handles the buttons and select menus attached to the replies above.
 *
 * Each id embeds its guild, so a message left open in one server can never drive another. The
 * reply is always the freshly rendered status container, which keeps the message the user is
 * looking at and the state of the bridge in step without a second command.
 */
export async function handleComponent(interaction: MessageComponentInteraction): Promise<void> {
  const [, action, guildId] = interaction.customId.split(':');
  if (!action || !guildId) return;

  if (interaction.guildId !== guildId) {
    await interaction.reply({
      content: 'That control belongs to a different server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  if (action === 'source') {
    const key = (interaction as StringSelectMenuInteraction).values[0];
    const item = pickerCache.get(guildId)?.find((candidate) => candidate.key === key);
    if (!item) {
      await interaction.editReply({
        components: [
          new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent('That source list is stale. Run `/stream` again.'),
          ),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }
    await startStream(interaction, item.source);
    return;
  }

  const session = getSession(guildId);
  if (!session) {
    await interaction.editReply({
      components: [statusContainer(guildId)],
      flags: MessageFlags.IsComponentsV2,
    });
    return;
  }

  switch (action) {
    case 'stop':
      await endSession(guildId);
      break;
    case 'mute':
      await session.setMuted(!session.muted);
      break;
    case 'gain-':
      await session.setGain(Math.max(-60, session.status().gainDb - 3));
      break;
    case 'gain+':
      await session.setGain(Math.min(20, session.status().gainDb + 3));
      break;
    case 'refresh':
      break;
    default:
      return;
  }

  await interaction.editReply({
    components: [statusContainer(guildId)],
    flags: MessageFlags.IsComponentsV2,
  });
}

/** Kept for `--doctor` and anything else that wants the plain-text dependency report. */
export async function collectDiagnostics(): Promise<string> {
  void captureBackend();
  return renderReport();
}

export const commands: Command[] = [stream, stop, status, gain, loudness, bitrate, quality, sources, diagnose];

// This bridge can enumerate and capture host applications. Ship every command as administrator-only
// instead of exposing that capability to every member of every guild the bot joins. A server owner
// can still make an explicit Discord command-permission override if they understand the tradeoff.
for (const command of commands) {
  (command.data as SlashCommandBuilder).setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

export const commandsByName = new Map(commands.map((command) => [command.data.name, command]));

export const requiredChannelType = ChannelType.GuildVoice;

export type { ButtonInteraction };
