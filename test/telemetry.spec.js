import {createTelemetry} from '../lib/telemetry.js';
import {createMonitor, HISTORY_MS, STALE_MS} from '../public/telemetry.js';

function fixture(files = {}) {
  let time = 0;
  let processCpu = 0;
  const sample = createTelemetry({
    readFile: name => files[name] ?? null,
    now: () => time,
    runtime: {
      constrainedMemory: () => 0,
      memoryUsage: {rss: () => 40 * 1024 * 1024},
      cpuUsage: () => ({user: processCpu, system: 0}),
    },
  });
  return {sample, advance: (ms, cpu) => { time += ms; processCpu += cpu; }};
}

describe('container telemetry', () => {
  test('measures cgroup v2 usage against the container limits', () => {
    const files = {'memory.current': '100663296', 'memory.max': '134217728', 'cpu.max': '10000 100000', 'cpu.stat': 'usage_usec 100000\nuser_usec 80000'};
    const meter = fixture(files);
    expect(meter.sample().memory).toMatchObject({used: 100663296, limit: 134217728, percent: 75, source: 'cgroup'});
    expect(meter.sample().cpu.used).toBeNull();
    meter.advance(1000, 999999);
    files['cpu.stat'] = 'usage_usec 150000\nuser_usec 120000';
    expect(meter.sample().cpu).toEqual({used: 0.05, limit: 0.1, percent: 50, source: 'cgroup'});
    meter.advance(10, 0);
    files['cpu.stat'] = 'usage_usec 151000';
    expect(meter.sample().cpu.used).toBe(0.05);
  });

  test('reads cgroup v1 nanosecond CPU counters', () => {
    const files = {'memory/memory.usage_in_bytes': '67108864', 'memory/memory.limit_in_bytes': '134217728', 'cpu/cpu.cfs_quota_us': '20000', 'cpu/cpu.cfs_period_us': '100000', 'cpuacct/cpuacct.usage': '100000000'};
    const meter = fixture(files);
    expect(meter.sample().memory.percent).toBe(50);
    meter.advance(1000, 0);
    files['cpuacct/cpuacct.usage'] = '200000000';
    expect(meter.sample().cpu).toEqual({used: 0.1, limit: 0.2, percent: 50, source: 'cgroup'});
  });

  test('reports process scope and unknown limits outside containers', () => {
    const meter = fixture();
    expect(meter.sample().memory).toMatchObject({source: 'process', limit: null, percent: null});
    meter.advance(1000, 250000);
    expect(meter.sample().cpu).toEqual({used: 0.25, limit: null, percent: null, source: 'process'});
  });

  test('does not interpret unlimited quotas as a finite limit', () => {
    const meter = fixture({'memory.max': 'max', 'cpu.max': 'max 100000'});
    expect(meter.sample().cpu.limit).toBeNull();
    expect(meter.sample().memory.limit).toBeNull();
  });
});

function pod(overrides = {}) {
  return {host: 'pod-a', instanceId: 'process-1', uptime: 120, memory: {used: 80, limit: 128, percent: 62.5}, cpu: {used: 0.05, limit: 0.1, percent: 50}, ...overrides};
}

describe('live pod observations', () => {
  test('keeps the memory climb and detects recovery even when the restart is faster than the stale threshold', () => {
    const monitor = createMonitor();
    monitor.ingest(pod(), 1000);
    monitor.markOom({host: 'pod-a', instanceId: 'process-1'}, 1100);
    monitor.ingest(pod({memory: {used: 120, limit: 128, percent: 93.75}, oom: {active: true}}), 2000);
    expect(monitor.incident.phase).toBe('allocating');
    monitor.ingest(pod({instanceId: 'process-2', uptime: 1}), 4000);
    const observed = monitor.pods.get('pod-a');
    expect(observed.restarts).toBe(1);
    expect(observed.points).toHaveLength(3);
    expect(observed.points[2].breakBefore).toBe(true);
    expect(monitor.incident).toMatchObject({phase: 'restarted', peakBytes: 120, recoveredAt: 4000});
    expect(monitor.events.some(event => event.message.includes('90%'))).toBe(true);
    monitor.ingest(pod({instanceId: 'process-2', uptime: 2, memory: {used: 125, limit: 128, percent: 97}}), 5000);
    expect(monitor.incident.peakBytes).toBe(120);
  });

  test('preserves stale pods without claiming they were killed', () => {
    const monitor = createMonitor();
    monitor.ingest(pod(), 1000);
    monitor.markOom({host: 'pod-a', instanceId: 'process-1'}, 1000);
    monitor.tick(1001 + STALE_MS);
    expect(monitor.pods.get('pod-a').stale).toBe(true);
    expect(monitor.incident.phase).toBe('unobserved');
    expect(monitor.events[0].message).toContain('availability unknown');
    monitor.ingest(pod({uptime: 135, oom: {active: true}}), 16000);
    expect(monitor.pods.get('pod-a').restarts).toBe(0);
    expect(monitor.pods.get('pod-a').points[1].breakBefore).toBe(true);
    expect(monitor.incident.phase).toBe('allocating');
  });

  test('does not mistake another load-balanced pod for target recovery', () => {
    const monitor = createMonitor();
    monitor.markOom({host: 'pod-a', instanceId: 'process-1'}, 1000);
    monitor.ingest(pod({host: 'pod-b', instanceId: 'process-2'}), 2000);
    expect(monitor.incident.phase).toBe('requested');
    monitor.ingest(pod({instanceId: 'process-2', uptime: 1}), 3000);
    expect(monitor.incident.phase).toBe('restarted');
    expect(monitor.pods.get('pod-a').restarts).toBe(1);
  });

  test('bounds history and discovered pods in long sessions', () => {
    const monitor = createMonitor();
    monitor.ingest(pod(), 0);
    monitor.ingest(pod(), HISTORY_MS + 1);
    expect(monitor.pods.get('pod-a').points).toHaveLength(1);
    for (let i = 0; i < 30; i++) monitor.ingest(pod({host: `pod-${i}`}), HISTORY_MS + i + 2);
    expect(monitor.pods.size).toBe(24);
    expect(monitor.events.length).toBeLessThanOrEqual(50);
  });
});
