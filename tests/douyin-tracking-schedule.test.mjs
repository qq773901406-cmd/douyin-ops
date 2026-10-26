import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DouyinTracking } from '../server/douyin-tracking.mjs';
import { AutomationService } from '../server/automation-service.mjs';
import { DailyProduction } from '../server/daily-production.mjs';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'doufeng-tracking-daily-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = new JsonStore(join(directory, 'workspace.json'), normalizeState(), normalizeState);
  const automation = new AutomationService(directory), dailyProduction = new DailyProduction(directory, workspace, automation);
  const binding = { accountId: 'account', browserId: 'browser' };
  await automation.store.update(state => Object.assign(state.config, binding, { verifiedAt: '2026-10-24T00:00:00Z' }));
  await dailyProduction.store.update(state => {
    Object.assign(state.config, binding);
    for (let i = 0; i < 2; i++) state.runs.push({ id: randomUUID(), status: 'submitted', title: `标题${i}`, caption: '完整文案', binding,
      sha256: String(i + 1).repeat(64), submitStartedAt: '2026-10-24T00:00:00Z', sourceMode: 'news', previewOnly: false });
  });
  let now = Date.parse('2026-10-26T10:15:00+08:00'), batches = [];
  const options = { workspace, automation, dailyProduction, now: () => now,
    collectBatch: async targets => { batches.push(targets); return targets.map(target => ({ ref: target.ref, proposal: null })); } };
  const tracking = new DouyinTracking(directory, options);
  t.after(() => tracking.stop());
  return { directory, automation, dailyProduction, options, tracking, batches, setTime: value => { now = Date.parse(value); } };
}

test('旧记录迁移为每天06:30且启动不立即开窗，过点配置从下一天开始', async t => {
  const f = await fixture(t);
  await f.tracking.start();
  assert.equal(f.batches.length, 0);
  const state = await f.tracking.snapshot();
  assert.deepEqual(state.config, { enabled: true, dailyTime: '06:30', timeZone: 'Asia/Shanghai', firstDay: '2026-10-27' });
  assert.equal(state.scheduler.nextRunAt, '2026-10-26T22:30:00.000Z');
  await f.tracking.tick();
  assert.equal(f.batches.length, 0);
  assert.equal((await f.tracking.snapshot()).automaticRuns.length, 0);
});

test('到点集中一次，失败后同日重启不再开窗，次日继续', async t => {
  const f = await fixture(t);
  await f.tracking.initialize();
  f.setTime('2026-10-27T06:30:01+08:00');
  await f.tracking.tick();
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0].length, 2);
  let snapshot = await f.tracking.snapshot();
  assert.equal(snapshot.automaticRuns[0].status, 'failed');
  assert.equal(snapshot.config.enabled, true);
  await f.tracking.tick();
  const restarted = new DouyinTracking(f.directory, f.options);
  await restarted.start(); t.after(() => restarted.stop());
  await restarted.tick();
  assert.equal(f.batches.length, 1);
  f.setTime('2026-10-28T06:30:01+08:00');
  await restarted.tick();
  assert.equal(f.batches.length, 2);
  assert.equal((await restarted.snapshot()).automaticRuns.length, 2);
});

test('两个实例同日竞争只认领一次，认领先于浏览器批次执行持久化', async t => {
  const f = await fixture(t);
  await f.tracking.initialize(); f.setTime('2026-10-27T06:30:00+08:00');
  let started = 0;
  const collectBatch = async targets => {
    const stored = JSON.parse(await readFile(join(f.directory, 'douyin-tracking/state.json'), 'utf8'));
    assert.equal(stored.automaticRuns.length, 1);
    assert.equal(stored.automaticRuns[0].status, 'running');
    started++; return targets.map(target => ({ ref: target.ref, proposal: null }));
  };
  const one = new DouyinTracking(f.directory, { ...f.options, collectBatch });
  const two = new DouyinTracking(f.directory, { ...f.options, collectBatch });
  await Promise.allSettled([one.tick(), two.tick()]);
  await two.tick();
  assert.equal(started, 1);
});

