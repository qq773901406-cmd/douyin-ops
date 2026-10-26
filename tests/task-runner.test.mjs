import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskRunner, nextTaskRunAt, validateTaskSchedule } from '../server/task-runner.mjs';

const once = { type: 'once', at: '2026-10-24T06:00:00+08:00' };
const base = { name: '可核对任务', kind: 'collect', input: { source: 'fixture' }, schedule: once, enabled: true };
const handler = execute => ({ readOnly: true, validate: value => value, execute: execute || (async () => ({ status: 'completed', output: { count: 3 } })) });
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'task-runner-'));
  const runner = new TaskRunner(directory, { handlers: { collect: handler() }, clock: () => new Date('2026-10-23T22:00:00Z'), ...options });
  t.after(async () => { await runner.stop(); await rm(directory, { recursive: true, force: true }); });
  await runner.initialize(); return { runner, directory };
}

test('单次执行先保存意图，实际结果留痕并自动停用，重启不会重放', async t => {
  let calls = 0;
  const { runner, directory } = await setup(t);
  runner.handlers.set('collect', handler(async (_, context) => {
    calls++;
    const state = JSON.parse(await readFile(join(directory, 'tasks', 'state.json'), 'utf8'));
    assert.equal(state.runs[0].status, 'running'); assert.ok(state.runs[0].intentAt);
    assert.equal(state.runs[0].id, context.runId);
    return { status: 'completed', output: { sourceItems: ['a', 'b'] } };
  }));
  const created = await runner.create(base), id = created.tasks[0].id;
  const result = await runner.tick(); assert.equal(result.trigger, 'scheduler'); assert.equal(result.status, 'completed');
  const state = await runner.snapshot(); assert.equal(state.tasks[0].enabled, false); assert.deepEqual(result.output, { sourceItems: ['a', 'b'] });
  await assert.rejects(runner.runNow(id), /单次任务已执行/);
  await assert.rejects(runner.resume(id), /单次任务已经尝试/);
  await runner.stop(); await runner.initialize(); assert.equal(await runner.tick(), null); assert.equal(calls, 1);
});

test('周期任务跳过过期时间槽，每次完成后计算未来时间；支持每周及时区', async t => {
  let now = '2026-10-23T01:00:00Z';
  const { runner } = await setup(t, { clock: () => new Date(now) });
  const created = await runner.create({ ...base, schedule: { type: 'daily', time: '10:00', timezone: 'Asia/Shanghai' } });
  assert.equal(created.tasks[0].nextRunAt, '2026-10-23T02:00:00.000Z');
  now = '2026-10-26T08:00:00Z'; await runner.tick();
  const state = await runner.snapshot(); assert.equal(state.tasks[0].nextRunAt, '2026-10-27T02:00:00.000Z'); assert.equal(state.runs.length, 1);
  assert.equal(nextTaskRunAt(validateTaskSchedule({ type: 'weekly', time: '06:00', daysOfWeek: [1], timezone: 'Asia/Shanghai' }), '2026-10-23T00:00:00Z'), '2026-10-25T22:00:00.000Z');
  assert.throws(() => validateTaskSchedule({ type: 'weekly', time: '06:00', daysOfWeek: [7] }), /daysOfWeek/);
  assert.throws(() => validateTaskSchedule({ type: 'once', at: '2026-10-24T06:00:00' }), /时区/);
});

test('busy 互斥和进程 lease 拒绝并行执行者', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const { runner, directory } = await setup(t, { handlers: { collect: handler(async () => { started(); await new Promise(resolve => { release = resolve; }); return { status: 'completed', output: 'ok' }; }) } });
  const id = (await runner.create(base)).tasks[0].id;
  const pending = runner.runNow(id); await entered;
  await assert.rejects(runner.runNow(id), /忙碌/);
  assert.equal(await runner.tick(), null);
  const other = new TaskRunner(directory, { handlers: { collect: handler() } });
  await assert.rejects(other.initialize(), /存活进程/);
  release(); await pending;
});

