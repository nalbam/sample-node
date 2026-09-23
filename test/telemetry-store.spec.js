import {jest} from '@jest/globals';
import {createTelemetryStore, startTelemetryPublisher, TELEMETRY_HISTORY_MS} from '../lib/telemetry-store.js';

describe('telemetry stream reads', () => {
  test('resumes exclusively after the last stream ID across application replicas', async () => {
    const sample = {host: 'pod-b', instanceId: 'process-b', sampledAt: new Date(600000).toISOString()};
    const client = {
      xRange: jest.fn().mockResolvedValue([{id: '600002-1', message: {key: 'sample-b'}}]),
      mGet: jest.fn().mockResolvedValue([JSON.stringify(sample)]),
    };
    const store = createTelemetryStore(client, 'test-stream', () => 600005);
    const result = await store.read('600001-9');
    expect(client.xRange).toHaveBeenCalledWith('test-stream', '(600001-9', '+', {COUNT: 500});
    expect(result).toEqual({source: 'redis', cursor: '600002-1', more: false, samples: [{at: 600000, sample}]});
  });

  test('skips samples expiring during a read while still advancing the cursor', async () => {
    const client = {
      xRange: jest.fn().mockResolvedValue([{id: '600002-1', message: {key: 'expired'}}]),
      mGet: jest.fn().mockResolvedValue([null]),
    };
    const result = await createTelemetryStore(client, 'test-stream', () => 600005).read('600001-0');
    expect(result.samples).toEqual([]);
    expect(result.cursor).toBe('600002-1');
  });

  test('limits initial or expired cursor reads to the retained history window', async () => {
    const client = {xRange: jest.fn().mockResolvedValue([])};
    const store = createTelemetryStore(client, 'test-stream', () => 900000);
    const result = await store.read();
    expect(result.cursor).toBe(`${900000 - TELEMETRY_HISTORY_MS}-0`);
    await store.read('1-0');
    expect(client.xRange).toHaveBeenLastCalledWith('test-stream', '600000-0', '+', {COUNT: 500});
  });

  test('surfaces storage failures instead of returning an empty successful history', async () => {
    const store = createTelemetryStore({xRange: jest.fn().mockRejectedValue(new Error('unavailable'))}, 'test-stream');
    await expect(store.read()).rejects.toThrow('unavailable');
  });
});

describe('telemetry publisher', () => {
  afterEach(() => jest.useRealTimers());

  test('publishes every second and stops cleanly', async () => {
    jest.useFakeTimers();
    const publish = jest.fn().mockResolvedValue();
    const stop = startTelemetryPublisher(publish, jest.fn());
    await jest.advanceTimersByTimeAsync(3000);
    expect(publish).toHaveBeenCalledTimes(4);
    stop();
    await jest.advanceTimersByTimeAsync(3000);
    expect(publish).toHaveBeenCalledTimes(4);
  });

  test('does not overlap slow writes and reports errors', async () => {
    jest.useFakeTimers();
    let reject;
    const publish = jest.fn(() => new Promise((_, fail) => { reject = fail; }));
    const onError = jest.fn();
    const stop = startTelemetryPublisher(publish, onError);
    await jest.advanceTimersByTimeAsync(5000);
    expect(publish).toHaveBeenCalledTimes(1);
    stop();
    const error = new Error('Redis disconnected');
    reject(error);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(error);
    await jest.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
