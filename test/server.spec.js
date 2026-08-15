import request from 'supertest';

import app from '../server.js';

describe('probe endpoints', () => {
  test('GET /live', async () => {
    const res = await request(app).get('/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: 'live' });
  });

  test('GET /read', async () => {
    const res = await request(app).get('/read');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: 'read' });
  });

  test('GET /health is ok while FAULT_RATE is 0', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
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
