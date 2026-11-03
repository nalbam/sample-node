// Coordinates a graceful process shutdown. This module only orchestrates
// injected callbacks: it never registers signal listeners, starts timers or
// touches servers at import time. The caller (server.js) owns signal
// registration and the actual HTTP, Redis and telemetry publisher handles.

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

// setTimeout clamps larger delays to 1ms, so cap at the signed 32-bit maximum.
const MAX_SHUTDOWN_TIMEOUT_MS = 2147483647;

function validTimeout(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_SHUTDOWN_TIMEOUT_MS;
}

/**
 * Parses SHUTDOWN_TIMEOUT_MS style configuration.
 *
 * Accepts an integer number of milliseconds in 1..2147483647, given either as
 * a number or as a decimal string of digits (surrounding whitespace allowed).
 * Anything else — undefined, empty, zero, negative, fractional, exponent or
 * unit suffixed values such as "5s", or out of range — returns
 * DEFAULT_SHUTDOWN_TIMEOUT_MS. It never throws.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function parseShutdownTimeout(value) {
  if (typeof value === 'number') return validTimeout(value) ? value : DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const parsed = Number(value);
  return validTimeout(parsed) ? parsed : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

function optionalCallback(options, name) {
  const callback = options[name];
  if (callback === undefined) return () => {};
  if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  return callback;
}

/**
 * Creates a one-shot shutdown coordinator.
 *
 * Options (every callback receives the signal passed to the first begin()):
 * - timeoutMs: overall deadline in integer ms (1..2147483647), counted from the
 *   first begin() and covering drain and cleanup together. Defaults to
 *   DEFAULT_SHUTDOWN_TIMEOUT_MS; use parseShutdownTimeout() for env values.
 *   Any other value throws a RangeError at creation.
 * - onStart(signal): synchronous. Called immediately inside the first begin(),
 *   after isShuttingDown becomes true and the deadline timer starts. Stop
 *   accepting new connections and stop periodic jobs here (for example
 *   server.close() and the telemetry publisher stop function).
 * - drain(signal): may return a Promise. Wait for in-flight work, such as
 *   open HTTP requests, to finish.
 * - cleanup(signal): may return a Promise. Runs after drain settles, even if
 *   onStart or drain failed. Close remaining resources such as Redis.
 * - forceClose(signal): called at most once, only when the deadline expires
 *   before drain and cleanup finish. Should synchronously destroy remaining
 *   connections. Its returned Promise is not awaited.
 * - exit(code): required. Called exactly once with 0 when onStart, drain and
 *   cleanup all succeed, or 1 on any failure or timeout. Use process.exit.
 * - onError(error, {phase, signal}): receives synchronous throws and
 *   rejections from onStart, drain, cleanup, forceClose and exit, plus a
 *   timeout Error (phase "timeout"). Errors thrown by onError are ignored.
 *
 * Failure behaviour: a failing phase is reported, the remaining phases still
 *   run, and exit(1) is used instead of exit(0). Hung phases are bounded by
 *   the deadline, which calls forceClose then exit(1) without waiting.
 *   Once exit has been called, late resolutions or rejections from drain,
 *   cleanup or forceClose are ignored: no further phase, onError or exit runs.
 *
 * Returns a frozen object:
 * - begin(signal): starts shutdown and returns a Promise resolving to the exit
 *   code once exit has been called. It never rejects. Repeated calls, with
 *   the same or a different signal, return the same Promise and do not restart
 *   phases or extend the deadline.
 * - isShuttingDown: read-only boolean, true from the first begin() onward.
 */
export function createShutdownManager(options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_SHUTDOWN_TIMEOUT_MS : options.timeoutMs;
  if (!validTimeout(timeoutMs)) {
    throw new RangeError(`timeoutMs must be an integer between 1 and ${MAX_SHUTDOWN_TIMEOUT_MS}`);
  }
  if (typeof options.exit !== 'function') throw new TypeError('exit must be a function');
  const {exit} = options;
  const onStart = optionalCallback(options, 'onStart');
  const drain = optionalCallback(options, 'drain');
  const cleanup = optionalCallback(options, 'cleanup');
  const forceClose = optionalCallback(options, 'forceClose');
  const onError = optionalCallback(options, 'onError');

  let shuttingDown = false;
  let finished = false;
  let failed = false;
  let timer;
  let completion;
  let resolveCompletion;
  let shutdownSignal;

  function report(error, phase) {
    if (finished) return;
    failed = true;
    try {
      onError(error, {phase, signal: shutdownSignal});
    } catch {
      // A broken error reporter must not prevent the process from exiting.
    }
  }

  function finish(code) {
    if (finished) return;
    clearTimeout(timer);
    try {
      exit(code);
    } catch (error) {
      report(error, 'exit');
    }
    finished = true;
    resolveCompletion(code);
  }

  async function runPhase(phase, callback) {
    try {
      await callback(shutdownSignal);
    } catch (error) {
      report(error, phase);
    }
  }

  function onTimeout() {
    if (finished) return;
    report(new Error(`Shutdown did not finish within ${timeoutMs}ms`), 'timeout');
    try {
      const result = forceClose(shutdownSignal);
      // Not awaited: a hung forceClose must not delay exit(1).
      Promise.resolve(result).catch(error => report(error, 'forceClose'));
    } catch (error) {
      report(error, 'forceClose');
    }
    finish(1);
  }

  async function run() {
    await runPhase('drain', drain);
    if (finished) return;
    await runPhase('cleanup', cleanup);
    finish(failed ? 1 : 0);
  }

  function begin(signal) {
    if (shuttingDown) return completion;
    shuttingDown = true;
    shutdownSignal = signal;
    completion = new Promise(resolve => { resolveCompletion = resolve; });
    timer = setTimeout(onTimeout, timeoutMs);
    try {
      onStart(signal);
    } catch (error) {
      report(error, 'onStart');
    }
    run();
    return completion;
  }

  return Object.freeze({
    begin,
    get isShuttingDown() { return shuttingDown; },
  });
}
