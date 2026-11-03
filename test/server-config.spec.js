import {jest} from '@jest/globals';
import net from 'node:net';
import {once} from 'node:events';
import {captureLogs} from './log-capture.js';

// PORT is honoured by startServer(), and REDIS_ENABLED=false wins over every
// Redis/Valkey setting. The unusable CACHE_VALKEY_URL is reported by name only.
const SECRET = 'cfg-secret-5e0b';

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const {port} = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

const createClient = jest.fn();
jest.unstable_mockModule('redis', () => ({default: {createClient}}));

const PORT = await freePort();
process.env.PORT = String(PORT);
process.env.REDIS_ENABLED = 'false';
process.env.CACHE_VALKEY_URL = `http://user:${SECRET}@valkey:6379`;
process.env.CACHE_VALKEY_HOST = 'valkey';
process.env.CACHE_VALKEY_PASSWORD = SECRET;
const startup = captureLogs();
const {startServer} = await import('../server.js');
startup.restore();
for (const name of ['PORT', 'REDIS_ENABLED', 'CACHE_VALKEY_URL', 'CACHE_VALKEY_HOST', 'CACHE_VALKEY_PASSWORD']) {
  delete process.env[name];
}

test('REDIS_ENABLED=false creates no client even with Valkey settings', () => {
  expect(createClient).not.toHaveBeenCalled();
});

test('an unusable CACHE_VALKEY_URL is reported without its value', () => {
  const warnings = startup.records().filter(record => record.event === 'redis.config_invalid');
  expect(warnings).toEqual([expect.objectContaining({level: 'warn', variable: 'CACHE_VALKEY_URL'})]);
  expect(startup.text()).not.toContain(SECRET);
});

test('startServer() listens on PORT by default', async () => {
  const logs = captureLogs();
  try {
    const exit = jest.fn();
    const {server, shutdown} = startServer({exit});
    await once(server, 'listening');
    expect(server.address().port).toBe(PORT);
    expect(logs.records().find(record => record.event === 'server.listening')).toMatchObject({port: PORT});
    expect(logs.records().some(record => record.event === 'redis.connecting')).toBe(false);
    await shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
    expect(logs.text()).not.toContain(SECRET);
  } finally {
    logs.restore();
  }
});
