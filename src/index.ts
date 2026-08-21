import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';

import { commandsByName, UserError } from './commands.ts';
import { config } from './config.ts';
import { logger } from './logger.ts';
import { signIn, hasToken } from './signin.ts';
import { isAudioTapBuilt } from './audio/tap.ts';
import { ControlServer } from './control/server.ts';
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

  try {
    await command.execute(interaction);
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

/* ── startup ──────────────────────────────────────────────────────────────── */

let control: ControlServer | undefined;

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
  await control?.stop().catch(() => undefined);
  await endAllSessions();
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
