import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { TaskRunner } from '../server/task-runner.mjs';
import { LegacyJobBridge, legacyJobSpec } from '../server/legacy-job-bridge.mjs';

const job = { id: 'old-1', label: '公开数据回采', url: 'https://www.douyin.com/video/123456789', extractor: 'currentVideo', repeat: 'once', nextRunAt: '2026-10-24T06:00:00+08:00', enabled: true, runner: 'workbuddy', lastResult: null };
async function fixture(t, { execute, clock = () => new Date('2026-10-23T22:00:00Z'), getBinding } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'legacy-bridge-'));
  const jobsStore = new JsonStore(join(root, 'jobs.json'), []);
  const runner = new TaskRunner(root, { clock, handlers: { 'content.capture': { readOnly: true, validate: input => input, execute: execute || (async () => ({ status: 'completed', output: { views: 23, observedAt: clock().toISOString() } })) } } });
  const bridge = new LegacyJobBridge({ jobsStore, runner, getBinding });
  t.after(async () => { await bridge.stop(); await runner.stop(); await rm(root, { recursive: true, force: true }); });
  await runner.initialize(); await jobsStore.update(jobs => jobs.push(structuredClone(job)));
  return { jobsStore, runner, bridge };
}

test('旧单次计划创建真实本地任务，回执自动回写旧入口，单次完成后暂停', async t => {
  const { jobsStore, runner, bridge } = await fixture(t, { getBinding: async () => ({ browserId: 'current-browser', accountId: 'account' }) });
  await bridge.sync(); const tasks = (await runner.snapshot()).tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].kind, 'content.capture'); assert.equal(tasks[0].input.browserId, 'current-browser');
  assert.equal(tasks[0].idempotencyKey, 'legacy-job:old-1'); assert.equal((await jobsStore.read()).value[0].runner, 'local');
  await runner.tick(); await bridge.sync();
  const saved = (await jobsStore.read()).value[0]; assert.equal(saved.enabled, false); assert.equal(saved.nextRunAt, ''); assert.equal(saved.lastResult.status, 'completed'); assert.equal(saved.lastResult.output.views, 23);
  await bridge.sync(); assert.equal((await runner.snapshot()).runs.length, 1);
});

test('每日/每周保留旧首次日期与北京时间，后续只计算未来槽位', async t => {
  let now = '2026-10-23T22:00:00Z';
  const { jobsStore, runner, bridge } = await fixture(t, { clock: () => new Date(now) });
  await jobsStore.update(jobs => Object.assign(jobs[0], { repeat: 'weekly', nextRunAt: '2026-11-09T06:00:00+08:00' }));
  await bridge.sync(); const task = (await runner.snapshot()).tasks[0];
  assert.equal(task.nextRunAt, '2026-11-08T22:00:00.000Z'); assert.deepEqual(task.schedule.daysOfWeek, [1]); assert.equal(await runner.tick(), null);
  now = '2026-11-08T22:00:00Z'; await runner.tick(); await bridge.sync();
  const saved = (await jobsStore.read()).value[0]; assert.equal(saved.enabled, true); assert.equal(saved.nextRunAt, '2026-11-15T22:00:00.000Z');
  assert.equal(legacyJobSpec({ ...job, repeat: 'daily' }).schedule.time, '06:00');
});

test('丢失旧 taskId 映射仍通过持久幂等键回找，不重建任务', async t => {
  const { jobsStore, runner, bridge } = await fixture(t);
  await bridge.sync(); const id = (await runner.snapshot()).tasks[0].id;
  await jobsStore.update(jobs => { delete jobs[0].taskId; jobs[0].runner = 'workbuddy'; });
  await bridge.sync(); assert.equal((await runner.snapshot()).tasks.length, 1); assert.equal((await jobsStore.read()).value[0].taskId, id);
});

test('旧任务停用/删除同步取消执行，保留新账本历史', async t => {
  const { jobsStore, runner, bridge } = await fixture(t);
  await bridge.sync();
  await jobsStore.update(jobs => { jobs[0].enabled = false; }); await bridge.sync(); assert.equal((await runner.snapshot()).tasks[0].status, 'cancelled');
  await jobsStore.update(jobs => jobs.push({ ...job, id: 'old-2' })); await bridge.sync(); assert.equal((await runner.snapshot()).tasks.length, 2);
  await jobsStore.update(jobs => jobs.splice(0, jobs.length)); await bridge.sync();
  const state = await runner.snapshot(); assert.equal(state.tasks.length, 2); assert.ok(state.tasks.every(task => !task.enabled)); assert.equal(await runner.tick(), null);
});

test('无效来源不执行不造成功记录，缺配置的真实回执会回写 requires_action', async t => {
  const { jobsStore, runner, bridge } = await fixture(t, { execute: async () => ({ status: 'requires_action', output: { reason: '登录状态失效' } }) });
  await jobsStore.update(jobs => jobs.push({ ...job, id: 'unsafe', url: 'https://creator.douyin.com.evil.test/' }));
  await bridge.sync(); assert.equal((await runner.snapshot()).tasks.length, 1);
  const unsafe = (await jobsStore.read()).value.find(item => item.id === 'unsafe'); assert.equal(unsafe.enabled, false); assert.equal(unsafe.lastResult.status, 'requires_action');
  await runner.tick(); await bridge.sync(); const saved = (await jobsStore.read()).value[0]; assert.equal(saved.lastResult.status, 'requires_action'); assert.equal(saved.lastResult.output.reason, '登录状态失效');
});

test('旧任务来源改变后暂停原任务，不偷偷用新目标复用已授权任务', async t => {
  const { jobsStore, runner, bridge } = await fixture(t); await bridge.sync();
  await jobsStore.update(jobs => { jobs[0].url = 'https://www.douyin.com/video/99999999'; }); await bridge.sync();
  assert.equal((await runner.snapshot()).tasks[0].enabled, false); assert.equal((await jobsStore.read()).value[0].lastResult.status, 'requires_action');
});
