import { REST, Routes } from 'discord.js';

import { commands } from './commands.ts';
import { config } from './config.ts';
import { logger } from './logger.ts';

const log = logger('register');

export interface RegistrationResult {
  count: number;
  scope: string;
  names: string[];
}

/**
 * The application this token belongs to.
 *
 * A bot token already identifies its application, so asking the person who owns it to also copy an
 * application id out of the developer portal only adds a way to get it wrong: paste the id of a
 * different application and command registration fails with a permissions error that says nothing
 * about the real cause. DISCORD_APP_ID is still honoured when set, for the rare case of a token
 * and an application that are deliberately not the same.
 */
async function resolveAppId(rest: REST): Promise<string> {
  const configured = config.discord.appId;
  if (configured) return configured;

  const application = (await rest.get(Routes.currentApplication())) as { id?: unknown };
  if (typeof application.id !== 'string') {
    throw new Error('Discord did not return an application id for this bot token.');
  }
  return application.id;
}

/** Registers the bundled command definitions without relying on npm or the source tree. */
export async function registerCommands(appId?: string): Promise<RegistrationResult> {
  const rest = new REST().setToken(config.discord.token);
  const id = appId ?? (await resolveAppId(rest));
  const body = commands.map((command) => command.data.toJSON());
  const route = config.discord.guildId
    ? Routes.applicationGuildCommands(id, config.discord.guildId)
    : Routes.applicationCommands(id);
  const scope = config.discord.guildId ? `guild ${config.discord.guildId}` : 'globally';
  const result = (await rest.put(route, { body })) as unknown[];
  const names = commands.map((command) => command.data.name);
  log.info(`registered ${result.length} commands ${scope}: ${names.join(', ')}`);
  return { count: result.length, scope, names };
}
