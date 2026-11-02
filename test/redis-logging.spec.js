import request from 'supertest';
import {jest} from '@jest/globals';
import {captureLogs, settle} from './log-capture.js';
import {runWithContext} from '../lib/logger.js';

// Redis enabled with a password and LOG_LEVEL=debug, against a client double.
const REDIS_PASSWORD = 'it-redis-pass-0d5c71';
const AUTH = 'Basic it-redis-auth-2a9f';
const COOKIE = 'token=it-redis-cookie-77e1';

const handlers = {};
const client = {
  isOpen: false,
  isReady: false,
  on: jest.fn((event, handler) => { handlers[event] = handler; }),
  connect: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  xRange: jest.fn(),
};
const createClient = jest.fn(() => client);
jest.unstable_mockModule('redis', () => ({default: {createClient}}));
delete process.env.REDIS_ENABLED;
process.env.REDIS_PASS = REDIS_PASSWORD;
process.env.LOG_LEVEL = 'debug';
const {default: app} = await import('../server.js');
const clientOptions = createClient.mock.calls[0][0];
delete process.env.REDIS_PASS;
delete process.env.LOG_LEVEL;

let capture;
beforeEach(() => {
  capture = captureLogs();
  jest.clearAllMocks();
  client.isOpen = false;
  client.isReady = false;
  client.connect.mockImplementation(async () => {
    client.isOpen = true;
    client.isReady = true;
  });
});
afterEach(() => capture.restore());

const byId = id => capture.records().filter(record => record.request_id === id);
const leaked = () => [REDIS_PASSWORD, AUTH, COOKIE, 'it-redis-auth', 'it-redis-cookie']
  .filter(value => capture.text().includes(value));

test('the shared client gets the password and logs through its event handlers', () => {
  expect(clientOptions.password).toBe(REDIS_PASSWORD);
  expect(handlers.connect).toBeInstanceOf(Function);
  expect(handlers.error).toBeInstanceOf(Function);
});

test('a shared failed connection logs the failure under each waiting request', async () => {
  client.connect.mockImplementation(async () => {
    await settle(30);
    throw new Error(`WRONGPASS for redis://default:${REDIS_PASSWORD}@redis:6379 (${REDIS_PASSWORD})`);
  });
  const ids = ['shared-1', 'shared-2', 'shared-3'];
  const responses = await Promise.all(ids.map(id => request(app).get(`/cache/k-${id}`)
    .set('X-Request-Id', id).set('Authorization', AUTH).set('Cookie', COOKIE)));
  await settle();

  expect(client.connect).toHaveBeenCalledTimes(1);
  responses.forEach((res, index) => {
    expect(res.status).toBe(503);
    expect(res.body).toEqual({status: 503, message: 'redis unavailable'});
    const records = byId(ids[index]);
    expect(records.map(record => record.event ?? record.message)).toEqual([
      `get /cache/k-${ids[index]}`, 'redis.connect_failed', 'http.request.completed',
    ]);
    expect(records[1]).toMatchObject({level: 'error', error: {name: 'Error'}});
    expect(records[1].error.message).toContain('[REDACTED]');
    expect(records[2]).toMatchObject({status: 503, path: `/cache/k-${ids[index]}`});
  });
  expect(capture.records().filter(record => record.event === 'redis.connect_failed')).toHaveLength(ids.length);
  expect(leaked()).toEqual([]);
});

test('the next request after a failure starts a new attempt under its own id', async () => {
  client.connect.mockRejectedValueOnce(new Error('unreachable'));
  expect((await request(app).get('/cache/a').set('X-Request-Id', 'retry-1')).status).toBe(503);
  expect((await request(app).get('/cache/a').set('X-Request-Id', 'retry-2')).status).toBe(200);
  await settle();

  expect(client.connect).toHaveBeenCalledTimes(2);
  expect(byId('retry-1').some(record => record.event === 'redis.connect_failed')).toBe(true);
  expect(byId('retry-2').some(record => record.event === 'redis.connect_failed')).toBe(false);
});

