import {randomUUID} from 'node:crypto';

export const TELEMETRY_HISTORY_MS = 5 * 60 * 1000;
const BATCH_SIZE = 500;

export function validCursor(value) {
  return typeof value === 'string' && /^\d{1,20}-\d{1,20}$/.test(value)
    && value.split('-').every(part => BigInt(part) <= 18446744073709551615n);
}

// Redis assigns ordered IDs, so readers can resume on any replica without
// missing a sample published concurrently by another pod.
export function createTelemetryStore(client, key, now = Date.now) {
  return {
    async publish(sample) {
      const capturedAt = Date.parse(sample.sampledAt);
      if (!Number.isFinite(capturedAt)) throw new Error('Invalid telemetry sample time');
      const sampleKey = `${key}:sample:${randomUUID()}`;
      await client.multi()
        .set(sampleKey, JSON.stringify(sample), {PXAT: capturedAt + TELEMETRY_HISTORY_MS})
        .xAdd(key, '*', {key: sampleKey}, {
          TRIM: {strategy: 'MINID', threshold: `${Math.max(0, now() - TELEMETRY_HISTORY_MS)}-0`},
        })
        .expire(key, TELEMETRY_HISTORY_MS / 1000)
        .exec();
    },
    async read(after) {
      const oldest = Math.max(0, now() - TELEMETRY_HISTORY_MS);
      const start = after && BigInt(after.split('-')[0]) >= BigInt(oldest) ? `(${after}` : `${oldest}-0`;
      const entries = await client.xRange(key, start, '+', {COUNT: BATCH_SIZE});
      const payloads = entries.length ? await client.mGet(entries.map(entry => entry.message.key)) : [];
      return {
        source: 'redis',
        cursor: entries.at(-1)?.id ?? after ?? `${oldest}-0`,
        more: entries.length === BATCH_SIZE,
        // A payload may expire between XRANGE and MGET. Advance the cursor
        // past its index entry without returning an expired sample.
        samples: payloads.flatMap(payload => {
          if (payload === null) return [];
          const sample = JSON.parse(payload);
          return [{at: Date.parse(sample.sampledAt), sample}];
        }),
      };
    },
  };
}

export function startTelemetryPublisher(publish, onError, intervalMs = 1000) {
  let stopped = false;
  let timer;
  async function tick() {
    const started = performance.now();
    try {
      await publish();
    } catch (error) {
      onError(error);
    } finally {
      // One writer per process, never overlapping during a slow Redis call.
      if (!stopped) timer = setTimeout(tick, Math.max(0, intervalMs - (performance.now() - started))).unref();
    }
  }
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}
