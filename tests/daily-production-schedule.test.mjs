import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DailyProduction } from '../server/daily-production.mjs';
import { AutomationService } from '../server/automation-service.mjs';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';

const today = '2026-10-22', tomorrow = '2026-10-23';
const time = value => Date.parse(`${value}+08:00`);
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!await condition()) {
    if (Date.now() > deadline) assert.fail('隔离调度未在预期时间内结束');
    await delay(15);
  }
}

async function fixture(t) {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'doufeng-production-schedule-'));
  assert.equal(dirname(resolve(directory)), temporaryRoot);
  assert.ok(basename(directory).startsWith('doufeng-production-schedule-'));
  const workspace = new JsonStore(join(directory, 'workspace.json'), normalizeState(), normalizeState);
  const automation = new AutomationService(directory);
  const calls = [];
  let now = time(`${today}T17:00:00`), empty = false, failure = '';
  const renderNews = async (articles, outputRoot, { day }) => {
    calls.push('render');
    if (failure === 'render') throw new Error('测试：合成失败');
    await mkdir(outputRoot, { recursive: true });
    const asset = join(outputRoot, `${randomUUID()}.mp4`);
    await writeFile(asset, 'SIMULATED video bytes, scheduling test only');
    return { asset, title: `${day} 资讯`, caption: articles.map(article => article.url).join(' '), seconds: 20 };
  };
  const daily = new DailyProduction(directory, workspace, automation, { now: () => now, intervalMs: 100, renderNews });
  t.after(async () => {
    if (process.env.DOUFENG_TEST_EVIDENCE_DIR) {
      const evidenceDirectory = resolve(process.env.DOUFENG_TEST_EVIDENCE_DIR);
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, `${basename(directory)}.json`), JSON.stringify({ test: t.name, capturedAt: new Date().toISOString(), clock: new Date(now).toISOString(), busy: daily.busy, error: daily.error, calls, state: (await daily.store.read()).value }, null, 2));
    }
    daily.stop(); automation.stop();
    await until(() => !daily.busy);
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    await rm(directory, { recursive: true, force: true });
  });
  await automation.store.update(state => Object.assign(state.config, { accountId: 'TEST-ACCOUNT', browserId: 'TEST-BROWSER', verifiedAt: new Date(now).toISOString() }));
  await daily.store.update(state => {
    Object.assign(state.config, { accountId: 'TEST-ACCOUNT', browserId: 'TEST-BROWSER' });
    state.newsLastSync = { at: new Date(now).toISOString() };
  });
  daily.check = async revision => {
    assert.equal(revision, (await daily.store.read()).revision);
    daily.environment = { ok: true, message: 'SIMULATED environment' };
  };
  daily.syncSource = async () => {
    calls.push('collect');
    await daily.store.update(state => {
      state.newsItems = empty ? [] : [{ id: String(now), title: '隔离测试资讯', url: `https://example.com/news/${now}`, sourceName: '测试来源', sourceUrl: state.config.newsFeedUrl, publishedAt: new Date(now).toISOString() }];
    });
    return { warnings: [], at: new Date(now).toISOString() };
  };
  automation.publisher = { publish: async (item, hooks) => {
    calls.push('publish');
    assert.equal(item.approval.accountId, 'TEST-ACCOUNT');
    await hooks.guard();
    if (failure === 'before-submit') throw new Error('测试：浏览器会话在提交前失败');
    await hooks.beforeSubmit();
    if (failure === 'submit') throw new Error('测试：点击后结果未知');
    return { message: 'SIMULATED submission; no platform contacted', evidence: { simulation: true } };
  } };
  const read = async () => (await daily.store.read()).value;
  const schedule = async (patch = {}) => daily.schedule({ startTime: '06:00', executionMode: 'once', executionDate: tomorrow, ...patch }, (await daily.store.read()).revision);
  const toggle = async (authorized = true) => daily.toggle({ enabled: true, authorized }, (await daily.store.read()).revision);
  const seedSubmission = async (patch = {}) => automation.store.update(state => {
    const scheduledAt = `${today}T07:45:30.000Z`;
    state.items.push({ id: randomUUID(), sourcePath: join(directory, 'prior.mp4'), fileName: 'prior.mp4', sourceSize: 1, sourceMtime: 1, title: '此前提交', caption: '', status: 'submitted', scheduledAt, startedAt: scheduledAt, submitStartedAt: scheduledAt, ...patch, approval: { asset: join(directory, 'prior.mp4'), sha256: 'a'.repeat(64), accountId: 'TEST-ACCOUNT', browserId: 'TEST-BROWSER', title: '此前提交', caption: '', scheduledAt } });
  });
  const seedFailed = async (patch = {}) => {
    let seeded;
    await daily.store.update(state => {
      seeded = { id: randomUUID(), day: today, previewOnly: false, trigger: 'scheduler', sourceMode: state.config.sourceMode, status: 'failed', startedAt: `${today}T06:00:00+08:00`, finishedAt: `${today}T06:00:03+08:00`, message: '测试：浏览器会话在提交前失败', binding: { ...structuredClone(state.config), enabled: true, executionMode: 'once', executionDate: today, authorizedAt: 'prior-test-authorization', firstDay: today }, ...patch };
      state.runs.push(seeded);
    });
    return structuredClone(seeded);
  };
  return { directory, daily, automation, workspace, calls, read, schedule, toggle, seedSubmission, seedFailed, advance: value => { now = time(value); }, empty: () => { empty = true; }, failAt: value => { failure = value; } };
}

