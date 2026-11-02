import {AsyncLocalStorage} from 'node:async_hooks';

// One JSON object per line. debug/info go to stdout, warn/error to stderr.
//
// Contract:
// - Every record has `time` (ISO 8601), `level` and `message`; `request_id` is
//   added from the request context when there is one.
// - Metadata never replaces those fields: reserved keys in metadata are dropped.
// - JSON.stringify escapes newlines, so a message or value never spans lines.
// - Values under secret-looking keys, registered secret values and URL
//   credentials are replaced by REDACTED before anything is written.
// - Errors are reduced to name, message, code, type, status and stack frames;
//   other properties (body-parser attaches the raw request body) are dropped.

export const LEVELS = Object.freeze({debug: 10, info: 20, warn: 30, error: 40});
export const DEFAULT_LEVEL = 'info';
export const REDACTED = '[REDACTED]';

const RESERVED = new Set(['time', 'level', 'message', 'request_id']);
const SECRET_KEY = /authorization|cookie|passw|^pass$|_pass$|secret|token|api[-_]?key|credential/i;
const URL_CREDENTIALS = /\/\/[^/\s:@]+:[^/\s@]+@/g;
const MAX_DEPTH = 5;

const storage = new AsyncLocalStorage();

// Returns the level to use and whether the configured value was rejected.
// Unset or empty means the default; names are matched case-insensitively.
export function parseLevel(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return {level: DEFAULT_LEVEL, valid: true};
  }
  const name = String(value).trim().toLowerCase();
  return Object.hasOwn(LEVELS, name) ? {level: name, valid: true} : {level: DEFAULT_LEVEL, valid: false};
}

function redactString(value, secrets) {
  let result = value.replace(URL_CREDENTIALS, `//${REDACTED}@`);
  for (const secret of secrets) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

function stackFrames(stack) {
  if (typeof stack !== 'string') return undefined;
  // The first lines repeat the message, which may carry input; keep frames only.
  const frames = stack.split('\n').filter(line => /^\s+at /.test(line)).map(line => line.trim());
  return frames.length ? frames : undefined;
}

export function serializeError(error) {
  const result = {name: error.name, message: String(error.message ?? '')};
  const code = error.code ?? error.cause?.code;
  if (typeof code === 'string' || typeof code === 'number') result.code = code;
  if (typeof error.type === 'string') result.type = error.type;
  const status = error.status ?? error.statusCode;
  if (Number.isInteger(status)) result.status = status;
  const stack = stackFrames(error.stack);
  if (stack) result.stack = stack;
  return result;
}

function sanitize(value, secrets, depth, seen) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  seen.add(value);
  try {
    if (value instanceof Error) return sanitize(serializeError(value), secrets, depth, seen);
    if (Array.isArray(value)) {
      return value.map(item => sanitize(item, secrets, depth + 1, seen) ?? null);
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      const clean = sanitize(item, secrets, depth + 1, seen);
      if (clean !== undefined) result[key] = clean;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

const defaultStreams = {
  get stdout() { return process.stdout; },
  get stderr() { return process.stderr; },
};

export function createLogger({
  level,
  secrets = [],
  stdout,
  stderr,
  now = () => new Date(),
} = {}) {
  const parsed = parseLevel(level);
  const threshold = LEVELS[parsed.level];
  const secretValues = [...new Set(secrets.filter(secret => typeof secret === 'string' && secret !== ''))]
    // Longest first, so a secret containing another is removed whole.
    .sort((a, b) => b.length - a.length);
  const out = () => stdout ?? defaultStreams.stdout;
  const err = () => stderr ?? defaultStreams.stderr;

  function write(name, message, meta, bindings, useContext) {
    if (LEVELS[name] < threshold) return;
    const context = useContext ? storage.getStore() : undefined;
    const record = {
      time: now().toISOString(),
      level: name,
      message: redactString(typeof message === 'string' ? message : String(message), secretValues),
    };
    const requestId = bindings.request_id ?? context?.request_id;
    if (requestId !== undefined) record.request_id = String(requestId);
    const fields = {...bindings, ...(meta && typeof meta === 'object' ? meta : {})};
    let extra;
    try {
      extra = sanitize(fields, secretValues, 0, new WeakSet());
    } catch {
      extra = {log_error: 'metadata could not be serialized'};
    }
    for (const [key, value] of Object.entries(extra)) {
      if (!RESERVED.has(key)) record[key] = value;
    }
    const stream = LEVELS[name] >= LEVELS.warn ? err() : out();
    stream.write(`${JSON.stringify(record)}\n`);
  }

  function build(bindings, useContext) {
    const logger = {
      level: parsed.level,
      isLevelEnabled: name => Object.hasOwn(LEVELS, name) && LEVELS[name] >= threshold,
      // Bindings are fixed fields, including request_id, for callbacks that run
      // outside the request's async context (response events, timers).
      child: extra => build({...bindings, ...extra}, useContext),
      // Ignores the async request context, for events that belong to the
      // process rather than to whichever request happened to trigger them.
      detached: () => build(bindings, false),
    };
    for (const name of Object.keys(LEVELS)) {
      logger[name] = (message, meta) => write(name, message, meta, bindings, useContext);
    }
    return logger;
  }

  const logger = build({}, true);
  if (!parsed.valid) {
    // The rejected value itself is not logged; it is arbitrary environment input.
    logger.warn('invalid LOG_LEVEL, using info', {
      event: 'logger.invalid_level',
      allowed: Object.keys(LEVELS),
    });
  }
  return logger;
}

// Runs fn with the given request context; every log written from code that fn
// starts, including awaited continuations, carries its request_id.
export function runWithContext(context, fn) {
  return storage.run(context, fn);
}

// Runs fn with no request context, so resources it creates (sockets, timers)
// do not keep the id of the request that happened to start them.
export function runWithoutContext(fn) {
  return storage.exit(fn);
}
