import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const option = (args, name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const fail = (reason, message = '浏览器协作状态已变化，请重新核对页面；未重放操作。') => Object.assign(new Error(message), { code: reason, reason, requiresReconcile: true });
const same = (a, b) => String(a) === String(b);
export const isControlledBskAction = args => ['navigate', 'evaluate', 'click', 'fill', 'press', 'upload', 'download', 'hover', 'select', 'drag', 'scroll-to', 'wheel'].includes(args[0]);

// BrowserSkill 0.4 contexts are single-use. Only explicit read-only inspectors
// may be repeated; mutations never receive a refreshed context and a replay.
export class BskCooperation {
  constructor(invoke, { tempRoot = tmpdir(), readAttempts = 3 } = {}) {
    this.invoke = invoke;
    this.tempRoot = path.resolve(tempRoot);
    this.readAttempts = readAttempts;
    this.sessions = new Map();
  }
  async open(session) {
    if (this.sessions.has(session)) throw fail('cooperation_session_conflict');
    const directory = await mkdtemp(path.join(this.tempRoot, 'doufeng-bsk-'));
    this.sessions.set(session, { session, directory, serial: 0, initial: true, busy: false, baseline: null, permit: null, tabs: new Map(), usedContexts: new Set() });
  }
  async close(session) {
    const state = this.sessions.get(session);
    this.sessions.delete(session);
    if (!state) return;
    // Delete only the mkdtemp directory owned by this session, never a caller path.
    const resolved = path.resolve(state.directory);
    if (path.dirname(resolved) !== this.tempRoot || !path.basename(resolved).startsWith('doufeng-bsk-')) throw fail('cooperation_cleanup_invalid');
    await rm(resolved, { recursive: true, force: true });
  }
  async exclusive(session, action) {
    const state = this.sessions.get(session);
    if (!state) throw fail('cooperation_session_missing');
    if (state.halted) throw fail(state.halted);
    if (state.busy) throw fail('cooperation_session_busy');
    state.busy = true;
    try { return await action(state); }
    finally { state.busy = false; }
  }
  checkReady(state, result) {
    if (result?.stopped || result?.state?.mode === 'user_aborted' || result?.reason === 'user_aborted') {
      state.halted = 'user_aborted'; throw fail('user_aborted', '用户已停止浏览器任务，本轮不会自动恢复。');
    }
    if (result?.ready === false || result?.state?.mode !== 'ready' || result?.state?.editing === true) {
      state.halted = 'cooperation_not_ready'; throw fail('cooperation_not_ready', '浏览器当前由用户操作或暂停，本轮已停止自动输入。');
    }
    if (!Array.isArray(result.activity) || result.activity.length) {
      state.halted = 'cooperation_human_activity'; throw fail('cooperation_human_activity', '检测到人工页面操作，需要重新核对当前业务状态。');
    }
    if (typeof result.context_id !== 'string' || !result.context_id || state.usedContexts.has(result.context_id) || !Number.isSafeInteger(result.tab_id)) throw fail('cooperation_invalid_context');
  }
  async sync(state, tabId, budgetMs = 20000, waitForPerson = true) {
    const deadline = Date.now() + Math.max(1, budgetMs);
    const remaining = () => {
      const value = deadline - Date.now();
      if (value <= 0) throw fail('cooperation_deadline');
      return value;
    };
    state.permit = null;
    const previous = state.baseline;
    const file = path.join(state.directory, `${++state.serial}.json`);
    const baseline = previous && (tabId === undefined || same(previous.tab, tabId)) ? previous : null;
    const args = ['cooperate', 'sync', '--settle', '--session', state.session, '--timeout-ms', String(Math.min(5000, Math.max(1, remaining() - 500))), '--save-full', file];
    if (baseline) args.push('--baseline', baseline.file);
    if (tabId !== undefined) args.push('--tab-id', String(tabId));
    let result;
    try { result = await this.invoke(args, remaining()); }
    catch (error) { state.halted = error.reason || error.code || 'cooperation_sync_failed'; throw error; }
    const aborted = result?.stopped || result?.state?.mode === 'user_aborted' || result?.reason === 'user_aborted';
    const held = result?.ready === false || result?.state?.editing === true || ['manual_hold', 'human_active', 'held', 'yielding'].includes(result?.state?.mode);
    if (!aborted && held && waitForPerson) {
      // Wait only; never resume an old selector or submission after a person
      // intervenes. A fresh sync is collected before returning for reconciliation.
      for (let attempt = 0; attempt < 2 && remaining() > 500; attempt++) {
        let waited;
        try { waited = await this.invoke(['cooperate', 'wait', '--session', state.session, '--timeout-ms', String(Math.min(5000, Math.max(1, remaining() - 500)))], remaining()); }
        catch (error) { state.halted = error.reason || error.code || 'cooperation_wait_failed'; throw error; }
        if (waited?.stopped || waited?.reason === 'user_aborted' || waited?.state?.mode === 'user_aborted') {
          state.halted = 'user_aborted'; throw fail('user_aborted', '用户已停止浏览器任务，本轮不会自动恢复。');
        }
        if (waited?.ready === true) { await this.sync(state, tabId, remaining(), false); break; }
        if (waited?.ready !== false) break;
      }
      state.halted = 'cooperation_requires_reconcile';
      throw fail('cooperation_requires_reconcile', '已停止自动输入并等待人工操作；需要重新核对业务状态后继续。');
    }
    this.checkReady(state, result);
    if (tabId !== undefined && !same(tabId, result.tab_id)) { state.halted = 'cooperation_tab_changed'; throw fail('cooperation_tab_changed'); }
    // CLI invocations do not share an in-memory baseline. The exact full file
    // is required on the next sync; stdout alone may be an abbreviated delta.
    let saved;
    try { saved = JSON.parse(await readFile(file, 'utf8')); } catch { throw fail('cooperation_baseline_missing'); }
    if (saved.context_id !== result.context_id || !same(saved.tab_id, result.tab_id)
      || saved.observation_origin?.session_id && saved.observation_origin.session_id !== state.session) throw fail('cooperation_baseline_invalid');
    state.baseline = { file, id: result.context_id, tab: result.tab_id };
    return result;
  }
  unchanged(before, after) {
    return after.kind === 'unchanged' && after.context_id !== before.context_id && after.previous_context_id === before.context_id
      && same(after.tab_id, before.tab_id) && after.history_complete === true
      && Array.isArray(after.changes) && after.changes.length === 0
      && Array.isArray(after.activity) && after.activity.length === 0;
  }
  async inspectInside(state, args, timeout, attempts) {
    const deadline = Date.now() + timeout;
    const remaining = () => {
      const value = deadline - Date.now();
      if (value <= 0) throw fail('cooperation_deadline');
      return value;
    };
    let tabId;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const before = await this.sync(state, tabId, remaining());
      tabId = before.tab_id;
      state.initial = false;
      state.usedContexts.add(before.context_id);
      let result;
      const command = [...args];
      const timeoutIndex = command.indexOf('--timeout');
      const cliBudget = `${Math.min(10000, Math.max(1, remaining() - 500))}ms`;
      if (timeoutIndex < 0) command.push('--timeout', cliBudget); else command[timeoutIndex + 1] = cliBudget;
      try { result = await this.invoke([...command, '--context', before.context_id, '--tab-id', String(before.tab_id)], remaining()); }
      catch (error) {
        const rejectedRead = error.code === 'permission_denied' && error.reason === 'cooperation_sync_required' && error.effectState === 'none';
        if (attempts > 1 && attempt + 1 < attempts && rejectedRead) {
          // This fixed DOM reader was refused before dispatch. Wait, discard
          // the old observation, then synchronize and recompute the whole read.
          // Arbitrary scripts and every mutation are excluded from this path.
          let waited;
          try { waited = await this.invoke(['cooperate', 'wait', '--session', state.session, '--tab-id', String(tabId), '--timeout-ms', String(Math.min(5000, Math.max(1, remaining() - 500)))], remaining()); }
          catch (waitError) { state.halted = waitError.reason || waitError.code || 'cooperation_wait_failed'; throw waitError; }
          if (waited?.stopped || waited?.reason === 'user_aborted' || waited?.state?.mode === 'user_aborted') {
            state.halted = 'user_aborted'; throw fail('user_aborted');
          }
          if (waited?.ready !== true || waited?.state?.editing === true || (Array.isArray(waited?.activity) && waited.activity.length)) {
            state.halted = 'cooperation_requires_reconcile'; throw fail('cooperation_requires_reconcile');
          }
          remaining();
          continue;
        }
        state.halted = error.reason || error.code || 'cooperation_inspection_failed';
        throw error;
      }
      const after = await this.sync(state, tabId, remaining());
      remaining();
      if (this.unchanged(before, after)) {
        state.permit = { id: after.context_id, tab: after.tab_id };
        return result;
      }
      // Discard the old DOM value and selectors. Only the fixed DOM inspector
      // is rerun, and the caller receives solely the newly inspected value.
    }
    throw fail('cooperation_page_changed');
  }
  async inspect(args, timeout, { readOnly = false } = {}) {
    if (args[0] !== 'evaluate' || args.includes('--context') || args.includes('--tab-id')) throw fail('cooperation_invalid_inspection');
    return this.exclusive(option(args, '--session'), state => this.inspectInside(state, args, timeout, readOnly ? this.readAttempts : 1));
  }
  async action(args, timeout, allowedLocation) {
    if (args.includes('--context') || args.includes('--tab-id')) throw fail('cooperation_external_context');
    return this.exclusive(option(args, '--session'), async state => {
      if (args[0] === 'navigate' && !state.initial) {
        const inspected = await this.inspectInside(state, ['evaluate', '({url:location.href})', '--session', state.session, '--timeout', '10s'], 20000, this.readAttempts);
        if (!allowedLocation(inspected.value?.url)) { state.permit = null; throw fail('cooperation_location_changed'); }
      }
      // Official 0.4 exception: only the untouched initial task tab permits
      // context-free navigation; CLI rejects it if a person already took over.
      const firstNavigation = args[0] === 'navigate' && state.initial;
      const permit = state.permit;
      state.initial = false;
      state.permit = null; // Consume before dispatch, including failed/unknown outcomes.
      if (!firstNavigation && !permit) throw fail('cooperation_fresh_inspection_required');
      if (permit) state.usedContexts.add(permit.id);
      let result;
      try {
        result = await this.invoke(firstNavigation ? args : [...args, '--context', permit.id, '--tab-id', String(permit.tab)], timeout);
      } catch (error) {
        if (error.code !== 'fill_value_mismatch') state.halted = error.reason || error.code || 'cooperation_action_failed';
        throw error;
      }
      await this.sync(state);
      // A post-action context is not a business decision. The next mutation
      // needs another DOM inspection, even when the last action succeeded.
      return result;
    });
  }
  rememberTabs(state, result) {
    state.tabs = new Map((Array.isArray(result?.tabs) ? result.tabs : []).filter(tab => tab.scope === 'agent').map(tab => [String(tab.tab_id), { ...tab }]));
    return result;
  }
  async tabs(args, timeout) {
    return this.exclusive(option(args, '--session'), async state => {
      if (args[1] === 'list') return this.rememberTabs(state, await this.invoke(args, timeout));
      if (!['select', 'close'].includes(args[1]) || args.includes('--context')) throw fail('cooperation_unsupported_tab_action');
      const target = state.tabs.get(String(args[2]));
      if (!target) throw fail('cooperation_unobserved_tab');
      await this.sync(state, target.tab_id);
      const live = await this.invoke(['tab', 'list', '--session', state.session, '--scope', 'agent'], timeout);
      const matches = (live?.tabs || []).filter(tab => tab.scope === 'agent' && same(tab.tab_id, target.tab_id) && tab.url === target.url);
      if (matches.length !== 1) throw fail('cooperation_tab_changed');
      // 0.4 tab select/close do not accept --context. Their exact observed tab
      // is rechecked above; never append unsupported flags or target user tabs.
      state.permit = null;
      let result;
      try { result = await this.invoke(args, timeout); }
      catch (error) { state.halted = error.reason || error.code || 'cooperation_action_failed'; throw error; }
      state.baseline = null;
      const after = this.rememberTabs(state, await this.invoke(['tab', 'list', '--session', state.session, '--scope', 'agent'], timeout));
      const next = args[1] === 'select' ? target : (after.tabs || []).find(tab => tab.scope === 'agent' && tab.active);
      if (next) await this.sync(state, next.tab_id);
      return result;
    });
  }
}
