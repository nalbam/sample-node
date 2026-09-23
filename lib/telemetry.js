import fs from 'node:fs';

function read(path) {
  try {
    return fs.readFileSync(`/sys/fs/cgroup/${path}`, 'utf8').trim();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 2 ** 60 ? number : null;
}

// cgroup counters cover the app container, including off-heap OOM allocations.
// Outside a container, report the process scope explicitly instead of inventing limits.
export function createTelemetry({readFile = read, runtime = process, now = () => performance.now()} = {}) {
  let previous = null;
  let cpuUsed = null;

  return function sample() {
    const memoryRaw = readFile('memory.current') ?? readFile('memory/memory.usage_in_bytes');
    const memoryLimit = positive(readFile('memory.max') ?? readFile('memory/memory.limit_in_bytes'))
      ?? positive(runtime.constrainedMemory());
    const rss = runtime.memoryUsage.rss();
    const memoryUsed = memoryRaw === null ? rss : Number(memoryRaw);
    const memorySource = memoryRaw === null ? 'process' : 'cgroup';

    const max = readFile('cpu.max');
    const [quota, period] = max === null
      ? [readFile('cpu/cpu.cfs_quota_us'), readFile('cpu/cpu.cfs_period_us')]
      : max.split(/\s+/);
    const cpuLimit = positive(quota) && positive(period) ? Number(quota) / Number(period) : null;
    const usage = readFile('cpu.stat')?.match(/^usage_usec\s+(\d+)$/m)?.[1];
    const v1 = usage === undefined ? readFile('cpuacct/cpuacct.usage') : null;
    const processCpu = runtime.cpuUsage();
    const source = usage !== undefined || v1 !== null ? 'cgroup' : 'process';
    const total = usage !== undefined ? Number(usage)
      : v1 !== null ? Number(v1) / 1000 : processCpu.user + processCpu.system;
    const at = now();
    if (!previous || previous.source !== source || total < previous.total) {
      previous = {total, at, source};
      cpuUsed = null;
    } else if (at - previous.at >= 500) {
      cpuUsed = (total - previous.total) / ((at - previous.at) * 1000);
      previous = {total, at, source};
    }

    return {
      memory: {
        used: memoryUsed, rss, limit: memoryLimit, source: memorySource,
        percent: memoryLimit ? Math.round(memoryUsed / memoryLimit * 1000) / 10 : null,
      },
      cpu: {
        used: cpuUsed, limit: cpuLimit, source,
        percent: cpuLimit && cpuUsed !== null ? Math.round(cpuUsed / cpuLimit * 1000) / 10 : null,
      },
    };
  };
}
