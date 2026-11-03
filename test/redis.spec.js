// lib/redis.js with fake timers and a fake client that follows redis 6.x:
// connect() opens (isOpen) and then becomes ready (isReady); destroy() closes
// at once and rejects every pending command and a connect still in its
// handshake.
import {jest} from '@jest/globals';
import {
  createRedisAccess, DEFAULT_REDIS_TIMEOUT_MS, parseRedisTimeout, RedisUnavailableError,
} from '../lib/redis.js';
import {startTelemetryPublisher} from '../lib/telemetry-store.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

function createFakeClient() {
  const pending = new Set();
  const fake = {
    isOpen: false,
    isReady: false,
    // false: destroy() does not reject a connect that already passed its
    // checks, so the connect can still complete late (a zombie attempt).
    destroyRejectsConnect: true,
    connects: [],
    connect: jest.fn(() => {
      fake.isOpen = true;
      const attempt = deferred();
      fake.connects.push(attempt);
      if (fake.destroyRejectsConnect) pending.add(attempt);
      return attempt.promise.then(() => {
        pending.delete(attempt);
        fake.isReady = true;
        return fake;
      }, error => {
        pending.delete(attempt);
        fake.isOpen = false;
        throw error;
      });
    }),
    // A command that settles only when the test settles it, or on destroy().
    command: jest.fn(() => {
      const reply = deferred();
      pending.add(reply);
      reply.promise.then(() => pending.delete(reply), () => pending.delete(reply));
      fake.commands.push(reply);
      return reply.promise;
    }),
    commands: [],
    destroy: jest.fn(() => {
      fake.isOpen = false;
      fake.isReady = false;
      for (const item of [...pending]) item.reject(new Error('Disconnects client'));
    }),
    close: jest.fn(async () => {
      fake.isOpen = false;
      fake.isReady = false;
    }),
  };
  return fake;
}

const TIMEOUT = 2000;
let client;
let logger;
let access;

