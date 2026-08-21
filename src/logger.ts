import { config, type LogLevel } from './config.ts';

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
const history: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

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
  const entry: LogEntry = { at: Date.now(), level, scope, message };
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

  const time = new Date(entry.at).toISOString().slice(11, 23);
  const line = `\x1b[90m${time}\x1b[0m ${tint[level]}${level.padEnd(5)}\x1b[0m \x1b[35m${scope}\x1b[0m ${message}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

  stream.write(entry.extra === undefined ? `${line}\n` : `${line} \x1b[90m${entry.extra}\x1b[0m\n`);
}

function plain(extra: unknown): string {
  if (extra instanceof Error) return extra.stack ?? extra.message;
  try {
    return JSON.stringify(extra) ?? String(extra);
  } catch {
    return String(extra);
  }
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
