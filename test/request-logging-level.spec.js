import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import request from 'supertest';
import {captureLogs, settle} from './log-capture.js';

// LOG_LEVEL applies to request logs too: at warn, completion records (info) are
// filtered out while warn/error records still carry the request id.
process.env.REDIS_ENABLED = 'false';
process.env.LOG_LEVEL = 'warn';
const {default: app} = await import('../server.js');
delete process.env.LOG_LEVEL;

let capture;
beforeEach(() => { capture = captureLogs(); });
afterEach(() => capture.restore());

test('LOG_LEVEL=warn suppresses completion records but keeps errors with their id', async () => {
  const ok = await request(app).get('/live');
  const work = await request(app).get('/work/1');
  const bad = await request(app).put('/cache/x').set('Content-Type', 'application/json')
    .set('X-Request-Id', 'warn-level-1').send('{bad');
  await settle();

  expect([ok.status, work.status, bad.status]).toEqual([200, 200, 400]);
  const records = capture.records();
  expect(records.filter(record => record.event === 'http.request.completed')).toEqual([]);
  expect(records.map(record => [record.event, record.request_id, record.level]))
    .toEqual([['http.request.error', 'warn-level-1', 'warn']]);
});

test('an invalid LOG_LEVEL warns once at startup and runs at info', async () => {
  const script = [
    "const {default: app} = await import('./server.js');",
    "const server = app.listen(0, '127.0.0.1');",
    "await new Promise(resolve => server.once('listening', resolve));",
    "await fetch(`http://127.0.0.1:${server.address().port}/ready`);",
    'server.close();',
    'process.exit(0);',
  ].join('\n');
  const {stdout, stderr} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: {...process.env, REDIS_ENABLED: 'false', LOG_LEVEL: 'loud-unknown-level', NODE_OPTIONS: ''},
  });

  const parse = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const errors = parse(stderr);
  const out = parse(stdout);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({level: 'warn', event: 'logger.invalid_level'});
  expect(stderr + stdout).not.toContain('loud-unknown-level');
  expect(out.map(record => [record.level, record.event])).toEqual([['info', 'http.request.completed']]);
});
