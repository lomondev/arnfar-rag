/**
 * Structured logging for rag-api.
 *
 * Deliberately dependency-free: one JSON object per line, which `jq` reads and any log
 * shipper parses, with a human-readable mode for the terminal. A local-first product ships
 * to machines nobody can SSH into — the log file is the only diagnostic that survives, so
 * it has to be parseable without a service backing it.
 *
 * Levels are ordered; LOG_LEVEL sets the floor (default "info", "debug" for development).
 * Format follows LOG_FORMAT: "pretty" when attached to a TTY, "json" otherwise.
 */

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

/** Anything safe to serialize into a log line. */
export type LogValue = string | number | boolean | null | undefined;
export type Fields = Readonly<Record<string, LogValue>>;

const LEVEL_RANK: Readonly<Record<Level, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLevel(raw: string | undefined, fallback: Level): Level {
  const v = raw?.toLowerCase();
  return LEVELS.includes(v as Level) ? (v as Level) : fallback;
}

const MIN_RANK = LEVEL_RANK[parseLevel(process.env.LOG_LEVEL, "info")];

/** Pretty when a human is watching, JSON when something else is reading. */
const PRETTY = (process.env.LOG_FORMAT ?? (process.stdout.isTTY ? "pretty" : "json")) === "pretty";

const COLOR: Readonly<Record<Level, string>> = {
  debug: "\x1b[2;37m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function render(level: Level, scope: string, msg: string, fields: Fields): string {
  const time = new Date().toISOString();
  if (!PRETTY) {
    return JSON.stringify({ time, level, scope, msg, ...fields });
  }
  const pairs = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" && v.includes(" ") ? JSON.stringify(v) : v}`)
    .join(" ");
  const head = `${COLOR[level]}${level.padEnd(5)}${RESET} \x1b[2m${time.slice(11, 23)}${RESET} [${scope}]`;
  return pairs ? `${head} ${msg} ${pairs}` : `${head} ${msg}`;
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  /** `err` is unwrapped to its message; the stack goes to `stack` at debug level only. */
  error(msg: string, err?: unknown, fields?: Fields): void;
  /** Derive a logger for a sub-component: `log.child("worker")` → scope "ingest:worker". */
  child(scope: string): Logger;
  /** Time an operation and log its duration. Rethrows after logging a failure. */
  timed<T>(msg: string, fn: () => Promise<T>, fields?: Fields): Promise<T>;
}

function write(level: Level, scope: string, msg: string, fields: Fields): void {
  if (LEVEL_RANK[level] < MIN_RANK) return;
  const line = render(level, scope, msg, fields);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

/** Pull a message out of anything a `catch` can hand you. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, fields = {}) => write("debug", scope, msg, fields),
    info: (msg, fields = {}) => write("info", scope, msg, fields),
    warn: (msg, fields = {}) => write("warn", scope, msg, fields),
    error: (msg, err, fields = {}) =>
      write("error", scope, msg, {
        ...fields,
        ...(err === undefined ? {} : { err: errorMessage(err) }),
        ...(err instanceof Error && LEVEL_RANK.debug >= MIN_RANK ? { stack: err.stack } : {}),
      }),
    child: (sub) => createLogger(`${scope}:${sub}`),
    timed: async (msg, fn, fields = {}) => {
      const started = performance.now();
      try {
        const out = await fn();
        write("info", scope, msg, { ...fields, ms: Math.round(performance.now() - started) });
        return out;
      } catch (err) {
        write("error", scope, `${msg} failed`, {
          ...fields,
          ms: Math.round(performance.now() - started),
          err: errorMessage(err),
        });
        throw err;
      }
    },
  };
}

/** Root logger. Prefer `log.child("feature")` over creating a second root. */
export const log = createLogger("rag-api");
