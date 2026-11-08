// env
const CLUSTER = process.env.CLUSTER_NAME ?? 'local';
const FAULT_RATE = parseFloat(process.env.FAULT_RATE) || 0;
const HOSTNAME = process.env.HOSTNAME ?? 'default.svc.cluster.local';
const LOOP_HOST = process.env.LOOP_HOST ?? `http://sample-node`;
const MESSAGE = process.env.MESSAGE ?? '';
const PORT = parsePort(process.env.PORT, DEFAULT_PORT);
const PROFILE = process.env.PROFILE ?? 'default';
const PROTOCOL = process.env.PROTOCOL ?? 'http';
// CACHE_VALKEY_* first, then the legacy REDIS_* settings; see lib/config.js.
const REDIS_CONFIG = resolveRedisConfig(process.env);
const REDIS_ENABLED = REDIS_CONFIG.enabled;
const REDIS_TIMEOUT_MS = parseRedisTimeout(process.env.REDIS_TIMEOUT_MS);
const VERSION = process.env.VERSION ?? 'v0.0.0';

const MB = 1024 * 1024;

import os from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DEFAULT_PORT, parsePort, resolveRedisConfig } from './lib/config.js';
import { createLogger, runWithContext, secretsFromHeaders } from './lib/logger.js';
import { createRedisAccess, parseRedisTimeout, RedisUnavailableError } from './lib/redis.js';
import { createTelemetry } from './lib/telemetry.js';
import { createTelemetryStore, startTelemetryPublisher, validCursor } from './lib/telemetry-store.js';
import { createShutdownManager, parseShutdownTimeout } from './lib/shutdown.js';

import cors from 'cors';
import express from 'express';
import moment from 'moment-timezone';
import redis from 'redis';
import prom from 'prom-client';

// Express's own default responder, resolved from express so the version always
// matches. The error handler below answers through it without its console output.
const require = createRequire(import.meta.url);
const finalhandler = createRequire(require.resolve('express'))('finalhandler');

// Request logs carry request_id from the async context set by the first
// middleware. Process-level events use serviceLog, which never has one.
const logger = createLogger({level: process.env.LOG_LEVEL, secrets: REDIS_CONFIG.secrets});
const serviceLog = logger.detached();
// Safe to log: never includes credentials.
const redisTarget = {redis_source: REDIS_CONFIG.source, redis_host: REDIS_CONFIG.host, redis_port: REDIS_CONFIG.port, redis_tls: REDIS_CONFIG.tls};
for (const {variable, reason} of REDIS_CONFIG.warnings) {
  // The value itself is not logged; it can carry credentials.
  serviceLog.warn(`ignoring ${variable}: ${reason}`, {event: 'redis.config_invalid', variable});
}

// Secret header values (Authorization, Cookie) of each request, removed from
// every log of that request, including error messages and stacks.
const requestSecrets = new WeakMap();

// A logger bound to the request's id and secrets, for callbacks that run
// outside the request's async context (response events, timers).
function requestLogger(req) {
  return logger.child({request_id: req.id}, {secrets: requestSecrets.get(req) ?? []});
}

// redis
const client = REDIS_ENABLED ? redis.createClient({
  ...REDIS_CONFIG.clientOptions,
  // A command issued while there is no ready connection fails at once
  // instead of waiting in the offline queue and running after recovery.
  disableOfflineQueue: true,
  socket: {
    connectTimeout: REDIS_TIMEOUT_MS,
    // No background reconnect: its handshake would have no time limit. The
    // next request or publish that needs Redis opens a new connection within
    // its own REDIS_TIMEOUT_MS budget (lib/redis.js).
    reconnectStrategy: false,
  }
}) : null;
// The shared client's events belong to the process, not to the request that
// happened to open the connection.
client?.on('connect', () => {
  serviceLog.info('connected to redis', {event: 'redis.connected', ...redisTarget});
});
client?.on('error', err => {
  serviceLog.error('redis client error', {event: 'redis.error', error: err});
});

// One REDIS_TIMEOUT_MS budget per Redis operation, from waiting for the
// connection to the last reply. See lib/redis.js.
const redisAccess = client ? createRedisAccess({client, timeoutMs: REDIS_TIMEOUT_MS, logger}) : null;

