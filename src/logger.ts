import { config, type LogLevel } from './config.ts';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { restrictPrivateFile } from './platform.ts';

const rank: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = rank[config.logLevel];

const tint: Record<LogLevel, string> = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
};

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  extra?: string;
}

/**
 * Recent history, so a control panel that connects late still has context to show. Sized to a few
 * minutes of normal chatter rather than a full session.
 */
const HISTORY_LIMIT = 500;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const history: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();
let fileUnavailable = false;
let fileBytes: number | undefined;
let fileHardened = false;
let writeQueue: Promise<void> = Promise.resolve();

export function recentLogs(): readonly LogEntry[] {
  return history;
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(level: LogLevel, scope: string, message: string, extra?: unknown) {
  // The history is kept at full fidelity regardless of LOG_LEVEL: the console setting controls
  // what floods the terminal, not what the UI is allowed to show after the fact.
  const entry: LogEntry = { at: Date.now(), level, scope, message: redact(message) };
  if (extra !== undefined) entry.extra = plain(extra);

  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.shift();
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      /* a broken listener must not break logging */
    }
  }

  if (rank[level] > threshold) return;

  // Disk and console obey LOG_LEVEL. The in-memory history intentionally stays complete so the
  // Diagnostics panel can still explain a failure that happened just before it was opened.
  queuePersist(entry);

  const time = new Date(entry.at).toISOString().slice(11, 23);
  const line = `\x1b[90m${time}\x1b[0m ${tint[level]}${level.padEnd(5)}\x1b[0m \x1b[35m${scope}\x1b[0m ${entry.message}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

  stream.write(entry.extra === undefined ? `${line}\n` : `${line} \x1b[90m${entry.extra}\x1b[0m\n`);
}

function plain(extra: unknown): string {
  if (extra instanceof Error) return redact(errorText(extra));
  try {
    return redact(JSON.stringify(extra, safeJson) ?? String(extra));
  } catch {
    return redact(String(extra));
  }
}

function errorText(error: Error): string {
  const causes: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    causes.push(current.stack ?? `${current.name}: ${current.message}`);
    current = current.cause;
  }
  return causes.join('\nCaused by: ');
}

function safeJson(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return errorText(value);
  return value;
}

/** Removes credentials from messages before they reach history, the UI, console, or disk. */
function redact(value: string): string {
  let result = value
    .replace(/([?#&]token=)[^&#\s"']+/gi, '$1[REDACTED]')
    .replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/(DISCORD_TOKEN\s*[=:]\s*)[^\s,"'}]+/gi, '$1[REDACTED]');

  const discordToken = process.env['DISCORD_TOKEN'];
  if (discordToken && discordToken.length >= 8) result = result.split(discordToken).join('[REDACTED]');
  return result;
}

function queuePersist(entry: LogEntry): void {
  if (!config.paths.logFile || fileUnavailable) return;
  writeQueue = writeQueue.then(() => persist(entry)).catch((error: unknown) => {
    fileUnavailable = true;
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`logger: persistent log disabled: ${redact(reason)}\n`);
  });
}

async function persist(entry: LogEntry): Promise<void> {
  const path = config.paths.logFile;
  if (!path || fileUnavailable) return;

  if (fileBytes === undefined) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const current = await stat(path);
      fileBytes = current.size;
      await chmod(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fileBytes = 0;
    }
  }

  const line = `${JSON.stringify({ ...entry, at: new Date(entry.at).toISOString() })}\n`;
  const bytes = Buffer.byteLength(line);
  if (fileBytes > 0 && fileBytes + bytes >= MAX_LOG_BYTES) {
    const rotated = `${path}.1`;
    // Windows rename does not replace an existing file. A timestamp keeps every rollover
    // recoverable without deleting an earlier diagnostic log.
    const target = existsSync(rotated) ? `${path}.${Date.now()}` : rotated;
    await rename(path, target);
    fileBytes = 0;
  }

  await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
  fileBytes += bytes;
  if (!fileHardened) {
    fileHardened = true;
    restrictPrivateFile(path);
  }
}

/** Waits for queued file writes so a graceful shutdown does not lose its final diagnostics. */
export async function flushLogs(): Promise<void> {
  await writeQueue;
}

export function logger(scope: string) {
  return {
    error: (message: string, extra?: unknown) => emit('error', scope, message, extra),
    warn: (message: string, extra?: unknown) => emit('warn', scope, message, extra),
    info: (message: string, extra?: unknown) => emit('info', scope, message, extra),
    debug: (message: string, extra?: unknown) => emit('debug', scope, message, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
