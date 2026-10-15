import request from 'supertest';
import {jest} from '@jest/globals';

const createClient = jest.fn();
jest.unstable_mockModule('redis', () => ({default: {createClient}}));
process.env.REDIS_ENABLED = 'false';
const {default: app} = await import('../server.js');

test('Redis-free page omits dependent controls and polling scripts', async () => {
  const response = await request(app).get('/');
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  for (const element of ['btn-thumbs-up', 'btn-thumbs-down', 'pod-select', 'freeze-chart',
    'history-scrubber', 'cpu-chart', 'memory-chart', 'telemetry-events', '/counter.js', '/pods.js']) {
    expect(response.text).not.toContain(element);
  }
  expect(response.text).toContain('load-btn');
  expect(response.text).toContain('btn-kill');
  expect(createClient).not.toHaveBeenCalled();
});

test.each([
  ['get', '/telemetry'], ['get', '/cache/demo'], ['put', '/cache/demo'],
  ['get', '/counter/up'], ['post', '/counter/up'], ['delete', '/counter/up'],
])('%s %s is disabled without creating a Redis client', async (method, path) => {
  const response = await request(app)[method](path);
  expect(response.status).toBe(404);
  expect(response.body.message).toBe('Redis features disabled');
  expect(createClient).not.toHaveBeenCalled();
});

test.each(['/live', '/read', '/health', '/status', '/metrics', '/drop', '/work/1'])(
  '%s stays available without Redis', async path => {
    expect((await request(app).get(path)).status).toBe(200);
    expect(createClient).not.toHaveBeenCalled();
  });
