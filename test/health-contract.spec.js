import request from 'supertest';
import {jest} from '@jest/globals';
import {captureLogs, settle} from './log-capture.js';

// The /health contract shared by sample-node, sample-spring and sample-tomcat:
// result is lowercase "ok" or "error", version is a string and uptime is whole
// seconds since the process started, 0 or more, and service is the exact name
// of the service that answered.
//
// FAULT_RATE is read when server.js loads. At 50 the fault path depends only on
// Math.random, which the tests below pin to reach each branch.
process.env.REDIS_ENABLED = 'false';
process.env.FAULT_RATE = '50';
delete process.env.LOG_LEVEL;
const {default: app} = await import('../server.js');

let capture;
beforeEach(() => { capture = captureLogs(); });
afterEach(() => capture.restore());

const byId = id => capture.records().filter(record => record.request_id === id);

// Answers every fetch with the given status and raw body text, and restores
// the real fetch afterwards.
async function withRemote(status, text, run) {
  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(text, {
    status,
    headers: {'Content-Type': 'application/json'},
  }));
  try {
    return await run(fetchMock);
  } finally {
    fetchMock.mockRestore();
  }
}

describe('own GET /health', () => {
  test.each([
    ['healthy', 0.9, 200, 'ok'],
    ['faulting', 0.1, 500, 'error'],
  ])('keeps the shared fields while %s', async (_label, random, status, result) => {
    const randomMock = jest.spyOn(Math, 'random').mockReturnValue(random);
    let res;
    try {
      res = await request(app).get('/health');
    } finally {
      randomMock.mockRestore();
    }

    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({
      result, version: process.env.VERSION ?? 'v0.0.0', uptime: expect.any(Number), service: 'sample-node',
    });
    expect(Number.isInteger(res.body.uptime)).toBe(true);
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    // Node's own response has never had type.
    expect(res.body).not.toHaveProperty('type');
  });
});

