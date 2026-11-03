// Redis outage and recovery with the real redis client against the
// controllable RESP server in test/resp-server.js, no container needed.
//
// One server.js process (this Jest worker) runs startServer(), including the
// telemetry publisher, for the whole file, so recovery is checked in the same
// application process that saw the failure. The tests run in order: each one
// leaves Redis answering again.
//
// Timing: REDIS_TIMEOUT_MS is TIMEOUT_MS. A Redis-bound request that hits the
// limit must answer no earlier than TIMEOUT_MS and no later than
// TIMEOUT_MS + SLACK_MS (event loop and HTTP scheduling). Requests that do not
// use Redis must answer within FAST_MS, both while Redis works and while a
// Redis request is really waiting. Every fetch has its own CLIENT_LIMIT_MS
// abort: hitting it fails the test, it is never taken for an app response.
import {jest} from '@jest/globals';
import {once} from 'node:events';
import {startRespServer} from './resp-server.js';
import {captureLogs} from './log-capture.js';

jest.setTimeout(20000);

const TIMEOUT_MS = 400;
const SLACK_MS = 300;
const FAST_MS = 150;
const CLIENT_LIMIT_MS = 5000;

const resp = await startRespServer();
const logs = captureLogs();
const unhandled = [];
const onUnhandled = reason => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);

Object.assign(process.env, {
  REDIS_ENABLED: 'true',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: String(resp.port),
  REDIS_TIMEOUT_MS: ` ${TIMEOUT_MS} `,
  FAULT_RATE: '0',
  VERSION: 'v9.9.9-redis',
  LOG_LEVEL: 'debug',
});
delete process.env.REDIS_PASS;
const {startServer} = await import('../server.js');
const exit = jest.fn();
const {server, shutdown} = startServer({port: 0, exit});
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

afterAll(async () => {
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await resp.close();
  process.off('unhandledRejection', onUnhandled);
  logs.restore();
});

async function call(method, path, body) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CLIENT_LIMIT_MS),
  });
  const text = await response.text();
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    body: type.includes('json') ? JSON.parse(text) : text,
    elapsed: performance.now() - started,
    id: response.headers.get('x-request-id'),
  };
}

const events = name => logs.records().filter(record => record.event === name);

