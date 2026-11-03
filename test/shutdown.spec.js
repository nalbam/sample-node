import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {jest} from '@jest/globals';
import {createShutdownManager, DEFAULT_SHUTDOWN_TIMEOUT_MS, parseShutdownTimeout} from '../lib/shutdown.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

// Lets queued promise continuations run without advancing fake time.
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(overrides = {}) {
  const calls = [];
  const callbacks = {
    onStart: jest.fn(signal => calls.push(`onStart:${signal}`)),
    drain: jest.fn(async () => { calls.push('drain'); }),
    cleanup: jest.fn(async () => { calls.push('cleanup'); }),
    forceClose: jest.fn(() => calls.push('forceClose')),
    exit: jest.fn(code => calls.push(`exit:${code}`)),
    onError: jest.fn((error, {phase}) => calls.push(`error:${phase}`)),
    ...overrides,
  };
  return {calls, callbacks, manager: createShutdownManager(callbacks)};
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('parseShutdownTimeout', () => {
  test('defaults to 10000ms when unset or empty', () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(10000);
    expect(parseShutdownTimeout(undefined)).toBe(10000);
    expect(parseShutdownTimeout(null)).toBe(10000);
    expect(parseShutdownTimeout('')).toBe(10000);
  });

  test('accepts integer milliseconds from 1 to 2147483647', () => {
    expect(parseShutdownTimeout('1')).toBe(1);
    expect(parseShutdownTimeout('2500')).toBe(2500);
    expect(parseShutdownTimeout(' 30000 ')).toBe(30000);
    expect(parseShutdownTimeout('2147483647')).toBe(2147483647);
    expect(parseShutdownTimeout(4000)).toBe(4000);
  });

  test.each(['0', '-1', '1.5', '1e3', '5s', 'abc', '0x10', '2147483648', '99999999999999999999', 0, -5, 1.5, NaN, Infinity, 2147483648, {}, true])(
    'falls back to the default for invalid value %p',
    value => expect(parseShutdownTimeout(value)).toBe(10000),
  );
});

describe('createShutdownManager configuration', () => {
  test('rejects invalid timeoutMs and missing callbacks at creation', () => {
    const exit = jest.fn();
    for (const timeoutMs of [0, -1, 1.5, '1000', 2147483648, NaN]) {
      expect(() => createShutdownManager({timeoutMs, exit})).toThrow(RangeError);
    }
    expect(() => createShutdownManager({})).toThrow(TypeError);
    expect(() => createShutdownManager({exit, drain: 'nope'})).toThrow(TypeError);
  });

  test('does not start a timer or call anything before begin', () => {
    const {callbacks, manager} = setup();
    expect(jest.getTimerCount()).toBe(0);
    expect(manager.isShuttingDown).toBe(false);
    for (const name of ['onStart', 'drain', 'cleanup', 'forceClose', 'exit', 'onError']) {
      expect(callbacks[name]).not.toHaveBeenCalled();
    }
  });

  test('isShuttingDown cannot be assigned by callers', () => {
    const {manager} = setup();
    expect(() => { manager.isShuttingDown = true; }).toThrow(TypeError);
    expect(manager.isShuttingDown).toBe(false);
  });
});

describe('graceful shutdown', () => {
  test('switches state, starts the deadline and stops new work synchronously', () => {
    let stateDuringStart;
    let timersDuringStart;
    const {callbacks, manager} = setup({
      onStart: jest.fn(() => {
        stateDuringStart = manager.isShuttingDown;
        timersDuringStart = jest.getTimerCount();
      }),
    });
    manager.begin('SIGTERM');
    expect(manager.isShuttingDown).toBe(true);
    expect(callbacks.onStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onStart).toHaveBeenCalledWith('SIGTERM');
    expect(stateDuringStart).toBe(true);
    expect(timersDuringStart).toBe(1);
    expect(callbacks.exit).not.toHaveBeenCalled();
  });

  test('runs drain then cleanup and exits 0 exactly once', async () => {
    const drained = deferred();
    const cleaned = deferred();
    const {calls, callbacks, manager} = setup({
      drain: jest.fn(() => { calls.push('drain'); return drained.promise; }),
      cleanup: jest.fn(() => { calls.push('cleanup'); return cleaned.promise; }),
    });
    const done = manager.begin('SIGTERM');
    await flush();
    expect(calls).toEqual(['onStart:SIGTERM', 'drain']);

    drained.resolve();
    await flush();
    expect(calls).toEqual(['onStart:SIGTERM', 'drain', 'cleanup']);
    expect(callbacks.exit).not.toHaveBeenCalled();

    cleaned.resolve();
    await expect(done).resolves.toBe(0);
    expect(calls).toEqual(['onStart:SIGTERM', 'drain', 'cleanup', 'exit:0']);
    expect(callbacks.drain).toHaveBeenCalledWith('SIGTERM');
    expect(callbacks.cleanup).toHaveBeenCalledWith('SIGTERM');
    expect(callbacks.forceClose).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    jest.advanceTimersByTime(DEFAULT_SHUTDOWN_TIMEOUT_MS * 2);
    await flush();
    expect(callbacks.exit).toHaveBeenCalledTimes(1);
  });

  test('works with only exit and synchronous callbacks', async () => {
    const exit = jest.fn();
    await expect(createShutdownManager({exit}).begin('SIGINT')).resolves.toBe(0);
    const drain = jest.fn();
    await expect(createShutdownManager({exit, drain}).begin('SIGINT')).resolves.toBe(0);
    expect(exit.mock.calls).toEqual([[0], [0]]);
  });
});

