import redis from 'redis';
import {
  buildRedisUrl, DEFAULT_PORT, DEFAULT_REDIS_PORT, parsePort, resolveRedisConfig,
} from '../lib/config.js';

// The parser the redis client applies to the url option.
const parseURL = url => redis.RedisClient.parseURL(url);

const PASSWORD = 'va1key p@ss:w/rd%41?#&=';
const USERNAME = 'app user@x';

describe('parsePort', () => {
  test.each([['3000', 3000], [' 8080 ', 8080], ['1', 1], ['65535', 65535]])('accepts %j', (value, expected) => {
    expect(parsePort(value, DEFAULT_PORT)).toBe(expected);
  });

  test.each([undefined, '', '0', '65536', '-1', '80abc', '1.5', 3000])('uses the fallback for %j', value => {
    expect(parsePort(value, DEFAULT_PORT)).toBe(DEFAULT_PORT);
  });
});

describe('buildRedisUrl', () => {
  test('percent-encodes credentials so the client decodes them unchanged', () => {
    const url = buildRedisUrl({host: 'valkey', port: 6380, username: USERNAME, password: PASSWORD});
    expect(url.startsWith('redis://')).toBe(true);
    expect(url).not.toContain(PASSWORD);
    const parsed = parseURL(url);
    expect(parsed).toMatchObject({username: USERNAME, password: PASSWORD, socket: {host: 'valkey', port: 6380, tls: false}});
  });

  test('brackets IPv6 hosts and keeps the database', () => {
    const url = buildRedisUrl({tls: true, host: '::1', port: 6379, database: 2});
    expect(url).toBe('rediss://[::1]:6379/2');
    expect(parseURL(url)).toMatchObject({database: 2, socket: {host: '::1', tls: true}});
  });
});

describe('resolveRedisConfig', () => {
  test('CACHE_VALKEY_URL wins over the host variables and the legacy settings', () => {
    const config = resolveRedisConfig({
      CACHE_VALKEY_URL: `rediss://${encodeURIComponent(USERNAME)}:${encodeURIComponent(PASSWORD)}@cache.internal:6390/1`,
      CACHE_VALKEY_HOST: 'other-host',
      CACHE_VALKEY_PASSWORD: 'other-pass',
      REDIS_HOST: 'legacy',
      REDIS_PASS: 'legacy-pass',
    });
    expect(config).toMatchObject({enabled: true, source: 'CACHE_VALKEY_URL', host: 'cache.internal', port: 6390, tls: true, warnings: []});
    expect(parseURL(config.clientOptions.url)).toMatchObject({
      username: USERNAME, password: PASSWORD, database: 1, socket: {host: 'cache.internal', port: 6390, tls: true},
    });
    expect(config.clientOptions).not.toHaveProperty('password');
    expect(config.secrets).toEqual(expect.arrayContaining([PASSWORD, encodeURIComponent(PASSWORD), config.clientOptions.url]));
  });

  test.each([
    ['redis://cache:6379', false, 6379],
    ['redis://cache', false, DEFAULT_REDIS_PORT],
    ['rediss://cache:6380', true, 6380],
  ])('accepts %s', (url, tls, port) => {
    expect(resolveRedisConfig({CACHE_VALKEY_URL: url})).toMatchObject({source: 'CACHE_VALKEY_URL', host: 'cache', port, tls});
  });

  test.each([
    'http://user:secret-x@cache:6379', 'not a url secret-x', 'redis://user:secret-x@cache:6379/abc', 'redis://:%E0%A4%A@cache',
  ])('ignores an unusable CACHE_VALKEY_URL by name only: %s', url => {
    const config = resolveRedisConfig({CACHE_VALKEY_URL: url, CACHE_VALKEY_HOST: 'valkey'});
    expect(config.source).toBe('CACHE_VALKEY_HOST');
    expect(config.warnings).toEqual([{variable: 'CACHE_VALKEY_URL', reason: expect.any(String)}]);
    expect(JSON.stringify(config.warnings)).not.toContain('secret-x');
    expect(config.secrets).toContain(url);
  });

  test('composes the host variables with encoded credentials', () => {
    const config = resolveRedisConfig({
      CACHE_VALKEY_HOST: 'valkey.dev.svc',
      CACHE_VALKEY_PORT: '6380',
      CACHE_VALKEY_USERNAME: USERNAME,
      CACHE_VALKEY_PASSWORD: PASSWORD,
      REDIS_HOST: 'legacy',
      REDIS_PASS: 'legacy-pass',
    });
    expect(config).toMatchObject({source: 'CACHE_VALKEY_HOST', host: 'valkey.dev.svc', port: 6380, tls: false});
    expect(config.clientOptions.url).not.toContain(PASSWORD);
    expect(parseURL(config.clientOptions.url)).toMatchObject({
      username: USERNAME, password: PASSWORD, socket: {host: 'valkey.dev.svc', port: 6380},
    });
    expect(config.secrets).toEqual(expect.arrayContaining([PASSWORD, encodeURIComponent(PASSWORD), 'legacy-pass']));
  });

  test('a host without credentials or port uses the default port and no auth', () => {
    const config = resolveRedisConfig({CACHE_VALKEY_HOST: 'valkey', CACHE_VALKEY_PORT: 'bad'});
    expect(config.clientOptions).toEqual({url: 'redis://valkey:6379'});
  });

  test('a password without a username authenticates as the default user', () => {
    const config = resolveRedisConfig({CACHE_VALKEY_HOST: 'valkey', CACHE_VALKEY_PASSWORD: PASSWORD});
    const parsed = parseURL(config.clientOptions.url);
    expect(parsed.password).toBe(PASSWORD);
    expect(parsed.username).toBeUndefined();
  });

  test('an invalid CACHE_VALKEY_HOST falls back to the legacy settings', () => {
    const config = resolveRedisConfig({CACHE_VALKEY_HOST: 'evil@host/x'});
    expect(config.source).toBe('REDIS_HOST');
    expect(config.warnings).toEqual([{variable: 'CACHE_VALKEY_HOST', reason: expect.any(String)}]);
  });

  test('without Valkey variables the legacy REDIS_* settings are used as before', () => {
    expect(resolveRedisConfig({REDIS_HOST: 'legacy', REDIS_PORT: '6390', REDIS_PASS: 'legacy-pass'})).toMatchObject({
      enabled: true,
      source: 'REDIS_HOST',
      host: 'legacy',
      port: 6390,
      clientOptions: {url: 'redis://legacy:6390', password: 'legacy-pass'},
      secrets: ['legacy-pass'],
    });
    expect(resolveRedisConfig({}).clientOptions).toEqual({url: 'redis://redis:6379'});
    expect(resolveRedisConfig({CACHE_VALKEY_URL: '  ', CACHE_VALKEY_HOST: ''}).source).toBe('REDIS_HOST');
  });

  test.each(['false', 'FALSE', ' false '])('REDIS_ENABLED=%j disables Redis whatever else is set', value => {
    const config = resolveRedisConfig({
      REDIS_ENABLED: value, CACHE_VALKEY_URL: 'redis://:vk-pass@cache:6379', CACHE_VALKEY_HOST: 'valkey', REDIS_HOST: 'legacy',
    });
    expect(config).toMatchObject({enabled: false, source: null, clientOptions: null});
    // Credentials stay registered for redaction even when unused.
    expect(config.secrets).toContain('vk-pass');
  });

  test.each([undefined, 'true', '', '0'])('REDIS_ENABLED=%j keeps Redis enabled', value => {
    expect(resolveRedisConfig({REDIS_ENABLED: value}).enabled).toBe(true);
  });
});
