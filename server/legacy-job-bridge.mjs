const error = message => Object.assign(new Error(message), { status: 400, code: 'requires_action' });
const prefix = 'legacy-job:';
const specKey = job => JSON.stringify([job.url, job.extractor, job.repeat, job.nextRunAt, job.enabled]);
const definition = job => JSON.stringify([job.url, job.extractor, job.repeat]);

export function legacyJobSpec(job, binding = {}) {
  let url;
  try { url = new URL(String(job.url || '')); } catch { throw error('旧回采任务缺少有效的抖音 HTTPS 地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['www.douyin.com', 'douyin.com', 'creator.douyin.com'].includes(url.hostname)) throw error('旧回采任务只允许明确的抖音 HTTPS 页面。');
  if (!['currentVideo', 'creatorMetrics', 'account'].includes(job.extractor)) throw error('旧回采任务的 extractor 无效。');
  if (!['once', 'daily', 'weekly'].includes(job.repeat)) throw error('旧回采任务的 repeat 无效。');
  const at = new Date(job.nextRunAt);
  if (!Number.isFinite(at.getTime())) throw error('旧回采任务没有有效的首次执行时间。');
  const beijing = new Date(at.getTime() + 8 * 3600000), time = beijing.toISOString().slice(11, 16);
  const schedule = job.repeat === 'once' ? { type: 'once', at: at.toISOString() } : { type: job.repeat, time, timezone: 'Asia/Shanghai', startAt: at.toISOString(), ...(job.repeat === 'weekly' ? { daysOfWeek: [beijing.getUTCDay()] } : {}) };
  const input = { url: url.href, extractor: job.extractor };
  for (const key of ['browserId', 'accountId']) if (typeof binding?.[key] === 'string' && binding[key]) input[key] = binding[key];
  return { name: String(job.label || '效果回采'), kind: 'content.capture', input, schedule, enabled: job.enabled === true, idempotencyKey: `${prefix}${job.id}` };
}

/** Bridge old saved plans into the same durable runner. The idempotency key is
 * the primary mapping, so a crash before jobs.taskId is saved cannot duplicate
 * a task. Deletion cancels scheduling but preserves task/run evidence.
 */
export class LegacyJobBridge {
  constructor({ jobsStore, runner, getBinding = async () => ({}), pollIntervalMs = 3000 } = {}) {
    if (!jobsStore?.read || !jobsStore?.update || !runner?.snapshot || !runner?.create) throw new Error('旧任务桥接需要 jobsStore 和 TaskRunner。');
    this.jobsStore = jobsStore; this.runner = runner; this.getBinding = getBinding; this.pollIntervalMs = pollIntervalMs;
    this.timer = null; this.syncing = null; this.lastError = ''; this.stopping = false;
  }
  async sync() {
    // A caller after POST/DELETE needs a pass that observes its own write,
    // rather than merely waiting for an older pass with a stale jobs snapshot.
    if (this.syncing) { await this.syncing; return this.sync(); }
    this.syncing = this.performSync();
    try { return await this.syncing; } finally { this.syncing = null; }
  }
  async performSync() {
    const jobs = (await this.jobsStore.read()).value;
    if (!Array.isArray(jobs)) throw error('旧回采任务账本不是数组，未修改原记录。');
    let state = await this.runner.snapshot();
    const activeIds = new Set(jobs.map(job => String(job.id))), patches = new Map();
    for (const task of state.tasks.filter(task => task.idempotencyKey?.startsWith(prefix))) {
      if (!activeIds.has(task.idempotencyKey.slice(prefix.length)) && (task.enabled || task.status === 'running')) await this.runner.cancel(task.id);
    }
    for (const job of jobs) {
      const key = `${prefix}${job.id}`;
      let task = state.tasks.find(item => item.idempotencyKey === key);
      try {
        if (!job.id || typeof job.id !== 'string') throw error('旧回采任务缺少有效编号。');
        if (!task && job.enabled === true) {
          const spec = legacyJobSpec(job, await this.getBinding());
          state = await this.runner.create(spec);
          task = state.tasks.find(item => item.idempotencyKey === key);
        }
        if (!task) { patches.set(job.id, { runner: 'local', taskId: job.taskId || '', enabled: false }); continue; }
        if (job.enabled !== true && (task.enabled || task.status === 'running')) {
          state = await this.runner.cancel(task.id); task = state.tasks.find(item => item.id === task.id);
        }
        const expectedDefinition = JSON.stringify([task.input.url, task.input.extractor, task.schedule.type]);
        if (definition(job) !== expectedDefinition) {
          if (task.enabled || task.status === 'running') await this.runner.cancel(task.id);
          throw error('旧任务来源或频率已变更；原任务已暂停，请新建任务以保留原执行记录。');
        }
        // Read again because completion can race the bridge's earlier snapshot.
        state = await this.runner.snapshot(); task = state.tasks.find(item => item.id === task.id);
        const run = state.runs.find(item => item.id === task.lastRunId);
        const patch = { runner: 'local', taskId: task.id, nextRunAt: task.nextRunAt || '', enabled: task.enabled === true, status: task.status };
        if (run && run.status !== 'running') patch.lastResult = { runId: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt || '', output: run.output, error: run.error || '', requiresAction: run.requiresAction || null };
        patches.set(job.id, patch);
      } catch (problem) {
        patches.set(job.id, { runner: 'local', ...(task ? { taskId: task.id } : {}), enabled: false, status: 'requires_action', lastResult: { status: 'requires_action', error: String(problem.message || problem), output: null } });
      }
    }
    const originals = new Map(jobs.map(job => [job.id, specKey(job)]));
    const saved = await this.jobsStore.update(current => {
      for (const job of current) {
        const patch = patches.get(job.id);
        if (!patch || specKey(job) !== originals.get(job.id)) continue;
        Object.assign(job, patch);
      }
    });
    this.lastError = '';
    return { jobs: saved.value, scheduler: { running: !!this.timer, error: this.lastError } };
  }
  async start() {
    this.stopping = false; await this.sync();
    if (!this.timer && !this.stopping) { this.timer = setInterval(() => this.sync().catch(error => { this.lastError = String(error.message || error); }), this.pollIntervalMs); this.timer.unref?.(); }
    return { running: !!this.timer, error: this.lastError };
  }
  async stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; if (this.syncing) await this.syncing; }
}
