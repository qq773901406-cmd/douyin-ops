import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireRecoveryGuard } from '../lib/background-recovery-guard.mjs';
import { AutomationService } from '../server/automation-service.mjs';
import { DailyProduction } from '../server/daily-production.mjs';
import { TaskRunner } from '../server/task-runner.mjs';
import { BilibiliWorkflow } from '../server/bilibili-workflow.mjs';
import { defaultAutomation } from '../shared/automation-model.mjs';

const temporaryRoot = fileURLToPath(new URL('../.codex_tmp/', import.meta.url));
const paths = ['automation/queue.json', 'daily-production/state.json', 'tasks/state.json', 'bilibili-publish/jobs.json'];
async function fixture(t) {
  await mkdir(temporaryRoot, { recursive: true });
  const dataDir = await mkdtemp(join(temporaryRoot, 'recovery-guard-'));
  t.after(async () => {
    assert.ok(resolve(dataDir).startsWith(resolve(temporaryRoot) + sep));
    await rm(dataDir, { recursive: true, force: true });
  });
  const write = async (path, value) => {
    const full = join(dataDir, path); await mkdir(dirname(full), { recursive: true });
    await writeFile(full, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const automation = new AutomationService(dataDir);
  const daily = new DailyProduction(dataDir, null, automation);
  const tasks = new TaskRunner(dataDir);
  const bili = new BilibiliWorkflow(join(dataDir, 'bilibili-publish'));
  return { dataDir, write, automation, daily, tasks, bili };
}

function queueItem(status) {
  const scheduledAt = '2026-10-24T06:00:00+08:00';
  return { id: randomUUID(), status, sourcePath: 'fixture.mp4', fileName: 'fixture.mp4', sourceSize: 1, sourceMtime: 1, title: '测试视频', caption: '', scheduledAt,
    approval: { sha256: 'a'.repeat(64), asset: 'fixture.mp4', accountId: 'fixture-account', browserId: 'fixture-browser', title: '测试视频', caption: '', scheduledAt },
  };
}

async function seedBili(f, status) {
  const asset = join(f.dataDir, 'video.mp4'); await writeFile(asset, 'test only; never uploaded');
  const job = await f.bili.prepare({ videoPath: asset, accountName: '测试账号', accountUid: '1', browserId: 'fixture-browser', title: '测试视频', description: '', tags: ['测试'], aiGenerated: true, category: '人工智能' });
  await f.bili.store.update(state => {
    state.jobs[0].status = status;
    if (['submitted', 'published'].includes(status)) state.jobs[0].receipt = { url: 'https://www.bilibili.com/video/BV1234567890/' };
  });
  return job;
}

test('缺失账本可恢复，只创建临时互斥锁，不创建默认账本', async t => {
  for (const service of ['browser', 'workbench']) await t.test(service, async sub => {
    const f = await fixture(sub), guard = await acquireRecoveryGuard({ dataDir: f.dataDir, service });
    assert.equal(guard.ok, true, guard.reason);
    await guard.release(); await guard.release();
    for (const path of paths) await assert.rejects(access(join(f.dataDir, path)), { code: 'ENOENT' });
    for (const path of ['automation/runner.lock', 'tasks/runner.lease', 'tasks/state.json.lock', 'bilibili-publish/jobs.json.lock']) await assert.rejects(access(join(f.dataDir, path)), { code: 'ENOENT' });
  });
});

test('两个恢复者实际竞争同一发布租约，只有一个成功；普通发布亦被阻止', async t => {
  const f = await fixture(t); await f.write(paths[0], JSON.stringify(defaultAutomation()) + '\n');
  const before = await readFile(f.automation.store.path, 'utf8');
  const outcomes = await Promise.all([1, 2].map(() => acquireRecoveryGuard({ dataDir: f.dataDir, service: 'browser' })));
  assert.equal(outcomes.filter(row => row.ok).length, 1);
  const winner = outcomes.find(row => row.ok);
  await assert.rejects(new AutomationService(f.dataDir).lease(), /另一个发布进程|执行锁/);
  assert.equal(await readFile(f.automation.store.path, 'utf8'), before);
  await winner.release();
  const normalRelease = await f.automation.lease(); await normalRelease();
});

test('已有存活发布者时不恢复、不删除其锁', async t => {
  const f = await fixture(t), release = await f.automation.lease();
  const path = join(f.dataDir, 'automation/runner.lock'), before = await readFile(path, 'utf8');
  const guard = await acquireRecoveryGuard({ dataDir: f.dataDir, service: 'browser' });
  assert.equal(guard.ok, false); assert.match(guard.reason, /另一个发布进程|执行锁/);
  assert.equal(await readFile(path, 'utf8'), before);
  await release();
});

test('活动或结果不明的三类发布账本均阻止恢复，并逐字节保留回执', async t => {
  const cases = [
    ...['running', 'uncertain'].map(status => ['queue', status]),
    ...['selecting', 'rendering', 'publishing', 'uncertain'].map(status => ['daily', status]),
    ...['submitting', 'uncertain'].map(status => ['bili', status]),
  ];
  for (const [kind, status] of cases) await t.test(`${kind}:${status}`, async sub => {
    const f = await fixture(sub);
    let path;
    if (kind === 'queue') { const state = defaultAutomation(); state.items.push(queueItem(status)); path = paths[0]; await f.write(path, state); }
    if (kind === 'daily') { await f.daily.store.update(state => state.runs.push({ id: randomUUID(), status, day: '2026-10-24', submitStartedAt: status === 'uncertain' ? '2026-10-24T06:01:00+08:00' : undefined })); path = paths[1]; }
    if (kind === 'bili') { await seedBili(f, status); path = paths[3]; }
    const before = await readFile(join(f.dataDir, path), 'utf8');
    const guard = await acquireRecoveryGuard({ dataDir: f.dataDir, service: 'browser' });
    assert.equal(guard.ok, false); assert.match(guard.reason, /执行|提交|待核实/);
    assert.equal(await readFile(join(f.dataDir, path), 'utf8'), before);
    await assert.rejects(access(join(f.dataDir, 'automation/runner.lock')), { code: 'ENOENT' });
  });
});

test('历史 submitted/published 不当作活动任务，恢复不改审批、日期或回执格式', async t => {
  const f = await fixture(t), queue = defaultAutomation(); queue.items.push(queueItem('submitted'), queueItem('published'));
  await f.write(paths[0], JSON.stringify(queue) + '\n\n');
  await f.daily.store.update(state => state.runs.push({ id: 'done', status: 'submitted', day: '2026-10-24' }));
  await f.write(paths[2], { version: 1, tasks: [{ id: 'unknown-task', status: 'unknown' }], runs: [{ id: 'interrupted-run', status: 'interrupted' }] });
  await seedBili(f, 'published');
  const before = await Promise.all(paths.map(path => readFile(join(f.dataDir, path), 'utf8')));
  const guard = await acquireRecoveryGuard({ dataDir: f.dataDir, service: 'browser' });
  assert.equal(guard.ok, true, guard.reason); await guard.release();
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(f.dataDir, path), 'utf8'))), before);
});

