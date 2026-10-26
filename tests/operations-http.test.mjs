import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';
import { defaultAutomation } from '../shared/automation-model.mjs';
import { DailyProduction } from '../server/daily-production.mjs';

const project = resolve(fileURLToPath(new URL('../', import.meta.url)));
const scratch = join(project, '.codex_tmp');
async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const runtime = await mkdtemp(join(scratch, 'operations-http-')), port = await freePort(), address = `http://127.0.0.1:${port}`;
  const uploadDirectory = join(runtime, 'uploads'), generatedDirectory = join(runtime, 'media-automation/jobs/fixture'), dailyDirectory = join(runtime, 'daily-production/videos/fixture');
  await Promise.all([uploadDirectory, generatedDirectory, dailyDirectory, join(runtime, 'automation')].map(path => mkdir(path, { recursive: true })));
  const bytes = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  const upload = join(uploadDirectory, 'original.mp4'), generated = join(generatedDirectory, 'video.mp4'), daily = join(dailyDirectory, 'video.mp4');
  await Promise.all([upload, generated, daily].map(path => writeFile(path, bytes)));
  const workspace = normalizeState({ drafts: [{ id: 'bili-draft', platform: 'bilibili', format: '视频', pubTitle: 'B站草稿', asset: upload }, { id: 'image-draft', platform: 'douyin', format: '图文', pubTitle: '图文草稿', asset: upload }] });
  await writeFile(join(runtime, 'workbench.json'), JSON.stringify(workspace));
  const queue = defaultAutomation(); queue.config.folder = uploadDirectory;
  await writeFile(join(runtime, 'automation/queue.json'), JSON.stringify(queue));
  await writeFile(join(runtime, 'media-automation/state.json'), JSON.stringify({ version: 1, jobs: [{ id: 'fixture', status: 'completed', directory: generatedDirectory, asset: generated, media: { sha256: createHash('sha256').update(bytes).digest('hex') } }] }));
  await new DailyProduction(runtime, null, null).store.update(state => state.runs.push({ id: 'old-preview', previewOnly: true, status: 'preview', asset: daily }));
  const child = spawn(process.execPath, ['server/server.mjs'], { cwd: project, shell: false, windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DOUFENG_DATA_DIR: runtime, BSK_AUTO_START: '0', BSK_BIN: join(runtime, 'not-a-real-browser-client') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', data => { logs = (logs + data).slice(-10000); }); child.stderr.on('data', data => { logs = (logs + data).slice(-10000); });
  const exited = new Promise(done => { child.once('exit', done); child.once('error', done); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); })]);
    await exited;
    // The generated test directory is verified under the explicit scratch root.
    const actual = resolve(runtime); assert.ok(actual.startsWith(resolve(scratch) + sep));
    await rm(actual, { recursive: true, force: true });
  });
  async function request(path, { method = 'GET', body, revision, headers = {} } = {}) {
    const response = await fetch(address + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(revision === undefined ? {} : { 'If-Match': revision }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  let ready;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Isolated server exited: ${logs}`);
    try { const response = await request('/api/operations'); if (response.status === 200 && response.body.scheduler.running) { ready = response.body; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `Isolated operations server did not start: ${logs}`);
  assert.equal((await request('/api/system')).body.dataDir, runtime);
  return { request, address, runtime, ready, bytes, upload, generated, daily, child };
}

test('isolated operations HTTP routes preserve publishing and preview boundaries', async t => {
  const f = await fixture(t);
  const schedule = { type: 'once', at: new Date(Date.now() + 86400000).toISOString() };
  const current = async () => (await f.request('/api/operations')).body;
  const definition = (overrides = {}) => ({ name: 'HTTP local diagnosis', kind: 'content.diagnosis', input: {}, schedule, enabled: false, ...overrides });

  await t.test('operations form recovery helper is available as a JavaScript module', async () => {
    const response = await fetch(`${f.address}/operations-form.js`);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /export function restorePendingForm/);
  });

  await t.test('daily Douyin tracking settings use revision guards and never trigger a browser check', async () => {
    const before = (await f.request('/api/douyin-tracking')).body;
    assert.equal(before.config.dailyTime, '06:30');
    assert.equal(before.scheduler.mode, 'daily');
    assert.equal(before.scheduler.busy, false);
    assert.deepEqual(before.automaticRuns, []);
    const input = { enabled: false, dailyTime: '07:15' };
    assert.equal((await f.request('/api/douyin-tracking/settings', { method: 'POST', body: input })).status, 428);
    assert.equal((await f.request('/api/douyin-tracking/settings', { method: 'POST', revision: before.revision, body: { ...input, publish: true } })).status, 400);
    assert.equal((await f.request('/api/douyin-tracking/settings', { method: 'POST', revision: 'stale-revision', body: input })).status, 409);
    const saved = await f.request('/api/douyin-tracking/settings', { method: 'POST', revision: before.revision, body: input });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.enabled, false);
    assert.equal(saved.body.config.dailyTime, '07:15');
    assert.equal(saved.body.scheduler.nextRunAt, '');
    assert.deepEqual(saved.body.automaticRuns, []);
    const after = (await f.request('/api/douyin-tracking')).body;
    assert.equal(after.revision, saved.body.revision);
    assert.deepEqual(after.records, before.records);
    assert.equal(after.scheduler.busy, false);
  });

  await t.test('AI pet production settings persist while missing generation requirements block enabling', async () => {
    const before = (await f.request('/api/daily-production')).body;
    const input = { productionMode: 'ai-pet', petSettings: { model: '', referenceUrls: [], firstFrames: [], duration: 20, audioMode: 'original-music' } };
    assert.equal((await f.request('/api/daily-production/production-settings', { method: 'POST', body: input })).status, 428);
    assert.equal((await f.request('/api/daily-production/production-settings', { method: 'POST', revision: 'stale-revision', body: input })).status, 409);
    const saved = await f.request('/api/daily-production/production-settings', { method: 'POST', revision: before.revision, body: input });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.productionMode, 'ai-pet');
    assert.equal(saved.body.config.enabled, false);
    assert.deepEqual(saved.body.runs, before.runs);
    assert.equal(saved.body.readiness.canEnable, false);
    const enabled = await f.request('/api/daily-production/toggle', { method: 'POST', revision: saved.body.revision, body: { enabled: true, authorized: true } });
    assert.equal(enabled.status, 409);
    const after = (await f.request('/api/daily-production')).body;
    assert.equal(after.config.enabled, false);
    assert.equal(after.config.productionMode, 'ai-pet');
    assert.deepEqual(after.runs, before.runs);
  });

  await t.test('catalog is executable, same-origin guard and revision/input validation reject invalid requests', async () => {
    const state = await current();
    for (const kind of ['content.diagnosis', 'media.news', 'media.product', 'media.wan', 'media.edit', 'bilibili.track', 'workflow.news', 'distribution.prepare']) assert.ok(state.catalog.some(row => row.kind === kind), kind);
    assert.equal(state.catalog.find(row => row.kind === 'media.wan').recurring, false);
    assert.equal((await f.request('/api/operations', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
    assert.equal((await f.request('/api/operations/tasks', { method: 'POST', body: definition() })).status, 428);
    assert.equal((await f.request('/api/operations/tasks', { method: 'POST', revision: state.revision, body: definition({ kind: 'not.configured' }) })).status, 400);
    assert.equal((await f.request('/api/operations/tasks', { method: 'POST', revision: state.revision, body: definition({ input: { arbitraryCommand: 'do-not-run' } }) })).status, 400);
    for (const kind of ['media.wan', 'bilibili.track']) assert.equal((await f.request('/api/operations/tasks', { method: 'POST', revision: state.revision, body: definition({ kind, input: { arbitraryCommand: 'do-not-run' } }) })).status, 400);
    assert.equal((await f.request('/api/operations/tasks', { method: 'POST', revision: 'stale-revision', body: definition() })).status, 409);
    assert.equal((await current()).tasks.length, 0);
  });

  await t.test('paused local task runs once, produces an honest requires-action receipt on empty metrics', async () => {
    let state = await current();
    const saved = await f.request('/api/operations/tasks', { method: 'POST', revision: state.revision, body: definition({ idempotencyKey: 'http-diagnosis-once' }) });
    assert.equal(saved.status, 201); const task = saved.body.tasks.find(item => item.idempotencyKey === 'http-diagnosis-once');
    assert.equal(task.status, 'paused'); assert.equal(task.enabled, false);
    const recovered = await f.request('/api/operations/tasks', { method: 'POST', revision: saved.body.revision, body: definition({ idempotencyKey: 'http-diagnosis-once' }) });
    assert.equal(recovered.status, 201); assert.equal(recovered.body.tasks.filter(item => item.idempotencyKey === 'http-diagnosis-once').length, 1);
    assert.equal(recovered.body.tasks.find(item => item.idempotencyKey === 'http-diagnosis-once').id, task.id);
    const accepted = await f.request(`/api/operations/tasks/${task.id}/run`, { method: 'POST', revision: saved.body.revision, body: {} });
    assert.equal(accepted.status, 202); assert.equal(accepted.body.run.taskId, task.id);
    for (let i = 0; i < 50; i++) { state = await current(); if (state.runs.find(run => run.taskId === task.id && run.status !== 'running')) break; await delay(100); }
    const runs = state.runs.filter(run => run.taskId === task.id);
    assert.equal(runs.length, 1); assert.equal(runs[0].status, 'requires_action'); assert.equal(runs[0].trigger, 'manual');
    assert.match(runs[0].output.summary, /真实回采指标/); assert.equal(state.tasks.find(item => item.id === task.id).enabled, false);
    assert.equal((await f.request(`/api/operations/tasks/${task.id}/run`, { method: 'POST', revision: state.revision, body: {} })).status, 409);
    assert.equal((await current()).runs.filter(run => run.taskId === task.id).length, 1);
  });

  await t.test('future legacy jobs map into one local task and deletion cancels without running browser actions', async () => {
    const created = await f.request('/api/jobs', { method: 'POST', body: { label: 'Future read only check', url: 'https://www.douyin.com/video/123456', extractor: 'currentVideo', repeat: 'once', nextRunAt: schedule.at } });
    assert.equal(created.status, 201); assert.equal(created.body.job.runner, 'local'); assert.ok(created.body.job.taskId);
    let state = await current(), mapped = state.tasks.filter(task => task.idempotencyKey === `legacy-job:${created.body.job.id}`);
    assert.equal(mapped.length, 1); assert.equal(mapped[0].kind, 'content.capture'); assert.equal(mapped[0].enabled, true); assert.equal(mapped[0].status, 'scheduled');
    assert.equal(state.runs.filter(run => run.taskId === mapped[0].id).length, 0);
    assert.equal((await f.request(`/api/jobs/${created.body.job.id}`, { method: 'DELETE' })).status, 200);
    state = await current(); assert.equal(state.tasks.find(task => task.id === mapped[0].id).enabled, false);
    assert.equal(state.runs.filter(run => run.taskId === mapped[0].id).length, 0);
  });

  await t.test('B站视频 and Douyin image drafts cannot enter the Douyin publication queue', async () => {
    const before = (await f.request('/api/automation')).body;
    for (const draftId of ['bili-draft', 'image-draft']) {
      const rejected = await f.request('/api/automation/import-draft', { method: 'POST', revision: before.revision, body: { draftId } });
      assert.equal(rejected.status, 400); assert.match(rejected.body.message, /只支持抖音视频/);
    }
    const after = (await f.request('/api/automation')).body;
    assert.deepEqual(after.items, before.items); assert.equal(after.revision, before.revision);
  });

  await t.test('new checked-media preview coexists with uploads/daily previews and rejects other runtime files', async () => {
    for (const path of [f.generated, f.upload, f.daily]) {
      const response = await fetch(`${f.address}/api/media?path=${encodeURIComponent(path)}`);
      assert.equal(response.status, 200, path); assert.equal(response.headers.get('content-type'), 'video/mp4');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
    }
    const range = await fetch(`${f.address}/api/media?path=${encodeURIComponent(f.upload)}`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), f.bytes.subarray(2, 6));
    const hidden = await fetch(`${f.address}/api/media?path=${encodeURIComponent(join(f.runtime, 'workbench.json'))}`); assert.equal(hidden.status, 403);
    await writeFile(f.generated, Buffer.alloc(64, 255));
    const corrupt = await fetch(`${f.address}/api/media?path=${encodeURIComponent(f.generated)}`); assert.notEqual(corrupt.status, 200);
    const unchanged = await fetch(`${f.address}/api/media?path=${encodeURIComponent(f.upload)}`); assert.equal(unchanged.status, 200);
  });
});
