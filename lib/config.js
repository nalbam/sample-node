// Parsing of the listen port and of the Redis/Valkey connection settings.
//
// Redis connection, highest priority first:
// 1. REDIS_ENABLED=false turns Redis off, whatever else is set.
// 2. CACHE_VALKEY_URL, a redis:// or rediss:// URL.
// 3. CACHE_VALKEY_HOST with CACHE_VALKEY_PORT, CACHE_VALKEY_USERNAME and
//    CACHE_VALKEY_PASSWORD.
// 4. The legacy REDIS_HOST, REDIS_PORT and REDIS_PASS.
// A Valkey setting that cannot be used is reported by variable name only and
// the next source is tried. Credentials never appear in warnings, and every
// credential value is returned in `secrets` for the logger to redact.

export const DEFAULT_PORT = 3000;
export const DEFAULT_REDIS_PORT = 6379;

/**
 * Parses a TCP port: digits only (surrounding whitespace allowed), 1 to 65535.
 * Anything else, including undefined or empty, returns fallback.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function parsePort(value, fallback) {
  if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

const present = value => typeof value === 'string' && value.trim() !== '';

// Host as written in a URL authority: IPv6 literals are bracketed.
function hostForUrl(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Composes a redis:// or rediss:// URL. Credentials are percent-encoded, so
 * any character, including `@`, `:`, `/` and `%`, survives the round trip
 * through the client's URL parser.
 */
export function buildRedisUrl({tls = false, host, port, database, username, password}) {
  const user = username ? encodeURIComponent(username) : '';
  const pass = password ? `:${encodeURIComponent(password)}` : '';
  const auth = user || pass ? `${user}${pass}@` : '';
  const db = database === undefined ? '' : `/${database}`;
  return `${tls ? 'rediss' : 'redis'}://${auth}${hostForUrl(host)}:${port}${db}`;
}

// Parses CACHE_VALKEY_URL. Returns null when it is not a usable redis:// or
// rediss:// URL. Parse errors are swallowed: their messages quote the input.
function fromValkeyUrl(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') return null;
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) return null;
  let database;
  if (url.pathname && url.pathname !== '/') {
    const match = /^\/(\d+)$/.exec(url.pathname);
    if (!match) return null;
    database = Number(match[1]);
  }
  let username;
  let password;
  try {
    username = url.username ? decodeURIComponent(url.username) : undefined;
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } catch {
    return null;
  }
  return {
    tls: url.protocol === 'rediss:',
    host,
    port: url.port ? Number(url.port) : DEFAULT_REDIS_PORT,
    database,
    username,
    password,
  };
}

// Characters that would change the meaning of the URL authority.
const INVALID_HOST = /[\s/?#@\\[\]]/;

function fromValkeyHost(env) {
  const host = env.CACHE_VALKEY_HOST.trim();
  if (INVALID_HOST.test(host.replace(/^\[(.*)\]$/, '$1'))) return null;
  return {
    tls: false,
    host: host.replace(/^\[(.*)\]$/, '$1'),
    port: parsePort(env.CACHE_VALKEY_PORT, DEFAULT_REDIS_PORT),
    username: present(env.CACHE_VALKEY_USERNAME) ? env.CACHE_VALKEY_USERNAME : undefined,
    password: present(env.CACHE_VALKEY_PASSWORD) ? env.CACHE_VALKEY_PASSWORD : undefined,
  };
}

/**
 * Resolves the Redis connection from the environment.
 *
 * Returns:
 * - enabled: false only for REDIS_ENABLED=false (case-insensitive).
 * - source: the variable the connection comes from: CACHE_VALKEY_URL,
 *   CACHE_VALKEY_HOST or REDIS_HOST; null when disabled.
 * - host, port, tls: safe to log.
 * - clientOptions: url (and password for the legacy settings) for
 *   redis.createClient(). Never log it.
 * - secrets: credential values to redact from every log.
 * - warnings: {variable, reason} for ignored Valkey settings.
 */
export function resolveRedisConfig(env = process.env) {
  const secrets = [];
  const warnings = [];
  const addSecrets = (...values) => secrets.push(...values.filter(present));

  addSecrets(env.REDIS_PASS, env.CACHE_VALKEY_PASSWORD, env.CACHE_VALKEY_URL);
  if (present(env.CACHE_VALKEY_PASSWORD)) addSecrets(encodeURIComponent(env.CACHE_VALKEY_PASSWORD));

  let valkey = null;
  let source = null;
  if (present(env.CACHE_VALKEY_URL)) {
    valkey = fromValkeyUrl(env.CACHE_VALKEY_URL);
    if (valkey) {
      source = 'CACHE_VALKEY_URL';
      if (valkey.password) addSecrets(valkey.password, encodeURIComponent(valkey.password));
    } else {
      warnings.push({variable: 'CACHE_VALKEY_URL', reason: 'not a valid redis:// or rediss:// URL'});
    }
  }
  if (!valkey && present(env.CACHE_VALKEY_HOST)) {
    valkey = fromValkeyHost(env);
    if (valkey) source = 'CACHE_VALKEY_HOST';
    else warnings.push({variable: 'CACHE_VALKEY_HOST', reason: 'not a valid host name or address'});
  }

  const enabled = String(env.REDIS_ENABLED ?? '').trim().toLowerCase() !== 'false';
  const unique = [...new Set(secrets)];
  if (!enabled) {
    return {enabled, source: null, host: null, port: null, tls: false, clientOptions: null, secrets: unique, warnings};
  }

  if (valkey) {
    const url = buildRedisUrl(valkey);
    addSecrets(url);
    return {
      enabled,
      source,
      host: valkey.host,
      port: valkey.port,
      tls: valkey.tls,
      clientOptions: {url},
      secrets: [...new Set(secrets)],
      warnings,
    };
  }

  const host = env.REDIS_HOST ?? 'redis';
  const port = parseInt(env.REDIS_PORT, 10) || DEFAULT_REDIS_PORT;
  const password = env.REDIS_PASS ?? '';
  return {
    enabled,
    source: 'REDIS_HOST',
    host,
    port,
    tls: false,
    clientOptions: {url: `redis://${host}:${port}`, ...(password && {password})},
    secrets: unique,
    warnings,
  };
}