test('旧生产配置保持每日模式，保存执行方式、日期或时间会撤销原授权', async t => {
  const f = await fixture(t);
  const saved = await f.read();
  delete saved.config.executionMode; delete saved.config.executionDate;
  await writeFile(f.daily.store.path, JSON.stringify(saved));
  assert.equal((await f.read()).config.executionMode, 'daily');
  await f.daily.start();
  await f.schedule({ executionMode: 'daily', startTime: '18:00' });
  await f.toggle();
  assert.equal((await f.read()).config.enabled, true);
  const stale = (await f.daily.store.read()).revision;
  await f.schedule();
  let config = (await f.read()).config;
  assert.deepEqual([config.executionMode, config.executionDate, config.enabled, config.authorizedAt, config.firstDay], ['once', tomorrow, false, '', '']);
  await assert.rejects(f.daily.schedule({ startTime: '07:00', executionMode: 'daily' }, stale), /已有更新|更新/);
  await assert.rejects(f.schedule({ executionDate: '2026-02-30' }), /日期/);
  await assert.rejects(f.schedule({ executionMode: 'forever' }), /执行模式/);
  await f.toggle();
  await f.schedule({ startTime: '07:00' });
  config = (await f.read()).config;
  assert.equal(config.enabled, false); assert.equal(config.authorizedAt, '');
});

test('今天已有同账号实发时每日计划首日为明天，单次计划不允许占用今天', async t => {
  const f = await fixture(t);
  await f.seedSubmission(); await f.daily.start();
  await f.schedule({ executionMode: 'daily', startTime: '18:00' });
  await f.toggle();
  assert.equal((await f.read()).config.firstDay, tomorrow);
  await f.schedule({ executionDate: today, startTime: '18:00' });
  await assert.rejects(f.toggle(), /已有生产或发布记录/);
  await f.schedule();
  await assert.rejects(f.toggle(false), /请确认/);
  await f.toggle();
  assert.equal((await f.read()).config.firstDay, tomorrow);
  assert.equal((await f.daily.snapshot()).nextRunAt, `${tomorrow}T06:00:00+08:00`);
  await f.schedule({ executionDate: today, startTime: '16:00' });
  await assert.rejects(f.toggle(), /时间已过/);
  assert.equal((await f.read()).config.enabled, false);
});

test('尚未到期的慢轮询不会占 busy 或阻止保存计划，返回旧快照后也不会执行', async t => {
  const f = await fixture(t);
  const originalRead = f.daily.store.read.bind(f.daily.store);
  let unblock, entered;
  const gate = new Promise(resolve => { unblock = resolve; });
  const pending = new Promise(resolve => { entered = resolve; });
  let first = true;
  f.daily.store.read = async () => {
    const result = await originalRead();
    if (first) { first = false; entered(); await gate; }
    return result;
  };
  const poll = f.daily.run(false, 'scheduler');
  await pending;
  try {
    assert.equal(f.daily.busy, false);
    await f.schedule();
    assert.equal((await f.read()).config.executionMode, 'once');
  } finally { unblock(); await poll; }
  assert.equal(f.daily.busy, false);
  assert.equal((await f.read()).runs.length, 0);
  assert.deepEqual(f.calls, []);
});

