import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { commandsByName, handleComponent, isBridgeComponent, UserError } from './commands.ts';
import { config, projectRoot, runtimeRoot } from './config.ts';
import { flushLogs, logger } from './logger.ts';
import { signIn, hasToken } from './signin.ts';
import { closeAllTaps, captureBackend } from './audio/tap.ts';
import { sourceMonitor } from './audio/monitor.ts';
import { closeAllEncoders } from './audio/encoder.ts';
import { clearChannelStatus, refreshPresence, startPresence } from './presence.ts';
import { lastRoute, rememberRoute } from './presets.ts';
import { allSessions, getSession, onSessionChange } from './voice/session.ts';
import { ControlServer } from './control/server.ts';
import { findRunningControlPanel } from './control/launcher.ts';
import { RemoteServer } from './remote/server.ts';
import { endAllSessions, endSession, startOrRetarget } from './voice/session.ts';
import { openUrl } from './platform.ts';
import { printDoctorReport } from './doctor.ts';

const log = logger('bot');

/* ── command-line entry points ────────────────────────────────────────────── */

// These exist mostly for the packaged executable, which has no npm scripts to lean on.
// The dispatch happens at the bottom of the file: running main() here would race the client
// constant below in the CommonJS release bundle, where const becomes a hoisted var.
const args = process.argv.slice(2);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // Needed to see which voice channel the caller is sitting in. Not a privileged intent.
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, (ready) => {
  log.info(`logged in as ${ready.user.tag}`);
  const backend = captureBackend();
  log.info(
    backend === 'wasapi'
      ? 'per-app capture via WASAPI process loopback (AudioTap)'
      : backend === 'pipewire'
        ? 'per-app capture via PipeWire (pw-record + pacer)'
        : 'no per-app capture backend available - only ffmpeg-input sources will work',
  );

  stopPresence = startPresence(client);
  startEmptyChannelWatch();
  if (config.automation.resumeLastRoute) void resumeLastRoute();
});

// One hook keeps presence, the channel status line and the remembered route in step, wherever the
// stream was started from: a slash command, a button, the control panel, or the phone dashboard.
onSessionChange((event, session) => {
  if (event === 'stopped') {
    void clearChannelStatus(client, session.channelId).catch(() => undefined);
    void refreshPresence(client).catch(() => undefined);
    return;
  }

  const snapshot = session.status();
  rememberRoute({
    guildId: snapshot.guildId,
    channelId: snapshot.channelId,
    sources: snapshot.sources,
    bitrate: snapshot.bitrate,
    gainDb: snapshot.gainDb,
    loudness: snapshot.loudness,
  });
  void refreshPresence(client).catch(() => undefined);
});

/* ── automation ───────────────────────────────────────────────────────────── */

let stopPresence: (() => void) | undefined;
let emptyWatch: NodeJS.Timeout | undefined;
/** When each currently-empty channel became empty, so the grace period is a real elapsed time. */
const emptySince = new Map<string, number>();

/**
 * Stops streams nobody is listening to.
 *
 * The player deliberately keeps encoding into an empty room - that is what makes `/status` honest
 * and lets someone rejoin without restarting capture - but "deliberately" and "forever" are
 * different things. After the configured grace period the session ends on its own, which is what
 * anyone would expect from a tool that is holding a microphone open on their PC.
 */
function startEmptyChannelWatch(): void {
  const graceMs = config.automation.leaveWhenEmptySeconds * 1_000;
  if (graceMs <= 0 || emptyWatch) return;

  emptyWatch = setInterval(() => {
    const now = Date.now();
    const live = new Set<string>();

    for (const session of allSessions()) {
      live.add(session.guildId);
      if (session.listeners > 0) {
        emptySince.delete(session.guildId);
        continue;
      }

      const since = emptySince.get(session.guildId) ?? now;
      emptySince.set(session.guildId, since);
      if (now - since < graceMs) continue;

      log.info('nobody has been listening for a while; stopping', {
        guild: session.guildId,
        afterSeconds: Math.round((now - since) / 1000),
      });
      emptySince.delete(session.guildId);
      void endSession(session.guildId).catch((error: unknown) =>
        log.debug('automatic stop failed', error),
      );
    }

    for (const guildId of emptySince.keys()) if (!live.has(guildId)) emptySince.delete(guildId);
  }, 15_000);
  emptyWatch.unref();
  log.info(`will stop a stream after ${config.automation.leaveWhenEmptySeconds}s with no listeners`);
}