// express
const app = express();
app.set('view engine', 'ejs');

// Client ids are reused only when they are 1-128 ASCII letters, digits, '-' or '_';
// anything else is replaced, never trimmed, so arbitrary input never becomes the id.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Registered first so every response, including static files, 404s and errors,
// carries the id and is logged under it.
//
// Completion: 'finish' means the whole response was handed to the OS, and logs
// one info `http.request.completed` record. 'close' without 'finish' means the
// client went away first and logs one warn `http.request.aborted` record
// instead. Whichever fires first wins, so a request never logs both.
app.use((req, res, next) => {
  const started = performance.now();
  const requestId = req.get('X-Request-Id');
  req.id = requestId && REQUEST_ID_PATTERN.test(requestId) ? requestId : randomUUID();
  res.set('X-Request-Id', req.id);
  const secrets = secretsFromHeaders(req.headers);
  requestSecrets.set(req, secrets);

  // Response events run outside the request's async context, so bind the id.
  const log = requestLogger(req);
  const fields = () => ({
    method: req.method,
    path: req.originalUrl.split('?')[0],
    status: res.statusCode,
    duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
  });
  let logged = false;
  res.once('finish', () => {
    if (logged) return;
    logged = true;
    log.info('request completed', {event: 'http.request.completed', ...fields()});
  });
  res.once('close', () => {
    if (logged) return;
    logged = true;
    log.warn('request aborted', {event: 'http.request.aborted', ...fields()});
  });

  runWithContext({request_id: req.id, secrets}, next);
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(['/telemetry', '/cache'], (req, res, next) => {
  if (!REDIS_ENABLED) {
    return res.status(404).json({result: 'error', message: 'Redis features disabled'});
  }
  next();
});

// prom-client
const register = new prom.Registry();
prom.collectDefaultMetrics({ register });

function sleep(sec) {
  return new Promise(resolve => setTimeout(resolve, sec * 1000));
}

// Node fires a timer longer than 2147483647ms (about 24.8 days) after 1ms, so
// /delay accepts no more than MAX_DELAY_SEC seconds.
const MAX_TIMER_MS = 2147483647;
const MAX_DELAY_SEC = MAX_TIMER_MS / 1000;

// A decimal number such as 5, -0.5, .5 or 1e2. Hex, Infinity, NaN, blanks and
// partial numbers such as 5abc are not numbers here. Each digit run has one
// way to match, so a long partial number fails in linear time.
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

// Returns the number the whole of value spells when it is finite and within
// min..max inclusive, else null.
function parseNumberInRange(value, min, max) {
  if (!DECIMAL_PATTERN.test(value)) {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    return null;
  }
  return number;
}

const sampleTelemetry = createTelemetry();
const INSTANCE_ID = randomUUID();
const STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();
sampleTelemetry();
const telemetryStore = client ? createTelemetryStore(client, `sample-node:telemetry:${encodeURIComponent(CLUSTER)}:${encodeURIComponent(PROFILE)}`) : null;

// The /health contract shared by sample-node, sample-spring and sample-tomcat:
// result is lowercase "ok" or "error", version is a string and uptime is whole
// seconds since the process started, and service is the exact name of the
// service that answered ("sample-node", "sample-spring" or "sample-tomcat").
// Other fields such as type are allowed.
// Returns why a body breaks the contract for expectedService, or null when it
// follows it. The reason is a fixed string and never contains remote values.
function healthContractViolation(body, expectedService) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body is not a JSON object';
  if (body.result !== 'ok' && body.result !== 'error') return 'result is not "ok" or "error"';
  if (typeof body.version !== 'string') return 'version is not a string';
  if (!Number.isInteger(body.uptime) || body.uptime < 0) return 'uptime is not a non-negative integer';
  if (body.service !== expectedService) return `service is not "${expectedService}"`;
  return null;
}

// Calls /health of a remote sample service and answers with its status and body.
// With checkHealthContract, a body that is not JSON, breaks the health contract
// or names a service other than sample-<serviceName> is answered with 502
// instead, and a valid "error" body from that service still passes through.
// Without it (/node), the body is passed through without any check.
// A failed call (connection, or reading the body) is answered with 500.
async function handleRemoteService(res, serviceName, {checkHealthContract = false} = {}) {
  logger.debug(`get /${serviceName}`);
  const remoteService = PROFILE === 'default' ? `http://sample-${serviceName}` : `${PROTOCOL}://sample-${serviceName}.${HOSTNAME}`;

  let response;
  let text;
  try {
    response = await fetch(`${remoteService}/health`);
    if (!checkHealthContract) {
      const body = await response.json();
      return res.status(response.status).json(body);
    }
    text = await response.text();
  } catch (err) {
    logger.error('remote service call failed', {event: 'remote.failed', service: serviceName, error: err});
    return res.status(500).json({
      result: 'error',
    });
  }

  let body;
  let violation;
  try {
    body = JSON.parse(text);
    violation = healthContractViolation(body, `sample-${serviceName}`);
  } catch {
    violation = 'body is not valid JSON';
  }
  if (violation) {
    logger.error('remote service broke the health contract', {
      event: 'remote.invalid_response', service: serviceName, status: response.status, reason: violation,
    });
    return res.status(502).json({
      result: 'error',
    });
  }
  return res.status(response.status).json(body);
}

app.get('/node', async (req, res) => handleRemoteService(res, 'node'));
app.get('/spring', async (req, res) => handleRemoteService(res, 'spring', {checkHealthContract: true}));
app.get('/tomcat', async (req, res) => handleRemoteService(res, 'tomcat', {checkHealthContract: true}));

app.get('/', async function (req, res) {
  logger.debug(`get /`);

  const host = os.hostname();
  const date = moment().tz('Asia/Seoul').format();
  res.set('Cache-Control', 'no-store');
  res.render('index.ejs', {
    redisAvailable: redisAccess ? await redisAccess.available() : false,
    host: host,
    date: date,
    cluster: CLUSTER,
    profile: PROFILE,
    message: MESSAGE,
    version: VERSION,
  });
});

app.get('/drop', async function (req, res) {
  logger.debug(`get /drop`);

  res.render('drop.ejs', {
    rate: 100,
  });
});

app.get('/drop/:rate', async function (req, res) {
  const rate = parseNumberInRange(req.params.rate, 0, 100);

  logger.debug(`get /drop/${req.params.rate}`);

  if (rate === null) {
    return res.status(400).json({
      result: 'error',
      message: 'Invalid rate value',
    });
  }

  res.render('drop.ejs', {
    rate: rate,
  });
});

app.get('/read', async function (req, res) {
  logger.debug(`get /read`);

  return res.status(200).json({
    result: 'read',
  });
});

// Set by startServer. Once shutdown begins, /ready fails so the load balancer
// stops routing here while in-flight requests finish; /live keeps answering.
let shutdownManager = null;

app.get('/ready', function (req, res) {
  logger.debug(`get /ready`);

  if (shutdownManager?.isShuttingDown) {
    return res.status(503).json({ ready: false });
  }
  return res.status(200).json({ ready: true });
});

app.get('/live', async function (req, res) {
  logger.debug(`get /live`);

  return res.status(200).json({ live: true });
});

app.get('/version', function (req, res) {
  logger.debug(`get /version`);

  return res.status(200).json({
    version: VERSION,
    node: process.version,
  });
});

app.get('/runtime', function (req, res) {
  logger.debug(`get /runtime`);

  return res.status(200).json({
    node: process.version,
    platform: process.platform,
  });
});

app.get('/uptime', function (req, res) {
  logger.debug(`get /uptime`);

  return res.status(200).json({
    uptime: process.uptime(),
  });
});

app.get('/ping', function (req, res) {
  logger.debug(`get /ping`);

  return res.status(200).json({ pong: true });
});

app.get('/echo', function (req, res) {
  logger.debug(`get /echo`);

  const msg = req.query.msg;

  if (typeof msg !== 'string' || msg === '') {
    return res.status(400).json({ error: 'msg is required' });
  }

  return res.status(200).json({ echo: msg });
});

app.get('/time', function (req, res) {
  logger.debug(`get /time`);

  return res.status(200).json({ time: new Date().toISOString() });
});

app.get('/random', function (req, res) {
  logger.debug(`get /random`);

  return res.status(200).json({ value: Math.random() });
});

app.get('/uuid', function (req, res) {
  logger.debug(`get /uuid`);

  return res.status(200).json({ uuid: randomUUID() });
});

app.get('/hostname', function (req, res) {
  logger.debug(`get /hostname`);

  return res.status(200).json({ hostname: os.hostname() });
});

app.get('/health', async function (req, res) {
  logger.debug(`get /health`);

  if (Math.random() * 100 >= FAULT_RATE) {
    return res.status(200).json({
      result: 'ok',
      version: VERSION,
      uptime: Math.round(process.uptime()),
      service: 'sample-node',
    });
  } else {
    return res.status(500).json({
      result: 'error',
      version: VERSION,
      uptime: Math.round(process.uptime()),
      service: 'sample-node',
    });
  }
});

// The dashboard polls /status every second and the publisher snapshots every
// second, so neither adds its own log line; each /status request still logs one
// info completion record, which LOG_LEVEL=warn suppresses.
function statusSnapshot() {
  return {
    result: 'ok',
    host: os.hostname(),
    cluster: CLUSTER,
    version: VERSION,
    instanceId: INSTANCE_ID,
    startedAt: STARTED_AT,
    sampledAt: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    ...sampleTelemetry(),
    oom: {...oomState},
  };
}

app.get('/status', function (req, res) {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json(statusSnapshot());
});

app.get('/telemetry', async function (req, res) {
  res.set('Cache-Control', 'no-store');
  const after = req.query.after;
  if (after !== undefined && !validCursor(after)) {
    return res.status(400).json({result: 'error', message: 'Invalid telemetry cursor'});
  }
  try {
    return res.json({result: 'ok', ...await redisAccess.run(() => telemetryStore.read(after))});
  } catch (error) {
    // An unavailable Redis is already logged by redisAccess.
    if (!(error instanceof RedisUnavailableError)) {
      logger.error('telemetry read failed', {event: 'telemetry.read_failed', error});
    }
    return res.status(503).json({result: 'error', message: 'Telemetry storage unavailable'});
  }
});

app.get('/loop/:count', async function (req, res) {
  let count = parseInt(req.params.count, 10);

  logger.debug(`get /loop/${req.params.count}`);

  if (Number.isNaN(count) || count < 0) {
    return res.status(400).json({
      result: 'error',
      message: 'Invalid count value',
    });
  }

  if (count <= 0) {
    return res.status(200).json({
      result: 'ok',
      version: VERSION,
    });
  }

  count--;

  const remoteService = LOOP_HOST;

  try {
    const response = await fetch(`${remoteService}/loop/${count}`);
    const body = await response.json();
    return res.status(response.status).json({
      result: 'ok',
      version: VERSION,
      data: body
    });
  } catch (err) {
    logger.error('loop call failed', {event: 'loop.failed', error: err});
    return res.status(500).json({
      result: 'error',
      version: VERSION,
    });
  }
});

// Load target. One request burns a fixed slice of CPU, so a steady request rate
// lands as a predictable amount of CPU spread over whatever pods are behind the
// service — which is the average an HPA scales on. The total stays put as pods
// come and go, so the per-pod share falls when one scales up.
//
// Capped because the burn blocks the event loop for its whole duration; past a
// second the liveness probe starts timing out and the pod restart becomes the
// demo instead.
const WORK_MAX_MS = 1000;

function burn(ms) {
  const end = performance.now() + ms;
  let sum = 0;
  while (performance.now() < end) {
    sum += Math.sqrt(sum + 1);
  }
  return sum;
}

// No handler log: the load switch calls this many times a second. Each request
// still logs one info completion record; LOG_LEVEL=warn suppresses those so the
// warn/error lines stand out.
app.get('/work/:ms', async function (req, res) {
  const ms = parseFloat(req.params.ms);

  if (Number.isNaN(ms) || ms < 0 || ms > WORK_MAX_MS) {
    return res.status(400).json({
      result: 'error',
      message: 'Invalid ms value',
    });
  }

  burn(ms);

  return res.status(200).json({
    result: 'ok',
    host: os.hostname(),
    ms: ms,
    version: VERSION,
  });
});

// Kill switch. Off-heap buffers grow RSS past the container memory limit, so the
// kernel OOM killer ends the process with exit 137 (k8s: OOMKilled) instead of
// V8 aborting on its own heap limit with 134.
const OOM_FILL_MS = 30000;
const OOM_INTERVAL_MS = 500;

// Aim past the limit rather than exactly at it, so rounding and a moving RSS
// cannot leave the fill just short of the kill.
const OOM_TARGET_RATIO = 1.1;

// Safety cap, ~1.2Gi, for a process with no memory limit at all, where
// unbounded growth would take the whole machine down instead of just this
// process. A pod with a limit is killed by the kernel long before any cap.
const OOM_MAX_BYTES = 1229 * MB;

const oomBallast = [];
let oomTimer = null;
const oomState = {active: false, startedAt: null, allocatedBytes: 0, capped: false};

// `log` is bound to the request that started the fill, so the plan and every
// timer line keep its request_id; later POSTs return here without touching it.
function startOomAllocation(log) {
  if (oomTimer || shutdownManager?.isShuttingDown) {
    return;
  }
  oomState.active = true;
  oomState.startedAt = new Date().toISOString();

  // Size each chunk to the headroom that actually exists, so the fill takes
  // about OOM_FILL_MS whatever the limit is. A fixed rate either dies in a few
  // seconds on a small pod — too fast for a metrics scrape to show anything —
  // or never reaches a limit larger than the cap.
  const limit = process.constrainedMemory();
  const target = limit ? limit * OOM_TARGET_RATIO : OOM_MAX_BYTES;
  const headroom = Math.max(target - process.memoryUsage.rss(), 0);
  const chunk = Math.max(Math.ceil(headroom / (OOM_FILL_MS / OOM_INTERVAL_MS)), 1);
  // With a limit the kernel does the stopping; the cap is only for the case
  // where nothing else would.
  const cap = limit ? Infinity : OOM_MAX_BYTES;

  log.info(`oom: limit ${limit ? `${Math.round(limit / MB)}mb` : 'none'}, filling ${Math.round(headroom / MB)}mb over ${OOM_FILL_MS / 1000}s in ${Math.round(chunk / MB)}mb chunks`, {
    event: 'oom.started',
    limit_bytes: limit || null,
    headroom_bytes: headroom,
    chunk_bytes: chunk,
  });

  oomTimer = setInterval(() => {
    if (oomBallast.length * chunk >= cap) {
      clearInterval(oomTimer);
      oomState.active = false;
      oomState.capped = true;
      log.warn(`oom: stopped at the ${Math.round(OOM_MAX_BYTES / MB)}mb cap, this process has no memory limit`, {event: 'oom.capped'});
      return;
    }

    // Fill with a non-zero byte. A zero-filled buffer is backed by the kernel
    // zero page, so it never commits real memory and RSS stays flat.
    oomBallast.push(Buffer.alloc(chunk, 1));
    oomState.allocatedBytes += chunk;
    const rss = process.memoryUsage.rss();
    log.info(`oom: rss ${Math.round(rss / MB)}mb`, {event: 'oom.progress', rss_bytes: rss, allocated_bytes: oomState.allocatedBytes});
  }, OOM_INTERVAL_MS);
}

// POST so a prefetch, crawler or probe can never kill the instance.
app.post('/oom', async function (req, res) {
  logger.debug(`post /oom`);

  // Allocate only after the response is flushed, so the caller learns which
  // instance is going down.
  const log = requestLogger(req);
  res.on('finish', () => startOomAllocation(log));

  return res.status(202).json({
    result: 'oom',
    host: os.hostname(),
    version: VERSION,
    instanceId: INSTANCE_ID,
    fillMs: OOM_FILL_MS,
  });
});

function handleRateBasedResponse(res, rate, successCondition) {
  if (successCondition(rate)) {
    return res.status(200).json({
      result: 'ok',
      rate: rate,
      version: VERSION,
    });
  } else {
    return res.status(500).json({
      result: 'error',
      rate: rate,
      version: VERSION,
    });
  }
}

app.get('/success/:rate', async function (req, res) {
  const rate = parseNumberInRange(req.params.rate, 0, 100);

  logger.debug(`get /success/${req.params.rate}`);

  if (rate === null) {
    return res.status(400).json({
      result: 'error',
      message: 'Invalid rate value',
    });
  }

  return handleRateBasedResponse(res, rate, (rate) => Math.random() * 100 <= rate);
});

app.get('/fault/:rate', async function (req, res) {
  const rate = parseNumberInRange(req.params.rate, 0, 100);

  logger.debug(`get /fault/${req.params.rate}`);

  if (rate === null) {
    return res.status(400).json({
      result: 'error',
      message: 'Invalid rate value',
    });
  }

  return handleRateBasedResponse(res, rate, (rate) => Math.random() * 100 >= rate);
});

app.get('/delay/:sec', async function (req, res) {
  const sec = parseNumberInRange(req.params.sec, 0, MAX_DELAY_SEC);

  logger.debug(`get /delay/${req.params.sec}`);

  if (sec === null || sec * 1000 > MAX_TIMER_MS) {
    return res.status(400).json({
      result: 'error',
      message: 'Invalid sec value',
    });
  }

  await sleep(sec);
  return res.status(200).json({
    result: 'ok',
    sec: sec,
    version: VERSION,
  });
});

// Unavailable Redis (unreachable, connection lost, or no answer within
// REDIS_TIMEOUT_MS) answers 503; anything else, such as a value that is not
// JSON, answers 500 as before.
function cacheFailure(res, err) {
  if (err instanceof RedisUnavailableError) {
    return res.status(503).json({
      status: 503,
      message: 'redis unavailable',
    });
  }
  logger.error('cache operation failed', {event: 'cache.failed', error: err});
  return res.status(500).json({
    status: 500,
    message: 'internal server error',
  });
}

app.get('/cache/:name', async function (req, res) {
  const name = req.params.name;

  logger.debug(`get /cache/${name}`);

  try {
    const result = await redisAccess.run(redis => redis.get(`cache:${name}`));
    return res.status(200).json(result == null ? {} : JSON.parse(result));
  } catch (err) {
    return cacheFailure(res, err);
  }
});

// PUT because the client picks the key and the value is replaced wholesale.
// A PUT that times out after SET was sent may or may not have been applied; it
// is answered 503 and never retried by the app.
app.put('/cache/:name', async function (req, res) {
  const name = req.params.name;

  logger.debug(`put /cache/${name}`);

  const json = JSON.stringify(req.body);
  try {
    const result = await redisAccess.run(redis => redis.set(`cache:${name}`, json));
    return res.status(200).json(result == null ? {} : result);
  } catch (err) {
    return cacheFailure(res, err);
  }
});

app.get('/metrics', async function (req, res) {
  logger.debug(`get /metrics`);

  res.setHeader('Content-Type', register.contentType);
  return res.send(await register.metrics());
});

// Last handler: logs errors passed to next() or thrown by a route, then answers
// through Express's default responder, so status and body stay unchanged. For
// client errors (4xx) only the error kind is logged: their messages can quote
// the request body, e.g. a JSON parse failure.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = [err?.status, err?.statusCode].find(code => Number.isInteger(code) && code >= 400 && code < 600)
    ?? (res.statusCode >= 400 && res.statusCode < 600 ? res.statusCode : 500);
  const log = requestLogger(req);
  if (status < 500) {
    log.warn('request rejected', {
      event: 'http.request.error',
      status,
      error: {name: err?.name, ...(typeof err?.type === 'string' && {type: err.type})},
    });
  } else {
    log.error('request failed', {event: 'http.request.error', status, error: err});
  }
  finalhandler(req, res, {env: app.get('env')})(err);
});

