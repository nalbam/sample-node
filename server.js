// env
const CLUSTER = process.env.CLUSTER_NAME ?? 'local';
const FAULT_RATE = parseFloat(process.env.FAULT_RATE) || 0;
const HOSTNAME = process.env.HOSTNAME ?? 'default.svc.cluster.local';
const LOOP_HOST = process.env.LOOP_HOST ?? `http://sample-node`;
const MESSAGE = process.env.MESSAGE ?? '';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const PROFILE = process.env.PROFILE ?? 'default';
const PROTOCOL = process.env.PROTOCOL ?? 'http';
const REDIS_HOST = process.env.REDIS_HOST ?? 'redis';
const REDIS_PORT = parseInt(process.env.REDIS_PORT, 10) || 6379;
const REDIS_PASS = process.env.REDIS_PASS ?? '';
const VERSION = process.env.VERSION ?? 'v0.0.0';

const MB = 1024 * 1024;

import os from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { createTelemetry } from './lib/telemetry.js';
import { createTelemetryStore, startTelemetryPublisher, validCursor } from './lib/telemetry-store.js';

import cors from 'cors';
import express from 'express';
import moment from 'moment-timezone';
import redis from 'redis';
import prom from 'prom-client';

// redis
const client = redis.createClient({
  url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
  password: REDIS_PASS,
  socket: {
    connectTimeout: 2000,
    // Stop retrying so a request fails fast instead of hanging. The next
    // request that needs redis starts a fresh attempt.
    reconnectStrategy: retries => (retries >= 2 ? new Error('redis unreachable') : 100),
  }
});
client.on('connect', () => {
  console.log(`connected to redis: ${REDIS_HOST}:${REDIS_PORT}`);
});
client.on('error', err => {
  console.error(`${err}`);
});

// The redis v4 client needs an explicit connect. Concurrent requests share the
// in-flight attempt so they never open a second connection.
let connecting = null;

