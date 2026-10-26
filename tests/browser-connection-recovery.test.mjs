import test from 'node:test';
import assert from 'node:assert/strict';
import { planBrowserConnectionRecovery, createBrowserConnectionRecovery } from '../lib/browser-connection-recovery.mjs';

const emptyStatus = () => ({ pid: 42, browsers: [], sessions: [], version_skew_browsers: [] });
const disconnected = (extra = {}) => ({ health: { state: 'healthy', pid: 42 }, status: emptyStatus(), launchConfigured: true, now: 1_000_000, ...extra });

test('断线等待后仅启动一次，持久记录在宿主重启后仍阻止重复开窗', () => {
  const first = planBrowserConnectionRecovery(disconnected());
  assert.equal(first.action, null);
  assert.equal(first.state.status, 'waiting_for_connection');
  const launched = planBrowserConnectionRecovery(disconnected({ previous: first.state, now: 1_060_000 }));
  assert.equal(launched.action, 'launch_browser');
  const restored = JSON.parse(JSON.stringify(launched.state));
  const pending = planBrowserConnectionRecovery(disconnected({ previous: restored, now: 1_070_000 }));
  assert.equal(pending.action, null);
  assert.equal(pending.state.status, 'waiting_for_connection');
  const expired = planBrowserConnectionRecovery(disconnected({ previous: pending.state, now: 9_000_000 }));
  assert.equal(expired.action, null);
  assert.equal(expired.state.status, 'needs_user_action');
});

test('连接恢复后使用本次实例ID、重置断线周期但保留启动冷却', () => {
  const previous = { attempted: true, lastAttemptAt: 1_000_000, disconnectedSince: 900_000, connectedBrowserIds: ['stale'] };
  const connected = planBrowserConnectionRecovery(disconnected({ previous, now: 1_100_000,
    status: { ...emptyStatus(), browsers: [{ instance_id: 'fresh' }] } }));
  assert.deepEqual(connected.state.connectedBrowserIds, ['fresh']);
  assert.equal(connected.state.attempted, false);
  assert.equal(connected.state.disconnectedSince, null);
  const again = planBrowserConnectionRecovery(disconnected({ previous: connected.state, now: 1_200_000 }));
  const waiting = planBrowserConnectionRecovery(disconnected({ previous: again.state, now: 1_300_000 }));
  assert.equal(waiting.action, null);
  assert.equal(waiting.state.nextAttemptAt, 1_600_000);
  const retry = planBrowserConnectionRecovery(disconnected({ previous: waiting.state, now: 1_600_000 }));
  assert.equal(retry.action, 'launch_browser');
  assert.deepEqual(retry.state.connectedBrowserIds, []);
});

test('守护进程故障、无法确认列表、会话未结束、未配置时不启动浏览器', () => {
  for (const extra of [
    { health: { state: 'unknown' } }, { status: { pid: 42 } },
    { status: { ...emptyStatus(), sessions: [{ session_id: 'someone-elses' }] } },
    { launchConfigured: false }, { allowLaunch: false },
  ]) {
    const result = planBrowserConnectionRecovery(disconnected({ previous: { disconnectedSince: 0 }, ...extra }));
    assert.equal(result.action, null);
    assert.notEqual(result.state.status, 'connected');
  }
});

test('已连接但无响应或协议不兼容须操作提示，不启动另一个浏览器', () => {
  for (const status of [
    { ...emptyStatus(), browsers: [{ instance_id: 'old', unresponsive: true }] },
    { ...emptyStatus(), browsers: [{}] },
    { ...emptyStatus(), browsers: [{ instance_id: 'old' }], version_skew_browsers: ['old'] },
  ]) {
    const result = planBrowserConnectionRecovery(disconnected({ status, previous: { disconnectedSince: 0 } }));
    assert.equal(result.action, null);
    assert.equal(result.state.status, 'needs_user_action');
    assert.equal(result.state.needsUserAction, true);
    assert.deepEqual(result.state.connectedBrowserIds, []);
  }
});

test('启动额度先持久化，启动结果丢失或失败不会重试', async () => {
  let persisted = { disconnectedSince: 0 };
  let launches = 0;
  const events = [];
  const options = {
    loadState: async () => persisted,
    saveState: async state => { persisted = structuredClone(state); events.push('save'); },
    launchBrowser: async () => { events.push('launch'); launches++; throw new Error('launch failed'); },
    now: () => 1_000_000,
  };
  const recovery = createBrowserConnectionRecovery(options);
  assert.equal((await recovery.check(disconnected())).needsUserAction, true);
  assert.deepEqual(events.slice(0, 2), ['save', 'launch']);
  const restarted = createBrowserConnectionRecovery(options);
  assert.equal((await restarted.check(disconnected())).needsUserAction, true);
  assert.equal(launches, 1);
});

test('明确未调用spawn的暂缓退还额度，持久保留时间并在60秒后再检查', async () => {
  let persisted = { disconnectedSince: 0 };
  let clock = 1_000_000;
  let calls = 0;
  let launches = 0;
  const options = {
    loadState: async () => persisted,
    saveState: async state => { persisted = structuredClone(state); },
    launchBrowser: async () => {
      calls++;
      if (calls === 1) return { deferred: true, reason: '有任务执行中' };
      launches++;
    },
    now: () => clock,
  };
  const recovery = createBrowserConnectionRecovery(options);
  const deferred = await recovery.check(disconnected());
  assert.equal(deferred.attempted, false);
  assert.equal(deferred.lastAttemptAt, clock);
  assert.equal(deferred.nextDeferredAt, clock + 60_000);
  const restarted = createBrowserConnectionRecovery(options);
  clock += 59_999;
  await restarted.check(disconnected());
  assert.equal(calls, 1);
  clock++;
  const attempted = await restarted.check(disconnected());
  assert.equal(calls, 2);
  assert.equal(launches, 1);
  assert.equal(attempted.attempted, true);
  assert.equal(attempted.lastAttemptDeferred, false);
  clock += 10 * 60_000;
  await restarted.check(disconnected());
  assert.equal(launches, 1);
});

test('状态读取或保存失败时禁止启动，异常日志剔除凭据', async () => {
  for (const failAt of ['load', 'save']) {
    let launches = 0;
    const recovery = createBrowserConnectionRecovery({
      loadState: async () => { if (failAt === 'load') throw new Error('token=private'); return { disconnectedSince: 0 }; },
      saveState: async () => { throw new Error('token=private'); },
      launchBrowser: async () => { launches++; }, now: () => 1_000_000,
    });
    const state = await recovery.check(disconnected());
    assert.equal(launches, 0);
    assert.equal(state.needsUserAction, true);
    assert.equal(state.message.includes('private'), false);
  }
});

test('并发检查也只预留和执行一次启动', async () => {
  let launches = 0;
  const recovery = createBrowserConnectionRecovery({
    loadState: async () => ({ disconnectedSince: 0 }), saveState: async () => {},
    launchBrowser: async () => { launches++; }, now: () => 1_000_000,
  });
  await Promise.all([recovery.check(disconnected()), recovery.check(disconnected())]);
  assert.equal(launches, 1);
});
