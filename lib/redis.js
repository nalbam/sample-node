// Bounded access to the shared Redis client.
//
// Every Redis operation (connecting when needed, then all of its commands) has
// one time budget, REDIS_TIMEOUT_MS. redis 6.x has no way to cancel a command
// that is already written to the socket: commandOptions.timeout and abortSignal
// only cover commands still waiting to be written. So when a budget runs out
// this module destroys the connection. destroy() rejects every pending command
// of that connection at once, which is also correct for the other requests:
// Redis answers one connection in order, so they would wait behind the stalled
// reply anyway. The next operation, a request or the telemetry publisher's next
// tick, opens a new connection. Nothing is retried or replayed.
import {runWithoutContext} from './logger.js';

export const DEFAULT_REDIS_TIMEOUT_MS = 2000;
export const MAX_REDIS_TIMEOUT_MS = 60000;

/**
 * Parses REDIS_TIMEOUT_MS.
 *
 * Accepts a string of digits only (surrounding whitespace allowed) for an
 * integer from 1 to 60000. Anything else, including undefined, empty, "0",
 * negative, fractional, exponent or unit suffixed values such as "2s", or out
 * of range, returns DEFAULT_REDIS_TIMEOUT_MS. It never throws.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function parseRedisTimeout(value) {
  if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) return DEFAULT_REDIS_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_REDIS_TIMEOUT_MS ? parsed : DEFAULT_REDIS_TIMEOUT_MS;
}

/**
 * Redis could not serve the operation: it is unreachable, the connection was
 * lost, or it did not answer within the budget. Callers answer 503. Any other
 * error (for example an error reply while the connection stays ready) is passed
 * through unchanged.
 */
export class RedisUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RedisUnavailableError';
  }
}

/**
 * Wraps a redis 6.x client created with reconnectStrategy: false and
 * disableOfflineQueue: true, so this module opens every connection itself.
 *
 * Options:
 * - client: the shared redis client.
 * - timeoutMs: budget of one operation in ms, see parseRedisTimeout().
 * - logger: context-aware logger; records written for a request carry its
 *   request_id.
 *
 * Returns:
 * - run(operation): waits for a ready connection, then returns
 *   await operation(client), all within one budget. Throws
 *   RedisUnavailableError when Redis is unavailable, and logs that once as
 *   redis.connect_failed, redis.timeout or redis.connection_lost.
 * - available(): resolves to whether a connection is ready, connecting when
 *   needed within the budget. Never rejects for an unavailable Redis.
 * - close(): for graceful shutdown. Stops new connections, waits for a pending
 *   connect, then closes the connection after its pending replies.
 * - destroy(): for forced shutdown. Stops new connections and destroys the
 *   connection immediately.
 */
export function createRedisAccess({client, timeoutMs, logger}) {
  let closed = false;
  // The connect attempt in flight, shared by every caller that needs a
  // connection meanwhile, so only one connection is ever opened at a time.
  let connecting = null;
  // Identifies the connection an operation uses. A timer or late completion
  // from an older connection never destroys a newer one.
  let generation = 0;

  function startConnect() {
    const attempt = {generation: ++generation, abandoned: false};
    attempt.promise = runWithoutContext(() => client.connect())
      .then(() => {
        // Shutdown began, or a caller gave up on this attempt and destroyed it,
        // while it was connecting: tear down whatever it opened.
        if (!closed && !attempt.abandoned) return null;
        client.destroy();
        return new Error(closed ? 'redis closed during shutdown' : 'redis connect abandoned after timeout');
      }, error => error)
      .finally(() => {
        if (connecting === attempt) connecting = null;
      });
    connecting = attempt;
    return attempt;
  }

  // Resolves once a connection is ready. op.generation is set synchronously,
  // so a timeout that fires while connecting knows which attempt to abandon.
  async function connect(op) {
    if (closed) throw new RedisUnavailableError('redis is closed');
    if (client.isReady) {
      op.generation = generation;
      return;
    }
    // An open socket that is not ready belongs to a close in progress.
    if (!connecting && client.isOpen) throw new RedisUnavailableError('redis connection is not ready');
    const attempt = connecting ?? startConnect();
    op.generation = attempt.generation;
    const error = await attempt.promise;
    if (!error) return;
    if (!op.done) logger.error('failed to connect redis', {event: 'redis.connect_failed', error});
    throw new RedisUnavailableError('redis unavailable', {cause: error});
  }

  // Destroys the connection an expired operation was using, unless it has
  // already been replaced. Pending commands of that connection reject at once.
  function abandon(op) {
    if (connecting && connecting.generation === op.generation) {
      connecting.abandoned = true;
      client.destroy();
    } else if (!connecting && op.generation === generation && (client.isOpen || client.isReady)) {
      client.destroy();
    }
  }

  async function run(operation) {
    const op = {done: false, generation: undefined, stage: 'connect'};
    let timer;
    const expired = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        op.done = true;
        logger.error('redis operation timed out', {event: 'redis.timeout', stage: op.stage, timeout_ms: timeoutMs});
        abandon(op);
        reject(new RedisUnavailableError(`redis did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      await Promise.race([connect(op), expired]);
      op.stage = 'command';
      return await Promise.race([operation(client), expired]);
    } catch (error) {
      if (error instanceof RedisUnavailableError) throw error;
      // The command failed because its connection went away (destroyed by
      // another operation's timeout, closed by the server, or not ready),
      // rather than because Redis answered with an error.
      if (op.generation !== generation || !client.isReady) {
        if (!op.done) logger.error('redis connection lost', {event: 'redis.connection_lost', error});
        throw new RedisUnavailableError('redis connection lost', {cause: error});
      }
      throw error;
    } finally {
      op.done = true;
      clearTimeout(timer);
    }
  }

  async function available() {
    try {
      await run(() => undefined);
      return true;
    } catch (error) {
      if (error instanceof RedisUnavailableError) return false;
      throw error;
    }
  }

  async function close() {
    closed = true;
    await connecting?.promise;
    // close() waits for pending replies and rejects when the socket is not open.
    if (client.isOpen) await client.close();
  }

  function destroy() {
    closed = true;
    client.destroy();
  }

  return {run, available, close, destroy};
}
