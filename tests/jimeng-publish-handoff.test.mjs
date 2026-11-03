import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { handoff, readJson, verifyArtifacts } from '../lib/jimeng-publish-handoff.mjs';
import { hashFile } from '../lib/fs-utils.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const clone = value => structuredClone(value);
const measured = () => ({ video: { decoded: true, frames: 320, seconds: 20, width: 468, height: 832, fps: 16 },
  audio: { decoded: true, nonSilent: true, seconds: 20, rmsDb: -20, peakDb: -5 },
  sources: Array.from({ length: 4 }, () => ({ video: { decoded: true, frames: 80, seconds: 5, width: 480, height: 832, fps: 16 }, motion: { checked: true, passed: true } })) });

async function fixture(t) {
  const temporaryRoot = resolve(project, '.codex_tmp'); await mkdir(temporaryRoot, { recursive: true });
  const dir = await mkdtemp(join(temporaryRoot, 'jimeng-handoff-test-'));
  t.after(async () => { assert.equal(dirname(resolve(dir)), temporaryRoot); assert.ok(basename(dir).startsWith('jimeng-handoff-test-')); await rm(dir, { recursive: true, force: true }); });
  const sources = [];
  for (let index = 1; index <= 4; index++) {
    const path = join(dir, `shot-${index}.mp4`); await writeFile(path, `ISOLATED TEST source ${index}, not a real video`);
    sources.push({ shot: index, path, sha256: await hashFile(path) });
  }
  const asset = join(dir, 'final.mp4'); await writeFile(asset, 'ISOLATED TEST assembled media, not a real video');
  const assetSha256 = await hashFile(asset), assemblyPath = join(dir, 'assembly.json'), qualityPath = join(dir, 'quality.json');
  await writeFile(assemblyPath, JSON.stringify({ status: 'completed', asset, sha256: assetSha256, fit: 'contain', sourceHashes: sources.map(source => source.sha256), video: measured().video, audioVerification: measured().audio, motionVerification: { passed: true, distinctSourceCount: 4 } }));
  await writeFile(qualityPath, JSON.stringify({ version: 1, assetSha256, reviewedAt: new Date().toISOString(), visualPassed: true, watermarksPreserved: true, continuityPassed: true, notes: ['隔离测试审查记录；不是实片验收。'] }));
  const manifest = { version: 1, id: `test-${randomUUID()}`, originalRunId: randomUUID(), runtimeDir: dir,
    asset, assetSha256, sources, accountId: 'TEST-ACCOUNT', title: '测试萌宠', caption: 'AI 生成画面', tags: '#测试', visibility: 'public', contentDeclaration: 'ai-generated',
    authorization: { scope: 'publish-completed-video-once', targetAccountId: 'TEST-ACCOUNT', confirmed: true, authorizedAt: new Date().toISOString(), userInstruction: '隔离测试：授权本条测试视频完成后进入测试队列。' },
    verification: { assemblyReport: { path: assemblyPath, sha256: await hashFile(assemblyPath) }, qualityReview: { path: qualityPath, sha256: await hashFile(qualityPath) } },
    tools: { python: process.execPath, ffmpeg: process.execPath }, publicationState: join(dir, 'publication-state.json') };
  let revision = 1, workspaceRevision = 1;
  const queue = { ok: true, revision: 'q1', capabilities: { contentDeclaration: true, whenReadySchedule: true, expectedAssetHash: true }, config: { accountId: manifest.accountId, verifiedAt: new Date().toISOString(), browserId: 'TEST-BROWSER', enabled: false }, items: [], scheduler: { running: true, busy: false }, readySuggestedAt: new Date(Date.now() + 150_000).toISOString() };
  let workspace = { drafts: [] };
  const calls = [], failure = { kind: '', beforeCommit: false }, controls = { browsers: true, toggleLimit: false, approveConflictOnce: false };
  const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(value) });
  const snapshot = () => { queue.revision = `q${revision}`; return clone(queue); };
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname, method = options.method;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method, body });
    assert.equal(options.headers.Origin, 'http://127.0.0.1:4174');
    if (method === 'GET') {
      if (path === '/api/health') return response({ ok: true, dataDir: dir });
      if (path === '/api/automation') return response(snapshot());
      if (path === '/api/automation/browsers') return response({ ok: true, browsers: controls.browsers ? [{ id: 'TEST-BROWSER' }] : [] });
      if (path === '/api/state') return response({ ok: true, state: workspace, revision: `w${workspaceRevision}` });
      assert.fail(`Unexpected GET ${path}`);
    }
    const kind = path === '/api/state' ? 'create-draft' : path.endsWith('/import-draft') ? 'import-draft' : path.endsWith('/approve') ? 'approve' : path.endsWith('/cancel') ? 'cancel-expired-schedule' : 'enable';
    if (failure.kind === kind && failure.beforeCommit) throw new Error('SIMULATED connection lost before response');
    if (path === '/api/state') {
      assert.equal(method, 'PUT');
      if (options.headers['If-Match'] !== `w${workspaceRevision}`) return response({ ok: false, message: '工作区版本已变化。' }, 409);
      workspace = body; workspaceRevision++;
      return response({ ok: true, revision: `w${workspaceRevision}` });
    }
    assert.equal(method, 'POST');
    if (options.headers['If-Match'] !== `q${revision}`) return response({ ok: false, message: '队列版本已变化。' }, 409);
    if (path === '/api/automation/import-draft') {
      const draft = workspace.drafts.find(row => row.id === body.draftId); assert.ok(draft);
      assert.equal(queue.items.filter(row => row.sourceDraftId === body.draftId).length, 0);
      queue.items.push({ id: randomUUID(), sourceDraftId: draft.id, title: draft.pubTitle, caption: `${draft.caption}\n\n${draft.hashtags}`, contentDeclaration: draft.contentDeclaration, sourcePath: draft.asset, status: 'pending', scheduledAt: '', approval: null });
      revision++;
    } else if (path.endsWith('/approve')) {
      if (controls.approveConflictOnce) { controls.approveConflictOnce = false; revision++; queue.readySuggestedAt = new Date(Date.now() + 180_000).toISOString(); return response({ ok: false, message: '账号或建议排期已变化' }, 409); }
      const item = queue.items.find(row => path.includes(row.id)); assert.ok(item);
      assert.equal(body.scheduleMode, 'when-ready'); assert.equal(body.scheduledAt, queue.readySuggestedAt); assert.equal(body.contentDeclaration, 'ai-generated');
      assert.equal(body.expectedSha256, manifest.assetSha256);
      item.status = 'approved'; item.scheduledAt = body.scheduledAt;
      item.approval = { sha256: manifest.assetSha256, asset: manifest.asset, accountId: body.accountId, browserId: queue.config.browserId, title: body.title, caption: body.caption, contentDeclaration: body.contentDeclaration, scheduledAt: body.scheduledAt }; revision++;
    } else if (path.endsWith('/cancel')) {
      const item = queue.items.find(row => path.includes(row.id)); assert.ok(item);
      item.status = 'pending'; item.approval = null; item.scheduledAt = ''; revision++;
    } else if (path === '/api/automation/toggle') {
      if (controls.toggleLimit) return response({ ok: false, message: '每日生产正在启用、结果待核实，或今天已提交视频，请先查看。' }, 409);
      queue.config.enabled = true; revision++;
    } else assert.fail(`Unexpected mutation ${path}`);
    if (failure.kind === kind) throw new Error('SIMULATED response lost after server commit');
    return response(snapshot());
  };
  const execute = (command = 'enqueue', options = {}) => handoff(manifest, { command, fetchImpl, probe: async () => measured(), ...options });
  return { dir, manifest, queue, calls, failure, controls, execute, workspace: () => workspace };
}

