import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { JsonStore } from '../../workbuddy/connector/lib/json-store.mjs';
import { authorizeMessage, selectMessage, REPOSITORY } from './policy.mjs';
import { defaultSettings, validateSettings, settingsVersion, fault, safeText } from './workflow-settings.mjs';

export const STATES = ['observed', 'queued', 'working', 'waiting_answer', 'awaiting_review', 'completed', 'failed', 'blocked', 'cancelled'];
const hash = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const now = () => new Date().toISOString();
const find = (state, id) => { const ticket = state.tickets.find(t => t.id === id); if (!ticket) throw fault('任务不存在。', 404); return ticket; };
const bounded = (list, max, name) => { if (list.length >= max) throw fault(`${name}容量已满，历史记录保留，请先归档。`, 507); };
const revisionRequired = revision => { if (typeof revision !== 'string' || !revision) throw fault('请刷新后重试。', 428); };
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/.test(value);
export function safePR(url) { try { const parsed = new URL(url); return parsed.origin === 'https://github.com' && new RegExp(`^/${REPOSITORY}/pull/[1-9][0-9]*$`).test(parsed.pathname) && !parsed.search && !parsed.hash && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; } }

function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.tickets) || !Array.isArray(state.events) || !Array.isArray(state.outbox) || !Array.isArray(state.decisions) || !Array.isArray(state.settingsHistory)) throw fault('开发代理状态损坏，原文件已保留。', 500);
  validateSettings(state.settings);
  const ids = new Set(), events = new Set();
  for (const t of state.tickets) {
    if (!validId(t.id) || ids.has(t.id) || !STATES.includes(t.status) || t.repository !== REPOSITORY || !Array.isArray(t.inputs) || !t.inputs.length || !Array.isArray(t.reports) || !t.mandate || t.mandate.allowed.merge !== false || (t.prUrl && !safePR(t.prUrl))) throw fault('任务记录损坏。', 500);
    ids.add(t.id);
  }
  for (const event of state.events) { if (!event.key || events.has(event.key)) throw fault('事件去重记录损坏。', 500); events.add(event.key); }
  return state;
}
function audit(state, ticket, type, detail = '') { bounded(ticket.history, 1000, '任务历史'); ticket.updatedAt = now(); ticket.history.push({ at: ticket.updatedAt, type, detail }); }
function receipt(state, ticket, text, kind) {
  bounded(state.outbox, 10000, '投递记录');
  state.outbox.push({ id: randomUUID(), ticketId: ticket.id, source: ticket.source, conversationId: ticket.conversationId, text: safeText(text), kind, status: ticket.source === 'local' || ticket.source === 'github' && !ticket.mandate?.allowed.push ? 'preview' : 'pending', attempts: 0, createdAt: now(), nextAt: now() });
}
function grant(ticket, settings, execute = false) {
  return { id: randomUUID(), at: now(), policyVersion: settingsVersion(settings), actor: ticket.requesterId, source: ticket.source, scope: ticket.inputs[0].text, repository: REPOSITORY, allowed: { execute, push: execute && settings.github.enabled, merge: false } };
}
function stillAllowed(ticket, settings) {
  if (ticket.source === 'local') return true;
  if (ticket.source === 'dingtalk') return authorizeMessage(ticket.origin, { ...settings.source, repository: REPOSITORY }).allowed;
  return ticket.source === 'github' && ticket.executionApprovedBy === 'local-operator';
}

