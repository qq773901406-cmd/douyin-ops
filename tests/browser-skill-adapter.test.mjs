import test from 'node:test';
import assert from 'node:assert/strict';
import { startBrowserSkillSession, executeBrowserSkill, browserSkillStatus } from '../server/browser-skill-adapter.mjs';

function fixture({ browsers = [{ instance_id: 'selected' }], claim = true } = {}) {
  const calls = [];
  const invoke = async args => {
    calls.push(args);
    let payload = {};
    if (args[0] === 'browsers') payload = browsers;
    if (args[1] === 'start') payload = { session_id: 'owned', browser_instance_id: 'selected' };
    if (args.includes('--claim')) payload = { state: claim ? 'active' : 'waiting', session: { session_id: 'owned' } };
    return { ok: true, stdout: JSON.stringify(payload) };
  };
  return { calls, invoke };
}
test('应用接入会话遵循 prepare、start、claim 并绑定浏览器', async () => {
  const { calls, invoke } = fixture();
  const result = await startBrowserSkillSession(undefined, invoke);
  assert.equal(result.ok, true); assert.equal(result.sessionId, 'owned');
  assert.equal(calls[0][0], 'browsers'); assert.ok(calls[1].includes('--prepare'));
  assert.equal(calls[2][1], 'start'); assert.equal(calls[2][calls[2].indexOf('--browser') + 1], 'selected');
  assert.ok(calls[3].includes('--claim'));
});
test('多个浏览器时不猜测，明确选择后允许启动', async () => {
  const { calls, invoke } = fixture({ browsers: [{ instance_id: 'selected' }, { instance_id: 'other' }] });
  assert.equal((await startBrowserSkillSession(undefined, invoke)).ok, false);
  assert.equal(calls.length, 1);
  assert.equal((await startBrowserSkillSession('selected', invoke)).ok, true);
});
test('应用接入领取失败会清理自己创建的会话', async () => {
  const { calls, invoke } = fixture({ claim: false });
  assert.equal((await startBrowserSkillSession('selected', invoke)).ok, false);
  assert.deepEqual(calls.at(-1), ['session', 'stop', 'owned', '--json']);
});
test('会话启动失败取消自己的 request', async () => {
  const { calls, invoke } = fixture();
  const result = await startBrowserSkillSession('selected', async args => {
    if (args[1] === 'start') { calls.push(args); return { ok: false, message: 'failed' }; }
    return invoke(args);
  });
  assert.equal(result.ok, false); assert.ok(calls.at(-1).includes('--cancel'));
});
test('非法输入和非目标页面在运行命令前被拒绝', async () => {
  await assert.rejects(executeBrowserSkill(null), { status: 400 });
  await assert.rejects(executeBrowserSkill({ action: 'navigate', sessionId: 'unit-test', url: 'invalid' }), { status: 400 });
  await assert.rejects(executeBrowserSkill({ action: 'navigate', sessionId: 'unit-test', url: 'https://example.com/' }), { status: 400 });
});

test('浏览器状态查询只读status，不运行会同步skill的doctor', async () => {
  const calls = [];
  const result = await browserSkillStatus(async args => {
    calls.push(args);
    return { ok: true, stdout: args[0] === '--version' ? 'bsk 0.3.2'
      : JSON.stringify({ pid: 42, browsers: [{ instance_id: 'fresh' }], sessions: [] }) };
  });
  assert.deepEqual(calls, [['--version'], ['status', '--json']]);
  assert.equal(result.connected, true);
  assert.equal(result.responsiveBrowserCount, 1);
});

test('daemon启动、扩展无响应和协议不兼容都不能误报浏览器已连接', async () => {
  for (const payload of [
    { pid: 42, browsers: [], sessions: [] },
    { pid: 42, browsers: [{ instance_id: 'fresh', unresponsive: true }], sessions: [] },
    { pid: 42, browsers: [{ instance_id: 'fresh' }], sessions: [], version_skew_browsers: ['fresh'] },
    { pid: 42 },
  ]) {
    const result = await browserSkillStatus(async args => ({ ok: true,
      stdout: args[0] === '--version' ? 'bsk 0.3.2' : JSON.stringify(payload) }));
    assert.equal(result.installed, true);
    assert.equal(result.connected, false);
    assert.equal(result.sessionId, null);
  }
});

test('daemon探针失败时报告未连接并隐藏凭据', async () => {
  const result = await browserSkillStatus(async args => args[0] === '--version'
    ? { ok: true, stdout: 'bsk 0.3.2' }
    : { ok: false, message: 'IPC timeout token=secret-value' });
  assert.equal(result.connected, false);
  assert.equal(result.state, 'daemon_unavailable');
  assert.equal(result.message.includes('secret-value'), false);
});

test('零浏览器状态不猜测后台是否配置了自动恢复', async () => {
  const result = await browserSkillStatus(async args => ({ ok: true,
    stdout: args[0] === '--version' ? 'bsk 0.3.2' : JSON.stringify({ pid: 42, browsers: [], sessions: [] }) }));
  assert.equal(result.state, 'disconnected');
  assert.equal(result.message.includes('尚未配置'), false);
  assert.equal(result.message.includes('后台恢复状态'), true);
});
