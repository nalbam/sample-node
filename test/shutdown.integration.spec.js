// Graceful shutdown of server.js.
//
// The first part runs the real entry point (`node server.js`) as a child
// process with Redis disabled and sends it real signals. Requests are raw
// HTTP/1.1 on one socket so a probe can follow an in-flight /delay on the same,
// already accepted connection after the listener has closed. The debug log
// line of each handler synchronises the test with the request actually
// running, instead of a fixed sleep.
//
// The second part imports server.js in process with a controllable fake Redis
// client, following the jest.unstable_mockModule convention of the other
// specs, and drives startServer().shutdown() directly so the order, delay and
// failure of Redis and telemetry publisher calls can be checked.
import {jest} from '@jest/globals';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_SHUTDOWN_TIMEOUT_MS} from '../lib/shutdown.js';
import {captureLogs} from './log-capture.js';

jest.setTimeout(20000);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 'v9.9.9-shutdown';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const {port} = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

// Resolves with 'connected' or the connect error code, e.g. ECONNREFUSED.
function tryConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', error => resolve(error.code));
  });
}

// A raw keep-alive connection. Everything received is kept until the peer
// closes, so pipelined responses can be parsed in order.
async function openConnection(port) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { received += chunk; });
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.on('error', () => {});
  return {
    get: url => socket.write(`GET ${url} HTTP/1.1\r\nHost: localhost\r\n\r\n`),
    post: url => socket.write(`POST ${url} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n`),
    destroy: () => socket.destroy(),
    received: () => received,
    closed,
  };
}

// Parses consecutive Content-Length framed responses. The bodies here are
// ASCII JSON, so string length equals byte length. An incomplete trailing
// response is reported as {complete: false}.
function parseResponses(text) {
  const responses = [];
  let rest = text;
  while (rest.length) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd < 0) return [...responses, {complete: false}];
    const [statusLine, ...headerLines] = rest.slice(0, headerEnd).split('\r\n');
    const headers = Object.fromEntries(headerLines.map(line => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
    const length = Number(headers['content-length']);
    const body = rest.slice(headerEnd + 4, headerEnd + 4 + length);
    if (body.length < length) return [...responses, {complete: false}];
    responses.push({complete: true, status: Number(statusLine.split(' ')[1]), headers, body: JSON.parse(body)});
    rest = rest.slice(headerEnd + 4 + length);
  }
  return responses;
}

// Polls a condition; bounded by the test timeout.
async function waitUntil(check) {
  while (!check()) await new Promise(resolve => setTimeout(resolve, 5));
}

