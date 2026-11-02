// Captures what the logger writes to the real process.stdout/stderr. Only
// logger records (lines starting with {"time") are held back; anything else is
// passed through so Jest's own output is untouched.
export function captureLogs() {
  const writes = [];
  const restores = [];
  for (const name of ['stdout', 'stderr']) {
    const stream = process[name];
    const original = stream.write;
    stream.write = function (chunk, ...rest) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (text.startsWith('{"time"')) {
        writes.push({stream: name, text});
        return true;
      }
      return original.call(this, chunk, ...rest);
    };
    restores.push(() => { stream.write = original; });
  }

  return {
    // Raw text exactly as written, for secret and line-shape checks.
    text: () => writes.map(write => write.text).join(''),
    writes: () => [...writes],
    records: () => writes.flatMap(write => write.text.split('\n').filter(Boolean).map(line => ({
      ...JSON.parse(line),
      _stream: write.stream,
    }))),
    clear: () => { writes.length = 0; },
    restore: () => restores.forEach(restore => restore()),
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 'close' follows 'finish' asynchronously; wait long enough for a duplicate to show.
export const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