test('今日失败后新启用明日单次计划显示等待，保留旧记录且不会提前运行', async t => {
  const f = await fixture(t);
  const failed = { id: randomUUID(), day: today, previewOnly: false, trigger: 'scheduler', status: 'failed', startedAt: `${today}T06:00:00+08:00`, finishedAt: `${today}T06:00:03+08:00`, message: '测试：浏览器会话建立失败' };
  await f.daily.store.update(state => { state.runs.push(failed); });
  await f.daily.start();
  await f.schedule({ executionDate: today, startTime: '18:00' });
  await assert.rejects(f.toggle(), /已有生产或发布记录/);
  await f.schedule(); await f.toggle();
  await delay(150);
  const snapshot = await f.daily.snapshot();
  assert.equal(snapshot.scheduleState, 'waiting');
  assert.equal(snapshot.nextRunAt, `${tomorrow}T06:00:00+08:00`);
  assert.equal(snapshot.config.firstDay, tomorrow);
  assert.equal(snapshot.config.enabled, true);
  assert.ok(snapshot.config.authorizedAt);
  assert.deepEqual(snapshot.todayRun, failed);
  assert.deepEqual(snapshot.runs, [failed]);
  assert.deepEqual(f.calls, []);
});

test('明确授权同日提交前失败的重排后，短 timer 完成一次新生产且保留原失败回执', async t => {
  const f = await fixture(t);
  const failed = await f.seedFailed();
  const retry = { executionDate: today, startTime: '18:00', retryOfRunId: failed.id, authorizedRetry: true };
  await f.daily.start();
  await f.schedule(retry);
  assert.equal((await f.read()).config.retryOfRunId, failed.id);
  await assert.rejects(f.toggle(false), /请确认/);
  await f.toggle();
  const authorized = structuredClone((await f.read()).config);
  await f.schedule(retry);
  assert.deepEqual((await f.read()).config, authorized, '相同重排设置再次保存不会撤销现有授权');
  f.daily.stop(); await f.daily.start(); await delay(120);
  const waiting = await f.daily.snapshot();
  assert.equal(waiting.config.enabled, true);
  assert.equal(waiting.scheduleState, 'waiting');
  assert.equal(waiting.nextRunAt, `${today}T18:00:00+08:00`);
  assert.deepEqual(waiting.runs, [failed]);
  assert.deepEqual(f.calls, []);
  f.advance(`${today}T18:00:00`);
  await until(async () => (await f.read()).runs.some(run => run.status === 'submitted'));
  const saved = await f.read();
  assert.deepEqual(f.calls, ['collect', 'render', 'publish']);
  assert.equal(saved.runs.length, 2);
  assert.deepEqual(saved.runs[0], failed);
  assert.equal(saved.runs[1].trigger, 'scheduler');
  assert.equal(saved.runs[1].previewOnly, false);
  assert.equal(saved.runs[1].binding.retryOfRunId, failed.id);
  assert.ok(saved.runs[1].submitStartedAt);
  assert.equal(saved.config.enabled, false);
  await delay(150);
  assert.equal((await f.read()).runs.length, 2);
  f.daily.stop(); await f.daily.start();
  f.advance(`${tomorrow}T18:00:00`); await delay(150);
  assert.equal((await f.read()).runs.length, 2);
  assert.equal(f.calls.filter(call => call === 'publish').length, 1);
});