describe.each([
  ['spring', 'tomcat'],
  ['tomcat', 'spring'],
])('GET /%s', (service, other) => {
  const expected = `sample-${service}`;

  test('calls /health of the remote service', async () => {
    await withRemote(200, JSON.stringify({result: 'ok', version: 'v1.0.0', uptime: 1, service: expected}), async fetchMock => {
      await request(app).get(`/${service}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe(`http://sample-${service}/health`);
    });
  });

  test.each([
    ['ok with type and extra fields', 200,
      {result: 'ok', type: 'health', version: 'v1.2.3', uptime: 42, artifactId: expected, service: expected, nested: {a: [1, null]}}],
    ['ok without type', 200, {result: 'ok', version: 'v0.0.0', uptime: 0, service: expected}],
    ['ok with an empty version', 200, {result: 'ok', type: 'health', version: '', uptime: 3, service: expected}],
    ['error with a 500 status', 500, {result: 'error', type: 'health', version: 'v1.2.3', uptime: 7, service: expected}],
    ['error with a 200 status', 200, {result: 'error', version: 'v1.2.3', uptime: 7, service: expected}],
    ['ok with a 503 status', 503, {result: 'ok', version: 'v1.2.3', uptime: 7, service: expected}],
  ])('passes a valid body through unchanged: %s', async (_label, status, body) => {
    await withRemote(status, JSON.stringify(body), async () => {
      const res = await request(app).get(`/${service}`).set('X-Request-Id', `valid-${service}`);
      await settle();

      expect(res.status).toBe(status);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toEqual(body);
      expect(byId(`valid-${service}`).filter(record => record.event?.startsWith('remote.'))).toEqual([]);
    });
  });

  const valid = {result: 'ok', type: 'health', version: 'v1.2.3', uptime: 42, service: expected};
  const without = field => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));

  test.each([
    ['missing result', without('result')],
    ['missing version', without('version')],
    ['missing uptime', without('uptime')],
    ['uppercase result OK', {...valid, result: 'OK'}],
    ['uppercase result ERROR', {...valid, result: 'ERROR'}],
    ['result UP', {...valid, result: 'UP'}],
    ['boolean result', {...valid, result: true}],
    ['null result', {...valid, result: null}],
    ['numeric version', {...valid, version: 1}],
    ['null version', {...valid, version: null}],
    ['object version', {...valid, version: {major: 1}}],
    ['string uptime', {...valid, uptime: '42'}],
    ['negative uptime', {...valid, uptime: -1}],
    ['fractional uptime', {...valid, uptime: 1.5}],
    ['null uptime', {...valid, uptime: null}],
    ['null body', null],
    ['array body', [valid]],
    ['string body', 'ok'],
    ['number body', 42],
    ['boolean body', true],
  ])('answers 502 for %s', async (label, body) => {
    await withRemote(200, JSON.stringify(body), async () => {
      const res = await request(app).get(`/${service}`).set('X-Request-Id', `invalid-${service}`);
      await settle();

      expect(res.status).toBe(502);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toEqual({result: 'error'});
      const records = byId(`invalid-${service}`);
      expect(records.filter(record => record.event === 'remote.invalid_response')).toEqual([
        expect.objectContaining({level: 'error', service, status: 200, reason: expect.any(String)}),
      ]);
      expect(records.filter(record => record.event === 'remote.failed')).toEqual([]);
    });
  });

  // The reason is a fixed string, so a remote value never reaches the log.
  test.each([
    ['missing service', 200, without('service')],
    ['the other target service', 200, {...valid, service: `sample-${other}`}],
    ['sample-node', 200, {...valid, service: 'sample-node'}],
    ['a different case', 200, {...valid, service: `Sample-${service[0].toUpperCase()}${service.slice(1)}`}],
    ['an uppercase name', 200, {...valid, service: expected.toUpperCase()}],
    ['surrounding spaces', 200, {...valid, service: ` ${expected} `}],
    ['the bare name', 200, {...valid, service: service}],
    ['an empty string', 200, {...valid, service: ''}],
    ['a number', 200, {...valid, service: 1}],
    ['null', 200, {...valid, service: null}],
    ['an array', 200, {...valid, service: [expected]}],
    ['an error body from the other service with 500', 500, {...valid, result: 'error', service: `sample-${other}`}],
    ['an error body without service with 500', 500, {result: 'error', version: 'v1.2.3', uptime: 7}],
  ])('answers 502 when service is %s', async (_label, status, body) => {
    await withRemote(status, JSON.stringify(body), async () => {
      const res = await request(app).get(`/${service}`).set('X-Request-Id', `service-${service}`);
      await settle();

      expect(res.status).toBe(502);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toEqual({result: 'error'});
      const records = byId(`service-${service}`);
      expect(records.filter(record => record.event === 'remote.invalid_response')).toEqual([
        expect.objectContaining({level: 'error', service, status, reason: `service is not "${expected}"`}),
      ]);
      expect(records.filter(record => record.event === 'remote.failed')).toEqual([]);
    });
  });

  test.each([
    ['an HTML page', 200, '<html>Bad Gateway</html>'],
    ['truncated JSON', 200, '{"result":"ok","version":'],
    ['an empty body', 200, ''],
    ['an HTML error page', 500, '<html>Internal Server Error</html>'],
  ])('answers 502 when the body is %s', async (_label, status, text) => {
    await withRemote(status, text, async () => {
      const res = await request(app).get(`/${service}`).set('X-Request-Id', `json-${service}`);
      await settle();

      expect(res.status).toBe(502);
      expect(res.body).toEqual({result: 'error'});
      expect(byId(`json-${service}`).filter(record => record.event === 'remote.invalid_response')).toEqual([
        expect.objectContaining({service, status, reason: 'body is not valid JSON'}),
      ]);
    });
  });

  test('keeps 500 and the remote.failed log when the call itself fails', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', {cause: Object.assign(new Error('refused'), {code: 'ECONNREFUSED'})}),
    );
    let res;
    try {
      res = await request(app).get(`/${service}`).set('X-Request-Id', `down-${service}`);
      await settle();
    } finally {
      fetchMock.mockRestore();
    }

    expect(res.status).toBe(500);
    expect(res.body).toEqual({result: 'error'});
    const records = byId(`down-${service}`);
    expect(records.filter(record => record.event === 'remote.failed')).toEqual([
      expect.objectContaining({level: 'error', service, error: expect.objectContaining({name: 'TypeError', code: 'ECONNREFUSED'})}),
    ]);
    expect(records.filter(record => record.event === 'remote.invalid_response')).toEqual([]);
  });
});

describe('GET /node', () => {
  // /node shares the remote call but is not checked against the contract.
  test.each([
    ['a contract body', 200, {result: 'ok', version: 'v1.2.3', uptime: 1, service: 'sample-node'}],
    ['a contract body without service', 200, {result: 'ok', version: 'v1.2.3', uptime: 1}],
    ['a body naming another service', 200, {result: 'ok', version: 'v1.2.3', uptime: 1, service: 'sample-spring'}],
    ['a body outside the contract', 200, {result: 'OK', type: 'health'}],
    ['an array', 503, [1, 2]],
    ['null', 200, null],
  ])('passes %s through with the remote status', async (_label, status, body) => {
    await withRemote(status, JSON.stringify(body), async fetchMock => {
      const res = await request(app).get('/node');

      expect(String(fetchMock.mock.calls[0][0])).toBe('http://sample-node/health');
      expect(res.status).toBe(status);
      expect(res.body).toEqual(body);
    });
  });

  test('keeps answering 500 for a body that is not JSON', async () => {
    await withRemote(200, '<html>', async () => {
      const res = await request(app).get('/node').set('X-Request-Id', 'node-html');
      await settle();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({result: 'error'});
      expect(byId('node-html').filter(record => record.event === 'remote.failed')).toEqual([
        expect.objectContaining({service: 'node'}),
      ]);
    });
  });
});
