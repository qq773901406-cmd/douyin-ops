import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchHealth, workbenchFailure, browserHealth, browserFailure, shortDiagnostic, restartDelayMs, mayStart, mayStopOwnedChild } from '../lib/background-service-policy.mjs';

const missing = 'ensure daemon is running: automatic daemon startup is disabled (BSK_AUTO_START=0); restore the daemon in its owning environment with its original configuration';

test('后台恢复只接受明确不存在，超时、权限与错误协议不启动第二个实例', () => {
  assert.equal(browserFailure({ code: 2, message: missing }).state, 'absent');
  for (const input of [
    { code: 1, message: missing }, { code: 2, message: `${missing}; permission denied` },
    { code: 2, message: `${missing}; IPC timeout` }, { code: 2, message: missing, killed: true },
    { code: 2, message: missing, signal: 'SIGTERM' }, { code: 2, message: 'invalid reply' },
  ]) assert.equal(browserFailure(input).state, 'unknown');
  assert.equal(workbenchFailure({ cause: { code: 'ECONNREFUSED' } }).state, 'absent');
  assert.equal(workbenchFailure({ name: 'TimeoutError' }).state, 'unknown');
  assert.equal(workbenchFailure({ code: 'EACCES' }).state, 'unknown');
  assert.equal(browserHealth({}).state, 'unknown');
});

test('复用工作台须匹配服务标识、根目录、数据目录和有效PID', () => {
  const config = { root: 'D:\\ai', dataDir: 'D:\\ai\\runtime' };
  const payload = { service: 'douyin-ops-workbuddy-workbench', root: 'd:/AI', dataDir: 'D:/ai/runtime', pid: 123 };
  assert.equal(workbenchHealth(payload, config).state, 'healthy');
  for (const extra of [{ service: 'other' }, { root: 'D:\\other' }, { root: undefined }, { dataDir: 'D:\\other' }, { dataDir: undefined }, { pid: 0 }]) {
    assert.equal(workbenchHealth({ ...payload, ...extra }, config).state, 'conflict');
  }
});

test('活着的子进程、外部健康服务和退避期不会被重复启动', () => {
  const base = { health: { state: 'absent' }, ownedChildRunning: false, nextStartAt: 100, now: 100 };
  assert.equal(mayStart(base), true);
  for (const extra of [{ ownedChildRunning: true }, { stopping: true }, { now: 99 }, { health: { state: 'healthy' } }, { health: { state: 'unknown' } }, { health: { state: 'conflict' } }]) {
    assert.equal(mayStart({ ...base, ...extra }), false);
  }
  assert.deepEqual([1, 2, 3, 9, 100].map(restartDelayMs), [5000, 10000, 20000, 300000, 300000]);
});

test('退出清理只针对仍持有的存活子进程，外部或已退出进程不停止', () => {
  const process = { pid: 123, exitCode: null, signalCode: null };
  assert.equal(mayStopOwnedChild({ owned: true, process }), true);
  assert.equal(mayStopOwnedChild({ owned: false, process }), false);
  assert.equal(mayStopOwnedChild({ owned: true, process: { ...process, exitCode: 0 } }), false);
  assert.equal(mayStopOwnedChild({ owned: true, process: { ...process, signalCode: 'SIGTERM' } }), false);
  assert.equal(mayStopOwnedChild(null), false);
});

test('短诊断剔除凭据和URL并限制长度', () => {
  const value = shortDiagnostic('Error token=abcdef password="secret text" Cookie=session Auth: Bearer abc.def.ghi https://example.com/?secret=yes\n' + 'x'.repeat(600));
  for (const secret of ['abcdef', 'secret text', 'session', 'abc.def.ghi', 'https://example.com']) assert.equal(value.includes(secret), false);
  assert.ok(value.length <= 400);
  assert.equal(shortDiagnostic('{"token":"sensitive-value"}').includes('sensitive-value'), false);
});
