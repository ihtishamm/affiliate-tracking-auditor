import type { z } from 'zod';
import type { logLevelSchema } from './env.ts';

// Structured logging (PROJECT_CONTEXT §4, §11): one JSON object per line on stdout, with
// `run_id` stamped on every line of a run via `.child({ run_id })`. Hand-rolled instead of
// pino because the only features needed are levels, bound fields and a duration helper;
// the platform (Vercel, Railway) already collects stdout, so there is no transport to manage.

export type LogLevel = z.output<typeof logLevelSchema>;
export type LogFields = Record<string, unknown>;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that stamps `fields` (e.g. `{ run_id }`) on every subsequent line. */
  child(fields: LogFields): Logger;
  /** Awaits `fn`, logs `msg` with `duration_ms`; on failure logs at error level and rethrows. */
  time<T>(msg: string, fn: () => Promise<T>, fields?: LogFields): Promise<T>;
}

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  fields?: LogFields;
  /** Sink for finished lines. Defaults to stdout; tests pass a collector. */
  write?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? 'info';
  const write = opts.write ?? writeStdout;
  const bound: LogFields = { service: opts.service, ...opts.fields };

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (RANK[lvl] < RANK[level]) return;
    // Key order is deliberate: time, level, bound context (service, run_id...), msg, details.
    const line = { time: new Date().toISOString(), level: lvl, ...bound, msg, ...fields };
    write(JSON.stringify(line, serialiseErrors));
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger({ ...opts, level, fields: { ...opts.fields, ...fields } }),
    async time(msg, fn, fields) {
      const started = performance.now();
      try {
        const result = await fn();
        emit('info', msg, { ...fields, duration_ms: elapsed(started) });
        return result;
      } catch (err) {
        emit('error', msg, { ...fields, duration_ms: elapsed(started), err });
        throw err;
      }
    },
  };
}

function writeStdout(line: string): void {
  process.stdout.write(line + '\n');
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

// JSON.stringify turns an Error into `{}`. Keep what someone reading the log actually needs.
function serialiseErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause !== undefined ? { cause: value.cause } : {}),
    };
  }
  return value;
}