// The client never half-closes: the server answers pipelined requests in
// order and closes the idle connection itself during shutdown.
describe('node server.js child process', () => {
  let child;

  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = undefined;
  });

  async function startChild(env) {
    const port = await freePort();
    const records = [];
    const waiters = [];
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {...process.env, NODE_OPTIONS: '', REDIS_ENABLED: 'false', VERSION, PORT: String(port), LOG_LEVEL: 'debug', ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise(resolve => {
      child.once('exit', (code, signal) => resolve({code, signal, at: performance.now()}));
    });
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const record = JSON.parse(line);
          records.push(record);
          for (const waiter of [...waiters]) {
            if (waiter.match(record)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(record);
            }
          }
        }
      });
    }
    const waitFor = match => {
      const found = records.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        waiters.push({match, resolve});
        exited.then(result => reject(new Error(`child exited ${JSON.stringify(result)} before the expected log`)));
      });
    };
    await waitFor(record => record.event === 'server.listening');
    return {port, records, waitFor, exited};
  }

  const handlerStarted = url => record => record.message === `get ${url}`;
  const event = name => record => record.event === name;

  test.each([
    ['SIGTERM', undefined],
    ['SIGINT', '5s'],
  ])('%s lets the in-flight /delay finish, fails readiness and exits 0 (SHUTDOWN_TIMEOUT_MS=%s)', async (signal, timeout) => {
    const {port, records, waitFor, exited} = await startChild(timeout === undefined ? {} : {SHUTDOWN_TIMEOUT_MS: timeout});

    const before = await openConnection(port);
    before.get('/ready');
    await waitUntil(() => parseResponses(before.received()).length === 1);
    before.destroy();
    expect(parseResponses(before.received())).toEqual([
      expect.objectContaining({complete: true, status: 200, body: {ready: true}}),
    ]);

    const connection = await openConnection(port);
    connection.get('/delay/1');
    await waitFor(handlerStarted('/delay/1'));

    child.kill(signal);
    const started = await waitFor(event('shutdown.started'));
    expect(started).toMatchObject({signal, timeout_ms: DEFAULT_SHUTDOWN_TIMEOUT_MS, active_requests: 1});

    // The listener is closed: a new TCP connection is refused ...
    expect(await tryConnect(port)).toBe('ECONNREFUSED');
    // ... while the accepted connection still carries probes behind /delay.
    connection.get('/ready');
    connection.get('/live');
    await waitFor(handlerStarted('/live'));

    const result = await exited;
    await connection.closed;
    expect(result).toMatchObject({code: 0, signal: null});
    expect(parseResponses(connection.received())).toEqual([
      expect.objectContaining({complete: true, status: 200, body: {result: 'ok', sec: 1, version: VERSION}}),
      expect.objectContaining({complete: true, status: 503, body: {ready: false}}),
      expect.objectContaining({complete: true, status: 200, body: {live: true}}),
    ]);
    expect(records.filter(event('shutdown.completed'))).toEqual([expect.objectContaining({exit_code: 0, level: 'info'})]);
    expect(records.filter(event('shutdown.failed'))).toEqual([]);
  });

  test('a repeated signal neither restarts the shutdown nor changes the exit', async () => {
    const {port, records, waitFor, exited} = await startChild({});
    const connection = await openConnection(port);
    connection.get('/delay/0.5');
    await waitFor(handlerStarted('/delay/0.5'));

    child.kill('SIGTERM');
    await waitFor(event('shutdown.started'));
    child.kill('SIGINT');
    await waitFor(record => record.event === 'shutdown.signal_repeated' && record.signal === 'SIGINT');
    child.kill('SIGTERM');
    await waitFor(record => record.event === 'shutdown.signal_repeated' && record.signal === 'SIGTERM');

    expect(await exited).toMatchObject({code: 0, signal: null});
    await connection.closed;
    expect(parseResponses(connection.received())).toEqual([
      expect.objectContaining({complete: true, status: 200, body: {result: 'ok', sec: 0.5, version: VERSION}}),
    ]);
    expect(records.filter(event('shutdown.started'))).toHaveLength(1);
    expect(records.filter(event('shutdown.completed'))).toHaveLength(1);
  });

  test('a request longer than SHUTDOWN_TIMEOUT_MS is cut off and the process exits 1 on time', async () => {
    const timeoutMs = 600;
    const {port, records, waitFor, exited} = await startChild({SHUTDOWN_TIMEOUT_MS: String(timeoutMs)});
    const connection = await openConnection(port);
    connection.get('/delay/5');
    await waitFor(handlerStarted('/delay/5'));

    const signalledAt = performance.now();
    child.kill('SIGTERM');
    await waitFor(event('shutdown.started'));
    // A second signal must not extend the deadline; a reset would push the
    // exit to at least 400 + 600ms after the first signal.
    await new Promise(resolve => setTimeout(resolve, 400));
    child.kill('SIGTERM');

    const result = await exited;
    await connection.closed;
    const elapsed = result.at - signalledAt;
    expect(result).toMatchObject({code: 1, signal: null});
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 10);
    expect(elapsed).toBeLessThan(timeoutMs + 400);
    // The forced close destroyed the active connection without a response.
    expect(connection.received()).toBe('');
    expect(records.filter(event('shutdown.started'))).toEqual([expect.objectContaining({timeout_ms: timeoutMs})]);
    expect(records.filter(event('shutdown.failed'))).toEqual([
      expect.objectContaining({level: 'error', phase: 'timeout', signal: 'SIGTERM'}),
    ]);
    expect(records.filter(event('shutdown.completed'))).toEqual([expect.objectContaining({exit_code: 1, level: 'error'})]);
  });
});