async function waitUntil(check, limitMs = 5000) {
  const deadline = performance.now() + limitMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function expectTimedOut(result) {
  expect(result.elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS);
  expect(result.elapsed).toBeLessThan(TIMEOUT_MS + SLACK_MS);
}

const CACHE_UNAVAILABLE = {status: 503, message: 'redis unavailable'};
const TELEMETRY_UNAVAILABLE = {result: 'error', message: 'Telemetry storage unavailable'};

// Paths that never touch Redis: probes, status and a static file.
const INDEPENDENT = ['/ready', '/health', '/live', '/status', '/style.css'];

async function measureIndependent() {
  const results = {};
  for (const path of INDEPENDENT) results[path] = await call('GET', path);
  return results;
}

function expectIndependentHealthy(results) {
  for (const path of INDEPENDENT) {
    expect({path, status: results[path].status}).toEqual({path, status: 200});
    expect({path, fast: results[path].elapsed < FAST_MS}).toEqual({path, fast: true});
  }
  expect(results['/ready'].body).toEqual({ready: true});
  expect(results['/health'].body).toEqual({result: 'ok', version: 'v9.9.9-redis', uptime: expect.any(Number)});
}

// Recovery: the same process writes and reads the cache again.
async function expectCacheWorks(name) {
  const put = await call('PUT', `/cache/${name}`, {value: name});
  expect([put.status, put.body]).toEqual([200, 'OK']);
  const get = await call('GET', `/cache/${name}`);
  expect([get.status, get.body]).toEqual([200, {value: name}]);
}

let baseline;

test('Redis answering: cache, telemetry and the publisher work; independent paths are fast', async () => {
  await waitUntil(() => [...resp.streams.values()].some(entries => entries.length > 0));
  await expectCacheWorks('first');
  const telemetry = await call('GET', '/telemetry');
  expect(telemetry.status).toBe(200);
  expect(telemetry.body).toMatchObject({result: 'ok', source: 'redis'});
  expect(telemetry.body.samples.length).toBeGreaterThan(0);
  expect((await call('GET', '/telemetry?after=bad')).status).toBe(400);
  const page = await call('GET', '/');
  expect(page.body).toContain('data-telemetry-source="redis"');
  baseline = await measureIndependent();
  expectIndependentHealthy(baseline);
});

test('connection refused: Redis paths answer 503 fast, probes stay up, then recover', async () => {
  await resp.refuse();
  // The client notices the closed connection and gives up on it.
  await waitUntil(() => events('redis.error').length > 0);

  const results = [
    await call('GET', '/cache/first'),
    await call('PUT', '/cache/first', {value: 'refused'}),
    await call('GET', '/telemetry'),
  ];
  expect(results.map(result => [result.status, result.body])).toEqual([
    [503, CACHE_UNAVAILABLE], [503, CACHE_UNAVAILABLE], [503, TELEMETRY_UNAVAILABLE],
  ]);
  for (const result of results) expect(result.elapsed).toBeLessThan(TIMEOUT_MS);
  const page = await call('GET', '/');
  expect(page.status).toBe(200);
  expect(page.body).toContain('data-telemetry-source="process"');
  expect(page.elapsed).toBeLessThan(TIMEOUT_MS);
  expectIndependentHealthy(await measureIndependent());
  const failures = events('redis.connect_failed').filter(record => record.request_id === results[0].id);
  expect(failures).toHaveLength(1);

  await resp.accept();
  await expectCacheWorks('after-refused');
});

test.each([
  ['GET', 'GET', () => call('GET', '/cache/first'), CACHE_UNAVAILABLE],
  ['PUT', 'SET', () => call('PUT', '/cache/first', {value: 'stalled'}), CACHE_UNAVAILABLE],
  ['telemetry XRANGE', 'XRANGE', () => call('GET', '/telemetry'), TELEMETRY_UNAVAILABLE],
  ['telemetry MGET', 'MGET', () => call('GET', '/telemetry'), TELEMETRY_UNAVAILABLE],
])('connected but %s never answered: 503 at the limit, independent paths stay fast, then recovery', async (label, command, send, unavailable) => {
  await expectCacheWorks(`before-${command}`);
  resp.stall(name => name === command);
  const stalled = resp.nextStall();
  const pending = send();
  expect(await stalled).toBe(command);

  // Redis is really waiting now: measure the paths that do not use it.
  const during = await measureIndependent();
  expectIndependentHealthy(during);
  for (const path of INDEPENDENT) {
    expect(during[path].elapsed).toBeLessThan(Math.max(baseline[path].elapsed, 1) + FAST_MS);
  }

  const result = await pending;
  expect([result.status, result.body]).toEqual([503, unavailable]);
  expectTimedOut(result);
  expect(events('redis.timeout').filter(record => record.request_id === result.id))
    .toEqual([expect.objectContaining({level: 'error', stage: 'command', timeout_ms: TIMEOUT_MS})]);

  resp.resume();
  await expectCacheWorks(`after-${command}`);
  if (command === 'XRANGE' || command === 'MGET') {
    expect((await call('GET', '/telemetry')).status).toBe(200);
  }
});

test('the connect handshake never answered: 503 at the limit, then a new connection recovers', async () => {
  // Drop the current connection so the next request has to connect.
  await resp.refuse();
  await resp.accept();
  await waitUntil(() => resp.connections === 0);
  resp.stall(name => name === 'CLIENT');
  const stalled = resp.nextStall();
  const pending = call('GET', '/cache/first');
  await stalled;
  expectIndependentHealthy(await measureIndependent());
  const result = await pending;
  expect([result.status, result.body]).toEqual([503, CACHE_UNAVAILABLE]);
  expectTimedOut(result);
  expect(events('redis.timeout').filter(record => record.request_id === result.id))
    .toEqual([expect.objectContaining({stage: 'connect'})]);

  resp.resume();
  await expectCacheWorks('after-handshake');
});

test('concurrent requests share one connect attempt and one stalled connection; all end at the limit', async () => {
  await expectCacheWorks('before-concurrent');
  await resp.refuse();
  await resp.accept();
  await waitUntil(() => resp.connections === 0);
  const acceptedBefore = resp.accepted;

  // Every request waits on the same handshake.
  resp.stall(name => name === 'CLIENT');
  const stalled = resp.nextStall();
  const connecting = await Promise.all([
    call('GET', '/cache/a'), call('PUT', '/cache/b', {value: 1}), call('GET', '/telemetry'),
    stalled.then(() => call('GET', '/ready')),
  ]);
  expect(resp.accepted - acceptedBefore).toBe(1);
  expect(connecting.map(result => result.status)).toEqual([503, 503, 503, 200]);
  for (const result of connecting.slice(0, 3)) expect(result.elapsed).toBeLessThan(TIMEOUT_MS + SLACK_MS);
  expect(connecting[3].elapsed).toBeLessThan(FAST_MS);

  // One connection, then all of them wait behind a stalled GET. The first
  // timeout destroys the connection and the others fail with it, within
  // their own limit.
  resp.resume();
  await expectCacheWorks('concurrent-connected');
  const acceptedConnected = resp.accepted;
  resp.stall(name => name === 'GET');
  const stalledGet = resp.nextStall();
  const first = call('GET', '/cache/a');
  await stalledGet;
  const rest = await Promise.all([call('GET', '/cache/b'), call('PUT', '/cache/c', {value: 1}), call('GET', '/telemetry')]);
  const all = [await first, ...rest];
  expect(all.map(result => result.status)).toEqual([503, 503, 503, 503]);
  expectTimedOut(all[0]);
  for (const result of rest) expect(result.elapsed).toBeLessThan(TIMEOUT_MS + SLACK_MS);

  // The destroyed connection is not reused and the stale one never closes
  // the new one: one new connection serves the recovered requests.
  resp.resume();
  await Promise.all([expectCacheWorks('concurrent-1'), expectCacheWorks('concurrent-2')]);
  expect(resp.accepted - acceptedConnected).toBe(1);
  expect(resp.connections).toBe(1);
});

test('a publish that never gets an answer times out, and publishing resumes after recovery', async () => {
  await expectCacheWorks('before-publish');
  const key = [...resp.streams.keys()][0];
  resp.stall(name => name === 'MULTI');
  await resp.nextStall();
  const timeoutsBefore = events('redis.timeout').length;
  await waitUntil(() => events('redis.timeout').length > timeoutsBefore);
  const timeout = events('redis.timeout').at(-1);
  expect(timeout).toMatchObject({stage: 'command', timeout_ms: TIMEOUT_MS});
  expect(timeout).not.toHaveProperty('request_id');

  // The publisher keeps its one-second ticks: the next publish already uses a
  // new connection, which stalls as well until Redis answers again.
  const stallsBefore = resp.received.filter(name => name === 'MULTI').length;
  await waitUntil(() => resp.received.filter(name => name === 'MULTI').length > stallsBefore, 3000);
  resp.resume();
  const entries = resp.streams.get(key).length;
  await waitUntil(() => resp.streams.get(key).length >= entries + 2, 4000);
  await expectCacheWorks('after-publish');
});

test('shutdown closes Redis, leaves no connection, and nothing rejected unhandled', async () => {
  expect(await shutdown('SIGTERM')).toBe(0);
  expect(exit.mock.calls).toEqual([[0]]);
  await waitUntil(() => resp.connections === 0);
  const accepted = resp.accepted;
  // Past several publish intervals no reconnect happens.
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(resp.accepted).toBe(accepted);
  expect(events('shutdown.failed')).toEqual([]);
  expect(unhandled).toEqual([]);
});