test('死进程留下的 running 只读任务标记 interrupted，外部写任务 unknown，并暂停', async t => {
  const { runner, directory } = await setup(t);
  const created = await runner.create(base); await runner.stop();
  const path = join(directory, 'tasks', 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.tasks[0].status = 'running';
  state.tasks.push({ ...state.tasks[0], id: 'writer', kind: 'publish' });
  state.runs = [{ id: 'r1', taskId: created.tasks[0].id, status: 'running', readOnly: true }, { id: 'r2', taskId: 'writer', status: 'running', readOnly: false }];
  await writeFile(path, JSON.stringify(state)); await writeFile(join(directory, 'tasks', 'runner.lease'), JSON.stringify({ pid: 2147483647, owner: 'dead' }));
  await runner.initialize();
  const recovered = await runner.snapshot(); assert.deepEqual(recovered.runs.map(run => run.status), ['interrupted', 'unknown']);
  assert.ok(recovered.tasks.every(task => !task.enabled && !task.nextRunAt)); assert.equal(await runner.tick(), null);
});

test('缺配置、未知结果和无 output 不冒充完成，全部暂停', async t => {
  const { runner } = await setup(t);
  for (const [code, expected] of [['requires_action', 'requires_action'], ['uncertain', 'unknown'], ['cancelled', 'cancelled'], ['other', 'failed']]) {
    runner.handlers.set(code, handler(async () => { throw Object.assign(new Error('需要配置账户'), { code }); }));
    const state = await runner.create({ ...base, kind: code });
    const result = await runner.runNow(state.tasks.at(-1).id);
    assert.equal(result.status, expected); assert.match(result.error, /配置账户/);
  }
  runner.handlers.set('empty', handler(async () => ({ status: 'completed' })));
  const state = await runner.create({ ...base, kind: 'empty' }); assert.equal((await runner.runNow(state.tasks.at(-1).id)).status, 'failed');
  assert.ok((await runner.snapshot()).tasks.every(task => !task.enabled));
});

test('非只读任务不能周期排期，异常结果 unknown 不可恢复或再执行', async t => {
  const { runner } = await setup(t);
  runner.handlers.set('write', { ...handler(async () => { throw new Error('connection lost after intent'); }), readOnly: false });
  await assert.rejects(runner.create({ ...base, kind: 'write', schedule: { type: 'daily', time: '06:00' } }), /周期任务仅允许/);
  const state = await runner.create({ ...base, kind: 'write' }), id = state.tasks.at(-1).id;
  assert.equal((await runner.runNow(id)).status, 'unknown'); await assert.rejects(runner.resume(id), /只有确认/); await assert.rejects(runner.runNow(id), /禁止再次执行/);
});

test('幂等 create 不重复创建，CAS 防止用旧页面覆盖任务', async t => {
  const { runner } = await setup(t);
  const initial = await runner.snapshot();
  const state = await runner.create({ ...base, idempotencyKey: 'legacy:1' }, initial.revision);
  const repeated = await runner.create({ ...base, idempotencyKey: 'legacy:1' }); assert.equal(repeated.tasks.length, 1);
  await assert.rejects(runner.create({ ...base, input: { source: 'changed' }, idempotencyKey: 'legacy:1' }), /幂等键/);
  await assert.rejects(runner.update(state.tasks[0].id, { name: 'bad' }, initial.revision), /已更新/);
  await assert.rejects(runner.cancel(state.tasks[0].id, initial.revision), /已被其他页面/);
  await assert.rejects(runner.create({ ...base, kind: 'shell' }), /任务类型未配置/);
});

test('取消活动任务传递 abort 并保留回执，停止释放 lease', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const { runner, directory } = await setup(t, { handlers: { collect: handler(async (_, { signal }) => { entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }) } });
  const id = (await runner.create(base)).tasks[0].id;
  const running = runner.runNow(id); await started; await runner.cancel(id);
  assert.equal((await running).status, 'interrupted'); assert.equal((await runner.snapshot()).tasks[0].enabled, false);
  await runner.stop(); await assert.rejects(readFile(join(directory, 'tasks', 'runner.lease')), { code: 'ENOENT' });
});

