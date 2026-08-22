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

/** Registers the bundled command definitions without relying on npm or the source tree. */
export async function registerCommands(): Promise<RegistrationResult> {
  const rest = new REST().setToken(config.discord.token);
  const body = commands.map((command) => command.data.toJSON());
  const route = config.discord.guildId
    ? Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId)
    : Routes.applicationCommands(config.discord.appId);
  const scope = config.discord.guildId ? `guild ${config.discord.guildId}` : 'globally';
  const result = (await rest.put(route, { body })) as unknown[];
  const names = commands.map((command) => command.data.name);
  log.info(`registered ${result.length} commands ${scope}: ${names.join(', ')}`);
  return { count: result.length, scope, names };
}