test('缺少成片哈希时 inspect/enqueue 都在所有 HTTP 请求前阻止', async t => {
  const f = await fixture(t); f.manifest.assetSha256 = null;
  for (const command of ['inspect', 'enqueue']) await assert.rejects(f.execute(command), /尚未记录真实 SHA256/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(access(f.manifest.publicationState), { code: 'ENOENT' });
});

test('真实源片、成片哈希和质量报告都必须绑定同一内容', async t => {
  const f = await fixture(t);
  await writeFile(f.manifest.sources[2].path, 'changed after verification');
  await assert.rejects(f.execute(), /SHA256 不符/); assert.deepEqual(f.calls, []);
  const g = await fixture(t), report = await readJson(g.manifest.verification.qualityReview.path);
  report.watermarksPreserved = false; await writeFile(g.manifest.verification.qualityReview.path, JSON.stringify(report));
  g.manifest.verification.qualityReview.sha256 = await hashFile(g.manifest.verification.qualityReview.path);
  await assert.rejects(g.execute(), /水印审查/); assert.deepEqual(g.calls, []);
});

test('不能用重复镜头或假声轨通过报告门槛', async t => {
  const f = await fixture(t); f.manifest.sources[3].sha256 = f.manifest.sources[0].sha256;
  await assert.rejects(f.execute(), /重复使用相同片段/);
  const g = await fixture(t);
  await assert.rejects(g.execute('enqueue', { probe: async () => ({ ...measured(), audio: { ...measured().audio, rmsDb: -60 } }) }), /实际音轨/);
  assert.deepEqual(g.calls, []);
});

test('inspect 默认只读，即使素材完整也不创建草稿或状态', async t => {
  const f = await fixture(t), result = await f.execute('inspect');
  assert.equal(result.status, 'ready'); assert.equal(result.writesPerformed, false);
  assert.ok(f.calls.every(call => call.method === 'GET')); assert.equal(f.workspace().drafts.length, 0);
  await assert.rejects(access(f.manifest.publicationState), { code: 'ENOENT' });
});

test('旧服务、非公开授权或离线绑定浏览器均禁止交接', async t => {
  const f = await fixture(t); f.queue.capabilities.contentDeclaration = false;
  await assert.rejects(f.execute(), /尚未加载 AI 声明/);
  assert.ok(f.calls.every(call => call.method === 'GET'));
  const g = await fixture(t); g.manifest.visibility = 'private';
  await assert.rejects(g.execute(), /公开发布/); assert.deepEqual(g.calls, []);
  const h = await fixture(t); h.controls.browsers = false;
  await assert.rejects(h.execute(), /浏览器当前未连接/); assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('成片仅一次导入批准，保留 AI 声明并由正式调度接手', async t => {
  const f = await fixture(t), result = await f.execute();
  assert.equal(result.status, 'approved'); assert.equal(result.schedulerEnabled, true);
  assert.equal(result.publicationSubmittedByCommand, false); assert.equal(f.workspace().drafts[0].sourceProductionId, undefined);
  assert.equal(f.workspace().drafts[0].contentDeclaration, 'ai-generated');
  const firstWrites = f.calls.filter(call => call.method !== 'GET').length;
  assert.equal(firstWrites, 4);
  await f.execute();
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, firstWrites);
  assert.equal(f.queue.items.length, 1);
  const state = await readJson(f.manifest.publicationState);
  assert.equal(state.pendingOperation, null); assert.equal(state.queueItemId, result.queueItemId);
});

test('导入响应丢失后先读服务器证据恢复，不再导入同一草稿', async t => {
  const f = await fixture(t); f.failure.kind = 'import-draft';
  await assert.rejects(f.execute(), problem => problem.uncertain === true);
  assert.equal((await readJson(f.manifest.publicationState)).pendingOperation.kind, 'import-draft');
  f.failure.kind = '';
  await f.execute();
  assert.equal(f.calls.filter(call => call.path.endsWith('/import-draft')).length, 1);
  assert.equal(f.queue.items.length, 1); assert.equal(f.queue.config.enabled, true);
});

test('同一 manifest 并发交接不会重复创建队列或批准', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.execute(), f.execute()]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal(f.workspace().drafts.length, 1); assert.equal(f.queue.items.length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/import-draft')).length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/approve')).length, 1);
  assert.equal((await readJson(f.manifest.publicationState)).pendingOperation, null);
});