test('暂停任务不调度，恢复周期只读任务后正常运行', async t => {
  const { runner } = await setup(t);
  const state = await runner.create({ ...base, enabled: false, schedule: { type: 'daily', time: '07:00' } }), id = state.tasks[0].id;
  assert.equal(await runner.tick(), null); const resumed = await runner.resume(id); assert.equal(resumed.tasks[0].enabled, true);
  await runner.cancel(id); assert.equal((await runner.snapshot()).tasks[0].status, 'cancelled');
});

test('enqueue 只有认领落盘才返回，后台结果可轮询，旧 revision 不会偷偷排队', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { runner, directory } = await setup(t, { handlers: { collect: handler(async () => { await gate; return { status: 'completed', output: { finished: true } }; }) } });
  const before = await runner.snapshot(), state = await runner.create(base), id = state.tasks[0].id;
  await assert.rejects(runner.enqueue(id, before.revision), /已被其他页面/);
  assert.equal((await runner.snapshot()).runs.length, 0);
  const claim = await runner.enqueue(id, state.revision); assert.equal(claim.status, 'running');
  const disk = JSON.parse(await readFile(join(directory, 'tasks', 'state.json'), 'utf8')); assert.equal(disk.runs[0].id, claim.id); assert.equal(disk.runs[0].status, 'running');
  const finished = runner.inFlight; release(); await finished;
  assert.equal((await runner.snapshot()).runs[0].status, 'completed');
});

test('取消结果未知的周期只读任务不会清除 unknown 防重试保护', async t => {
  const { runner } = await setup(t, { handlers: { collect: handler(async () => { throw Object.assign(new Error('不可确定'), { code: 'uncertain' }); }) } });
  const state = await runner.create({ ...base, schedule: { type: 'daily', time: '07:00' } }), id = state.tasks[0].id;
  await runner.runNow(id); await runner.cancel(id);
  assert.equal((await runner.snapshot()).tasks[0].status, 'unknown');
  await assert.rejects(runner.resume(id), /只有确认/); await assert.rejects(runner.runNow(id), /禁止再次执行/);
});

test('已保存周期任务的 handler 权限改变或缺失时暂停，不执行新外部写处理器', async t => {
  const { runner } = await setup(t); let called = false;
  const first = await runner.create({ ...base, schedule: { type: 'daily', time: '07:00' } }), firstId = first.tasks[0].id;
  runner.handlers.set('collect', { ...handler(async () => { called = true; return { status: 'completed', output: {} }; }), readOnly: false });
  assert.equal((await runner.runNow(firstId)).status, 'requires_action'); assert.equal(called, false);
  runner.handlers.set('collect', handler()); const second = await runner.create(base), secondId = second.tasks.at(-1).id; runner.handlers.delete('collect');
  const receipt = await runner.runNow(secondId); assert.equal(receipt.status, 'requires_action'); assert.match(receipt.error, /未配置/);
  assert.ok((await runner.snapshot()).tasks.every(task => !task.enabled));
});

test('非只读 handler 在 execute 之前校验失败记为需处理，执行后未知仍保持 unknown', async t => {
  const { runner } = await setup(t); let valid = true, calls = 0;
  runner.handlers.set('local-work', { readOnly: false, validate: input => { if (!valid) throw new Error('运行环境尚未配置'); return input; }, execute: async () => { calls++; throw new Error('lost after start'); } });
  const state = await runner.create({ ...base, kind: 'local-work' }); valid = false;
  const first = await runner.runNow(state.tasks.at(-1).id); assert.equal(first.status, 'requires_action'); assert.equal(calls, 0);
  valid = true; const second = await runner.create({ ...base, kind: 'local-work' }); assert.equal((await runner.runNow(second.tasks.at(-1).id)).status, 'unknown'); assert.equal(calls, 1);
});
