import os from 'os';
import request from 'supertest';
import {jest} from '@jest/globals';

import app from '../server.js';

describe('probe endpoints', () => {
  test('GET /ready', async () => {
    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ ready: true });
  });

  test('GET /live', async () => {
    const res = await request(app).get('/live');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ live: true });
  });

  test('GET /read', async () => {
    const res = await request(app).get('/read');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: 'read' });
  });

  test('GET /version', async () => {
    const res = await request(app).get('/version');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.version).toBe(process.env.VERSION ?? 'v0.0.0');
  });

  test('GET /version includes the Node.js version', async () => {
    const res = await request(app).get('/version');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({
      version: process.env.VERSION ?? 'v0.0.0',
      node: process.version,
    });
    expect(res.body.node).toMatch(/^v\d+\./);
  });

  test('GET /runtime', async () => {
    const res = await request(app).get('/runtime');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ node: process.version, platform: process.platform });
  });

  test('GET /uptime', async () => {
    const res = await request(app).get('/uptime');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  test('GET /ping', async () => {
    const res = await request(app).get('/ping');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ pong: true });
  });

  test('GET /echo returns msg', async () => {
    const res = await request(app).get('/echo?msg=hi');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ echo: 'hi' });
  });

  test.each([
    ['missing msg', '/echo'],
    ['empty msg', '/echo?msg='],
    ['repeated msg (array)', '/echo?msg=a&msg=b'],
    ['nested msg (object)', '/echo?msg[a]=b'],
  ])('GET /echo rejects %s with 400', async (_name, url) => {
    const res = await request(app).get(url);

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ error: 'msg is required' });
  });

  test('GET /health is ok while FAULT_RATE is 0', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
  });

  test('GET /health includes integer uptime seconds', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(Number.isInteger(res.body.uptime)).toBe(true);
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    expect(res.body.result).toBeDefined();
    expect(res.body.version).toBeDefined();
  });
});

describe('GET /metrics', () => {
  test('renders the prometheus exposition format', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });
});

describe('rate endpoints', () => {
  test('GET /success/100 always succeeds', async () => {
    const res = await request(app).get('/success/100');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: 'ok', rate: 100 });
  });

  test('GET /fault/0 never faults', async () => {
    const res = await request(app).get('/fault/0');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: 'ok', rate: 0 });
  });
});

describe('parameter validation', () => {
  test.each([
    ['/loop/abc'],
    ['/loop/-1'],
    ['/delay/abc'],
    ['/delay/-1'],
    ['/success/abc'],
    ['/fault/abc'],
    ['/drop/abc'],
    ['/work/abc'],
    ['/work/-1'],
  ])('GET %s is rejected', async (path) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(400);
    expect(res.body.result).toBe('error');
  });
});

describe('GET /loop/:count', () => {
  test('stops recursing at 0', async () => {
    const res = await request(app).get('/loop/0');

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
  });
});

describe('GET /delay/:sec', () => {
  test('waits and echoes the parsed seconds', async () => {
    const res = await request(app).get('/delay/0');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: 'ok', sec: 0 });
  });
});

describe('GET /work/:ms', () => {
  test('burns for the requested milliseconds', async () => {
    const res = await request(app).get('/work/10');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: 'ok', ms: 10 });
  });

  // The burn blocks the event loop, so a long one would starve the probes.
  test('rejects a duration past the cap', async () => {
    const res = await request(app).get('/work/5000');

    expect(res.status).toBe(400);
    expect(res.body.result).toBe('error');
  });
});

describe('GET /status', () => {
  test('reports uptime, memory and cpu', async () => {
    const res = await request(app).get('/status');

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(res.body.startedAt))).toBe(false);
    expect(res.body.oom).toEqual({active: false, startedAt: null, allocatedBytes: 0, capped: false});
    expect(res.body.memory).toHaveProperty('used');
    expect(res.body.memory).toHaveProperty('percent');
    expect(res.body.cpu).toHaveProperty('limit');
    expect(res.body.cpu).toHaveProperty('percent');
    expect(['cgroup', 'process']).toContain(res.body.memory.source);
    const next = await request(app).get('/status');
    expect(next.body.instanceId).toBe(res.body.instanceId);
    expect(next.body.startedAt).toBe(res.body.startedAt);
  });
});