test('开窗前已保存running的中断记录不会在重启后重开窗口', async t => {
  const f = await fixture(t);
  await f.tracking.initialize();
  await f.tracking.store.update(state => state.automaticRuns.push({ day: '2026-10-27', trigger: 'scheduler', status: 'running',
    startedAt: '2026-10-26T22:30:00Z', scheduledAt: '2026-10-26T22:30:00Z' }));
  f.setTime('2026-10-27T06:31:00+08:00');
  await f.tracking.tick();
  assert.equal(f.batches.length, 0);
  assert.equal((await f.tracking.snapshot()).scheduler.nextRunAt, '2026-10-27T22:30:00.000Z');
});

test('错过十分钟窗口不补开；关闭排期不影响显式手动回采', async t => {
  const f = await fixture(t);
  await f.tracking.initialize(); f.setTime('2026-10-27T10:00:00+08:00');
  await f.tracking.tick();
  assert.equal(f.batches.length, 0);
  assert.equal((await f.tracking.snapshot()).automaticRuns[0].status, 'skipped');
  const snapshot = await f.tracking.snapshot();
  await f.tracking.configure({ enabled: false, dailyTime: '06:30' }, snapshot.revision);
  f.setTime('2026-10-28T06:30:00+08:00');
  await f.tracking.tick();
  assert.equal(f.batches.length, 0);
  await f.tracking.checkNow();
  assert.equal(f.batches.length, 1);
  assert.equal((await f.tracking.snapshot()).scheduler.nextRunAt, '');
});

test('自动批次只检查当前已确认账号，不为其他历史账号另开窗口', async t => {
  const f = await fixture(t);
  await f.dailyProduction.store.update(state => { state.runs[1].binding = { accountId: 'other', browserId: 'other-browser' }; });
  await f.tracking.initialize(); f.setTime('2026-10-27T06:30:00+08:00');
  const result = await f.tracking.tick();
  assert.equal(f.batches.length, 1); assert.equal(f.batches[0].length, 1);
  assert.ok(result.results.some(row => /其他窗口/.test(row.error || '')));
});

test('缺少集中读取器、账号不一致或错误批次归属时不开分散窗口', async t => {
  const f = await fixture(t);
  await f.tracking.initialize(); f.setTime('2026-10-27T06:30:00+08:00');
  let oldReads = 0;
  const old = new DouyinTracking(f.directory, { ...f.options, collectBatch: undefined, inspect: async () => { oldReads++; } });
  await assert.rejects(old.tick(), /集中回采读取器/);
  assert.equal(oldReads, 0);
  f.setTime('2026-10-28T06:30:00+08:00');
  await f.automation.store.update(state => { state.config.browserId = 'changed'; });
  await assert.rejects(f.tracking.tick(), /一致的账号/);
  assert.equal(f.batches.length, 0);
});

test('配置使用revision且不清除当天执行记录以再次开窗', async t => {
  const f = await fixture(t);
  await f.tracking.initialize(); f.setTime('2026-10-27T06:30:00+08:00');
  await f.tracking.tick();
  let snapshot = await f.tracking.snapshot();
  await assert.rejects(f.tracking.configure({ enabled: true, dailyTime: '25:01' }, snapshot.revision), /有效/);
  await f.tracking.configure({ enabled: true, dailyTime: '07:00' }, snapshot.revision);
  await assert.rejects(f.tracking.configure({ enabled: false, dailyTime: '07:00' }, snapshot.revision), /更新/);
  f.setTime('2026-10-27T07:00:00+08:00');
  await f.tracking.tick();
  assert.equal(f.batches.length, 1);
  assert.equal((await f.tracking.snapshot()).automaticRuns.length, 1);
});
