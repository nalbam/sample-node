import request from 'supertest';
import {jest} from '@jest/globals';

const client = {
  isOpen: false,
  isReady: false,
  on: jest.fn(),
  connect: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  xRange: jest.fn(),
};
jest.unstable_mockModule('redis', () => ({default: {createClient: () => client}}));
delete process.env.REDIS_ENABLED;
const {default: app} = await import('../server.js');

beforeEach(() => {
  jest.clearAllMocks();
  client.isOpen = false;
  client.isReady = false;
  client.connect.mockImplementation(async () => {
    client.isOpen = true;
    client.isReady = true;
  });
});

test('Redis is enabled by default and renders shared telemetry without thumbs', async () => {
  const response = await request(app).get('/');
  expect(response.status).toBe(200);
  expect(response.text).toContain('data-telemetry-source="redis"');
  for (const element of ['pod-select', 'freeze-chart', 'history-scrubber', '/pods.js']) {
    expect(response.text).toContain(element);
  }
  for (const element of ['btn-thumbs-up', 'btn-thumbs-down', '/counter.js']) {
    expect(response.text).not.toContain(element);
  }
  expect(client.connect).toHaveBeenCalledTimes(1);
});

test('unreachable Redis hides dependent controls and returns an unavailable response', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  client.connect.mockRejectedValue(new Error('unreachable'));
  try {
    const page = await request(app).get('/');
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('btn-thumbs-up');
    expect(page.text).not.toContain('/counter.js');
    expect(page.text).toContain('data-telemetry-source="process"');
    expect(page.text).toContain('/pods.js');
    expect((await request(app).get('/cache/demo')).status).toBe(503);
    expect(client.get).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test('an open but reconnecting socket does not advertise Redis features or queue commands', async () => {
  client.isOpen = true;
  const page = await request(app).get('/');
  expect(page.text).toContain('data-telemetry-source="process"');
  expect((await request(app).get('/telemetry')).status).toBe(503);
  expect(client.connect).not.toHaveBeenCalled();
  expect(client.xRange).not.toHaveBeenCalled();
  client.isReady = true;
  expect((await request(app).get('/')).text).toContain('data-telemetry-source="redis"');
});

test.each(['get', 'post', 'delete'])('removed counter %s endpoint returns 404 without connecting', async method => {
  expect((await request(app)[method]('/counter/up')).status).toBe(404);
  expect(client.connect).not.toHaveBeenCalled();
});

test('enabled cache and telemetry retain their Redis operations', async () => {
  client.get.mockResolvedValueOnce('{"value":1}');
  client.set.mockResolvedValue('OK');
  client.xRange.mockResolvedValue([]);
  expect((await request(app).get('/cache/demo')).body).toEqual({value: 1});
  expect((await request(app).put('/cache/demo').send({value: 2})).body).toBe('OK');
  expect(client.set).toHaveBeenCalledWith('cache:demo', '{"value":2}');
  const telemetry = await request(app).get('/telemetry');
  expect(telemetry.status).toBe(200);
  expect(telemetry.body).toMatchObject({source: 'redis', samples: []});
  expect(client.connect).toHaveBeenCalledTimes(1);
});