test('导入请求结果不明且无服务器证据时不能重试', async t => {
  const f = await fixture(t); f.failure.kind = 'import-draft'; f.failure.beforeCommit = true;
  await assert.rejects(f.execute(), problem => problem.uncertain === true); f.failure.kind = '';
  await assert.rejects(f.execute(), /上次交接请求结果不明/);
  assert.equal(f.calls.filter(call => call.path.endsWith('/import-draft')).length, 1);
  assert.equal(f.queue.items.length, 0);
});

test('已提交或结果不明条目只返回回执，不重批、不重新开启', async t => {
  for (const status of ['running', 'submitted', 'published', 'uncertain']) {
    const f = await fixture(t); await f.execute();
    f.queue.items[0].status = status; f.queue.items[0].submitStartedAt = new Date().toISOString(); f.queue.config.enabled = false;
    const count = f.calls.length, result = await f.execute();
    assert.equal(result.status, status); assert.equal(result.resubmitted, false);
    assert.ok(f.calls.slice(count).every(call => call.method === 'GET'));
  }
});

test('存在其他 approved 不会被顺带启用', async t => {
  const f = await fixture(t); f.queue.items.push({ id: randomUUID(), sourceDraftId: 'unrelated', status: 'approved' });
  await assert.rejects(f.execute(), /其他已批准/);
  assert.ok(f.calls.every(call => call.method === 'GET')); assert.equal(f.queue.config.enabled, false);
});

