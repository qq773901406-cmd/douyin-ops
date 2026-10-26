import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AutomationService } from '../server/automation-service.mjs';
import { DailyProduction } from '../server/daily-production.mjs';
import { BilibiliWorkflow } from '../server/bilibili-workflow.mjs';
import { TaskRunner } from '../server/task-runner.mjs';
import { shortDiagnostic } from './background-service-policy.mjs';

const taskStates = new Set(['scheduled', 'paused', 'running', 'completed', 'requires_action', 'failed', 'interrupted', 'unknown', 'cancelled']);
const runStates = new Set(['running', 'completed', 'requires_action', 'failed', 'interrupted', 'unknown', 'cancelled']);
const blocked = message => Object.assign(new Error(message), { recoveryBlocked: true });

// Compatible with JsonStore's exclusive write lock, but never formats or writes
// the ledger. A missing or unrecognized existing lock is not reclaimed here.
async function readOnlyStoreLock(path) {
  const lockPath = `${path}.lock`, owner = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  let file;
  try { file = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw blocked('账本正在写入或存在未确认的写锁，暂不恢复。');
    throw error;
  }
  try { await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), owner })); await file.sync(); }
  catch (error) { await file.close(); await unlink(lockPath); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await file.close();
    let saved;
    try { saved = JSON.parse(await readFile(lockPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (saved.owner !== owner || saved.pid !== process.pid) throw blocked('恢复期间账本锁身份变化，未删除其他执行者的锁。');
    await unlink(lockPath);
  };
}

function validateTasks(state) {
  if (state?.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.runs)) throw blocked('运营任务账本格式无效，暂不恢复。');
  for (const [rows, statuses] of [[state.tasks, taskStates], [state.runs, runStates]]) {
    const ids = new Set();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || !statuses.has(row.status)) throw blocked('运营任务条目格式无效，暂不恢复。');
      ids.add(row.id);
    }
  }
  if (state.tasks.some(row => row.status === 'running') || state.runs.some(row => row.status === 'running')) throw blocked('运营任务仍在执行，等待结束后恢复。');
}

async function validateTaskLease(path) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw blocked('运营任务执行锁无法读取，暂不恢复。'); }
  if (!Number.isSafeInteger(value?.pid) || value.pid < 1 || typeof value.owner !== 'string' || !value.owner) throw blocked('运营任务执行锁身份不完整，暂不恢复。');
}

/**
 * Freeze publication claims and task/Bilibili ledger transitions while the
 * supervisor restores a process it owns. The caller must separately fence
 * BrowserSkill commands and inspect live sessions before terminating a daemon.
 * Never starts services, edits receipts, enables schedules or retries a job.
 */
export async function acquireRecoveryGuard({ dataDir, service } = {}) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || !['browser', 'workbench'].includes(service)) return { ok: false, reason: '恢复配置需要绝对数据目录和已知服务。' };
  dataDir = resolve(dataDir);
  const releases = [];
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    let problem;
    for (const cleanup of releases.reverse()) {
      try { await cleanup(); } catch (error) { problem ||= error; }
    }
    if (problem) throw problem;
  };
  try {
    const automation = new AutomationService(dataDir);
    // lease() uses queue.json's write lock to serialize runner.lock recovery.
    // Its normal JsonStore.update can create/format a ledger even when the
    // callback changes nothing; this read-only transaction preserves its bytes.
    automation.store.update = async change => {
      const unlock = await readOnlyStoreLock(automation.store.path);
      try { return await change((await automation.store.read()).value); }
      finally { await unlock(); }
    };
    releases.push(await automation.lease());

    const tasks = new TaskRunner(dataDir);
    if (service === 'workbench') {
      await validateTaskLease(tasks.leasePath);
      // This is a lifetime lease, so a living workbench retains ownership even
      // while idle. Do not take it from an unresponsive process without a
      // separate shutdown handshake; report blocked rather than force recovery.
      await tasks.acquireLease();
      releases.push(() => tasks.releaseLease());
    }
    releases.push(await readOnlyStoreLock(tasks.store.path));
    const bilibili = new BilibiliWorkflow(join(dataDir, 'bilibili-publish'));
    releases.push(await readOnlyStoreLock(bilibili.store.path));

    // Existing validators reject malformed records. Defaults only apply to
    // genuinely absent ledgers; these reads never write the defaults to disk.
    const daily = new DailyProduction(dataDir, null, automation);
    const [queue, production, operations, bili] = await Promise.all([
      automation.store.read(), daily.store.read(), tasks.store.read(), bilibili.store.read(),
    ]);
    if (queue.value.items.some(row => ['running', 'uncertain'].includes(row.status))) throw blocked('发布队列仍在执行或提交结果待核实，暂不恢复。');
    if (production.value.runs.some(row => ['selecting', 'rendering', 'publishing', 'uncertain'].includes(row.status))) throw blocked('每日生产仍在执行或提交结果待核实，暂不恢复。');
    validateTasks(operations.value);
    if (bili.value.jobs.some(row => ['submitting', 'uncertain'].includes(row.status))) throw blocked('B站有提交中或结果待核实的任务，暂不恢复。');
    return { ok: true, reason: '已取得发布互斥锁并确认账本没有活动任务。', release };
  } catch (error) {
    let reason = shortDiagnostic(error.message || error);
    try { await release(); }
    catch (cleanupError) { reason += ` ${shortDiagnostic(cleanupError.message || cleanupError)}`; }
    return { ok: false, reason };
  }
}