function ensureRedisConnection() {
  if (client.isOpen) {
    return Promise.resolve(true);
  }
  if (!connecting) {
    connecting = client.connect()
      .then(() => true)
      .catch(err => {
        console.error(`failed to connect redis: ${err}`);
        return false;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

// express
const app = express();
app.set('view engine', 'ejs');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// prom-client
const register = new prom.Registry();
prom.collectDefaultMetrics({ register });

function sleep(sec) {
  return new Promise(resolve => setTimeout(resolve, sec * 1000));
}

const sampleTelemetry = createTelemetry();
const INSTANCE_ID = randomUUID();
const STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();
sampleTelemetry();
const telemetryStore = createTelemetryStore(client, `sample-node:telemetry:${encodeURIComponent(CLUSTER)}:${encodeURIComponent(PROFILE)}`);

async function handleRemoteService(res, serviceName) {
  console.log(`get /${serviceName}`);
  const remoteService = PROFILE === 'default' ? `http://sample-${serviceName}` : `${PROTOCOL}://sample-${serviceName}.${HOSTNAME}`;

  try {
    const response = await fetch(`${remoteService}/health`);
    const body = await response.json();
    return res.status(response.status).json(body);
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).json({
      result: 'error',
    });
  }
}

app.get('/node', async (req, res) => handleRemoteService(res, 'node'));
app.get('/spring', async (req, res) => handleRemoteService(res, 'spring'));
app.get('/tomcat', async (req, res) => handleRemoteService(res, 'tomcat'));

app.get('/', async function (req, res) {
  console.log(`get /`);

  const host = os.hostname();
  const date = moment().tz('Asia/Seoul').format();
  res.render('index.ejs', {
    host: host,
    date: date,
    cluster: CLUSTER,
    profile: PROFILE,
    message: MESSAGE,
    version: VERSION,
  });
});

app.get('/drop', async function (req, res) {
  console.log(`get /drop`);

  res.render('drop.ejs', {
    rate: 100,
  });
});

app.get('/drop/:rate', async function (req, res) {
  const rate = parseFloat(req.params.rate);

  console.log(`get /drop/${req.params.rate}`);

  if (Number.isNaN(rate)) {
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
  console.log(`get /read`);

  return res.status(200).json({
    result: 'read',
  });
});

app.get('/live', async function (req, res) {
  console.log(`get /live`);

  return res.status(200).json({
    result: 'live',
  });
});

app.get('/health', async function (req, res) {
  console.log(`get /health`);

  if (Math.random() * 100 >= FAULT_RATE) {
    return res.status(200).json({
      result: 'ok',
      version: VERSION,
    });
  } else {
    return res.status(500).json({
      result: 'error',
      version: VERSION,
    });
  }
});

// Keep periodic snapshots quiet so they do not bury the OOM diagnostics.
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
  if (!(await ensureRedisConnection())) {
    return res.status(503).json({result: 'error', message: 'Telemetry storage unavailable'});
  }
  try {
    return res.json({result: 'ok', ...await telemetryStore.read(after)});
  } catch (error) {
    console.error(`telemetry read failed: ${error.message}`);
    return res.status(503).json({result: 'error', message: 'Telemetry storage unavailable'});
  }
});

app.get('/loop/:count', async function (req, res) {
  let count = parseInt(req.params.count, 10);

  console.log(`get /loop/${req.params.count}`);

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
    console.error(`${err}`);
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

// No request log: the load switch calls this many times a second, and the noise
// would bury the lines that matter, like the oom plan.
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

function startOomAllocation() {
  if (oomTimer) {
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

  console.log(`oom: limit ${limit ? `${Math.round(limit / MB)}mb` : 'none'}, filling ${Math.round(headroom / MB)}mb over ${OOM_FILL_MS / 1000}s in ${Math.round(chunk / MB)}mb chunks`);

  oomTimer = setInterval(() => {
    if (oomBallast.length * chunk >= cap) {
      clearInterval(oomTimer);
      oomState.active = false;
      oomState.capped = true;
      console.log(`oom: stopped at the ${Math.round(OOM_MAX_BYTES / MB)}mb cap, this process has no memory limit`);
      return;
    }

    // Fill with a non-zero byte. A zero-filled buffer is backed by the kernel
    // zero page, so it never commits real memory and RSS stays flat.
    oomBallast.push(Buffer.alloc(chunk, 1));
    oomState.allocatedBytes += chunk;
    console.log(`oom: rss ${Math.round(process.memoryUsage.rss() / MB)}mb`);
  }, OOM_INTERVAL_MS);
}

// POST so a prefetch, crawler or probe can never kill the instance.
app.post('/oom', async function (req, res) {
  console.log(`post /oom`);

  // Allocate only after the response is flushed, so the caller learns which
  // instance is going down.
  res.on('finish', startOomAllocation);

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
  const rate = parseFloat(req.params.rate);

  console.log(`get /success/${req.params.rate}`);

  if (Number.isNaN(rate)) {
    return res.status(400).json({
      result: 'error',
      message: 'Invalid rate value',
    });
  }

  return handleRateBasedResponse(res, rate, (rate) => Math.random() * 100 <= rate);
});

app.get('/fault/:rate', async function (req, res) {
  const rate = parseFloat(req.params.rate);

  console.log(`get /fault/${req.params.rate}`);

  if (Number.isNaN(rate)) {
    return res.status(400).json({
      result: 'error',
      message: 'Invalid rate value',
    });
  }

  return handleRateBasedResponse(res, rate, (rate) => Math.random() * 100 >= rate);
});

app.get('/delay/:sec', async function (req, res) {
  const sec = parseFloat(req.params.sec);

  console.log(`get /delay/${req.params.sec}`);

  if (Number.isNaN(sec) || sec < 0) {
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

app.get('/cache/:name', async function (req, res) {
  const name = req.params.name;

  console.log(`get /cache/${name}`);

  if (!(await ensureRedisConnection())) {
    return res.status(503).json({
      status: 503,
      message: 'redis unavailable',
    });
  }

  try {
    const result = await client.get(`cache:${name}`);
    return res.status(200).json(result == null ? {} : JSON.parse(result));
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).json({
      status: 500,
      message: 'internal server error',
    });
  }
});

// PUT because the client picks the key and the value is replaced wholesale.
app.put('/cache/:name', async function (req, res) {
  const name = req.params.name;

  console.log(`put /cache/${name}`);

  if (!(await ensureRedisConnection())) {
    return res.status(503).json({
      status: 503,
      message: 'redis unavailable',
    });
  }

  const json = JSON.stringify(req.body);
  try {
    const result = await client.set(`cache:${name}`, json);
    return res.status(200).json(result == null ? {} : result);
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).json({
      status: 500,
      message: 'internal server error',
    });
  }
});

app.get('/counter/:name', async function (req, res) {
  const name = req.params.name;

  console.log(`get /counter/${name}`);

  res.setHeader('Content-Type', 'text/plain; charset=UTF-8');

  if (!(await ensureRedisConnection())) {
    return res.status(503).send('redis unavailable');
  }

  try {
    const result = await client.get(`counter:${name}`);
    return res.send(result == null ? '0' : result.toString());
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).send('internal server error');
  }
});

app.post('/counter/:name', async function (req, res) {
  const name = req.params.name;

  console.log(`post /counter/${name}`);

  res.setHeader('Content-Type', 'text/plain; charset=UTF-8');

  if (!(await ensureRedisConnection())) {
    return res.status(503).send('redis unavailable');
  }

  try {
    const result = await client.incr(`counter:${name}`);
    return res.send(result == null ? '0' : result.toString());
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).send('internal server error');
  }
});

app.delete('/counter/:name', async function (req, res) {
  const name = req.params.name;

  console.log(`delete /counter/${name}`);

  res.setHeader('Content-Type', 'text/plain; charset=UTF-8');

  if (!(await ensureRedisConnection())) {
    return res.status(503).send('redis unavailable');
  }

  try {
    await client.del(`counter:${name}`);
    // The counter is gone, so its value is 0. DEL returns the number of keys
    // removed, which would read as a counter value.
    return res.send('0');
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).send('internal server error');
  }
});

app.get('/metrics', async function (req, res) {
  console.log(`get /metrics`);

  res.setHeader('Content-Type', register.contentType);
  return res.send(await register.metrics());
});

export default app;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`connecting to redis: ${REDIS_HOST}:${REDIS_PORT}`);
  ensureRedisConnection();
  startTelemetryPublisher(async () => {
    if (await ensureRedisConnection()) await telemetryStore.publish(statusSnapshot());
  }, error => console.error(`telemetry publish failed: ${error.message}`));

  app.listen(PORT, function () {
    console.log(`[${PROFILE}] Listening on port ${PORT}!`);
  });
}
