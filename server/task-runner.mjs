import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';

const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const clone = value => structuredClone(value);
const livePid = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

function instant(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw fault('单次任务需要包含时区的有效 at 时间。');
  return new Date(value).toISOString();
}

export function validateTaskSchedule(value = {}) {
  if (!['once', 'daily', 'weekly'].includes(value.type)) throw fault('任务排期必须为 once、daily 或 weekly。');
  if (value.type === 'once') return { type: 'once', at: instant(value.at) };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time || '')) throw fault('周期任务需要有效的 HH:mm 时间。');
  const timezone = value.timezone || 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw fault('排期时区无效。'); }
  const schedule = { type: value.type, time: value.time, timezone };
  if (value.startAt !== undefined) schedule.startAt = instant(value.startAt);
  if (value.type === 'weekly') {
    if (!Array.isArray(value.daysOfWeek) || !value.daysOfWeek.length || value.daysOfWeek.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw fault('每周任务需要 daysOfWeek，0 为周日、6 为周六。');
    schedule.daysOfWeek = [...new Set(value.daysOfWeek)].sort();
  }
  return schedule;
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

// Resolve wall-clock times through Intl. Nonexistent DST times are skipped;
// ambiguous times produce only one slot because the next search is strict.
export function nextTaskRunAt(schedule, after) {
  let now = new Date(after).getTime();
  if (!Number.isFinite(now)) throw fault('当前时间无效。');
  if (schedule.type === 'once') return schedule.at;
  if (schedule.startAt) now = Math.max(now, Date.parse(schedule.startAt) - 1);
  const local = zonedParts(new Date(now), schedule.timezone);
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset < 15; offset++) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    if (schedule.type === 'weekly' && !schedule.daysOfWeek.includes(day.getUTCDay())) continue;
    const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
    let candidate = wall;
    for (let attempt = 0; attempt < 4; attempt++) {
      const parts = zonedParts(new Date(candidate), schedule.timezone);
      const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      if (rendered === wall) break;
      candidate += wall - rendered;
    }
    const parts = zonedParts(new Date(candidate), schedule.timezone);
    if (parts.year === day.getUTCFullYear() && parts.month === day.getUTCMonth() + 1 && parts.day === day.getUTCDate() && parts.hour === hour && parts.minute === minute && candidate > now) return new Date(candidate).toISOString();
  }
  throw fault('无法计算下次执行时间。');
}

function stateShape(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.runs)) throw fault('任务账本格式无效，原文件保持不变。', 500);
  return state;
}

