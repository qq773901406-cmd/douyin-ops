import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverOwnedBrowser } from '../lib/recover-owned-browser.mjs';

function fixture(overrides = {}) {
  const events = [];
  const child = { pid: 123, exitCode: null, signalCode: null };
  const service = { name: 'browser', owned: true, process: child, lastHealthyPid: 123, lastSessionCount: 0, stallCount: 5, stalledSince: 1 };
  const callbacks = {
    service,
    acquireGuard: async () => { events.push('guard'); return { ok: true, release: async () => events.push('guard-release') }; },
    acquireMaintenance: async () => { events.push('maintenance'); return { ok: true, release: async () => events.push('maintenance-release') }; },
    probe: async () => { events.push('probe'); return { state: 'unknown', recoverable: true }; },
    stopChild: async actual => {
      assert.equal(actual, child); events.push('stop');
      child.exitCode = 0; service.process = null; service.owned = false;
      return true;
    },
    startChild: async () => {
      events.push('start'); service.process = { pid: 456, exitCode: null, signalCode: null }; service.owned = true;
    },
    log: async event => events.push(event.event),
    ...overrides,
  };
  return { service, child, events, callbacks };
}

test('锁、维护、复查、确认退出、启动、清理严格顺序且单次调用', async () => {
  const f = fixture(), outcome = await recoverOwnedBrowser(f.callbacks);
  assert.equal(outcome.action, 'restarted');
  assert.equal(outcome.stopped, true); assert.equal(outcome.started, true);
  assert.ok(f.service.lastRecoveryAt > 0);
  assert.deepEqual(f.events, ['guard', 'maintenance', 'probe', 'recovery-stop', 'stop', 'start', 'recovery-start', 'maintenance-release', 'guard-release']);
});

test('业务忙碌或维护被占用时不会probe、kill或start', async t => {
  await t.test('business guard busy', async () => {
    const f = fixture(); f.callbacks.acquireGuard = async () => ({ ok: false, reason: '正在提交' });
    const outcome = await recoverOwnedBrowser(f.callbacks);
    assert.equal(outcome.action, 'blocked'); assert.match(outcome.reason, /正在提交/);
    assert.equal(outcome.stopAttempted, false); assert.deepEqual(f.events, []);
  });
  await t.test('maintenance busy', async () => {
    const f = fixture(); f.callbacks.acquireMaintenance = async () => ({ ok: false, reason: '命令仍在运行' });
    const outcome = await recoverOwnedBrowser(f.callbacks);
    assert.equal(outcome.action, 'blocked'); assert.deepEqual(f.events, ['guard', 'guard-release']);
  });
});

test('复查恢复健康就保留原进程并清除连续失败计数', async () => {
  const f = fixture(); f.callbacks.probe = async () => ({ state: 'healthy', pid: 123 });
  const outcome = await recoverOwnedBrowser(f.callbacks);
  assert.equal(outcome.action, 'none'); assert.equal(outcome.stopAttempted, false);
  assert.equal(f.service.process, f.child); assert.equal(f.service.health.state, 'healthy');
  assert.equal(f.service.stallCount, 0); assert.equal(f.service.stalledSince, null);
  assert.deepEqual(f.events, ['guard', 'maintenance', 'maintenance-release', 'guard-release']);
});

test('权限错误、状态变化、外部进程、PID变化或会话未结束均不停止', async t => {
  const cases = [
    ['absent', f => { f.callbacks.probe = async () => ({ state: 'absent' }); }],
    ['conflict', f => { f.callbacks.probe = async () => ({ state: 'conflict' }); }],
    ['unrecoverable', f => { f.callbacks.probe = async () => ({ state: 'unknown', recoverable: false }); }],
    ['external', f => { f.service.owned = false; }],
    ['PID changed', f => { f.service.lastHealthyPid = 789; }],
    ['already exited', f => { f.child.exitCode = 0; }],
    ['active session', f => { f.service.lastSessionCount = 1; }],
  ];
  for (const [label, setup] of cases) await t.test(label, async () => {
    const f = fixture(); setup(f); const outcome = await recoverOwnedBrowser(f.callbacks);
    assert.equal(outcome.action, 'blocked'); assert.equal(outcome.stopAttempted, false);
    assert.equal(f.events.includes('start'), false);
    assert.deepEqual(f.events.slice(-2), ['maintenance-release', 'guard-release']);
  });
});

test('日志等待期间所有权改变时不停止已替换进程', async () => {
  const f = fixture();
  f.callbacks.log = async () => { f.service.process = { pid: 456, exitCode: null, signalCode: null }; };
  const outcome = await recoverOwnedBrowser(f.callbacks);
  assert.equal(outcome.action, 'blocked'); assert.equal(outcome.stopAttempted, false);
  assert.equal(f.events.includes('stop'), false);
});

