import {createLogger, parseLevel, runWithContext, runWithoutContext, secretsFromHeaders, REDACTED} from '../lib/logger.js';
import {captureLogs} from './log-capture.js';

function sink() {
  const chunks = [];
  return {
    write: chunk => { chunks.push(chunk); return true; },
    text: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').filter(Boolean),
    records: () => chunks.join('').split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

function setup(options = {}) {
  const stdout = sink();
  const stderr = sink();
  const logger = createLogger({stdout, stderr, ...options});
  return {logger, stdout, stderr};
}

describe('record shape', () => {
  test('writes one parseable JSON line with time, level and message', () => {
    const {logger, stdout} = setup();
    logger.info('hello', {count: 2});

    expect(stdout.text().endsWith('\n')).toBe(true);
    expect(stdout.lines()).toHaveLength(1);
    const record = JSON.parse(stdout.lines()[0]);
    expect(record).toMatchObject({level: 'info', message: 'hello', count: 2});
    expect(new Date(record.time).toISOString()).toBe(record.time);
  });

  test('keeps newlines in the message and metadata inside a single line', () => {
    const {logger, stdout} = setup();
    logger.info('first\nsecond\r\nthird', {value: 'a\nb', nested: {lines: ['x\ny']}});

    const lines = stdout.lines();
    expect(lines).toHaveLength(1);
    expect(stdout.text().split('\n')).toEqual([lines[0], '']);
    const record = JSON.parse(lines[0]);
    expect(record.message).toBe('first\nsecond\r\nthird');
    expect(record.value).toBe('a\nb');
    expect(record.nested.lines).toEqual(['x\ny']);
  });

  test('always includes the required fields, even with no metadata or a non-string message', () => {
    const {logger, stdout} = setup();
    logger.info();
    logger.info(42, 'not an object');

    for (const record of stdout.records()) {
      expect(typeof record.time).toBe('string');
      expect(record.level).toBe('info');
      expect(typeof record.message).toBe('string');
    }
    expect(stdout.records().map(record => record.message)).toEqual(['undefined', '42']);
  });

  test('serializes circular, bigint, non-finite and deep values without throwing', () => {
    const {logger, stdout} = setup();
    const loop = {name: 'loop'};
    loop.self = loop;
    let deep = {};
    const root = deep;
    for (let i = 0; i < 10; i++) deep = deep.next = {};
    logger.info('odd values', {loop, big: 10n, nan: NaN, fn: () => 1, root, when: new Date(0)});

    const record = stdout.records()[0];
    expect(record.loop).toEqual({name: 'loop', self: '[Circular]'});
    expect(record.big).toBe('10');
    expect(record.nan).toBe('NaN');
    expect(record).not.toHaveProperty('fn');
    expect(JSON.stringify(record.root)).toContain('[Truncated]');
    expect(record.when).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('required field protection', () => {
  test('reserved metadata keys are dropped and the context id wins', () => {
    const {logger, stdout, stderr} = setup({now: () => new Date('2026-01-02T03:04:05.000Z')});
    runWithContext({request_id: 'req-1'}, () => {
      logger.warn('real', {time: 'fake', level: 'debug', message: 'fake', request_id: 'other', extra: 1});
    });
    logger.info('outside', {request_id: 'injected'});

    expect(stderr.records()).toEqual([
      {time: '2026-01-02T03:04:05.000Z', level: 'warn', message: 'real', request_id: 'req-1', extra: 1},
    ]);
    expect(stdout.records()).toEqual([
      {time: '2026-01-02T03:04:05.000Z', level: 'info', message: 'outside'},
    ]);
  });

  test('child bindings fix request_id outside the async context', async () => {
    const {logger, stdout} = setup();
    const bound = logger.child({request_id: 'bound-id'});
    await new Promise(resolve => setTimeout(resolve, 1));
    bound.info('timer', {request_id: 'meta-id'});

    expect(stdout.records()[0]).toMatchObject({message: 'timer', request_id: 'bound-id'});
  });

  test('detached loggers ignore the active request context', () => {
    const {logger, stdout} = setup();
    const service = logger.detached();
    runWithContext({request_id: 'req-2'}, () => {
      service.info('service event');
      logger.info('request event');
    });

    const [service0, request0] = stdout.records();
    expect(service0).not.toHaveProperty('request_id');
    expect(request0.request_id).toBe('req-2');
  });

  test('context follows awaited work and does not leak between concurrent runs', async () => {
    const {logger, stdout} = setup();
    const work = (id, ms) => runWithContext({request_id: id}, async () => {
      await new Promise(resolve => setTimeout(resolve, ms));
      logger.info('done', {id});
    });
    await Promise.all([work('a', 15), work('b', 5), work('c', 10)]);
    runWithoutContext(() => logger.info('none'));

    const records = stdout.records();
    for (const record of records.slice(0, 3)) expect(record.request_id).toBe(record.id);
    expect(records[3]).not.toHaveProperty('request_id');
  });
});

describe('levels', () => {
  const emitAll = logger => {
    for (const level of ['debug', 'info', 'warn', 'error']) logger[level](`${level} line`);
  };
  const levelsOf = ({stdout, stderr}) => [...stdout.records(), ...stderr.records()].map(record => record.level).sort();

  test.each([
    ['debug', ['debug', 'error', 'info', 'warn']],
    ['info', ['error', 'info', 'warn']],
    ['warn', ['error', 'warn']],
    ['error', ['error']],
  ])('LOG_LEVEL=%s writes only that level and above', (level, expected) => {
    const out = setup({level});
    emitAll(out.logger);
    expect(levelsOf(out)).toEqual(expected);
    expect(out.logger.level).toBe(level);
  });

  test('defaults to info when unset or empty, without a warning', () => {
    for (const level of [undefined, '', '  ']) {
      const out = setup({level});
      expect(out.stderr.records()).toEqual([]);
      emitAll(out.logger);
      expect(levelsOf(out)).toEqual(['error', 'info', 'warn']);
      expect(out.logger.level).toBe('info');
    }
  });

  test('accepts level names case-insensitively', () => {
    expect(parseLevel(' WARN ')).toEqual({level: 'warn', valid: true});
    expect(setup({level: 'Debug'}).logger.level).toBe('debug');
  });

  test('debug and info go to stdout, warn and error to stderr', () => {
    const out = setup({level: 'debug'});
    emitAll(out.logger);
    expect(out.stdout.records().map(record => record.level)).toEqual(['debug', 'info']);
    expect(out.stderr.records().map(record => record.level)).toEqual(['warn', 'error']);
  });

  test('an invalid LOG_LEVEL behaves as info and warns once without echoing the value', () => {
    const invalid = 'verbose-secret-value\n{"level":"error"}';
    const out = setup({level: invalid});
    emitAll(out.logger);
    out.logger.child({a: 1}).info('child line');

    const warnings = out.stderr.records().filter(record => record.event === 'logger.invalid_level');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({level: 'warn', allowed: ['debug', 'info', 'warn', 'error']});
    expect(levelsOf(out)).toEqual(['error', 'info', 'info', 'warn', 'warn']);
    expect(out.logger.level).toBe('info');
    expect(out.stdout.text() + out.stderr.text()).not.toContain('verbose-secret-value');
  });

  test('writes to the real process streams by default', () => {
    const capture = captureLogs();
    try {
      const logger = createLogger({level: 'debug'});
      logger.info('to stdout');
      logger.error('to stderr');
      expect(capture.records().map(record => [record.message, record._stream])).toEqual([
        ['to stdout', 'stdout'], ['to stderr', 'stderr'],
      ]);
    } finally {
      capture.restore();
    }
  });
});

describe('sensitive data', () => {
  const PASSWORD = 'unit-redis-pass-7f3a';
  const AUTH = 'Bearer unit-auth-token-91c2';
  const COOKIE = 'session=unit-cookie-5d8e';

  test('redacts secret-looking keys at any depth', () => {
    const {logger, stdout} = setup();
    logger.info('headers', {
      headers: {authorization: AUTH, Cookie: COOKIE, 'set-cookie': [COOKIE], accept: 'json'},
      redis: {password: PASSWORD, REDIS_PASS: PASSWORD, host: 'redis'},
      api_key: 'k', token: 't', secret: 's',
    });

    const text = stdout.text();
    for (const value of [PASSWORD, AUTH, COOKIE, 'unit-auth-token', 'unit-cookie']) {
      expect(text).not.toContain(value);
    }
    const record = stdout.records()[0];
    expect(record.headers).toEqual({authorization: REDACTED, Cookie: REDACTED, 'set-cookie': REDACTED, accept: 'json'});
    expect(record.redis).toEqual({password: REDACTED, REDIS_PASS: REDACTED, host: 'redis'});
  });

  test('removes registered secret values from messages, metadata, error messages and stacks', () => {
    const {logger, stdout, stderr} = setup({secrets: [PASSWORD, '']});
    const error = new Error(`auth failed for ${PASSWORD}`);
    error.stack = `Error: auth failed for ${PASSWORD}\n    at connect (/app/${PASSWORD}.js:1:1)`;
    logger.error(`connect with ${PASSWORD}`, {error, note: `pw=${PASSWORD}`, list: [PASSWORD]});

    const text = stderr.text() + stdout.text();
    expect(text).not.toContain(PASSWORD);
    const record = stderr.records()[0];
    expect(record.message).toBe(`connect with ${REDACTED}`);
    expect(record.error.message).toBe(`auth failed for ${REDACTED}`);
    expect(record.error.stack).toEqual([`at connect (/app/${REDACTED}.js:1:1)`]);
    expect(record.note).toBe(`pw=${REDACTED}`);
  });

  test('removes credentials embedded in URLs', () => {
    const {logger, stdout} = setup();
    logger.info('connecting to redis://admin:url-secret-42@redis:6379/0', {url: 'https://u:url-secret-43@host/x'});

    const text = stdout.text();
    expect(text).not.toContain('url-secret-42');
    expect(text).not.toContain('url-secret-43');
    expect(stdout.records()[0].message).toBe(`connecting to redis://${REDACTED}@redis:6379/0`);
  });

  test('errors keep only name, message, code, type, status and stack frames', () => {
    const {logger, stderr} = setup();
    const error = new SyntaxError('Unexpected token');
    Object.assign(error, {
      type: 'entity.parse.failed', status: 400, body: `{"password":"${PASSWORD}"`,
      headers: {authorization: AUTH}, config: {password: PASSWORD},
    });
    const fetchError = new TypeError('fetch failed', {cause: Object.assign(new Error('refused'), {code: 'ECONNREFUSED'})});
    logger.error('failed', {error, fetchError});

    const record = stderr.records()[0];
    expect(Object.keys(record.error).sort()).toEqual(['message', 'name', 'stack', 'status', 'type']);
    expect(record.error).toMatchObject({name: 'SyntaxError', message: 'Unexpected token', type: 'entity.parse.failed', status: 400});
    expect(record.error.stack.every(frame => frame.startsWith('at '))).toBe(true);
    expect(record.fetchError).toMatchObject({name: 'TypeError', message: 'fetch failed', code: 'ECONNREFUSED'});
    expect(stderr.text()).not.toContain(PASSWORD);
    expect(stderr.text()).not.toContain(AUTH);
  });

  test('secretsFromHeaders collects whole values, credentials and cookie values', () => {
    expect(secretsFromHeaders({
      authorization: 'Bearer unit-hdr-token-1',
      'proxy-authorization': 'Basic dXNlcjpwYXNz',
      cookie: 'session=unit-hdr-cookie-2; a=1; theme=dark',
      accept: 'json',
    }).sort()).toEqual([
      'Basic dXNlcjpwYXNz', 'Bearer unit-hdr-token-1', 'dXNlcjpwYXNz', 'dark',
      'session=unit-hdr-cookie-2; a=1; theme=dark', 'unit-hdr-cookie-2', 'unit-hdr-token-1',
    ].sort());
    expect(secretsFromHeaders({})).toEqual([]);
    expect(secretsFromHeaders()).toEqual([]);
  });

  test('request context secrets are removed from messages, metadata, error messages and stacks', () => {
    const {logger, stdout, stderr} = setup({secrets: [PASSWORD]});
    const secrets = secretsFromHeaders({authorization: AUTH, cookie: COOKIE});
    runWithContext({request_id: 'ctx-secret', secrets}, () => {
      const error = new Error(`denied ${AUTH} with ${COOKIE} and ${PASSWORD}`);
      error.stack = `Error: denied\n    at handler (/app/unit-auth-token-91c2/unit-cookie-5d8e.js:1:1)`;
      logger.error(`header ${AUTH}`, {error, note: `cookie ${COOKIE}`, nested: {list: ['unit-cookie-5d8e']}});
      logger.info('token only unit-auth-token-91c2');
    });
    // Outside the context the request's values are no longer registered.
    logger.info('after unit-auth-token-91c2');

    const text = stdout.text() + stderr.text();
    expect(text.split('after')[0]).not.toContain('unit-auth-token');
    expect(text).not.toContain('unit-cookie');
    expect(text).not.toContain(PASSWORD);
    const [record] = stderr.records();
    expect(record).toMatchObject({request_id: 'ctx-secret', message: `header ${REDACTED}`, note: `cookie ${REDACTED}`});
    expect(record.error.message).toBe(`denied ${REDACTED} with ${REDACTED} and ${REDACTED}`);
    expect(record.error.stack).toEqual([`at handler (/app/${REDACTED}/${REDACTED}.js:1:1)`]);
    expect(record).not.toHaveProperty('secrets');
    expect(stdout.records().map(item => item.message)).toEqual([`token only ${REDACTED}`, 'after unit-auth-token-91c2']);
  });

  test('child secrets apply outside the async context and do not leak to other loggers', () => {
    const {logger, stdout} = setup();
    const child = logger.child({request_id: 'child-secret'}, {secrets: secretsFromHeaders({authorization: AUTH})});
    child.info(`late ${AUTH}`, {error: new Error(`timer saw unit-auth-token-91c2`)});
    child.child({step: 2}).info('nested unit-auth-token-91c2');
    logger.info('root unit-auth-token-91c2');

    const records = stdout.records();
    expect(records[0]).toMatchObject({request_id: 'child-secret', message: `late ${REDACTED}`, error: {message: `timer saw ${REDACTED}`}});
    expect(records[1]).toMatchObject({request_id: 'child-secret', step: 2, message: `nested ${REDACTED}`});
    expect(records[2].message).toBe('root unit-auth-token-91c2');
    for (const record of records) expect(record).not.toHaveProperty('secrets');
  });

  test('a secret that contains another registered secret is removed whole', () => {
    const {logger, stdout} = setup({secrets: ['abc', 'xxabcxx']});
    logger.info('value xxabcxx and abc');
    expect(stdout.records()[0].message).toBe(`value ${REDACTED} and ${REDACTED}`);
  });
});
