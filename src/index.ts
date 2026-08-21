import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';

import { commandsByName, UserError } from './commands.ts';
import { config } from './config.ts';
import { logger } from './logger.ts';
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

let control: ControlServer | undefined;

client.once(Events.ClientReady, async (ready) => {
  log.info(`logged in as ${ready.user.tag}`);
  log.info(
    isAudioTapBuilt()
      ? 'AudioTap is built - per-app and per-device capture available'
      : 'AudioTap is NOT built - only DirectShow sources will work (run: npm run build:native)',
  );

  if (config.control.port <= 0) {
    log.info('control panel disabled (CONTROL_PORT=0)');
    return;
  }

  control = new ControlServer(ready, config.control.port);
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
        '(is another copy already running?). The bot keeps working via slash commands.',
      error,
    );
  }
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
// process alive in an undefined state - and, worse, exiting 0 makes a fatal startup failure look
// like a clean shutdown to whatever launched us.
process.on('uncaughtException', (error) => {
  log.error('uncaught exception - shutting down', error);
  process.exit(1);
});

try {
  await client.login(config.discord.token);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  const hint = /token|unauthorized|401/i.test(reason)
    ? 'DISCORD_TOKEN looks wrong. Reset it under Bot in the Discord developer portal and paste the new one into .env.'
    : /intent|disallowed/i.test(reason)
      ? 'Discord rejected the gateway intents. This bot needs only Guilds and GuildVoiceStates, neither of which is privileged.'
      : 'Check your network connection and that Discord is reachable.';

  log.error(`could not sign in to Discord: ${reason}`);
  log.error(hint);
  process.exit(1);
}