test('重排后的新任务再次失败会停用；引用旧失败或新失败都不能继续豁免同日记录', async t => {
  const f = await fixture(t);
  const failed = await f.seedFailed();
  f.failAt('before-submit');
  await f.daily.start();
  await f.schedule({ executionDate: today, startTime: '18:00', retryOfRunId: failed.id, authorizedRetry: true });
  await f.toggle();
  f.advance(`${today}T18:00:00`);
  await until(async () => (await f.read()).runs.length === 2 && (await f.read()).runs[1].status === 'failed');
  await until(() => !f.daily.busy);
  const saved = await f.read();
  assert.equal(saved.config.enabled, false);
  assert.deepEqual(saved.runs[0], failed);
  assert.equal(saved.runs[1].submitStartedAt, undefined);
  for (const retryOfRunId of [failed.id, saved.runs[1].id]) {
    await assert.rejects(async () => {
      await f.schedule({ executionDate: today, startTime: '19:00', retryOfRunId, authorizedRetry: true });
      await f.toggle();
    });
    assert.equal((await f.read()).config.enabled, false);
  }
  f.advance(`${today}T19:00:00`); await delay(150);
  assert.deepEqual((await f.read()).runs, saved.runs);
  assert.equal(f.calls.filter(call => call === 'publish').length, 1);
});

test('只有同日同账号且完全无发布信号的完整失败回执可以申请显式重排', async t => {
  const cases = [
    ['submitted', { status: 'submitted' }],
    ['uncertain', { status: 'uncertain' }],
    ['submitStartedAt', { submitStartedAt: `${today}T06:00:02+08:00` }],
    ['evidence', { evidence: { message: '提交结果待核实' } }],
    ['empty evidence', { evidence: {} }],
    ['publishedUrl', { publishedUrl: 'https://example.com/video/123' }],
    ['boundWorkId', { boundWorkId: '123' }],
    ['reconciledResult', { reconciledResult: 'not_published' }],
    ['different day', { day: '2026-10-21' }],
    ['different account', { binding: { accountId: 'ANOTHER-ACCOUNT' } }],
    ['missing account binding', { binding: {} }],
    ['unfinished', { finishedAt: '' }],
    ['preview', { previewOnly: true }],
  ];
  for (const [label, patch] of cases) {
    await t.test(label, async sub => {
      const f = await fixture(sub);
      const original = await f.seedFailed(patch);
      await f.daily.start();
      const before = await f.read();
      await assert.rejects(f.schedule({ executionDate: today, startTime: '18:00', retryOfRunId: original.id, authorizedRetry: true }));
      assert.deepEqual((await f.read()).runs, before.runs);
      assert.equal((await f.read()).config.enabled, false);
      assert.deepEqual(f.calls, []);
    });
  }
});

test('重排必须单次且明确授权；普通保存清除重排标记并恢复同日防重', async t => {
  const f = await fixture(t);
  const failed = await f.seedFailed();
  const retry = { executionDate: today, startTime: '18:00', retryOfRunId: failed.id };
  await f.daily.start();
  await assert.rejects(f.schedule(retry));
  await assert.rejects(f.schedule({ ...retry, authorizedRetry: false }));
  await assert.rejects(f.schedule({ ...retry, executionMode: 'daily', authorizedRetry: true }));
  await assert.rejects(f.schedule({ ...retry, retryOfRunId: 'missing-run', authorizedRetry: true }));
  await f.schedule({ ...retry, authorizedRetry: true }); await f.toggle();
  await f.schedule({ executionDate: today, startTime: '18:00' });
  const saved = await f.read();
  assert.equal(saved.config.retryOfRunId, '');
  assert.equal(saved.config.enabled, false);
  assert.equal(saved.config.authorizedAt, '');
  await assert.rejects(f.toggle(), /已有生产或发布记录/);
  assert.deepEqual((await f.read()).runs, [failed]);
  assert.deepEqual(f.calls, []);
});

