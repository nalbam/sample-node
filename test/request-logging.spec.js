import express from 'express';
import request from 'supertest';
import {jest} from '@jest/globals';
import {captureLogs, settle, UUID} from './log-capture.js';

// Default level (info) and no Redis: completion records, request ids, the
// Express error path and secret headers, all read from the real output streams.
process.env.REDIS_ENABLED = 'false';
delete process.env.LOG_LEVEL;
const {default: app} = await import('../server.js');

const AUTH = 'Bearer it-auth-token-4b1e9';
const COOKIE = 'sid=it-cookie-value-8c27';
const BODY_SECRET = 'it-body-secret-63fa';

let capture;
beforeEach(() => { capture = captureLogs(); });
afterEach(() => capture.restore());

const completions = () => capture.records().filter(record => record.event === 'http.request.completed');
const byId = id => capture.records().filter(record => record.request_id === id);

describe('completion record', () => {
  test.each([
    ['a JSON route with a query', 'get', '/live?debug=1&token=q-secret', '/live', 200],
    ['a static file', 'get', '/style.css', '/style.css', 200],
    ['an unknown path', 'get', '/no-such-path?x=1', '/no-such-path', 404],
    ['a Redis-disabled route', 'get', '/telemetry', '/telemetry', 404],
    ['a Redis-disabled write', 'put', '/cache/demo', '/cache/demo', 404],
    ['/status', 'get', '/status', '/status', 200],
    ['/work', 'get', '/work/1', '/work/1', 200],
    ['a rejected parameter', 'get', '/work/abc', '/work/abc', 400],
  ])('is written exactly once for %s', async (_label, method, url, path, status) => {
    const res = await request(app)[method](url);
    await settle();

    expect(res.status).toBe(status);
    const id = res.headers['x-request-id'];
    expect(id).toMatch(UUID);
    const records = completions();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info', message: 'request completed', request_id: id,
      method: method.toUpperCase(), path, status,
    });
    expect(records[0]._stream).toBe('stdout');
    expect(Number.isFinite(records[0].duration_ms)).toBe(true);
    expect(records[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(capture.records().filter(record => record.event === 'http.request.aborted')).toEqual([]);
    expect(capture.text()).not.toContain('q-secret');
  });

  test('uses a valid client id and replaces an invalid one in the logs too', async () => {
    const valid = await request(app).get('/ping').set('X-Request-Id', 'client-id_42');
    const invalid = await request(app).get('/ping').set('X-Request-Id', 'bad id\t{"level":"error"}');
    await settle();

    expect(valid.headers['x-request-id']).toBe('client-id_42');
    expect(invalid.headers['x-request-id']).toMatch(UUID);
    expect(completions().map(record => record.request_id)).toEqual(['client-id_42', invalid.headers['x-request-id']]);
    expect(capture.text()).not.toContain('bad id');
    expect(capture.writes().every(write => write.text.split('\n').length === 2)).toBe(true);
  });

  test('reports duration with a monotonic clock for a delayed response', async () => {
    const res = await request(app).get('/delay/0.05');
    await settle();

    const [record] = completions();
    expect(record.request_id).toBe(res.headers['x-request-id']);
    expect(record.duration_ms).toBeGreaterThanOrEqual(45);
  });

  test('does not log handler debug lines at the default level', async () => {
    await request(app).get('/ready');
    await settle();
    expect(capture.records().filter(record => record.level === 'debug')).toEqual([]);
  });

  test('concurrent requests keep their own id and status', async () => {
    const calls = [
      ['c-1', '/delay/0.04', 200], ['c-2', '/delay/0.01', 200], ['c-3', '/no-such', 404],
      ['c-4', '/delay/abc', 400], ['c-5', '/delay/0.02', 200],
    ];
    const responses = await Promise.all(calls.map(([id, url]) => request(app).get(url).set('X-Request-Id', id)));
    await settle();

    calls.forEach(([id, url, status], index) => {
      expect(responses[index].headers['x-request-id']).toBe(id);
      const records = byId(id);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({event: 'http.request.completed', path: url, status});
    });
    expect(completions()).toHaveLength(calls.length);
  });

  test('a client that disconnects first is logged once as aborted, not completed', async () => {
    const server = app.listen(0);
    try {
      const {port} = server.address();
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/delay/0.2`, {
        headers: {'X-Request-Id': 'abort-1'}, signal: controller.signal,
      }).catch(error => error);
      await settle(50);
      controller.abort();
      await pending;
      await settle(300);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }

    const records = byId('abort-1');
    expect(records.map(record => record.event)).toEqual(['http.request.aborted']);
    expect(records[0]).toMatchObject({level: 'warn', method: 'GET', path: '/delay/0.2'});
    expect(records[0]._stream).toBe('stderr');
  });
});

describe('Express error path', () => {
  const malformed = `{"password": "${BODY_SECRET}", oops`;

  // The same request against a bare Express app gives the response this app had
  // before it logged errors itself.
  function reference(env) {
    const bare = express();
    bare.set('env', env);
    bare.use(express.json());
    return bare;
  }

  test.each(['test', 'production'])('JSON parse failure keeps the default %s response and logs it without the body', async env => {
    const previous = app.get('env');
    app.set('env', env);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app).put('/cache/demo').set('Content-Type', 'application/json')
        .set('X-Request-Id', `parse-${env}`).send(malformed);
      await settle();
      // Express's default handler would print the error, with its raw body, to stderr.
      expect(consoleError).not.toHaveBeenCalled();
      const expected = await request(reference(env)).put('/cache/demo')
        .set('Content-Type', 'application/json').send(malformed);
      // The bare app's own console.error runs on setImmediate; keep it inside the spy.
      await settle();

      expect(res.status).toBe(400);
      expect(res.status).toBe(expected.status);
      expect(res.headers['content-type']).toBe(expected.headers['content-type']);
      if (env === 'production') expect(res.text).toBe(expected.text);
      else expect(res.text.split('<br>')[0]).toBe(expected.text.split('<br>')[0]);

      const records = byId(`parse-${env}`);
      expect(records.map(record => record.event)).toEqual(['http.request.error', 'http.request.completed']);
      expect(records[0]).toMatchObject({
        level: 'warn', status: 400, error: {name: 'SyntaxError', type: 'entity.parse.failed'},
      });
      expect(records[1]).toMatchObject({method: 'PUT', path: '/cache/demo', status: 400});
      expect(capture.text()).not.toContain(BODY_SECRET);
    } finally {
      consoleError.mockRestore();
      app.set('env', previous);
    }
  });
});

describe('sensitive headers', () => {
  test('Authorization and Cookie values never reach the output', async () => {
    const send = (req, id) => req.set('Authorization', AUTH).set('Cookie', COOKIE).set('X-Request-Id', id);
    await send(request(app).get('/live'), 'h-ok');
    await send(request(app).get('/no-such'), 'h-404');
    await send(request(app).get('/node'), 'h-500');
    await send(request(app).put('/cache/x').set('Content-Type', 'application/json'), 'h-400').send('{bad');
    await settle();

    expect(['h-ok', 'h-404', 'h-500', 'h-400'].map(id => byId(id).length > 0)).toEqual([true, true, true, true]);
    const text = capture.text();
    for (const value of [AUTH, COOKIE, 'it-auth-token', 'it-cookie-value']) {
      expect(text).not.toContain(value);
    }
  });
});

describe('remote calls', () => {
  test('a failed fetch is logged with the id of the request that made it', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async url => {
      await settle(String(url).includes('spring') ? 5 : 25);
      throw new TypeError('fetch failed', {cause: Object.assign(new Error('refused'), {code: 'ECONNREFUSED'})});
    });
    try {
      const [node, spring] = await Promise.all([
        request(app).get('/node').set('X-Request-Id', 'remote-node'),
        request(app).get('/spring').set('X-Request-Id', 'remote-spring'),
      ]);
      await settle();
      expect([node.status, spring.status]).toEqual([500, 500]);
      expect(node.body).toEqual({result: 'error'});
    } finally {
      fetchMock.mockRestore();
    }

    for (const [id, service] of [['remote-node', 'node'], ['remote-spring', 'spring']]) {
      const failure = byId(id).find(record => record.event === 'remote.failed');
      expect(failure).toMatchObject({level: 'error', service, error: {name: 'TypeError', code: 'ECONNREFUSED'}});
      expect(byId(id).filter(record => record.event === 'http.request.completed')).toHaveLength(1);
    }
  });
});

describe('OOM kill switch', () => {
  test('the fill keeps the id of the request that started it', async () => {
    let tick;
    const interval = jest.spyOn(global, 'setInterval').mockImplementation(callback => {
      tick = callback;
      return {};
    });
    try {
      const first = await request(app).post('/oom').set('X-Request-Id', 'oom-first');
      const second = await request(app).post('/oom').set('X-Request-Id', 'oom-second');
      await settle();
      expect([first.status, second.status]).toEqual([202, 202]);
      expect(interval).toHaveBeenCalledTimes(1);
      tick();
      tick();
    } finally {
      interval.mockRestore();
    }

    const oom = capture.records().filter(record => record.event?.startsWith('oom.'));
    expect(oom.map(record => record.event)).toEqual(['oom.started', 'oom.progress', 'oom.progress']);
    expect(oom.every(record => record.request_id === 'oom-first')).toBe(true);
    expect(byId('oom-second').map(record => record.event)).toEqual(['http.request.completed']);
  });
});