test('Redis client events are service logs even when emitted inside a request', () => {
  runWithContext({request_id: 'unrelated-request'}, () => {
    handlers.error(new Error(`connection lost, password ${REDIS_PASSWORD}`));
    handlers.connect();
  });

  const records = capture.records();
  expect(records.map(record => record.event)).toEqual(['redis.error', 'redis.connected']);
  for (const record of records) expect(record).not.toHaveProperty('request_id');
  expect(records[0]._stream).toBe('stderr');
  expect(leaked()).toEqual([]);
});

test('handler logs after the JSON body parser keep the request id', async () => {
  client.set.mockResolvedValue('OK');
  const res = await request(app).put('/cache/body').set('X-Request-Id', 'body-1')
    .set('Authorization', AUTH).set('Cookie', COOKIE).send({password: REDIS_PASSWORD, value: 1});
  await settle();

  expect(res.status).toBe(200);
  expect(res.body).toBe('OK');
  expect(byId('body-1').map(record => record.event ?? record.message)).toEqual(['put /cache/body', 'http.request.completed']);
  expect(leaked()).toEqual([]);
});

test('cache and telemetry failures are logged under their request without secrets', async () => {
  client.get.mockRejectedValueOnce(Object.assign(new Error(`ERR auth ${REDIS_PASSWORD}`), {password: REDIS_PASSWORD}));
  client.xRange.mockRejectedValueOnce(new Error(`stream read with ${REDIS_PASSWORD}`));
  const [cache, telemetry] = await Promise.all([
    request(app).get('/cache/x').set('X-Request-Id', 'fail-cache'),
    request(app).get('/telemetry').set('X-Request-Id', 'fail-telemetry'),
  ]);
  await settle();

  expect(cache.status).toBe(500);
  expect(cache.body).toEqual({status: 500, message: 'internal server error'});
  expect(telemetry.status).toBe(503);
  expect(byId('fail-cache').find(record => record.event === 'cache.failed')).toMatchObject({level: 'error'});
  expect(byId('fail-telemetry').find(record => record.event === 'telemetry.read_failed')).toMatchObject({level: 'error'});
  expect(leaked()).toEqual([]);
});

test('a Redis failure quoting the request headers is logged without them', async () => {
  client.get.mockImplementationOnce(async () => {
    const error = new Error(`ERR ${AUTH} ${COOKIE} ${REDIS_PASSWORD}`);
    error.stack = `Error: ERR\n    at get (/app/it-redis-auth-2a9f/it-redis-cookie-77e1/${REDIS_PASSWORD}.js:1:1)`;
    throw error;
  });
  const res = await request(app).get('/cache/quoted').set('X-Request-Id', 'quoted-1')
    .set('Authorization', AUTH).set('Cookie', COOKIE);
  await settle();

  expect(res.status).toBe(500);
  expect(res.body).toEqual({status: 500, message: 'internal server error'});
  const failure = byId('quoted-1').find(record => record.event === 'cache.failed');
  expect(failure.error.message).toBe('ERR [REDACTED] [REDACTED] [REDACTED]');
  expect(failure.error.stack).toEqual(['at get (/app/[REDACTED]/[REDACTED]/[REDACTED].js:1:1)']);
  expect(leaked()).toEqual([]);
});

test('debug handler lines and completions match each concurrent response id', async () => {
  const responses = await Promise.all(['/ready', '/ping', '/delay/0.02', '/no-such'].map(path => request(app).get(path)));
  await settle();

  for (const res of responses) {
    const id = res.headers['x-request-id'];
    const records = byId(id);
    expect(records.filter(record => record.event === 'http.request.completed')).toHaveLength(1);
    expect(records.at(-1).status).toBe(res.status);
  }
  expect(capture.records().every(record => record.request_id !== undefined)).toBe(true);
});