describe('startServer with a controllable Redis client', () => {
  let client;
  let calls;
  let logs;
  let running;

  // One fake per server.js instance. connect/exec/get behaviour is set per
  // test; isOpen/isReady follow redis 6.x: open while connecting, ready once
  // connected, neither after a failed connect, close or destroy.
  function createFakeClient() {
    const fake = {
      isOpen: false,
      isReady: false,
      on: jest.fn(),
      connectImpl: async () => {},
      execImpl: async () => [],
      getImpl: async () => null,
      connect: jest.fn(async () => {
        calls.push('connect');
        fake.isOpen = true;
        try {
          await fake.connectImpl();
        } catch (error) {
          fake.isOpen = false;
          throw error;
        }
        // A destroy() while connecting leaves the client closed.
        if (fake.isOpen) fake.isReady = true;
        return fake;
      }),
      multi: jest.fn(() => {
        const chain = {
          set: () => chain,
          xAdd: () => chain,
          expire: () => chain,
          exec: async () => {
            calls.push('exec:start');
            const result = await fake.execImpl();
            calls.push('exec:end');
            return result;
          },
        };
        return chain;
      }),
      get: jest.fn(async key => {
        calls.push('get:start');
        const result = await fake.getImpl(key);
        calls.push('get:end');
        return result;
      }),
      close: jest.fn(async () => {
        calls.push('close');
        if (!fake.isOpen) throw new Error('The client is closed');
        fake.isOpen = false;
        fake.isReady = false;
      }),
      destroy: jest.fn(() => {
        calls.push('destroy');
        fake.isOpen = false;
        fake.isReady = false;
      }),
    };
    return fake;
  }

  jest.unstable_mockModule('redis', () => ({default: {createClient: () => client}}));

  // Imports a fresh server.js, so module state (client, shutdown) is new.
  async function start({redis = true, timeoutMs, setup = () => {}} = {}) {
    jest.resetModules();
    process.env.REDIS_ENABLED = redis ? 'true' : 'false';
    process.env.LOG_LEVEL = 'debug';
    if (timeoutMs === undefined) delete process.env.SHUTDOWN_TIMEOUT_MS;
    else process.env.SHUTDOWN_TIMEOUT_MS = String(timeoutMs);
    client = createFakeClient();
    setup(client);
    const {startServer} = await import('../server.js');
    const exit = jest.fn();
    const {server, shutdown} = startServer({port: 0, exit});
    running = server;
    if (!server.listening) await once(server, 'listening');
    return {server, shutdown, exit, port: server.address().port};
  }

  const tick = () => new Promise(resolve => setImmediate(resolve));

  beforeEach(() => {
    calls = [];
    logs = captureLogs();
  });
  afterEach(async () => {
    if (running?.listening) {
      running.closeAllConnections();
      await new Promise(resolve => running.close(resolve));
    }
    running = undefined;
    logs.restore();
  });

  const events = name => logs.records().filter(record => record.event === name);

  test('Redis disabled: shutdown closes the server and exits 0 without touching Redis', async () => {
    const {server, shutdown, exit} = await start({redis: false});
    const first = shutdown('SIGTERM');
    expect(shutdown('SIGINT')).toBe(first);
    expect(await first).toBe(0);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(server.listening).toBe(false);
    expect(calls).toEqual([]);
    expect(events('redis.connecting')).toEqual([]);
  });

  test('connected: the publisher stops, the in-flight publish finishes, then Redis closes once', async () => {
    const exec = deferred();
    const execStarted = deferred();
    const {shutdown, exit} = await start({
      setup: fake => {
        fake.execImpl = () => { execStarted.resolve(); return exec.promise; };
      },
    });
    await execStarted.promise;

    const first = shutdown('SIGTERM');
    await tick();
    expect(shutdown('SIGINT')).toBe(first);
    await tick();
    expect(exit).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();

    exec.resolve([]);
    expect(await first).toBe(0);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(calls).toEqual(['connect', 'exec:start', 'exec:end', 'close']);

    // Past the 1s publish interval no new publish or connection starts.
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(calls).toEqual(['connect', 'exec:start', 'exec:end', 'close']);
    expect(client.multi).toHaveBeenCalledTimes(1);
    expect(client.isOpen).toBe(false);
  });

  test('connecting: shutdown waits for the pending connect and the publish before closing', async () => {
    const connect = deferred();
    const {shutdown, exit} = await start({
      setup: fake => { fake.connectImpl = () => connect.promise; },
    });
    await waitUntil(() => calls.includes('connect'));

    const done = shutdown('SIGTERM');
    await tick();
    expect(calls).toEqual(['connect']);
    expect(exit).not.toHaveBeenCalled();

    connect.resolve();
    expect(await done).toBe(0);
    expect(calls).toEqual(['connect', 'exec:start', 'exec:end', 'close']);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.isOpen).toBe(false);
  });

  test('connecting past the deadline: Redis is destroyed, exit 1, and a late connect is torn down', async () => {
    const connect = deferred();
    const {shutdown, exit} = await start({
      timeoutMs: 100,
      setup: fake => { fake.connectImpl = () => connect.promise; },
    });
    await waitUntil(() => calls.includes('connect'));

    const started = performance.now();
    const done = shutdown('SIGTERM');
    expect(await done).toBe(1);
    expect(performance.now() - started).toBeGreaterThanOrEqual(90);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(calls).toEqual(['connect', 'destroy']);
    expect(events('shutdown.failed')).toEqual([expect.objectContaining({phase: 'timeout', signal: 'SIGTERM'})]);

    // The fake keeps the socket open on purpose: the late completion must not
    // leave a connection behind or start a publish.
    client.isOpen = true;
    connect.resolve();
    await waitUntil(() => calls.length > 2);
    await tick();
    expect(calls).toEqual(['connect', 'destroy', 'destroy']);
    expect(client.isOpen).toBe(false);
    expect(client.multi).not.toHaveBeenCalled();
    expect(shutdown('SIGTERM')).toBe(done);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test('failed connect: shutdown exits 0 without closing or reconnecting', async () => {
    const {shutdown, exit} = await start({
      setup: fake => { fake.connectImpl = async () => { throw new Error('unreachable'); }; },
    });
    await waitUntil(() => events('redis.connect_failed').length === 1);

    expect(await shutdown('SIGTERM')).toBe(0);
    expect(await shutdown('SIGINT')).toBe(0);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(calls).toEqual(['connect']);
    expect(events('shutdown.failed')).toEqual([]);
  });

  test('Redis stays usable for an in-flight request until it completes, and /oom cannot restart during drain', async () => {
    const get = deferred();
    const getStarted = deferred();
    const {shutdown, exit, port} = await start({
      setup: fake => {
        fake.getImpl = () => { getStarted.resolve(); return get.promise; };
      },
    });
    await waitUntil(() => calls.includes('exec:end'));

    const connection = await openConnection(port);
    connection.get('/cache/demo');
    await getStarted.promise;

    const done = shutdown('SIGTERM');
    connection.post('/oom');
    await waitUntil(() => logs.records().some(record => record.message === 'post /oom'));
    await tick();
    expect(client.close).not.toHaveBeenCalled();

    get.resolve('{"value":1}');
    expect(await done).toBe(0);
    await connection.closed;
    expect(exit.mock.calls).toEqual([[0]]);
    expect(calls).toEqual(['connect', 'exec:start', 'exec:end', 'get:start', 'get:end', 'close']);
    expect(parseResponses(connection.received())).toEqual([
      expect.objectContaining({complete: true, status: 200, body: {value: 1}}),
      expect.objectContaining({complete: true, status: 202, body: expect.objectContaining({result: 'oom'})}),
    ]);
    expect(events('oom.started')).toEqual([]);
  });
});
