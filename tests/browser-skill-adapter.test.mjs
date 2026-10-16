import test from 'node:test';
import assert from 'node:assert/strict';
import { startBrowserSkillSession, executeBrowserSkill } from '../browser-skill-adapter.mjs';

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
