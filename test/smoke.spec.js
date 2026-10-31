import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {jest} from '@jest/globals';

const createClient = jest.fn();
jest.unstable_mockModule('redis', () => ({default: {createClient}}));
process.env.REDIS_ENABLED = 'false';
process.env.VERSION = 'v1.2.3-smoke';
const {default: app} = await import('../server.js');

const run = promisify(execFile);
const smoke = (url, version) => run(process.execPath, ['scripts/smoke.mjs', url, version], {
  env: {...process.env, SMOKE_START_TIMEOUT_MS: '2000'},
});

let server;
let baseUrl;
beforeAll(done => {
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll(done => {
  server.close(done);
});

test('smoke passes against a Redis-free app with the expected VERSION', async () => {
  const {stdout} = await smoke(baseUrl, 'v1.2.3-smoke');
  expect(stdout).toContain('smoke passed');
  expect(createClient).not.toHaveBeenCalled();
});

test('smoke exits non-zero when the version differs', async () => {
  await expect(smoke(baseUrl, 'v9.9.9')).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('FAIL GET /version: version is v9.9.9'),
  });
});

test('smoke exits non-zero when the app never starts', async () => {
  const closed = app.listen(0, '127.0.0.1');
  await new Promise(resolve => closed.once('listening', resolve));
  const url = `http://127.0.0.1:${closed.address().port}`;
  await new Promise(resolve => closed.close(resolve));
  await expect(smoke(url, 'v1.2.3-smoke')).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('/live did not answer'),
  });
}, 10000);