test('审批遇确定的 409 可刷新一次；日限阻挡保留同条批准等待', async t => {
  const f = await fixture(t); f.controls.approveConflictOnce = true; f.controls.toggleLimit = true;
  const result = await f.execute();
  assert.equal(result.status, 'approved-waiting-for-daily-limit'); assert.equal(f.queue.items.length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/approve')).length, 2);
  f.controls.toggleLimit = false; await f.execute();
  assert.equal(f.calls.filter(call => call.path.endsWith('/approve')).length, 2);
  assert.equal(f.calls.filter(call => call.path.endsWith('/import-draft')).length, 1);
});

test('批准后启用前中断一小时，可用同条记录安全重新排期', async t => {
  const f = await fixture(t); f.controls.toggleLimit = true; await f.execute();
  const item = f.queue.items[0], id = item.id;
  item.scheduledAt = new Date(Date.now() - 3_600_000).toISOString(); item.approval.scheduledAt = item.scheduledAt;
  f.controls.toggleLimit = false; await f.execute();
  assert.equal(f.queue.items.length, 1); assert.equal(f.queue.items[0].id, id);
  assert.equal(f.calls.filter(call => call.path.endsWith('/import-draft')).length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/approve')).length, 2);
  assert.equal(f.queue.config.enabled, true);
});

test('过期批准只要存在执行证据就不能撤销重排', async t => {
  const f = await fixture(t); f.controls.toggleLimit = true; await f.execute();
  const item = f.queue.items[0]; item.scheduledAt = new Date(Date.now() - 3_600_000).toISOString(); item.approval.scheduledAt = item.scheduledAt;
  item.startedAt = new Date(Date.now() - 3_600_000).toISOString();
  const count = f.calls.length, result = await f.execute();
  assert.equal(result.action, 'existing-receipt-only'); assert.equal(result.needsUser, true);
  assert.ok(f.calls.slice(count).every(call => call.method === 'GET'));
});

test('撤销过期排期响应丢失后只核实 pending，不重复撤销', async t => {
  const f = await fixture(t); f.controls.toggleLimit = true; await f.execute();
  const item = f.queue.items[0]; item.scheduledAt = new Date(Date.now() - 3_600_000).toISOString(); item.approval.scheduledAt = item.scheduledAt;
  f.failure.kind = 'cancel-expired-schedule';
  await assert.rejects(f.execute(), problem => problem.uncertain === true);
  f.failure.kind = ''; f.controls.toggleLimit = false; await f.execute();
  assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 1); assert.equal(f.queue.items.length, 1);
});

test('报告即使自称通过，实际 FFmpeg 无法解码仍阻止', async t => {
  const f = await fixture(t);
  f.manifest.tools.python = resolve(project, 'runtime/python/Scripts/python.exe');
  f.manifest.tools.ffmpeg = resolve(project, 'runtime/python/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
  try { await access(f.manifest.tools.python); await access(f.manifest.tools.ffmpeg); } catch { t.skip('没有本地项目 Python/FFmpeg'); return; }
  await assert.rejects(verifyArtifacts(f.manifest), /真实媒体解码未通过/);
  assert.deepEqual(f.calls, []);
});