export class TaskRunner {
  constructor(runtimeDir, { handlers = {}, clock = () => new Date(), pollIntervalMs = 15000, pidAlive = livePid } = {}) {
    this.directory = join(resolve(runtimeDir), 'tasks');
    this.store = new JsonStore(join(this.directory, 'state.json'), { version: 1, tasks: [], runs: [], updatedAt: '' }, stateShape);
    this.leasePath = join(this.directory, 'runner.lease');
    this.handlers = new Map(Object.entries(handlers));
    this.clock = clock; this.pollIntervalMs = pollIntervalMs; this.pidAlive = pidAlive;
    this.owner = randomUUID(); this.timer = null; this.busy = false; this.initialized = false; this.stopping = false; this.lastError = ''; this.active = null;
  }
  now() { return new Date(typeof this.clock === 'function' ? this.clock() : this.clock.now()).toISOString(); }
  handler(kind) {
    const handler = this.handlers.get(kind);
    if (!handler || typeof handler.execute !== 'function' || typeof handler.validate !== 'function') throw fault(`任务类型未配置或不可执行：${kind}`);
    return handler;
  }
  async validate(input) {
    const kind = String(input.kind || '');
    const handler = this.handler(kind);
    if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw fault('任务 input 必须为对象。');
    let value;
    try { value = JSON.parse(JSON.stringify(input.input)); } catch { throw fault('任务 input 必须能保存为 JSON。'); }
    if (JSON.stringify(value).length > 262144) throw fault('任务输入过大。');
    const checked = await handler.validate(clone(value));
    if (checked === false) throw fault('任务参数未通过校验。');
    if (checked && typeof checked === 'object') value = checked;
    if (Array.isArray(value) || JSON.stringify(value).length > 262144) throw fault('校验后的任务输入无效或过大。');
    const schedule = validateTaskSchedule(input.schedule);
    if (schedule.type !== 'once' && handler.readOnly !== true) throw fault('周期任务仅允许没有外部写入副作用的处理器。');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw fault('enabled 必须为布尔值。');
    const name = String(input.name || kind).trim().slice(0, 160);
    if (!name) throw fault('任务名称不能为空。');
    return { name, kind, input: value, schedule, enabled: input.enabled === true, readOnly: handler.readOnly === true };
  }
  async acquireLease() {
    await mkdir(this.directory, { recursive: true });
    const recoveryPath = `${this.leasePath}.recovery`;
    let gate;
    try { gate = await open(recoveryPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw fault('另一进程正在取得任务执行权；若持续出现，请检查任务 lease。', 409); throw error; }
    try {
      let previous;
      try { previous = JSON.parse(await readFile(this.leasePath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw fault('任务 lease 无法读取；请保留证据并检查，未接管执行。', 409); }
      if (previous) {
        if (!Number.isInteger(previous.pid) || this.pidAlive(previous.pid)) throw fault('任务执行器已由存活进程持有，未启动第二个实例。', 409);
        await unlink(this.leasePath);
      }
      const file = await open(this.leasePath, 'wx');
      try { await file.writeFile(JSON.stringify({ pid: process.pid, owner: this.owner, acquiredAt: this.now() })); await file.sync(); }
      finally { await file.close(); }
      // JsonStore write locks belong to this runner's process lease. Reclaim
      // only a positively dead writer, never an opaque or living lock.
      try {
        const lock = JSON.parse(await readFile(`${this.store.path}.lock`, 'utf8'));
        if (!Number.isInteger(lock.pid) || this.pidAlive(lock.pid)) throw fault('任务账本仍被其他进程锁定。', 409);
        await unlink(`${this.store.path}.lock`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } catch (error) { await this.releaseLease(); throw error; }
    finally { await gate.close(); await unlink(recoveryPath); }
  }
  async releaseLease() {
    try { const lease = JSON.parse(await readFile(this.leasePath, 'utf8')); if (lease.owner === this.owner) await unlink(this.leasePath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async assertLease() {
    if (!this.initialized) await this.initialize();
    const lease = JSON.parse(await readFile(this.leasePath, 'utf8'));
    if (lease.owner !== this.owner || lease.pid !== process.pid) throw fault('任务执行权已变化，停止执行。', 409);
  }
  async initialize() {
    if (this.initialized) return this.snapshot();
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      await this.acquireLease();
      try {
        await this.store.update(state => {
          for (const run of state.runs.filter(item => item.status === 'running')) {
            run.status = run.readOnly ? 'interrupted' : 'unknown'; run.finishedAt = this.now();
            run.error = '执行进程中断，原执行结果未确认；未自动重试。';
            const task = state.tasks.find(item => item.id === run.taskId);
            if (task) { task.status = run.status; task.enabled = false; task.nextRunAt = ''; task.updatedAt = this.now(); }
          }
          state.updatedAt = this.now();
        });
        this.initialized = true; this.stopping = false;
        return this.snapshot();
      } catch (error) { await this.releaseLease(); throw error; }
    })();
    try { return await this.initializing; } finally { this.initializing = null; }
  }
  async snapshot() {
    const state = await this.store.read();
    return { ...state.value, revision: state.revision, kinds: [...this.handlers].map(([kind, handler]) => ({ kind, readOnly: handler.readOnly === true })), scheduler: { running: !!this.timer, busy: this.busy, error: this.lastError, checkSeconds: this.pollIntervalMs / 1000 } };
  }
  async create(input, revision) {
    await this.assertLease();
    const spec = await this.validate(input), now = this.now();
    await this.store.update(state => {
      const idempotencyKey = String(input.idempotencyKey || '').slice(0, 200);
      const prior = idempotencyKey && state.tasks.find(task => task.idempotencyKey === idempotencyKey);
      if (prior) {
        if (prior.kind !== spec.kind || JSON.stringify(prior.input) !== JSON.stringify(spec.input) || JSON.stringify(prior.schedule) !== JSON.stringify(spec.schedule)) throw fault('幂等键已用于不同的任务参数。', 409);
        return;
      }
      if (state.tasks.length >= 500) throw fault('任务数量已达到 500 个。');
      state.tasks.push({ id: randomUUID(), ...spec, idempotencyKey, status: spec.enabled ? 'scheduled' : 'paused', nextRunAt: spec.enabled ? (spec.schedule.startAt || nextTaskRunAt(spec.schedule, now)) : '', createdAt: now, updatedAt: now, lastRunId: '' }); state.updatedAt = now;
    }, revision);
    return this.snapshot();
  }
  async update(id, patch, revision) {
    await this.assertLease();
    const current = await this.store.read(), task = current.value.tasks.find(item => item.id === id);
    if (revision !== undefined && revision !== current.revision) throw fault('任务已更新，请刷新后重试。', 409);
    if (!task) throw fault('任务不存在。', 404);
    if (task.status === 'running') throw fault('执行中的任务不能修改，请先取消并等待结束。', 409);
    if (['unknown', 'interrupted'].includes(task.status)) throw fault('中断或结果未知的任务不能修改；请保留原记录并新建任务。', 409);
    if (current.value.runs.some(run => run.taskId === id) && task.schedule.type === 'once') throw fault('单次任务已经尝试执行，请保留原记录并新建任务。', 409);
    if (patch.kind !== undefined && patch.kind !== task.kind) throw fault('已保存任务不能更换处理器。');
    const spec = await this.validate({ ...task, ...patch, kind: task.kind });
    await this.store.update(state => {
      const target = state.tasks.find(item => item.id === id);
      Object.assign(target, spec, { status: spec.enabled ? 'scheduled' : 'paused', nextRunAt: spec.enabled ? nextTaskRunAt(spec.schedule, this.now()) : '', updatedAt: this.now() }); state.updatedAt = this.now();
    }, current.revision);
    return this.snapshot();
  }
  async cancel(id, revision) {
    await this.assertLease();
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === id); if (!task) throw fault('任务不存在。', 404);
      task.enabled = false; task.nextRunAt = ''; task.cancelRequestedAt = this.now(); task.updatedAt = this.now();
      if (['scheduled', 'paused'].includes(task.status)) task.status = 'cancelled'; state.updatedAt = this.now();
    }, revision);
    if (this.active?.taskId === id) this.active.controller.abort(new Error('用户取消任务。'));
    return this.snapshot();
  }
  async resume(id, revision) {
    const state = await this.snapshot(), task = state.tasks.find(item => item.id === id);
    if (revision !== undefined && revision !== state.revision) throw fault('任务已更新，请刷新后重试。', 409);
    if (!task) throw fault('任务不存在。', 404);
    if (this.handler(task.kind).readOnly !== true || task.status === 'unknown') throw fault('只有确认没有外部写入的任务可以恢复。', 409);
    if (task.schedule.type === 'once' && state.runs.some(run => run.taskId === id)) throw fault('单次任务已经尝试执行，请新建任务，避免隐式重试。', 409);
    let currentRevision = state.revision;
    if (task.status === 'interrupted') {
      await this.assertLease();
      const changed = await this.store.update(value => { const target = value.tasks.find(item => item.id === id); target.status = 'paused'; target.updatedAt = this.now(); }, currentRevision);
      currentRevision = changed.revision;
    }
    return this.update(id, { enabled: true }, currentRevision);
  }
  async runNow(id) { return this.execute(id, 'manual'); }
  async enqueue(id, revision) { return this.execute(id, 'manual', { wait: false, revision }); }
  async execute(id, trigger, { wait = true, revision } = {}) {
    await this.assertLease();
    if (this.busy || this.stopping) throw fault('任务执行器忙碌或正在停止。', 409);
    this.busy = true;
    const controller = new AbortController(), runId = randomUUID();
    this.active = { taskId: id, controller, runId };
    let task, receipt;
    let claimSucceeded, claimFailed;
    const claimed = new Promise((resolve, reject) => { claimSucceeded = resolve; claimFailed = reject; });
    // runNow waits on the final result; enqueue waits on the durable claim.
    // Install a rejection observer for the unused side of either mode.
    claimed.catch(() => {});
    const work = (async () => {
      await this.store.update(state => {
        task = state.tasks.find(item => item.id === id); if (!task) throw fault('任务不存在。', 404);
        if (trigger === 'scheduler' && (!task.enabled || !task.nextRunAt || Date.parse(task.nextRunAt) > Date.parse(this.now()))) throw fault('任务尚未到期或已暂停。', 409);
        if (['running', 'unknown', 'interrupted', 'cancelled'].includes(task.status)) throw fault('当前任务状态禁止再次执行。', 409);
        if (task.schedule.type === 'once' && state.runs.some(run => run.taskId === id)) throw fault('单次任务已执行过，禁止重复提交。', 409);
        const handler = this.handler(task.kind);
        // Durable intent precedes execute. A crash after this point is never
        // interpreted as success and never causes an automatic repeat.
        receipt = { id: runId, taskId: id, kind: task.kind, trigger, readOnly: handler.readOnly === true, status: 'running', intentAt: this.now(), startedAt: this.now(), scheduledFor: task.nextRunAt || '', input: clone(task.input), output: null, error: '', progress: null };
        state.runs.push(receipt); task.status = 'running'; task.lastRunId = runId; task.updatedAt = this.now(); state.updatedAt = this.now(); task = clone(task);
      }, revision);
      claimSucceeded(clone(receipt));
      let result, status, problem = '';
      try {
        const handler = this.handler(task.kind);
        if (this.stopping || controller.signal.aborted) throw Object.assign(new Error('任务已取消或执行器正在停止。'), { code: 'cancelled' });
        if (await handler.validate(clone(task.input)) === false) throw new Error('任务参数未通过校验。');
        result = await handler.execute(clone(task.input), { task, runId, signal: controller.signal, reportProgress: async progress => {
          await this.store.update(state => { const run = state.runs.find(item => item.id === runId); if (run?.status === 'running') { run.progress = clone(progress); state.updatedAt = this.now(); } });
        } });
        if (!result || typeof result !== 'object' || !['completed', 'requires_action', 'failed'].includes(result.status)) throw new Error('处理器未返回真实的完成状态和结果。');
        if (result.status === 'completed' && !Object.hasOwn(result, 'output')) throw new Error('处理器未返回可核对的 output。');
        status = result.status; problem = String(result.error || result.message || '');
      } catch (error) {
        if (error?.code === 'requires_action' || error?.actionable === true) status = 'requires_action';
        else if (['uncertain', 'unknown'].includes(error?.code)) status = 'unknown';
        else if (error?.code === 'cancelled') status = receipt.readOnly ? 'cancelled' : 'unknown';
        else status = receipt.readOnly ? (controller.signal.aborted ? 'interrupted' : 'failed') : 'unknown';
        problem = String(error?.message || error);
      }
      await this.store.update(state => {
        const target = state.tasks.find(item => item.id === id), run = state.runs.find(item => item.id === runId);
        Object.assign(run, { status, finishedAt: this.now(), output: result?.output ?? null, error: problem, requiresAction: result?.requiresAction ?? (status === 'requires_action' ? problem : null) });
        const repeat = status === 'completed' && target.enabled && !controller.signal.aborted && target.schedule.type !== 'once' && this.handler(target.kind).readOnly === true;
        Object.assign(target, { status: repeat ? 'scheduled' : status, enabled: repeat, nextRunAt: repeat ? nextTaskRunAt(target.schedule, this.now()) : '', updatedAt: this.now() }); state.updatedAt = this.now(); receipt = clone(run);
      });
      return receipt;
    })();
    this.inFlight = work.catch(error => { claimFailed(error); throw error; }).finally(() => { this.inFlight = null; this.active = null; this.busy = false; });
    if (!wait) { this.inFlight.catch(error => { this.lastError = String(error.message || error); }); return claimed; }
    return this.inFlight;
  }
  async tick() {
    if (this.busy || this.stopping) return null;
    await this.assertLease();
    const state = await this.snapshot();
    const due = state.tasks.filter(task => task.enabled && task.status === 'scheduled' && task.nextRunAt && Date.parse(task.nextRunAt) <= Date.parse(this.now())).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0];
    if (!due) return null;
    try { const result = await this.execute(due.id, 'scheduler'); this.lastError = ''; return result; }
    catch (error) { this.lastError = String(error.message || error); throw error; }
  }
  async start() {
    await this.initialize();
    if (!this.timer) { this.stopping = false; this.timer = setInterval(() => this.tick().catch(error => { this.lastError = String(error.message || error); }), this.pollIntervalMs); this.timer.unref?.(); }
    return this.snapshot();
  }
  async stop() {
    this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null;
    this.active?.controller.abort(new Error('任务执行器停止。'));
    if (this.inFlight) await this.inFlight.catch(() => {});
    if (this.initialized) await this.releaseLease(); this.initialized = false;
  }
}