export class WorkflowStore {
  constructor(runtimeDir) {
    this.store = new JsonStore(join(runtimeDir, 'dingtalk-superagent', 'workflow.json'), { version: 1, settings: defaultSettings(), settingsHistory: [], tickets: [], events: [], decisions: [], outbox: [], cursors: {} }, validate);
  }
  async snapshot() {
    const saved = await this.store.read(), state = structuredClone(saved.value);
    return { ...state, revision: saved.revision, settingsRevision: settingsVersion(state.settings), tickets: state.tickets.reverse(), events: state.events.slice(-200).reverse(), decisions: state.decisions.slice(-200).reverse(), outbox: state.outbox.slice(-200).reverse() };
  }
  async saveSettings(input, expected) {
    revisionRequired(expected); const next = validateSettings(input);
    await this.store.update(state => {
      if (settingsVersion(state.settings) !== expected) throw fault('配置已更新，请载入最新配置。', 409);
      bounded(state.settingsHistory, 200, '配置历史');
      state.settingsHistory.push({ at: now(), version: settingsVersion(state.settings), settings: state.settings }); state.settings = next;
    });
    return this.snapshot();
  }
  async ingest({ source = 'local', eventId, text, conversationId = 'local-console', senderId = 'local-operator', ticketId, origin }) {
    text = safeText(text).trim(); if (!text || !validId(eventId) || !validId(conversationId) || !validId(senderId) || !['local', 'dingtalk', 'github'].includes(source)) throw fault('消息缺少有效身份、事件 ID 或正文。');
    const key = hash([source, origin?.corpId || '', origin?.robotCode || '', eventId]);
    const saved = await this.store.update(state => {
      if (source === 'dingtalk' && (!origin || !authorizeMessage(origin, { ...state.settings.source, repository: REPOSITORY }).allowed || origin.text !== text || origin.eventId !== eventId || origin.senderId !== senderId || origin.conversationId !== conversationId)) throw fault('消息未通过钉钉身份及白名单检查。', 403);
      const existing = state.events.find(e => e.key === key);
      if (existing) {
        if (existing.text !== text || existing.conversationId !== conversationId || existing.senderId !== senderId) throw fault('幂等键已经用于不同的消息。', 409);
        return { duplicate: true, ticketId: existing.ticketId };
      }
      bounded(state.events, 10000, '事件');
      let ticket;
      if (ticketId) {
        ticket = find(state, ticketId);
        if (source !== 'local' && (ticket.source !== source || ticket.conversationId !== conversationId)) throw fault('消息不能关联到其他会话的任务。', 403);
        if (ticket.status === 'cancelled') throw fault('已停止任务不能恢复，请创建新任务。', 409);
        if (!stillAllowed(ticket, state.settings)) throw fault('原任务授权已失效。', 403);
        bounded(ticket.inputs, 500, '任务消息');
      } else {
        bounded(state.tickets, 1000, '任务');
        ticket = { id: randomUUID(), title: text.split('\n')[0].slice(0, 100), source, conversationId, requesterId: senderId, repository: REPOSITORY, status: 'observed', createdAt: now(), updatedAt: now(), inputs: [], reports: [], history: [], grants: [], origin: origin ? selectMessage(origin) : null };
        state.tickets.push(ticket);
      }
      const input = { id: randomUUID(), text, senderId, source, at: now() }; ticket.inputs.push(input);
      if (!ticket.mandate) { ticket.mandate = grant(ticket, state.settings); ticket.grants.push(ticket.mandate); }
      // Follow-ups are retained; they never silently widen execution authority.
      if (['waiting_answer', 'completed', 'failed', 'blocked', 'awaiting_review'].includes(ticket.status)) ticket.status = 'observed';
      audit(state, ticket, ticketId ? 'input_received' : 'created');
      state.events.push({ id: randomUUID(), key, eventId, source, conversationId, senderId, text, ticketId: ticket.id, at: input.at });
      if (!ticketId) receipt(state, ticket, `已记录任务 ${ticket.id}：${ticket.title}。等待评估或本机授权执行。`, 'acknowledgement');
      return { duplicate: false, ticketId: ticket.id };
    });
    return { ...saved.result, ...(await this.snapshot()) };
  }
  async action(id, action, revision) {
    revisionRequired(revision);
    await this.store.update(state => {
      const ticket = find(state, id);
      if (['queue', 'retry'].includes(action)) {
        if (state.settings.mode !== 'manual' || state.settings.paused || !state.settings.worker.enabled) throw fault('需要手动执行模式、已启用的独立 Worker，且调度未暂停。', 409);
        if (!['observed', 'failed', 'blocked', 'waiting_answer'].includes(ticket.status)) throw fault('当前任务状态不能排队。', 409);
        if (ticket.source !== 'github' && !stillAllowed(ticket, state.settings)) throw fault('任务原始授权已失效。', 403);
        ticket.executionApprovedBy = 'local-operator';
        ticket.mandate = grant(ticket, state.settings, true); ticket.grants.push(ticket.mandate); ticket.status = 'queued';
      } else if (action === 'stop') {
        if (['completed', 'cancelled'].includes(ticket.status)) throw fault('任务已经结束。', 409);
        ticket.status = 'cancelled'; receipt(state, ticket, `任务 ${ticket.id} 已停止。`, 'result');
      } else if (action === 'complete') {
        if (!['observed', 'awaiting_review', 'waiting_answer', 'blocked', 'failed'].includes(ticket.status)) throw fault('运行或排队中的任务不能直接标记完成。', 409);
        ticket.status = 'completed'; receipt(state, ticket, `任务 ${ticket.id} 已由本机操作员确认完成。`, 'result');
      } else throw fault('未知任务操作。');
      audit(state, ticket, action, '本机操作员');
    }, revision);
    return this.snapshot();
  }
  async decision(id, decision, policyVersion, inputCount) {
    await this.store.update(state => {
      const ticket = find(state, id);
      if (settingsVersion(state.settings) !== policyVersion || ticket.inputs.length !== inputCount || ticket.status !== 'observed') throw fault('评估期间任务或策略已变化，请重新评估。', 409);
      if (!['accept', 'ignore', 'attach', 'stop'].includes(decision.action)) throw fault('评估结果无效。');
      const enabled = state.settings.rules.filter(r => r.enabled).map(r => r.id);
      if (!Array.isArray(decision.matchedRules) || decision.matchedRules.some(id => !enabled.includes(id))) throw fault('模型引用了未启用的规则。');
      bounded(state.decisions, 10000, '评估记录');
      const row = { id: randomUUID(), ticketId: id, at: now(), policyVersion, inputCount, action: decision.action, reason: safeText(decision.reason, 4000), matchedRules: decision.matchedRules, targetTicketId: decision.ticketId || null, outcome: decision.action === 'accept' ? (state.settings.acceptMode === 'auto' && decision.matchedRules.length ? 'accepted_pending_authorization' : 'would_accept') : 'suggested' };
      // A model output is advice, never an executable grant or a stop command.
      state.decisions.push(row); ticket.lastEvaluation = { policyVersion, inputCount }; audit(state, ticket, 'evaluated', row.reason);
    }); return this.snapshot();
  }
  async claim(owner) {
    const saved = await this.store.update(state => {
      const cfg = state.settings;
      if (cfg.paused || cfg.mode !== 'manual' || !cfg.worker.enabled || state.tickets.filter(t => t.status === 'working').length >= cfg.concurrency) return null;
      const ticket = state.tickets.find(t => t.status === 'queued'); if (!ticket) return null;
      if (!stillAllowed(ticket, cfg) || ticket.mandate.policyVersion !== settingsVersion(cfg) || !ticket.mandate.allowed.execute) { ticket.status = 'blocked'; audit(state, ticket, 'authorization_changed', '排队后的策略已变化，需要重新授权。'); return null; }
      const assignment = { id: randomUUID(), owner, pid: process.pid, startedAt: now(), inputCount: ticket.inputs.length, status: 'running' };
      ticket.assignment = assignment; ticket.status = 'working'; audit(state, ticket, 'started');
      return { ticket: structuredClone(ticket), settings: structuredClone(cfg), assignmentId: assignment.id };
    }); return saved.result;
  }
  async report(id, assignmentId, result) {
    await this.store.update(state => {
      const ticket = find(state, id);
      if (ticket.status !== 'working' || ticket.assignment?.id !== assignmentId) return;
      const status = ['ready', 'waiting_answer', 'blocked', 'failed'].includes(result.status) ? result.status : 'failed';
      const prUrl = result.prUrl ? safePR(result.prUrl) : undefined;
      if (result.prUrl && !prUrl) throw fault('Worker 返回了目标仓库之外的 PR。');
      const report = { status, summary: safeText(result.summary || 'Worker 未提供结果。', 32000), question: safeText(result.question || '', 4000), at: now(), ...(prUrl ? { prUrl } : {}) };
      if (result.deliveryHead !== undefined) { if (!/^[a-f0-9]{40}$/.test(result.deliveryHead)) throw fault('交付提交无效。'); ticket.deliveryHead = result.deliveryHead; }
      bounded(ticket.reports, 500, '任务报告'); ticket.reports.push(report); if (prUrl) ticket.prUrl = prUrl;
      ticket.assignment.status = 'ended'; ticket.assignment.endedAt = now();
      ticket.status = status === 'ready' ? (ticket.prUrl ? 'awaiting_review' : 'completed') : status;
      if (ticket.inputs.length > ticket.assignment.inputCount) ticket.status = 'observed';
      audit(state, ticket, 'reported', report.summary);
      receipt(state, ticket, `${ticket.title}\n${report.summary.slice(0, 6000)}${report.summary.length > 6000 ? '\n完整报告见工作台。' : ''}${report.question ? '\n需要补充：' + report.question.slice(0, 1200) : ''}${prUrl ? '\n' + prUrl : ''}`, report.question ? 'attention' : 'result');
    }); return this.snapshot();
  }
  async recover(isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }) {
    // Only reclaim a positively dead writer, never a live or opaque lock.
    try {
      const lock = JSON.parse(await readFile(`${this.store.path}.lock`, 'utf8'));
      if (Number.isInteger(lock.pid) && lock.pid > 0 && !isAlive(lock.pid)) await unlink(`${this.store.path}.lock`);
    } catch (error) { if (error.code !== 'ENOENT') throw fault('状态写锁无法核验，请保留现场并检查。', 503); }
    await this.store.update(state => {
      for (const ticket of state.tickets) if (ticket.status === 'working' && !isAlive(ticket.assignment?.pid)) {
        ticket.status = 'blocked'; ticket.assignment.status = 'interrupted'; audit(state, ticket, 'interrupted', '宿主退出；先核对 Worker、分支和 PR，再重试，避免重复外部操作。');
      }
      for (const message of state.outbox) if (message.status === 'sending' && !isAlive(message.pid)) { message.status = 'uncertain'; message.error = '投递进程退出，结果未知；核对原会话后再处理。'; }
    });
  }
  async claimOutbound(owner) {
    const saved = await this.store.update(state => {
      for (const item of state.outbox) if (item.status === 'pending' && item.source === 'dingtalk' && state.settings.source.enabled) {
        const ticket = state.tickets.find(t => t.id === item.ticketId);
        if (!ticket || !stillAllowed(ticket, state.settings)) { item.status = 'withdrawn'; item.error = '目标会话或人员已不在当前授权范围。'; }
      }
      const message = state.outbox.find((item, index) => item.status === 'pending' && (item.source === 'dingtalk' ? state.settings.source.enabled : item.source === 'github' && state.settings.github.enabled) && Date.parse(item.nextAt) <= Date.now() && !state.outbox.slice(0, index).some(prior => prior.ticketId === item.ticketId && prior.conversationId === item.conversationId && ['pending', 'sending', 'uncertain'].includes(prior.status)));
      if (!message) return null;
      message.status = 'sending'; message.owner = owner; message.pid = process.pid; message.attempts++; return structuredClone(message);
    }); return saved.result;
  }
  async finishOutbound(id, { ok, retryable = false, uncertain = false }) {
    await this.store.update(state => {
      const message = state.outbox.find(m => m.id === id); if (!message || message.status !== 'sending') return;
      message.status = ok ? 'sent' : uncertain ? 'uncertain' : retryable && message.attempts < 5 ? 'pending' : 'failed';
      message.updatedAt = now(); message.nextAt = new Date(Date.now() + Math.min(300000, 5000 * 2 ** message.attempts)).toISOString();
      message.error = ok ? null : uncertain ? '投递结果未知，暂停自动重试。' : '投递未完成，请检查通道配置与权限。';
    });
  }
  async setCursor(name, value) { await this.store.update(state => { state.cursors[name] = value; }); }
  async assessmentFailed(id, policyVersion, inputCount) {
    await this.store.update(state => { const ticket = find(state, id); bounded(state.decisions, 10000, '评估记录'); ticket.lastEvaluation = { policyVersion, inputCount }; state.decisions.push({ id: randomUUID(), ticketId: id, at: now(), policyVersion, inputCount, action: 'unavailable', outcome: 'unavailable', reason: '模型未完成有效评估，请检查模型服务后手动重试。', matchedRules: [] }); });
  }
  async githubEvent(event) {
    const current = await this.snapshot();
    const ticket = current.tickets.find(t => t.prUrl === `https://github.com/${REPOSITORY}/pull/${event.number}`);
    if (!ticket) return this.ingest({ source: 'github', eventId: event.id, text: (event.text || `${event.kind} ${event.state || ''}`).slice(0, 8000), conversationId: event.conversationId, senderId: event.senderId || 'github-system' });
    await this.store.update(state => {
      const key = hash(['github', '', '', event.id]); if (state.events.some(e => e.key === key)) return;
      bounded(state.events, 10000, '事件');
      const item = find(state, ticket.id), text = (event.text || `${event.kind} ${event.state || ''}`).slice(0, 8000);
      state.events.push({ id: randomUUID(), key, eventId: event.id, source: 'github', conversationId: event.conversationId, senderId: event.senderId || 'github-system', text, ticketId: item.id, at: now() });
      if (item.status === 'cancelled') return;
      if (event.kind === 'pull-state' && ['merged', 'closed'].includes(event.state) && item.status === 'awaiting_review') {
        item.status = 'completed'; audit(state, item, 'pull_closed', event.state); receipt(state, item, `${item.title}：PR 已${event.state === 'merged' ? '合并' : '关闭'}。`, 'result');
      } else {
        bounded(item.inputs, 500, '任务消息'); item.inputs.push({ id: randomUUID(), source: 'github', senderId: event.senderId || 'github-system', text, context: true, at: now() }); audit(state, item, 'github_context', event.kind);
      }
    }); return this.snapshot();
  }
  async note(id, type, detail) { await this.store.update(state => audit(state, find(state, id), type, safeText(detail))); }
  async assertDelivery(id, assignmentId, policyVersion) {
    const state = (await this.store.read()).value, ticket = find(state, id);
    if (ticket.status !== 'working' || ticket.assignment?.id !== assignmentId || !ticket.mandate.allowed.push || !state.settings.github.enabled || state.settings.paused || state.settings.mode !== 'manual' || settingsVersion(state.settings) !== policyVersion || !stillAllowed(ticket, state.settings)) throw fault('交付授权已变化，停止外部写入。', 409);
  }
  async reconcileOutbound(id, resolution, revision) {
    revisionRequired(revision);
    await this.store.update(state => {
      const item = state.outbox.find(m => m.id === id); if (!item) throw fault('投递记录不存在。', 404);
      if (!['uncertain', 'failed'].includes(item.status) || !['sent', 'withdrawn', 'retry'].includes(resolution) || resolution === 'retry' && item.status !== 'failed') throw fault('结果未知的投递须先核对送达状态，不能直接重发。', 409);
      item.status = resolution === 'retry' ? 'pending' : resolution; item.nextAt = now(); item.updatedAt = now(); item.reconciledBy = 'local-operator'; item.error = null;
    }, revision); return this.snapshot();
  }
}
