import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('isolated HTTP observation flow blocks execution, spoofed intake, CSRF and stale cancellation', async t => {
  const scratch = resolve('.codex_tmp'); await mkdir(scratch, { recursive: true });
  const runtime = await mkdtemp(join(scratch, 'dingtalk-http-'));
  const listener = createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port; await new Promise(done => listener.close(done));
  const address = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/server.mjs'], { cwd: resolve('.'), windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DOUFENG_DATA_DIR: runtime, BSK_AUTO_START: '0', BSK_BIN: join(runtime, 'no-browser') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', data => { logs = (logs + data).slice(-4000); }); child.stderr.on('data', data => { logs = (logs + data).slice(-4000); });
  const exited = new Promise(done => { child.once('exit', done); child.once('error', done); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); })]);
    await exited; assert.ok(resolve(runtime).startsWith(scratch + sep)); await rm(runtime, { recursive: true, force: true });
  });
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(address + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, data: await response.json() };
  }
  let ready, connectionError;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { ready = await request('/api/superagent'); if (ready.status === 200) break; } catch (error) { connectionError = `${error.message}: ${error.cause?.code || ''}`; }
    await delay(100);
  }
  assert.equal(ready?.status, 200, `${logs}\n${connectionError || ''}`);
  assert.equal((await request('/api/system')).data.dataDir, runtime);
  const asset = await fetch(address + '/superagent-panel.js'); assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(address + '/integrations/dingtalk-superagent/config.example.json')).status, 404);
  assert.equal((await request('/api/superagent/demo', { method: 'POST' })).status, 415);
  assert.equal((await request('/api/superagent/demo', { method: 'POST', body: {}, headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await request('/api/superagent/demo', { method: 'POST', body: { execute: true } })).status, 400);
  for (const route of ['/run', '/approve', '/settings', '/messages', '/push']) assert.equal((await request('/api/superagent' + route, { method: 'POST', body: {} })).status, 404);
  const first = await request('/api/superagent/demo', { method: 'POST', body: {} });
  const again = await request('/api/superagent/demo', { method: 'POST', body: {} });
  assert.equal(first.status, 200); assert.equal(again.data.duplicate, true); assert.equal(again.data.tickets.length, 1);
  const id = first.data.tickets[0].id, path = `/api/superagent/demo/${id}/cancel`;
  assert.equal((await request(path, { method: 'POST', body: {} })).status, 428);
  const cancel = await request(path, { method: 'POST', body: {}, headers: { 'If-Match': first.data.demoRevision } });
  assert.equal(cancel.status, 200); assert.equal(cancel.data.tickets[0].status, 'cancelled');
  assert.equal((await request(path, { method: 'POST', body: {}, headers: { 'If-Match': first.data.demoRevision } })).status, 409);
  assert.equal((await request('/api/superagent')).data.revision, 'missing');
  await t.test('workflow HTTP supports local requests, followups, guarded settings and completion', async () => {
    const path = '/api/superagent/workflow';
    let state = (await request(path)).data;
    assert.equal(state.settings.mode, 'observe'); assert.equal(state.worker.ready, false);
    assert.equal((await request(path + '/requests', { method: 'POST', body: { text: '修改文案', idempotencyKey: 'http-req-1', execute: true } })).status, 400);
    let created = await request(path + '/requests', { method: 'POST', body: { text: '修改文案', idempotencyKey: 'http-req-1' } });
    assert.equal(created.status, 200); const ticket = created.data.tickets[0];
    const repeated = await request(path + '/requests', { method: 'POST', body: { text: '修改文案', idempotencyKey: 'http-req-1' } }); assert.equal(repeated.data.tickets.length, 1);
    const followup = await request(path + '/requests', { method: 'POST', body: { text: '补充目标文案', ticketId: ticket.id, idempotencyKey: 'http-follow-1' } }); assert.equal(followup.data.tickets[0].inputs.length, 2);
    assert.equal((await request(`${path}/tickets/${ticket.id}/queue`, { method: 'POST', body: {}, headers: { 'If-Match': followup.data.revision } })).status, 503);
    assert.equal((await request(`${path}/tickets/${ticket.id}/evaluate`, { method: 'POST', body: {}, headers: { 'If-Match': followup.data.revision } })).status, 409);
    assert.equal((await request(path + '/settings', { method: 'PUT', body: state.settings })).status, 428);
    assert.equal((await request(path + '/settings', { method: 'PUT', body: { ...state.settings, token: 'not-allowed' }, headers: { 'If-Match': state.settingsRevision } })).status, 400);
    const previous = state.settingsRevision;
    state = (await request(path + '/pause', { method: 'POST', body: { paused: true }, headers: { 'If-Match': previous } })).data;
    assert.equal(state.settings.paused, true); assert.equal(state.settingsHistory.length, 1);
    assert.equal((await request(path + '/pause', { method: 'POST', body: { paused: false }, headers: { 'If-Match': previous } })).status, 409);
    state = (await request(path + '/settings/restore', { method: 'POST', body: { version: previous }, headers: { 'If-Match': state.settingsRevision } })).data;
    assert.equal(state.settings.paused, false); assert.equal(state.settingsHistory.length, 2);
    const complete = await request(`${path}/tickets/${ticket.id}/complete`, { method: 'POST', body: {}, headers: { 'If-Match': state.revision } }); assert.equal(complete.data.tickets[0].status, 'completed');
    assert.equal((await request(path, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  });
});