test('重排计划启动恢复遇到新的已落盘任务仍消费授权，不会再次采集或提交', async t => {
  for (const [status, submitted, expected] of [['submitted', true, 'submitted'], ['rendering', false, 'failed'], ['publishing', true, 'uncertain']]) {
    await t.test(status, async sub => {
      const f = await fixture(sub);
      const failed = await f.seedFailed();
      await f.schedule({ executionDate: today, startTime: '18:00', retryOfRunId: failed.id, authorizedRetry: true });
      await f.daily.store.update(state => {
        Object.assign(state.config, { enabled: true, authorizedAt: 'test-retry-authorization', firstDay: today });
        state.runs.push({ id: randomUUID(), day: today, previewOnly: false, trigger: 'scheduler', status, ...(submitted ? { submitStartedAt: `${today}T18:00:00+08:00` } : {}), binding: structuredClone(state.config) });
      });
      f.advance(`${today}T18:00:01`); await f.daily.start(); await delay(150);
      const saved = await f.read();
      assert.equal(saved.config.enabled, false);
      assert.equal(saved.runs.length, 2);
      assert.deepEqual(saved.runs[0], failed);
      assert.equal(saved.runs[1].status, expected);
      assert.deepEqual(f.calls, []);
    });
  }
});

test('另一个进程不能消费正在执行的重排任务；发布租约仍阻止第二次执行', async t => {
  const f = await fixture(t);
  const failed = await f.seedFailed();
  await f.schedule({ executionDate: today, startTime: '18:00', retryOfRunId: failed.id, authorizedRetry: true });
  await f.daily.store.update(state => {
    Object.assign(state.config, { enabled: true, authorizedAt: 'test-retry-authorization', firstDay: today });
    state.runs.push({ id: randomUUID(), day: today, previewOnly: false, trigger: 'scheduler', status: 'rendering', binding: structuredClone(state.config) });
  });
  const release = await f.automation.lease();
  try {
    await assert.rejects(f.daily.start(), /另一个发布进程/);
    f.advance(`${today}T18:00:00`); await f.daily.run(false, 'scheduler');
    const saved = await f.read();
    assert.equal(saved.config.enabled, true);
    assert.equal(saved.runs.length, 2);
    assert.deepEqual(saved.runs[0], failed);
    assert.equal(saved.runs[1].status, 'rendering');
    assert.deepEqual(f.calls, []);
  } finally { await release(); }
});

test('真实短 timer 到点触发采集、制作、单次提交；预览不消费授权，回执与停用同时持久化', async t => {
  const f = await fixture(t);
  await f.daily.start(); await f.schedule(); await f.toggle();
  await delay(60);
  assert.equal((await f.read()).runs.length, 0);
  await f.daily.run(true);
  assert.equal((await f.read()).config.enabled, true);
  assert.deepEqual(f.calls, ['collect', 'render']);
  f.calls.length = 0;
  f.advance(`${tomorrow}T06:00:00`);
  await until(async () => (await f.read()).runs.some(run => run.status === 'submitted'));
  const saved = await f.read();
  assert.deepEqual(f.calls, ['collect', 'render', 'publish']);
  assert.deepEqual(saved.runs.map(run => [run.status, run.trigger]), [['preview', 'preview'], ['submitted', 'scheduler']]);
  assert.ok(saved.runs[1].submitStartedAt);
  assert.equal(saved.config.enabled, false);
  assert.equal((await f.workspace.read()).value.drafts.length, 2);
  f.advance('2026-10-24T06:00:00'); await delay(60);
  assert.equal((await f.read()).runs.length, 2);
  assert.equal(f.calls.filter(call => call === 'publish').length, 1);
});

test('单次启用后出现跨午夜队列提交时，按实际提交日阻止第二条', async t => {
  const f = await fixture(t);
  await f.daily.start(); await f.schedule(); await f.toggle();
  await f.seedSubmission({ startedAt: `${today}T15:59:30.000Z`, submitStartedAt: `${today}T16:00:30.000Z` });
  f.advance(`${tomorrow}T06:00:00`);
  await until(async () => (await f.read()).runs.some(run => run.status === 'failed'));
  const saved = await f.read();
  assert.equal(saved.config.enabled, false);
  assert.match(saved.runs[0].message, /今天已有发布记录/);
  assert.equal(saved.runs[0].submitStartedAt, undefined);
  assert.deepEqual(f.calls, ['collect', 'render']);
});

