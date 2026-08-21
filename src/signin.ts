import type { Client } from 'discord.js';

import { logger } from './logger.ts';

const log = logger('auth');

let lastError: string | null = null;
let attempting = false;

export interface AuthStatus {
  hasToken: boolean;
  attempting: boolean;
  error: string | null;
}

/**
 * Read straight from the environment rather than through `config`, which throws on a missing
 * token. Before the first sign-in "no token yet" is an ordinary state, not an error.
 */
export function hasToken(): boolean {
  return Boolean(process.env['DISCORD_TOKEN']?.trim());
}

export function authStatus(): AuthStatus {
  return { hasToken: hasToken(), attempting, error: lastError };
}

/** Turns a discord.js login failure into something worth showing a person. */
function explain(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);

  if (/token|unauthorized|401/i.test(reason)) {
    return 'Discord rejected that bot token. Reset it under Bot in the developer portal and paste the new one in.';
  }
  if (/intent|disallowed/i.test(reason)) {
    return 'Discord rejected the gateway intents. This bot needs only Guilds and Guild Voice States, neither of which is privileged.';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|fetch failed/i.test(reason)) {
    return `Could not reach Discord: ${reason}`;
  }
  return reason;
}

/**
 * Signs in with whatever token is currently in the environment.
 *
 * Deliberately callable more than once: the control panel starts before sign-in so that the Setup
 * tab is reachable when there is no token yet, and saving one there calls straight back into here.
 * Without that, entering a token would require a token.
 */
export async function signIn(client: Client): Promise<void> {
  if (client.isReady()) {
    log.debug('sign-in skipped because the client is already ready');
    return;
  }

  if (attempting) throw new Error('A sign-in attempt is already running.');

  const token = process.env['DISCORD_TOKEN']?.trim();
  if (!token) {
    lastError = 'No bot token yet. Add one in the Setup tab.';
    throw new Error(lastError);
  }

  attempting = true;
  lastError = null;
  const started = performance.now();
  log.info('signing in to Discord');

  try {
    await client.login(token);
    log.info('signed in to Discord', { durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    lastError = explain(error);
    log.error(`sign-in failed: ${lastError}`);

    // A rejected login leaves the client holding a half-built websocket. Reset it so the next
    // attempt starts clean instead of failing with "already logged in".
    try {
      await client.destroy();
      log.debug('reset Discord client after failed sign-in');
    } catch (destroyError) {
      log.debug('Discord client reset after failed sign-in also failed', destroyError);
    }

    throw new Error(lastError);
  } finally {
    attempting = false;
  }
}
