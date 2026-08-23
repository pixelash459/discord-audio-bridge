import { Events, type Client } from 'discord.js';

import { logger } from './logger.ts';

const log = logger('auth');

let lastError: string | null = null;
let pending: Promise<void> | undefined;

/**
 * How long to wait for READY after Discord accepts the token. Identify plus the initial guild
 * burst is normally under a second; a slow link or a rate-limited gateway can take much longer,
 * and giving up early would be worse than saying so.
 */
const READY_TIMEOUT_MS = 30_000;

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
  return { hasToken: hasToken(), attempting: pending !== undefined, error: lastError };
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
 * Waits for the session to actually be usable.
 *
 * `client.login()` resolves once the gateway accepts the token, which is well before READY has
 * arrived and therefore before `client.isReady()`, the guild cache, or the application id mean
 * anything (discordjs/discord.js#3607). Returning at that point is what made the panel announce
 * "signed in" and then immediately render "not signed in to Discord".
 */
async function waitForReady(client: Client): Promise<void> {
  if (client.isReady()) return;

  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer);
      client.off(Events.ClientReady, ready);
      client.off(Events.Error, failed);
      error ? reject(error) : resolve();
    };
    const ready = () => done();
    const failed = (error: Error) => done(error);
    const timer = setTimeout(
      () =>
        done(
          new Error(
            'Discord accepted the token but the session did not finish opening. It may still come ' +
              'up on its own; check the connection indicator in a moment.',
          ),
        ),
      READY_TIMEOUT_MS,
    );

    client.once(Events.ClientReady, ready);
    client.once(Events.Error, failed);
  });
}

async function attempt(client: Client): Promise<void> {
  const token = process.env['DISCORD_TOKEN']?.trim();
  if (!token) {
    lastError = 'No bot token yet. Add one in the Setup tab.';
    throw new Error(lastError);
  }

  lastError = null;
  const started = performance.now();
  log.info('signing in to Discord');

  try {
    await client.login(token);
  } catch (error) {
    lastError = explain(error);
    log.error(`sign-in failed: ${lastError}`);

    // A rejected login leaves the client holding a half-built websocket. Reset it so the next
    // attempt starts clean instead of failing with "already logged in". Only ever done for a
    // rejected login: once the token is accepted the connection is real, and tearing it down
    // because READY is slow would turn a wait into a permanent failure.
    try {
      await client.destroy();
      log.debug('reset Discord client after failed sign-in');
    } catch (destroyError) {
      log.debug('Discord client reset after failed sign-in also failed', destroyError);
    }

    throw new Error(lastError);
  }

  try {
    await waitForReady(client);
  } catch (error) {
    lastError = explain(error);
    log.error(`sign-in did not complete: ${lastError}`);
    throw new Error(lastError);
  }

  log.info('signed in to Discord', { durationMs: Math.round(performance.now() - started) });
}

/**
 * Signs in with whatever token is currently in the environment.
 *
 * Deliberately callable more than once: the control panel starts before sign-in so that the Setup
 * tab is reachable when there is no token yet, and saving one there calls straight back into here.
 * Without that, entering a token would require a token.
 *
 * Concurrent callers join the attempt already running rather than starting a second one. A second
 * `login()` on a client that is mid-handshake fails, and the failure path resets the client - so
 * pressing "Try again" while the first attempt was still connecting used to destroy the very
 * connection it was waiting for, leaving the panel stuck on "connecting" forever.
 */
export async function signIn(client: Client): Promise<void> {
  if (client.isReady()) {
    log.debug('sign-in skipped because the client is already ready');
    return;
  }

  if (pending) {
    log.debug('joining the sign-in attempt already in flight');
    return pending;
  }

  pending = attempt(client).finally(() => {
    pending = undefined;
  });
  return pending;
}