test('运营任务任一任务或回执running均阻止恢复', async t => {
  for (const collection of ['tasks', 'runs']) await t.test(collection, async sub => {
    const f = await fixture(sub), state = { version: 1, tasks: [], runs: [] };
    state[collection].push({ id: 'live', status: 'running' }); await f.write(paths[2], state);
    const guard = await acquireRecoveryGuard({ dataDir: f.dataDir, service: 'browser' });
    assert.equal(guard.ok, false); assert.match(guard.reason, /运营任务仍在执行/);
  });
});

test('存活运营执行器的生命周期租约不能被工作台恢复抢占', async t => {
  const f = await fixture(t); await f.tasks.acquireLease();
  const before = await readFile(f.tasks.leasePath, 'utf8');
  const guard = await acquireRecoveryGuard({ dataDir: f.dataDir, service: 'workbench' });
  assert.equal(guard.ok, false); assert.match(guard.reason, /存活进程/);
  assert.equal(await readFile(f.tasks.leasePath, 'utf8'), before);
  await f.tasks.releaseLease();
});

test('坏JSON、未知状态和无法识别锁均保留并阻止恢复', async t => {
  for (const path of paths) await t.test(path, async sub => {
    const f = await fixture(sub); await f.write(path, '{broken');
    const guard = await acquireRecoveryGuard({ dataDir: f.dataDir, service: 'browser' });
    assert.equal(guard.ok, false); assert.equal(await readFile(join(f.dataDir, path), 'utf8'), '{broken');
  });
  for (const path of ['automation/runner.lock', 'tasks/state.json.lock', 'bilibili-publish/jobs.json.lock', 'tasks/runner.lease']) await t.test(path, async sub => {
    const f = await fixture(sub); await f.write(path, '{opaque');
    const guard = await acquireRecoveryGuard({ dataDir: f.dataDir, service: path.endsWith('.lease') ? 'workbench' : 'browser' });
    assert.equal(guard.ok, false); assert.equal(await readFile(join(f.dataDir, path), 'utf8'), '{opaque');
  });
  const f = await fixture(t); await f.write(paths[2], { version: 1, tasks: [{ id: 'bad', status: 'future-status' }], runs: [] });
  assert.equal((await acquireRecoveryGuard({ dataDir: f.dataDir, service: 'browser' })).ok, false);
});

test('恢复期间保留运营和B站账本写锁，释放后写入恢复', async t => {
  const f = await fixture(t), guard = await acquireRecoveryGuard({ dataDir: f.dataDir, service: 'browser' });
  assert.equal(guard.ok, true, guard.reason);
  for (const path of [f.tasks.store.path, f.bili.store.path]) {
    const lock = JSON.parse(await readFile(`${path}.lock`, 'utf8'));
    assert.equal(lock.pid, process.pid); assert.ok(lock.owner);
  }
  await guard.release();
  await f.tasks.store.update(state => state.tasks.push({ id: 'after', status: 'paused' }));
  assert.equal((await f.tasks.store.read()).value.tasks[0].id, 'after');
});