/** Picks up exactly where the last run left off, when the user asked for that. */
async function resumeLastRoute(): Promise<void> {
  const route = lastRoute();
  if (!route) return;

  try {
    const guild = client.guilds.cache.get(route.guildId);
    const channel = guild?.channels.cache.get(route.channelId);
    if (!channel?.isVoiceBased()) {
      log.info('not resuming the last route: that channel is no longer reachable');
      return;
    }

    const ceiling = Math.min(channel.bitrate, channel.guild.maximumBitrate);
    await startOrRetarget(
      channel,
      route.sources,
      Math.min(route.bitrate ?? ceiling, ceiling),
      route.loudness ? { loudness: route.loudness } : {},
    );
    if (route.gainDb) await getSession(route.guildId)?.setGain(route.gainDb);
    log.info('resumed the last route', { guild: route.guildId, channel: route.channelId });
  } catch (error) {
    log.warn('could not resume the last route', error);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }
    const command = commandsByName.get(interaction.commandName);
    await command?.autocomplete?.(interaction).catch((error: unknown) =>
      log.debug('autocomplete error', error),
    );
    return;
  }

  // Buttons and select menus on the bridge's own replies: stop, mute, trim, pick a source.
  if (interaction.isMessageComponent()) {
    if (!isBridgeComponent(interaction.customId)) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: 'Bridge controls are restricted to server administrators.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      await handleComponent(interaction);
    } catch (error) {
      log.error('component interaction failed', error);
      const message =
        error instanceof UserError
          ? error.message
          : `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
      await interaction
        .followUp({ content: message, flags: MessageFlags.Ephemeral })
        .catch((replyError: unknown) => log.debug('could not deliver the error to the user', replyError));
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: 'Bridge commands are restricted to server administrators.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const started = performance.now();
  log.info(`/${interaction.commandName} invoked`, {
    guild: interaction.guildId,
    channel: interaction.channelId,
    user: interaction.user.id,
  });

  try {
    await command.execute(interaction);
    log.info(`/${interaction.commandName} completed`, {
      guild: interaction.guildId,
      durationMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    const friendly =
      error instanceof UserError
        ? error.message
        : `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;

    if (!(error instanceof UserError)) log.error(`/${interaction.commandName} failed`, error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: friendly, embeds: [] });
      } else {
        await interaction.reply({ content: friendly, flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      log.debug('could not deliver the error to the user', replyError);
    }
  }
});

client.on(Events.Error, (error) => log.error('client error', error));
client.on(Events.Warn, (message) => log.warn(`Discord client: ${message}`));
client.on(Events.Debug, (message) => log.debug(`Discord client: ${message}`));

/* ── startup ──────────────────────────────────────────────────────────────── */

// Everything asynchronous lives inside main() because the release bundle is CommonJS for
// Node's single-executable format, which has no top-level await.
let control: ControlServer | undefined;
let remote: RemoteServer | undefined;

