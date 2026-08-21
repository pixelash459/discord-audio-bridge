import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';

import { commandsByName, UserError } from './commands.ts';
import { config } from './config.ts';
import { logger } from './logger.ts';
import { signIn, hasToken } from './signin.ts';
import { closeAllTaps, isAudioTapBuilt } from './audio/tap.ts';
import { closeAllEncoders } from './audio/encoder.ts';
import { ControlServer } from './control/server.ts';
import { RemoteServer } from './remote/server.ts';
import { endAllSessions } from './voice/session.ts';

const log = logger('bot');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // Needed to see which voice channel the caller is sitting in. Not a privileged intent.
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, (ready) => {
  log.info(`logged in as ${ready.user.tag}`);
  log.info(
    isAudioTapBuilt()
      ? 'AudioTap is built - per-app and per-device capture available'
      : 'AudioTap is NOT built - only DirectShow sources will work (run: npm run build:native)',
  );
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = commandsByName.get(interaction.commandName);
    await command?.autocomplete?.(interaction).catch((error: unknown) =>
      log.debug('autocomplete error', error),
    );
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

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

let control: ControlServer | undefined;
let remote: RemoteServer | undefined;
log.info('starting Discord Audio Bridge', {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  pid: process.pid,
  logFile: config.paths.logFile ?? 'disabled',
});

// The control panel comes up BEFORE sign-in, on purpose. Its Setup tab is where you enter the bot
// token, so gating it behind a successful sign-in would mean needing a token to enter a token.
if (config.control.port > 0) {
  control = new ControlServer(client, config.control.port);
  try {
    await control.start();
    process.stdout.write(`\n  Control panel:  ${control.url}\n\n`);

    if (config.control.autoOpen) {
      const { spawn } = await import('node:child_process');
      spawn('cmd', ['/c', 'start', '', control.url], { windowsHide: true, detached: true }).unref();
    }
  } catch (error) {
    control = undefined;
    log.error(
      `control panel could not start on port ${config.control.port} ` +
        '(is another copy already running?)',
      error,
    );
  }
} else {
  log.info('control panel disabled (CONTROL_PORT=0)');
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

/* ── shutdown ─────────────────────────────────────────────────────────────── */

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`${signal} - shutting down`);
  await remote?.stop().catch(() => undefined);
  await control?.stop().catch(() => undefined);
  await endAllSessions();
  await Promise.allSettled([closeAllEncoders(), closeAllTaps()]);
  await client.destroy();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdown(signal));
}

process.on('unhandledRejection', (error) => log.error('unhandled rejection', error));

// Node's default for an uncaught exception is to crash. Logging without exiting would leave the
// process alive in an undefined state - and exiting 0 would make a fatal failure look to whatever
// launched us like a clean shutdown.
process.on('uncaughtException', (error) => {
  log.error('uncaught exception - shutting down', error);
  process.exit(1);
});
