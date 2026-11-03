import {jest} from '@jest/globals';
import {captureLogs, settle} from './log-capture.js';

// Redis configured through CACHE_VALKEY_URL, with legacy REDIS_* also set,
// against a client double. Nothing that carries the credentials may be logged.
const USERNAME = 'vk-user';
const PASSWORD = 'vk-pass:9f@2/c%41';
const ENCODED = encodeURIComponent(PASSWORD);
const VALKEY_URL = `rediss://${USERNAME}:${ENCODED}@valkey.dev.internal:6380/0`;

const handlers = {};
const client = {
  isOpen: false,
  isReady: false,
  on: jest.fn((event, handler) => { handlers[event] = handler; }),
  connect: jest.fn(),
  close: jest.fn(async () => { client.isOpen = false; client.isReady = false; }),
  destroy: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  xRange: jest.fn(),
  multi: jest.fn(),
};
const createClient = jest.fn(() => client);
jest.unstable_mockModule('redis', () => ({default: {createClient}}));

delete process.env.REDIS_ENABLED;
process.env.CACHE_VALKEY_URL = VALKEY_URL;
process.env.REDIS_HOST = 'legacy-redis';
process.env.REDIS_PASS = 'legacy-pass-71c';
process.env.LOG_LEVEL = 'debug';
const startup = captureLogs();
const {default: app, startServer} = await import('../server.js');
startup.restore();
const clientOptions = createClient.mock.calls[0][0];
for (const name of ['CACHE_VALKEY_URL', 'REDIS_HOST', 'REDIS_PASS', 'LOG_LEVEL']) delete process.env[name];

const request = (await import('supertest')).default;

let capture;
beforeEach(() => {
  capture = captureLogs();
  client.connect.mockReset();
});
afterEach(() => capture.restore());

const leaked = text => [PASSWORD, ENCODED, VALKEY_URL, 'legacy-pass-71c'].filter(value => text.includes(value));

test('the client connects with the CACHE_VALKEY_URL target and credentials, not the legacy settings', () => {
  const url = new URL(clientOptions.url);
  expect(url.protocol).toBe('rediss:');
  expect(url.hostname).toBe('valkey.dev.internal');
  expect(url.port).toBe('6380');
  expect(decodeURIComponent(url.username)).toBe(USERNAME);
  expect(decodeURIComponent(url.password)).toBe(PASSWORD);
  expect(clientOptions).not.toHaveProperty('password');
  expect(startup.text()).not.toContain('config_invalid');
});

test('client events log the target without credentials', () => {
  handlers.connect();
  handlers.error(new Error(`connect failed for ${VALKEY_URL} password=${PASSWORD} encoded=${ENCODED}`));
  const records = capture.records();
  expect(records[0]).toMatchObject({
    event: 'redis.connected', redis_source: 'CACHE_VALKEY_URL', redis_host: 'valkey.dev.internal', redis_port: 6380, redis_tls: true,
  });
  expect(records[1].event).toBe('redis.error');
  expect(leaked(capture.text())).toEqual([]);
});

test('connect failures under a request are logged and answered without credentials', async () => {
  client.connect.mockRejectedValue(new Error(`WRONGPASS ${USERNAME}:${PASSWORD} at redis://:${ENCODED}@valkey`));
  const res = await request(app).get('/cache/demo').set('X-Request-Id', 'vk-1');
  await settle();
  expect(res.status).toBe(503);
  expect(leaked(JSON.stringify(res.body))).toEqual([]);
  expect(capture.records().some(record => record.event === 'redis.connect_failed')).toBe(true);
  expect(leaked(capture.text())).toEqual([]);
});

test('startup logs the target without credentials', async () => {
  client.connect.mockRejectedValue(new Error(`unreachable ${VALKEY_URL}`));
  const exit = jest.fn();
  const {server, shutdown} = startServer({port: 0, exit});
  await new Promise(resolve => server.once('listening', resolve));
  const connecting = capture.records().find(record => record.event === 'redis.connecting');
  expect(connecting).toMatchObject({redis_source: 'CACHE_VALKEY_URL', redis_host: 'valkey.dev.internal', redis_port: 6380});
  await shutdown('SIGTERM');
  expect(leaked(capture.text())).toEqual([]);
});