async function main(openPanel = false): Promise<void> {
  log.info('starting Discord Audio Bridge', {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    pid: process.pid,
    projectRoot,
    runtimeRoot,
    logFile: config.paths.logFile ?? 'disabled',
  });

  // One resident helper that pushes source-list and now-playing changes, so nothing has to spawn a
  // process on a timer to find out what is playing. Silently does nothing where it is unsupported.
  sourceMonitor.start();

  // The control panel comes up BEFORE sign-in, on purpose. Its Setup tab is where you enter the bot
  // token, so gating it behind a successful sign-in would mean needing a token to enter a token.
  if (config.control.port > 0) {
    control = new ControlServer(client, config.control.port, () => void shutdown('control-panel quit'));
    try {
      await control.start();
      process.stdout.write(`\n  Control panel:  ${control.url}\n\n`);

      if (config.control.autoOpen || openPanel) openUrl(control.url);
    } catch (error) {
      control = undefined;
      log.error(
        `control panel could not start on port ${config.control.port} ` +
          '(is another copy already running?)',
        error,
      );

      // Two near-simultaneous menu clicks can race before the first process writes its token file.
      // Give the winner a moment to finish listening, then attach this click to it and exit.
      if (openPanel) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const existing = await findRunningControlPanel();
        if (existing) {
          openUrl(existing);
          await client.destroy();
          return;
        }
      }
    }
  } else {
    log.info('control panel disabled (CONTROL_PORT=0)');
  }

  if (openPanel && !control) {
    log.error('desktop launch requires the local control panel; set CONTROL_PORT to a non-zero port');
    await client.destroy();
    process.exitCode = 1;
    return;
  }

  // The remote dashboard is deliberately a separate, restricted server. It exposes runtime controls
  // but none of the local panel's credential, configuration, build, or command-registration routes.
  if (config.remote.port > 0) {
    try {
      remote = new RemoteServer(
        client,
        config.remote.host,
        config.remote.port,
        config.remote.token,
        config.remote.trustTailscale,
      );
      await remote.start();
      process.stdout.write('\n  Remote control (keep these URLs private):\n');
      for (const url of remote.accessUrls()) process.stdout.write(`  ${url}\n`);
      process.stdout.write('\n');
    } catch (error) {
      remote = undefined;
      log.error(`remote control could not start on ${config.remote.host}:${config.remote.port}`, error);
    }
  } else {
    log.info('remote control disabled (REMOTE_PORT=0)');
  }

  // A failed sign-in is not fatal while the panel is up: it is the one screen that can fix it.
  // Headless, there is nothing to fix it with, so exit and say why.
  try {
    await signIn(client);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    if (!control) {
      log.error(`could not sign in to Discord: ${reason}`);
      log.error(
        hasToken()
          ? 'Fix DISCORD_TOKEN in .env and start again.'
          : 'Put DISCORD_TOKEN and DISCORD_APP_ID in .env (copy .env.example), then start again.',
      );
      process.exit(1);
    }

    log.warn(`not signed in: ${reason}`);
    log.warn(`Open the control panel and finish setup there: ${control.url}`);
  }
}

/* ── shutdown ─────────────────────────────────────────────────────────────── */

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`${signal} - shutting down`);
  const watchdog = setTimeout(() => {
    log.error('graceful shutdown timed out; forcing exit');
    process.exit(exitCode || 1);
  }, 10_000);
  watchdog.unref();
  try {
    stopPresence?.();
    if (emptyWatch) clearInterval(emptyWatch);

    // Remember the route before the sessions are gone, and take the channel status back down so a
    // stale "now playing" line does not outlive the process that wrote it.
    for (const session of allSessions()) {
      const snapshot = session.status();
      rememberRoute({
        guildId: snapshot.guildId,
        channelId: snapshot.channelId,
        sources: snapshot.sources,
        bitrate: snapshot.bitrate,
        gainDb: snapshot.gainDb,
        loudness: snapshot.loudness,
      });
      await clearChannelStatus(client, snapshot.channelId).catch(() => undefined);
    }

    await remote?.stop().catch((error) => log.debug('remote shutdown failed', error));
    await control?.stop().catch((error) => log.debug('control shutdown failed', error));
    await endAllSessions();
    await Promise.allSettled([closeAllEncoders(), closeAllTaps()]);
    await client.destroy();
    await flushLogs();
  } finally {
    clearTimeout(watchdog);
    process.exit(exitCode);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdown(signal));
}

process.on('unhandledRejection', (error) => {
  log.error('unhandled rejection - shutting down', error);
  void shutdown('unhandled rejection', 1);
});

// Node's default for an uncaught exception is to crash. Logging without exiting would leave the
// process alive in an undefined state - and exiting 0 would make a fatal failure look to whatever
// launched us like a clean shutdown.
process.on('uncaughtException', (error) => {
  log.error('uncaught exception - shutting down', error);
  void shutdown('uncaught exception', 1);
});

/* ── entry-point dispatch ──────────────────────────────────────────────────── */

// No top-level await anywhere above: the release build is a CommonJS bundle for Node's
// single-executable format, which cannot contain it.
if (args.includes('--doctor')) {
  void printDoctorReport().then(() => process.exit(0));
} else if (args.includes('--version')) {
  // Reading package.json from the project root keeps dev and packaged output identical.
  try {
    process.stdout.write(`${JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version}\n`);
  } catch {
    process.stdout.write('unknown\n');
  }
  process.exit(0);
} else if (args.includes('--open')) {
  void findRunningControlPanel().then((existing) => {
    if (existing) {
      openUrl(existing);
      return;
    }
    return main(true);
  });
} else {
  void main(false);
}