describe('GET /telemetry', () => {
  test.each(['invalid', '-1-0', '1', '18446744073709551616-0', '1-18446744073709551616'])('rejects invalid cursor %s before accessing Redis', async (cursor) => {
    const response = await request(app).get('/telemetry').query({after: cursor});
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Invalid telemetry cursor');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('OOM observation contract', () => {
  test('identifies the target and reports allocation without scheduling duplicate fills', async () => {
    const interval = jest.spyOn(global, 'setInterval').mockReturnValue({});
    try {
      const first = await request(app).post('/oom');
      const duplicate = await request(app).post('/oom');
      const status = await request(app).get('/status');
      expect(first.status).toBe(202);
      expect(first.body.instanceId).toBe(status.body.instanceId);
      expect(duplicate.body.instanceId).toBe(first.body.instanceId);
      expect(status.body.oom).toMatchObject({active: true, allocatedBytes: 0, capped: false});
      expect(interval).toHaveBeenCalledTimes(1);
    } finally {
      interval.mockRestore();
    }
  });
});

describe('view rendering', () => {
  test('GET / renders host, date, cluster, profile and version', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(`<title>sample-node · ${os.hostname()}</title>`);
    expect(res.text).toContain(`${process.env.CLUSTER_NAME ?? 'local'} · ${process.env.VERSION ?? 'v0.0.0'}`);
    expect(res.text).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00">[^<]+<\/time>/);
    expect(res.text).not.toContain('<%');
  });

  test.each([['/drop', '100'], ['/drop/25', '25']])('GET %s renders the rate', async (path, rate) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain(`<title>sample-node · drop ${rate}%</title>`);
    expect(res.text).toContain(`let rate = "${rate}";`);
    expect(res.text).not.toContain('<%');
  });
});

describe('X-Request-Id header', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  test('echoes the id sent by the client', async () => {
    const res = await request(app).get('/live').set('X-Request-Id', 'abc-123');

    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  test('generates a UUID when the header is missing', async () => {
    const res = await request(app).get('/live');

    expect(res.headers['x-request-id']).toMatch(uuid);
  });

  test('differs per request and is set on 404 and static responses', async () => {
    const a = await request(app).get('/no-such-path');
    const b = await request(app).get('/no-such-path');
    const file = await request(app).get('/style.css');

    expect(a.status).toBe(404);
    expect(a.headers['x-request-id']).toMatch(uuid);
    expect(b.headers['x-request-id']).toMatch(uuid);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    expect(file.status).toBe(200);
    expect(file.headers['x-request-id']).toMatch(uuid);
  });
});

describe('GET /time', () => {
  test('returns the current time in ISO 8601', async () => {
    const res = await request(app).get('/time');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body.time).toBe('string');
    expect(new Date(res.body.time).toISOString()).toBe(res.body.time);
  });
});

describe('GET /random', () => {
  test('returns a number in [0, 1) as JSON', async () => {
    const res = await request(app).get('/random');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body.value).toBe('number');
    expect(res.body.value).toBeGreaterThanOrEqual(0);
    expect(res.body.value).toBeLessThan(1);
  });
});

describe('GET /uuid', () => {
  test('returns a random UUID v4 as JSON', async () => {
    const res = await request(app).get('/uuid');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe('GET /hostname', () => {
  test('returns the host name as JSON', async () => {
    const res = await request(app).get('/hostname');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body.hostname).toBe('string');
    expect(res.body.hostname).not.toBe('');
    expect(res.body.hostname).toBe(os.hostname());
  });
});