test('必须等待stop确认；未确认退出或抛错都不启动第二实例', async t => {
  await t.test('false', async () => {
    const f = fixture(); f.callbacks.stopChild = async () => { f.events.push('stop-unconfirmed'); return false; };
    const outcome = await recoverOwnedBrowser(f.callbacks);
    assert.equal(outcome.action, 'blocked'); assert.equal(outcome.stopAttempted, true); assert.equal(outcome.stopped, false);
    assert.equal(outcome.startAttempted, false); assert.equal(f.events.includes('start'), false);
  });
  await t.test('throws', async () => {
    const f = fixture(); f.callbacks.stopChild = async () => { throw new Error('stop timeout'); };
    const outcome = await recoverOwnedBrowser(f.callbacks);
    assert.equal(outcome.action, 'blocked'); assert.match(outcome.reason, /未自动重试/);
    assert.equal(outcome.startAttempted, false);
    assert.deepEqual(f.events.slice(-2), ['maintenance-release', 'guard-release']);
  });
  await t.test('await close', async () => {
    const f = fixture(); let confirm;
    const close = new Promise(resolve => { confirm = resolve; });
    const original = f.callbacks.stopChild;
    f.callbacks.stopChild = async actual => { await close; return original(actual); };
    const work = recoverOwnedBrowser(f.callbacks);
    // Advance only queued promise continuations; no timer-based race assertion.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(f.events.includes('start'), false);
    confirm(); assert.equal((await work).action, 'restarted');
  });
});

test('等待旧进程退出期间已有新实例时不再启动', async () => {
  const f = fixture();
  f.callbacks.stopChild = async () => {
    f.child.exitCode = 0; f.service.process = { pid: 789, exitCode: null, signalCode: null }; return true;
  };
  const outcome = await recoverOwnedBrowser(f.callbacks);
  assert.equal(outcome.action, 'blocked'); assert.equal(outcome.stopped, true); assert.equal(outcome.startAttempted, false);
});

test('取得维护锁或复查抛错会清理已经取得的全部锁', async t => {
  for (const name of ['acquireMaintenance', 'probe']) await t.test(name, async () => {
    const f = fixture(); f.callbacks[name] = async () => { throw new Error('test failure'); };
    const outcome = await recoverOwnedBrowser(f.callbacks);
    assert.equal(outcome.action, 'blocked'); assert.equal(outcome.stopAttempted, false);
    assert.equal(f.events.at(-1), 'guard-release');
    if (name === 'probe') assert.equal(f.events.includes('maintenance-release'), true);
  });
});

test('一个清理失败不跳过另一个；已启动事实保留且不重复启动', async () => {
  const f = fixture();
  f.callbacks.acquireGuard = async () => ({ ok: true, release: async () => { f.events.push('guard-release-failed'); throw new Error('guard cleanup'); } });
  f.callbacks.acquireMaintenance = async () => ({ ok: true, release: async () => { f.events.push('maintenance-release-failed'); throw new Error('maintenance cleanup'); } });
  const outcome = await recoverOwnedBrowser(f.callbacks);
  assert.equal(outcome.action, 'blocked'); assert.equal(outcome.cleanupFailed, true);
  assert.equal(outcome.cleanupErrors.length, 2); assert.equal(outcome.started, true); assert.equal(outcome.stopped, true);
  assert.deepEqual(f.events.slice(-2), ['maintenance-release-failed', 'guard-release-failed']);
  assert.equal(f.events.filter(event => event === 'start').length, 1);
});

test('启动或启动日志失败不重试，返回动作是否已经尝试', async t => {
  await t.test('start failure', async () => {
    const f = fixture(); f.callbacks.startChild = async () => { f.events.push('start'); throw new Error('start failed'); };
    const outcome = await recoverOwnedBrowser(f.callbacks);
    assert.equal(outcome.action, 'blocked'); assert.equal(outcome.startAttempted, true); assert.equal(outcome.started, false);
    assert.equal(f.events.filter(event => event === 'start').length, 1);
    assert.deepEqual(f.events.slice(-2), ['maintenance-release', 'guard-release']);
  });
  await t.test('post-start log failure', async () => {
    const f = fixture(); f.callbacks.log = async event => { if (event.event === 'recovery-start') throw new Error('log failed'); };
    const outcome = await recoverOwnedBrowser(f.callbacks);
    assert.equal(outcome.action, 'blocked'); assert.equal(outcome.started, true);
    assert.equal(f.events.filter(event => event === 'start').length, 1);
  });
});
