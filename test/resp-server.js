// A minimal Redis (RESP2) server on node:net for tests with the real redis
// client. It keeps strings and streams in memory and implements only what
// sample-node sends: the client handshake (HELLO 3, which redis 6.x sends by
// default, and CLIENT SETINFO), GET, SET, MGET, XADD, XRANGE, EXPIRE and
// MULTI/EXEC. Replies use RESP2 types, which RESP3 clients also decode.
//
// stall(match) stops answering: every command for which match(name) is true,
// and every command after it on the same connection, is held without a reply,
// as a Redis that accepts the request but never responds. Each held command is
// announced through the 'stalled' event. resume() answers again from the next
// command on; held commands stay unanswered, as their connection is expected
// to be destroyed by the client.
//
// refuse() closes the listener and every connection, so new connections get
// ECONNREFUSED; accept() listens on the same port again.
import {EventEmitter, once} from 'node:events';
import net from 'node:net';

function encode(value) {
  if (value === null || value === undefined) return '$-1\r\n';
  if (value instanceof Error) return `-${value.message}\r\n`;
  if (Array.isArray(value)) return `*${value.length}\r\n${value.map(encode).join('')}`;
  if (typeof value === 'object' && value.simple) return `+${value.simple}\r\n`;
  if (typeof value === 'object' && value.map) {
    const entries = Object.entries(value.map);
    return `%${entries.length}\r\n${entries.map(([key, item]) => encode(key) + encode(item)).join('')}`;
  }
  if (typeof value === 'number') return `:${value}\r\n`;
  const text = String(value);
  return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
}

const OK = {simple: 'OK'};

// Parses complete RESP arrays of bulk strings from buffer; returns the
// commands and the unparsed rest.
function parse(buffer) {
  const commands = [];
  let offset = 0;
  for (;;) {
    if (buffer[offset] !== 0x2a) break; // '*'
    let end = buffer.indexOf('\r\n', offset);
    if (end < 0) break;
    const count = Number(buffer.subarray(offset + 1, end).toString());
    let cursor = end + 2;
    const args = [];
    let complete = true;
    for (let i = 0; i < count; i++) {
      end = buffer.indexOf('\r\n', cursor);
      if (end < 0) { complete = false; break; }
      const length = Number(buffer.subarray(cursor + 1, end).toString());
      const start = end + 2;
      if (buffer.length < start + length + 2) { complete = false; break; }
      args.push(buffer.subarray(start, start + length).toString());
      cursor = start + length + 2;
    }
    if (!complete) break;
    commands.push(args);
    offset = cursor;
  }
  return {commands, rest: buffer.subarray(offset)};
}

function compareIds(a, b) {
  const [am, as] = a.split('-').map(BigInt);
  const [bm, bs] = b.split('-').map(BigInt);
  return am === bm ? (as === bs ? 0 : as < bs ? -1 : 1) : am < bm ? -1 : 1;
}

export async function startRespServer() {
  const events = new EventEmitter();
  const strings = new Map();
  const streams = new Map();
  const sockets = new Set();
  const received = [];
  let stallMatch = null;
  let lastId = '0-0';
  let accepted = 0;

  function execute([name, ...args]) {
    switch (name.toUpperCase()) {
      case 'HELLO': return {map: {server: 'redis', version: '7.4.0', proto: 3, mode: 'standalone', role: 'master', modules: []}};
      case 'CLIENT': return OK;
      case 'PING': return {simple: 'PONG'};
      case 'GET': return strings.get(args[0]) ?? null;
      case 'SET': strings.set(args[0], args[1]); return OK;
      case 'MGET': return args.map(key => strings.get(key) ?? null);
      case 'EXPIRE': return 1;
      case 'XADD': {
        const key = args[0];
        const star = args.indexOf('*');
        const fields = args.slice(star + 1);
        const ms = Date.now();
        const [lastMs, lastSeq] = lastId.split('-').map(Number);
        const id = ms > lastMs ? `${ms}-0` : `${lastMs}-${lastSeq + 1}`;
        lastId = id;
        if (!streams.has(key)) streams.set(key, []);
        streams.get(key).push([id, fields]);
        return id;
      }
      case 'XRANGE': {
        const [key, start, end, countWord, count] = args;
        const exclusive = start.startsWith('(');
        const from = exclusive ? start.slice(1) : start;
        let entries = (streams.get(key) ?? []).filter(([id]) => {
          const order = compareIds(id, from);
          return (exclusive ? order > 0 : order >= 0) && (end === '+' || compareIds(id, end) <= 0);
        });
        if (countWord?.toUpperCase() === 'COUNT') entries = entries.slice(0, Number(count));
        return entries;
      }
      default: return new Error(`ERR unknown command '${name}'`);
    }
  }

  const server = net.createServer(socket => {
    sockets.add(socket);
    accepted++;
    let buffer = Buffer.alloc(0);
    let held = false;
    let transaction = null;
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const {commands, rest} = parse(buffer);
      buffer = rest;
      for (const command of commands) {
        const name = command[0].toUpperCase();
        received.push(name);
        if (held || stallMatch?.(name)) {
          held = true;
          events.emit('stalled', name);
          continue;
        }
        let reply;
        if (name === 'MULTI') {
          transaction = [];
          reply = OK;
        } else if (name === 'EXEC') {
          reply = (transaction ?? []).map(execute);
          transaction = null;
        } else if (transaction) {
          transaction.push(command);
          reply = {simple: 'QUEUED'};
        } else {
          reply = execute(command);
        }
        socket.write(encode(reply));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();

  return {
    port,
    events,
    strings,
    streams,
    received,
    // Number of client connections currently open.
    get connections() { return sockets.size; },
    // Number of client connections accepted so far.
    get accepted() { return accepted; },
    stall(match = () => true) { stallMatch = match; },
    resume() { stallMatch = null; },
    // Resolves with the command name once a command is held.
    nextStall() { return once(events, 'stalled').then(([name]) => name); },
    async refuse() {
      const closed = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
    async accept() {
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}