describe('repeated shutdown requests', () => {
  test('share the first procedure, timer and signal without extending the deadline', async () => {
    const drained = deferred();
    const {callbacks, manager} = setup({timeoutMs: 1000, drain: jest.fn(() => drained.promise)});
    const first = manager.begin('SIGTERM');
    jest.advanceTimersByTime(600);
    const second = manager.begin('SIGTERM');
    const third = manager.begin('SIGINT');
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(jest.getTimerCount()).toBe(1);
    await flush();
    expect(callbacks.onStart).toHaveBeenCalledTimes(1);
    expect(callbacks.drain).toHaveBeenCalledTimes(1);
    expect(callbacks.drain).toHaveBeenCalledWith('SIGTERM');

    // Deadline still counts from the first request: 600 + 400 = 1000ms.
    jest.advanceTimersByTime(399);
    expect(callbacks.exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(first).resolves.toBe(1);
    expect(callbacks.forceClose).toHaveBeenCalledTimes(1);
    expect(callbacks.forceClose).toHaveBeenCalledWith('SIGTERM');
    expect(callbacks.exit).toHaveBeenCalledTimes(1);
  });

  test('after completion return the settled result without rerunning anything', async () => {
    const {callbacks, manager} = setup();
    await expect(manager.begin('SIGTERM')).resolves.toBe(0);
    await expect(manager.begin('SIGINT')).resolves.toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    for (const name of ['onStart', 'drain', 'cleanup', 'exit']) {
      expect(callbacks[name]).toHaveBeenCalledTimes(1);
    }
  });
});

describe('shutdown deadline', () => {
  test('uses 10000ms by default and forces close when drain hangs', async () => {
    const {calls, callbacks, manager} = setup({drain: jest.fn(() => new Promise(() => {}))});
    const done = manager.begin('SIGTERM');
    jest.advanceTimersByTime(9999);
    await flush();
    expect(callbacks.forceClose).not.toHaveBeenCalled();
    expect(callbacks.exit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await expect(done).resolves.toBe(1);
    expect(calls).toEqual(['onStart:SIGTERM', 'error:timeout', 'forceClose', 'exit:1']);
    expect(callbacks.cleanup).not.toHaveBeenCalled();
    expect(callbacks.onError.mock.calls[0][0].message).toMatch('10000ms');
  });

  test('honours a custom timeout covering drain and cleanup together', async () => {
    const drained = deferred();
    const {callbacks, manager} = setup({
      timeoutMs: 3000,
      drain: jest.fn(() => drained.promise),
      cleanup: jest.fn(() => new Promise(() => {})),
    });
    const done = manager.begin('SIGTERM');
    jest.advanceTimersByTime(2000);
    drained.resolve();
    await flush();
    expect(callbacks.cleanup).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(999);
    await flush();
    expect(callbacks.exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(done).resolves.toBe(1);
    expect(callbacks.forceClose).toHaveBeenCalledTimes(1);
    expect(callbacks.exit.mock.calls).toEqual([[1]]);
  });

  test('exits 1 without waiting for a hung or failing forceClose', async () => {
    const {callbacks, manager} = setup({
      timeoutMs: 50,
      drain: jest.fn(() => new Promise(() => {})),
      forceClose: jest.fn(() => new Promise(() => {})),
    });
    const done = manager.begin('SIGTERM');
    jest.advanceTimersByTime(50);
    expect(callbacks.exit.mock.calls).toEqual([[1]]);
    await expect(done).resolves.toBe(1);

    const throwing = setup({
      timeoutMs: 50,
      drain: jest.fn(() => new Promise(() => {})),
      forceClose: jest.fn(() => { throw new Error('destroy failed'); }),
    });
    const throwingDone = throwing.manager.begin('SIGTERM');
    jest.advanceTimersByTime(50);
    await expect(throwingDone).resolves.toBe(1);
    expect(throwing.calls).toEqual(['onStart:SIGTERM', 'error:timeout', 'error:forceClose', 'exit:1']);
  });

  test('ignores drain and cleanup completing after the deadline', async () => {
    const drained = deferred();
    const {callbacks, manager} = setup({timeoutMs: 100, drain: jest.fn(() => drained.promise)});
    const done = manager.begin('SIGTERM');
    jest.advanceTimersByTime(100);
    await expect(done).resolves.toBe(1);

    drained.resolve();
    await flush();
    jest.runAllTimers();
    expect(callbacks.cleanup).not.toHaveBeenCalled();
    expect(callbacks.forceClose).toHaveBeenCalledTimes(1);
    expect(callbacks.exit).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).toHaveBeenCalledTimes(1);

    const cleaned = deferred();
    const late = setup({timeoutMs: 100, cleanup: jest.fn(() => cleaned.promise)});
    const lateDone = late.manager.begin('SIGTERM');
    await flush();
    jest.advanceTimersByTime(100);
    await expect(lateDone).resolves.toBe(1);
    cleaned.reject(new Error('late failure'));
    await flush();
    expect(late.callbacks.exit.mock.calls).toEqual([[1]]);
    expect(late.callbacks.forceClose).toHaveBeenCalledTimes(1);
    expect(late.calls).toEqual(['onStart:SIGTERM', 'drain', 'error:timeout', 'forceClose', 'exit:1']);
  });
});

describe('callback failures', () => {
  test('a rejected drain is reported, cleanup still runs and exit is 1', async () => {
    const failure = new Error('drain failed');
    const {calls, callbacks, manager} = setup({drain: jest.fn(async () => { throw failure; })});
    await expect(manager.begin('SIGTERM')).resolves.toBe(1);
    expect(calls).toEqual(['onStart:SIGTERM', 'error:drain', 'cleanup', 'exit:1']);
    expect(callbacks.onError).toHaveBeenCalledWith(failure, {phase: 'drain', signal: 'SIGTERM'});
    expect(callbacks.forceClose).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a synchronously throwing drain is treated like a rejection', async () => {
    const {calls, manager} = setup({drain: jest.fn(() => { throw new Error('sync drain'); })});
    await expect(manager.begin('SIGTERM')).resolves.toBe(1);
    expect(calls).toEqual(['onStart:SIGTERM', 'error:drain', 'cleanup', 'exit:1']);
  });

  test('a throwing onStart is reported but drain and cleanup still run', async () => {
    const failure = new Error('close failed');
    const {calls, callbacks, manager} = setup({onStart: jest.fn(() => { throw failure; })});
    const done = manager.begin('SIGTERM');
    expect(manager.isShuttingDown).toBe(true);
    expect(callbacks.onError).toHaveBeenCalledWith(failure, {phase: 'onStart', signal: 'SIGTERM'});
    await expect(done).resolves.toBe(1);
    expect(calls).toEqual(['error:onStart', 'drain', 'cleanup', 'exit:1']);
  });

  test('a failing cleanup, sync or async, exits 1', async () => {
    const asyncFailure = setup({cleanup: jest.fn(async () => { throw new Error('quit failed'); })});
    await expect(asyncFailure.manager.begin('SIGTERM')).resolves.toBe(1);
    expect(asyncFailure.calls).toEqual(['onStart:SIGTERM', 'drain', 'error:cleanup', 'exit:1']);

    const syncFailure = setup({cleanup: jest.fn(() => { throw new Error('sync quit'); })});
    await expect(syncFailure.manager.begin('SIGTERM')).resolves.toBe(1);
    expect(syncFailure.calls).toEqual(['onStart:SIGTERM', 'drain', 'error:cleanup', 'exit:1']);
  });

  test('a failed drain followed by a hung cleanup still exits 1 at the deadline', async () => {
    const {calls, callbacks, manager} = setup({
      timeoutMs: 500,
      drain: jest.fn(async () => { throw new Error('drain failed'); }),
      cleanup: jest.fn(() => new Promise(() => {})),
    });
    const done = manager.begin('SIGTERM');
    await flush();
    expect(callbacks.exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(500);
    await expect(done).resolves.toBe(1);
    expect(calls).toEqual(['onStart:SIGTERM', 'error:drain', 'error:timeout', 'forceClose', 'exit:1']);
  });

  test('a throwing onError does not stop shutdown', async () => {
    const {callbacks, manager} = setup({
      drain: jest.fn(async () => { throw new Error('drain failed'); }),
      onError: jest.fn(() => { throw new Error('logger broken'); }),
    });
    await expect(manager.begin('SIGTERM')).resolves.toBe(1);
    expect(callbacks.cleanup).toHaveBeenCalledTimes(1);
    expect(callbacks.exit.mock.calls).toEqual([[1]]);
  });
});

describe('module import', () => {
  test('creates no signal listeners, timers or servers', () => {
    const modulePath = fileURLToPath(new URL('../lib/shutdown.js', import.meta.url));
    const script = `
      const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit', 'beforeExit'];
      const before = process.getActiveResourcesInfo();
      await import(${JSON.stringify(modulePath)});
      console.log(JSON.stringify({
        listeners: signals.map(name => process.listenerCount(name)),
        added: process.getActiveResourcesInfo().length - before.length,
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 10000});
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({listeners: [0, 0, 0, 0, 0], added: 0});
  });
});
