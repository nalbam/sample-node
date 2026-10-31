// Smoke test for a running sample-node started with REDIS_ENABLED=false.
//
//   node scripts/smoke.mjs <base-url> <expected-version>
//
// Waits for /live, then checks the public probe, page and metrics contracts.
// Exits 1 when the app never starts or any response differs.

import { readFileSync } from 'node:fs';

const [baseUrl, expectedVersion] = process.argv.slice(2);
if (!baseUrl || !expectedVersion) {
  console.error('usage: node scripts/smoke.mjs <base-url> <expected-version>');
  process.exit(2);
}

const START_TIMEOUT_MS = parseInt(process.env.SMOKE_START_TIMEOUT_MS, 10) || 30000;
const REQUEST_TIMEOUT_MS = 5000;
const REQUEST_ID = 'smoke-request-id';

const engines = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).engines.node;
const minNodeMajor = parseInt(engines.match(/\d+/)[0], 10);

function get(path) {
  return fetch(new URL(path, baseUrl), {
    headers: { 'X-Request-Id': REQUEST_ID },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function waitForLive() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await get('/live');
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.cause?.code ?? error.message;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`/live did not answer within ${START_TIMEOUT_MS}ms: ${lastError}`);
}

const isJson = /^application\/json\b/;
const json = (status, check) => ({ status, type: isJson, body: 'json', check });

const checks = {
  '/': {
    status: 200,
    type: /^text\/html\b/,
    body: 'text',
    check: (text, headers) => [
      [headers.get('cache-control') === 'no-store', 'Cache-Control is no-store'],
      [text.includes(expectedVersion), `page shows version ${expectedVersion}`],
      [text.includes('data-telemetry-source="process"'), 'page uses process telemetry without Redis'],
    ],
  },
  '/live': json(200, body => [[body.live === true, 'live is true']]),
  '/ready': json(200, body => [[body.ready === true, 'ready is true']]),
  '/read': json(200, body => [[body.result === 'read', 'result is "read"']]),
  '/health': json(200, body => [
    [body.result === 'ok', 'result is "ok"'],
    [body.version === expectedVersion, `version is ${expectedVersion}`],
    [Number.isInteger(body.uptime) && body.uptime >= 0, 'uptime is a non-negative integer'],
  ]),
  '/version': json(200, body => [
    [body.version === expectedVersion, `version is ${expectedVersion}`],
    [parseInt(/^v(\d+)\./.exec(body.node)?.[1], 10) >= minNodeMajor, `node satisfies engines ${engines}`],
  ]),
  '/metrics': {
    status: 200,
    type: /^text\/plain\b/,
    body: 'text',
    check: text => [
      [/^process_cpu_user_seconds_total \d/m.test(text), 'exports process_cpu_user_seconds_total'],
      [/^nodejs_version_info\{/m.test(text), 'exports nodejs_version_info'],
    ],
  },
  '/telemetry': json(404, body => [[body.message === 'Redis features disabled', 'Redis features disabled']]),
  '/cache/smoke': json(404, body => [[body.message === 'Redis features disabled', 'Redis features disabled']]),
};

async function verify(path, expected) {
  const response = await get(path);
  const headers = response.headers;
  const type = headers.get('content-type') ?? '';
  const failures = [];
  if (response.status !== expected.status) failures.push(`status ${response.status}, expected ${expected.status}`);
  if (!expected.type.test(type)) failures.push(`Content-Type "${type}", expected ${expected.type}`);
  if (headers.get('x-request-id') !== REQUEST_ID) failures.push('X-Request-Id is not echoed');
  const raw = await response.text();
  let body = raw;
  if (expected.body === 'json') {
    try {
      body = JSON.parse(raw);
    } catch {
      return [...failures, `body is not JSON: ${raw.slice(0, 200)}`];
    }
  }
  for (const [ok, message] of expected.check(body, headers)) {
    if (!ok) failures.push(message);
  }
  return failures;
}

try {
  await waitForLive();
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
}

let failed = 0;
for (const [path, expected] of Object.entries(checks)) {
  let failures;
  try {
    failures = await verify(path, expected);
  } catch (error) {
    failures = [`request failed: ${error.cause?.code ?? error.message}`];
  }
  if (failures.length) {
    failed++;
    console.error(`FAIL GET ${path}: ${failures.join('; ')}`);
  } else {
    console.log(`ok   GET ${path}`);
  }
}

if (failed) {
  console.error(`${failed} of ${Object.keys(checks).length} checks failed`);
  process.exit(1);
}
console.log(`smoke passed against ${baseUrl} (${expectedVersion})`);
