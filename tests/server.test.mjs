import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = join(root, '.codex_tmp');
let dir, child, base, port;
async function start(host, dataDir) {
  const probe = createServer(); probe.listen(0, host); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOST: host, PORT: String(port), DOUFENG_DATA_DIR: dataDir } });
  let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (output.includes('已就绪')) return { child, port, base: `http://${host === '::1' ? '[::1]' : host}:${port}` };
    if (child.exitCode !== null) throw new Error(output);
    await delay(50);
  }
  child.kill(); throw new Error(`启动超时：${output}`);
}
async function stop(process) { if (process && process.exitCode === null && process.signalCode === null) { const closed = once(process, 'exit'); process.kill(); await closed; } }
before(async () => {
  await mkdir(temporaryRoot, { recursive: true }); dir = await mkdtemp(join(temporaryRoot, 'http-test-'));
  ({ child, base, port } = await start('127.0.0.1', dir));
});
after(async () => {
  await stop(child);
  if (dir) { assert.ok(resolve(dir).startsWith(resolve(temporaryRoot) + sep)); await rm(dir, { recursive: true, force: true }); }
});
async function json(path, options = {}) { const response = await fetch(base + path, options); return { status: response.status, data: await response.json() }; }
const put = (state, revision) => json('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(revision ? { 'If-Match': revision } : {}) }, body: JSON.stringify(state) });

test('前端模块可读取，运行数据和源码配置不暴露', async () => {
  for (const path of ['/', '/app.js', '/shop-workspace.js', '/shop-import.js', '/shop-cards.js', '/workbuddy/connector/lib/shop-products.mjs']) assert.equal((await fetch(base + path)).status, 200, path);
  for (const path of ['/runtime/workbench.json', '/server.mjs', '/package.json']) assert.equal((await fetch(base + path)).status, 404, path);
});
test('拒绝外部 Origin 和伪造 Host', async () => {
  assert.equal((await json('/api/state', { headers: { Origin: 'https://example.com' } })).status, 403);
  // Fetch rewrites Host; use the HTTP client to exercise a real forged header.
  const status = await new Promise((resolve, reject) => { const req = request(base + '/api/state', { headers: { Host: 'example.com' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(status, 403);
});
test('允许三种本机地址的 Origin', async () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.equal((await json('/api/state', { headers: { Origin: `http://${host}:${port}` } })).status, 200, host);
});
test('保存需要版本且拒绝无效输入', async () => {
  assert.equal((await put(normalizeState())).status, 428);
  assert.equal((await put({ products: [{ id: 'a', title: '商品', cost: '-1' }] }, 'missing')).status, 400);
});
test('保存、过期版本拒绝、手动备份、恢复保护完整闭环', async () => {
  const initial = await json('/api/state');
  const saved = await put(normalizeState({ account: '备份状态' }), initial.data.revision); assert.equal(saved.status, 200);
  const backup = await json('/api/backups', { method: 'POST', body: JSON.stringify({ label: 'HTTP 验证' }) }); assert.equal(backup.status, 201);
  const newer = await put(normalizeState({ account: '较新状态' }), saved.data.revision); assert.equal(newer.status, 200);
  assert.equal((await put(normalizeState({ account: '过期覆盖' }), saved.data.revision)).status, 409);
  const restored = await json('/api/backups/restore', { method: 'POST', headers: { 'If-Match': newer.data.revision }, body: JSON.stringify({ id: backup.data.backup.id }) });
  assert.equal(restored.status, 200); assert.equal(restored.data.state.account, '备份状态');
  const list = (await json('/api/backups')).data.backups;
  const protection = list.find(b => b.kind === 'restore'); assert.ok(protection);
  assert.equal((await json(`/api/backups/${protection.id}`)).data.backup.state.account, '较新状态');
});
test('错误的 JSON 与导入数据返回 400', async () => {
  assert.equal((await json('/api/backups', { method: 'POST', body: '{broken' })).status, 400);
  const revision = (await json('/api/state')).data.revision;
  assert.equal((await json('/api/backups/restore', { method: 'POST', headers: { 'If-Match': revision }, body: JSON.stringify({ state: { products: 'bad' } }) })).status, 400);
  assert.equal((await json('/api/backups/restore', { method: 'POST', headers: { 'If-Match': revision }, body: '{}' })).status, 400);
});

test('JSON 非对象和非法回采链接返回 400，不产生服务器错误', async () => {
  for (const path of ['/api/backups', '/api/backups/restore', '/api/jobs', '/api/browser-skill/execute']) {
    for (const body of ['null', '[]', '"bad"', '12']) {
      const result = await json(path, { method: 'POST', headers: { 'If-Match': 'missing' }, body });
      assert.equal(result.status, 400, `${path}: ${body}`);
    }
  }
  assert.equal((await json('/api/jobs', { method: 'POST', body: JSON.stringify({ url: 'bad-url', nextRunAt: new Date().toISOString(), extractor: 'account' }) })).status, 400);
});
test('图片上传、范围预览和路径隔离', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
  const uploaded = await json('/api/uploads?name=sample.png', { method: 'POST', body: bytes }); assert.equal(uploaded.status, 201);
  const path = '/api/media?path=' + encodeURIComponent(uploaded.data.path);
  const response = await fetch(base + path); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const range = await fetch(base + path, { headers: { Range: 'bytes=0-7' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 8);
  assert.equal((await fetch(base + path, { headers: { Range: 'bytes=99999-' } })).status, 416);
  assert.equal((await json('/api/media?path=' + encodeURIComponent(join(root, 'package.json')))).status, 403);
});
test('伪装成图片的文本不会作为图片保存', async () => {
  assert.equal((await json('/api/uploads?name=fake.png', { method: 'POST', body: 'this is not an image' })).status, 400);
});
test('IPv6 本机模式可以正常访问', async t => {
  let instance;
  try { instance = await start('::1', join(dir, 'ipv6')); }
  catch (error) { if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { t.skip('本机未启用 IPv6'); return; } throw error; }
  try { assert.equal((await fetch(instance.base + '/api/system')).status, 200); }
  finally { await stop(instance.child); }
});