beforeEach(() => {
  jest.useFakeTimers();
  client = createFakeClient();
  logger = {error: jest.fn()};
  access = createRedisAccess({client, timeoutMs: TIMEOUT, logger});
});
afterEach(() => {
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

const logged = event => logger.error.mock.calls.filter(([, fields]) => fields.event === event).map(([, fields]) => fields);

// Settles a promise without an unhandled rejection; returns {value} or {error}.
function track(promise) {
  const state = {settled: false};
  promise.then(value => Object.assign(state, {settled: true, value}), error => Object.assign(state, {settled: true, error}));
  return state;
}

describe('parseRedisTimeout', () => {
  test.each([
    ['1', 1], ['2000', 2000], ['60000', 60000], [' 750 ', 750], ['\t30\n', 30], ['007', 7],
  ])('accepts %j as %d', (value, expected) => {
    expect(parseRedisTimeout(value)).toBe(expected);
  });

  test.each([
    undefined, '', '   ', '0', '-1', '60001', '1.5', '1e3', '2s', '0x10', '+5', '20 00', 2000, null,
  ])('uses the default for %j', value => {
    expect(parseRedisTimeout(value)).toBe(DEFAULT_REDIS_TIMEOUT_MS);
  });

  test('the default is 2000ms', () => {
    expect(DEFAULT_REDIS_TIMEOUT_MS).toBe(2000);
  });
});

describe('one budget per operation', () => {
  test('connect and every command share one limit; the connection is destroyed at the limit', async () => {
    const result = track(access.run(async redis => {
      await redis.command('XRANGE');
      return redis.command('MGET');
    }));
    await jest.advanceTimersByTimeAsync(1500);
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(300);
    client.commands[0].resolve([]);
    // 1800ms used: the second command has only 200ms left, not a new budget.
    await jest.advanceTimersByTimeAsync(199);
    expect(result.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(result.error).toBeInstanceOf(RedisUnavailableError);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(logged('redis.timeout')).toEqual([{event: 'redis.timeout', stage: 'command', timeout_ms: TIMEOUT}]);
    // The destroyed command's late rejection is not logged again.
    await jest.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test('a connect that never completes ends at the limit with stage connect', async () => {
    const result = track(access.run(redis => redis.command('GET')));
    await jest.advanceTimersByTimeAsync(TIMEOUT);
    expect(result.error).toBeInstanceOf(RedisUnavailableError);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(client.command).not.toHaveBeenCalled();
    expect(logged('redis.timeout')).toEqual([expect.objectContaining({stage: 'connect'})]);
    // The connect rejected by destroy() is not logged for the expired request.
    expect(logged('redis.connect_failed')).toEqual([]);
  });

  test('a reply arriving after the limit is ignored', async () => {
    client.destroy.mockImplementation(() => { client.isOpen = false; client.isReady = false; });
    const result = track(access.run(redis => redis.command('GET')));
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(TIMEOUT);
    expect(result.error).toBeInstanceOf(RedisUnavailableError);
    client.commands[0].resolve('late');
    await jest.advanceTimersByTimeAsync(0);
    expect(result.error).toBeInstanceOf(RedisUnavailableError);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test('an answer within the limit clears its timer', async () => {
    const result = track(access.run(redis => redis.command('GET')));
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(10);
    client.commands[0].resolve('value');
    await jest.advanceTimersByTimeAsync(0);
    expect(result.value).toBe('value');
    expect(client.destroy).not.toHaveBeenCalled();
  });
});

describe('errors', () => {
  test('an error reply on a ready connection passes through unchanged', async () => {
    const reply = new Error('WRONGTYPE');
    const result = track(access.run(async () => { throw reply; }));
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(result.error).toBe(reply);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('a failure after the connection went away is unavailable', async () => {
    const result = track(access.run(async () => {
      client.isReady = false;
      throw new Error('Socket closed unexpectedly');
    }));
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(result.error).toBeInstanceOf(RedisUnavailableError);
    expect(result.error.cause.message).toBe('Socket closed unexpectedly');
    expect(logged('redis.connection_lost')).toHaveLength(1);
  });

  test('a failed connect is unavailable and the next operation starts a new attempt', async () => {
    const first = track(access.run(redis => redis.command('GET')));
    client.connects[0].reject(new Error('ECONNREFUSED'));
    await jest.advanceTimersByTimeAsync(0);
    expect(first.error).toBeInstanceOf(RedisUnavailableError);
    expect(logged('redis.connect_failed')).toEqual([expect.objectContaining({error: expect.objectContaining({message: 'ECONNREFUSED'})})]);
    const second = track(access.run(async () => 'ok'));
    client.connects[1].resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(second.value).toBe('ok');
    expect(client.connect).toHaveBeenCalledTimes(2);
  });
});

describe('concurrency and stale work', () => {
  test('concurrent operations share one connect attempt', async () => {
    const results = [1, 2, 3].map(() => track(access.run(async () => 'ok')));
    expect(client.connect).toHaveBeenCalledTimes(1);
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(results.map(result => result.value)).toEqual(['ok', 'ok', 'ok']);
  });

  test('a destroyed connection fails the other waiting operations within their own limit', async () => {
    const first = track(access.run(redis => redis.command('GET')));
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(500);
    const second = track(access.run(redis => redis.command('GET')));
    await jest.advanceTimersByTimeAsync(1500);
    expect(first.error).toBeInstanceOf(RedisUnavailableError);
    expect(second.error).toBeInstanceOf(RedisUnavailableError);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(logged('redis.connection_lost')).toHaveLength(1);
  });

  test('a late connect of an abandoned attempt is torn down and never reported ready', async () => {
    client.destroyRejectsConnect = false;
    const first = track(access.run(async () => 'first'));
    await jest.advanceTimersByTimeAsync(TIMEOUT);
    expect(first.error).toBeInstanceOf(RedisUnavailableError);
    // Joins the abandoned attempt that is still settling.
    const joined = track(access.run(async () => 'joined'));
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(client.destroy).toHaveBeenCalledTimes(2);
    expect(client.isReady).toBe(false);
    expect(joined.error).toBeInstanceOf(RedisUnavailableError);
    expect(client.connect).toHaveBeenCalledTimes(1);

    const next = track(access.run(async () => 'next'));
    expect(client.connect).toHaveBeenCalledTimes(2);
    client.connects[1].resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(next.value).toBe('next');
    expect(client.isReady).toBe(true);
  });

  test('a timer of an operation on an old connection never destroys the new one', async () => {
    // Commands of the old connection stay pending after destroy(), as a reply
    // that never comes back.
    client.destroy.mockImplementation(() => { client.isOpen = false; client.isReady = false; });
    const old = track(access.run(redis => redis.command('GET')));
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(1000);
    const older = track(access.run(redis => redis.command('GET')));
    await jest.advanceTimersByTimeAsync(1000);
    expect(old.error).toBeInstanceOf(RedisUnavailableError);
    expect(client.destroy).toHaveBeenCalledTimes(1);

    const fresh = track(access.run(redis => redis.command('GET')));
    client.connects[1].resolve();
    await jest.advanceTimersByTimeAsync(0);
    // The second operation on the old connection now expires.
    await jest.advanceTimersByTimeAsync(1000);
    expect(older.error).toBeInstanceOf(RedisUnavailableError);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(client.isReady).toBe(true);
    client.commands[2].resolve('fresh');
    await jest.advanceTimersByTimeAsync(0);
    expect(fresh.value).toBe('fresh');
  });
});

describe('available()', () => {
  test('reports a ready connection, and false within the limit otherwise', async () => {
    const first = track(access.available());
    await jest.advanceTimersByTimeAsync(TIMEOUT);
    expect(first.value).toBe(false);
    const second = track(access.available());
    client.connects[1].resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(second.value).toBe(true);
  });

  test('an open socket that is not ready is unavailable without connecting', async () => {
    client.isOpen = true;
    const result = track(access.available());
    await jest.advanceTimersByTimeAsync(0);
    expect(result.value).toBe(false);
    expect(client.connect).not.toHaveBeenCalled();
  });
});

describe('shutdown', () => {
  test('close() waits for a pending connect, closes once, and no operation reconnects', async () => {
    const pending = track(access.run(async () => 'ok'));
    const closed = track(access.close());
    await jest.advanceTimersByTimeAsync(0);
    expect(closed.settled).toBe(false);
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(closed.settled).toBe(true);
    // A connect completing after shutdown began is torn down.
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(pending.error).toBeInstanceOf(RedisUnavailableError);
    const after = track(access.run(async () => 'ok'));
    await jest.advanceTimersByTimeAsync(0);
    expect(after.error).toBeInstanceOf(RedisUnavailableError);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  test('destroy() closes at once and stops reconnecting', async () => {
    access.destroy();
    expect(client.destroy).toHaveBeenCalledTimes(1);
    const after = track(access.run(async () => 'ok'));
    await jest.advanceTimersByTimeAsync(0);
    expect(after.error).toBeInstanceOf(RedisUnavailableError);
    expect(client.connect).not.toHaveBeenCalled();
  });
});

describe('telemetry publisher with a stalled Redis', () => {
  test('each publish ends at the limit, ticks never overlap, and publishing resumes', async () => {
    let active = 0;
    let maxActive = 0;
    let stalled = true;
    const onError = jest.fn();
    const publish = jest.fn(() => access.run(async redis => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (stalled) await redis.command('EXEC');
      } finally {
        active--;
      }
    }).catch(error => {
      if (!(error instanceof RedisUnavailableError)) throw error;
    }));
    const stop = startTelemetryPublisher(publish, onError);
    client.connects[0].resolve();
    await jest.advanceTimersByTimeAsync(TIMEOUT + 1);
    // The stalled publish ended at the limit and the next tick started at once.
    expect(publish).toHaveBeenCalledTimes(2);
    expect(client.connect).toHaveBeenCalledTimes(2);
    stalled = false;
    client.connects[1].resolve();
    await jest.advanceTimersByTimeAsync(3000);
    expect(publish).toHaveBeenCalledTimes(5);
    expect(maxActive).toBe(1);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });
});