test('单次跳过、合成失败和提交结果不明都停止，不会在次日补发', async t => {
  for (const [failure, expected] of [['empty', 'skipped'], ['render', 'failed'], ['submit', 'uncertain']]) {
    await t.test(failure, async sub => {
      const f = await fixture(sub);
      if (failure === 'empty') f.empty(); else f.failAt(failure);
      await f.daily.start(); await f.schedule(); await f.toggle();
      f.advance(`${tomorrow}T06:00:00`);
      await until(async () => (await f.read()).runs.some(run => run.status === expected));
      const saved = await f.read();
      assert.equal(saved.config.enabled, false); assert.equal(saved.runs.length, 1);
      assert.equal(!!saved.runs[0].submitStartedAt, failure === 'submit');
      f.advance('2026-10-24T06:00:00'); await delay(60);
      assert.equal((await f.read()).runs.length, 1);
    });
  }
});

test('单次计划整日离线后只记录指定日期已过期，不采集、制作或顺延', async t => {
  const f = await fixture(t);
  await f.daily.start(); await f.schedule(); await f.toggle(); f.daily.stop();
  f.advance('2026-10-24T06:00:00'); await f.daily.start();
  await until(async () => (await f.read()).runs.some(run => run.status === 'skipped'));
  const saved = await f.read();
  assert.equal(saved.runs[0].day, tomorrow); assert.equal(saved.runs[0].status, 'skipped');
  assert.match(saved.runs[0].message, /不顺延/); assert.equal(saved.config.enabled, false);
  assert.deepEqual(f.calls, []); assert.equal((await f.daily.snapshot()).nextRunAt, '');
});

test('单次启动恢复消费已落盘结果；中断提交前失败、提交后待核实，均不重试', async t => {
  for (const [status, submitted, expected] of [['submitted', true, 'submitted'], ['rendering', false, 'failed'], ['publishing', true, 'uncertain']]) {
    await t.test(status, async sub => {
      const f = await fixture(sub);
      await f.schedule();
      await f.daily.store.update(state => {
        Object.assign(state.config, { enabled: true, authorizedAt: 'test-authorization', firstDay: tomorrow });
        state.runs.push({ id: randomUUID(), day: tomorrow, previewOnly: false, status, ...(submitted ? { submitStartedAt: '2026-10-22T22:00:00Z' } : {}), binding: structuredClone(state.config) });
      });
      f.advance('2026-10-24T06:00:00'); await f.daily.start(); await delay(60);
      const saved = await f.read();
      assert.equal(saved.config.enabled, false); assert.equal(saved.runs.length, 1);
      assert.equal(saved.runs[0].status, expected); assert.deepEqual(f.calls, []);
    });
  }
});

test('第二个进程不能凭单次已被占用而停掉正在运行的发布', async t => {
  const f = await fixture(t);
  await f.schedule();
  await f.daily.store.update(state => {
    Object.assign(state.config, { enabled: true, authorizedAt: 'test-authorization', firstDay: tomorrow });
    state.runs.push({ id: randomUUID(), day: tomorrow, previewOnly: false, status: 'rendering', binding: structuredClone(state.config) });
  });
  const release = await f.automation.lease();
  try {
    await assert.rejects(f.daily.start(), /另一个发布进程/);
    f.advance(`${tomorrow}T06:00:00`); await f.daily.run();
    const saved = await f.read();
    assert.equal(saved.config.enabled, true); assert.equal(saved.runs[0].status, 'rendering');
    assert.deepEqual(f.calls, []);
  } finally { await release(); }
});

test('每日模式继续跨日运行，每天最多一次，不受单次停用规则影响', async t => {
  const f = await fixture(t);
  await f.daily.start(); await f.schedule({ executionMode: 'daily', startTime: '18:00' }); await f.toggle();
  f.advance(`${today}T18:00:00`);
  await until(async () => (await f.read()).runs.filter(run => run.status === 'submitted').length === 1);
  assert.equal((await f.read()).runs[0].status, 'submitted');
  assert.equal((await f.read()).config.enabled, true);
  await delay(60); assert.equal((await f.read()).runs.length, 1);
  f.advance(`${tomorrow}T18:00:00`);
  await until(async () => (await f.read()).runs.filter(run => run.status === 'submitted').length === 2);
  assert.equal((await f.read()).config.enabled, true);
  assert.equal(f.calls.filter(call => call === 'publish').length, 2);
});
