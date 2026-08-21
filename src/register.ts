import { REST, Routes } from 'discord.js';

import { commands } from './commands.ts';
import { config } from './config.ts';
import { logger } from './logger.ts';

const log = logger('register');

const rest = new REST().setToken(config.discord.token);
const body = commands.map((command) => command.data.toJSON());

// Guild-scoped commands appear immediately; global ones can take up to an hour to propagate.
const route = config.discord.guildId
  ? Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId)
  : Routes.applicationCommands(config.discord.appId);

const scope = config.discord.guildId ? `guild ${config.discord.guildId}` : 'globally';

const result = (await rest.put(route, { body })) as unknown[];
log.info(`registered ${result.length} commands ${scope}: ${commands.map((c) => c.data.name).join(', ')}`);