export default app;

// Starts the HTTP server, the telemetry publisher (when Redis is enabled) and
// the shutdown coordinator. It registers no signal listeners: the entry point
// below does that, so importing this module stays free of process-wide effects.
//
// Returns {server, shutdown(signal)}. shutdown() is idempotent: every call
// returns the same Promise of the exit code. It stops accepting connections,
// stops the publisher and the OOM fill, waits for in-flight requests and the
// in-flight publish, then closes Redis and calls exit(0). Past
// SHUTDOWN_TIMEOUT_MS it destroys the remaining connections and Redis and
// calls exit(1).
export function startServer({port = PORT, exit = code => process.exit(code)} = {}) {
  const timeoutMs = parseShutdownTimeout(process.env.SHUTDOWN_TIMEOUT_MS);

  let stopPublisher = () => {};
  let publishing = null;
  if (REDIS_ENABLED) {
    serviceLog.info('connecting to redis', {event: 'redis.connecting', ...redisTarget});
    stopPublisher = startTelemetryPublisher(() => {
      if (shutdownManager?.isShuttingDown) return undefined;
      // The publisher's stop only cancels the next tick, so shutdown waits on
      // this Promise for a publish that is already running. The publisher
      // reports a failure of run through onError; the tracked copy only
      // signals completion, so it settles without rejecting.
      // Bounded by REDIS_TIMEOUT_MS, so a stalled Redis never stops the next
      // tick. An unavailable Redis is logged by redisAccess and retried by the
      // next tick on a new connection; other failures reach onError.
      const run = (async () => {
        try {
          await redisAccess.run(() => telemetryStore.publish(statusSnapshot()));
        } catch (error) {
          if (!(error instanceof RedisUnavailableError)) throw error;
        }
      })();
      publishing = run.then(() => {}, () => {}).finally(() => { publishing = null; });
      return run;
    }, error => serviceLog.error('telemetry publish failed', {event: 'telemetry.publish_failed', error}));
  }

  // In-flight requests, counted from 'request' until the response closes
  // (finished or aborted), including requests pipelined on open connections.
  let activeRequests = 0;
  let requestsDone = null;
  let resolveRequestsDone = () => {};

  const server = app.listen(port, function (error) {
    if (error) {
      serviceLog.error('server failed to listen', {event: 'server.listen_failed', port, error});
      return;
    }
    const actualPort = server.address().port;
    serviceLog.info(`[${PROFILE}] Listening on port ${actualPort}!`, {event: 'server.listening', port: actualPort, profile: PROFILE, version: VERSION, log_level: logger.level});
  });
  server.on('request', (req, res) => {
    activeRequests++;
    res.once('close', () => {
      activeRequests--;
      if (activeRequests === 0) resolveRequestsDone();
    });
  });

  let serverClosed = null;

  function stopOom() {
    clearInterval(oomTimer);
    oomTimer = null;
    oomState.active = false;
  }

  shutdownManager = createShutdownManager({
    timeoutMs,
    onStart(signal) {
      // The listener is closed before the shutdown is announced. Closing it
      // takes a moment, and until the listening socket is gone the port still
      // accepts connections, so a client that reacts to the 'shutdown started'
      // record must already find the port closed.
      serverClosed = new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
      serviceLog.info('shutdown started', {event: 'shutdown.started', signal, timeout_ms: timeoutMs, active_requests: activeRequests});
      stopPublisher();
      stopOom();
    },
    async drain() {
      if (activeRequests > 0) {
        requestsDone = new Promise(resolve => { resolveRequestsDone = resolve; });
        await requestsDone;
      }
      await publishing;
    },
    async cleanup() {
      // Only idle keep-alive connections remain; drop them so close() settles.
      server.closeIdleConnections();
      await serverClosed;
      // No new connection from here on; a connect still in flight is waited
      // for and, when it completes, torn down again.
      await redisAccess?.close();
    },
    forceClose() {
      server.closeAllConnections();
      stopOom();
      redisAccess?.destroy();
    },
    onError(error, {phase, signal}) {
      serviceLog.error('shutdown failed', {event: 'shutdown.failed', phase, signal, error});
    },
    exit(code) {
      const level = code === 0 ? 'info' : 'error';
      serviceLog[level]('shutdown completed', {event: 'shutdown.completed', exit_code: code});
      exit(code);
    },
  });

  return {
    server,
    shutdown: signal => shutdownManager.begin(signal),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {shutdown} = startServer();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    // A repeated signal reaches the same begin(), which neither restarts the
    // cleanup nor extends the deadline.
    process.on(signal, () => {
      if (shutdownManager.isShuttingDown) {
        serviceLog.warn('shutdown already in progress', {event: 'shutdown.signal_repeated', signal});
      }
      shutdown(signal);
    });
  }
}
