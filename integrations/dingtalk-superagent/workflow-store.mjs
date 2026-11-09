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

export function hasOutstandingInputs(ticket) {
  return ticket.inputs.slice(ticket.assignment.inputCount).some(input =>
    !(input.source === 'github' && input.context === true) &&
    (input.steering?.assignmentId !== ticket.assignment.id || input.steering.status !== 'delivered'));
}

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

const queueable = new Set(['observed', 'failed', 'blocked', 'waiting_answer']);
function manualQueueEnabled(settings) {
  return settings.mode === 'manual' && !settings.paused && settings.worker.enabled;
}
function queueTicket(ticket, settings, actor) {
  if (!manualQueueEnabled(settings)) throw fault('需要手动执行模式、已启用的独立 Worker，且调度未暂停。', 409);
  if (!queueable.has(ticket.status)) throw fault('当前任务状态不能排队。', 409);
  if (ticket.source !== 'github' && !stillAllowed(ticket, settings)) throw fault('任务原始授权已失效。', 403);
  ticket.executionApprovedBy = actor;
  ticket.mandate = grant(ticket, settings, true);
  ticket.mandate.inputCount = ticket.inputs.length;
  ticket.grants.push(ticket.mandate);
  ticket.status = 'queued';
}
function stopTicket(state, ticket) {
  if (['completed', 'cancelled'].includes(ticket.status)) throw fault('任务已经结束。', 409);
  ticket.status = 'cancelled';
  receipt(state, ticket, `任务 ${ticket.id} 已停止。`, 'result');
}

// The ticket scope and policy generation prevent an old card from becoming
// valid again when an operator restores earlier settings or a task is retried.
function cardView(state, ticket, policy = settingsVersion(state.settings)) {
  if (!state.settings.cards?.enabled || ticket.source !== 'dingtalk' || !stillAllowed(ticket, state.settings)) return null;
  const actions = [];
  if (manualQueueEnabled(state.settings) && queueable.has(ticket.status)) actions.push('approve');
  if (!['completed', 'cancelled'].includes(ticket.status)) actions.push('stop', 'supplement');
  const prUrl = safePR(ticket.prUrl);
  if (prUrl) actions.push('view_pr');
  if (!actions.length) return null;
  const scopeVersion = hash([ticket.id, policy, state.settingsHistory.length, ticket.inputs.length,
    ticket.inputs.at(-1).id, ticket.reports.length]);
  const mandateId = ticket.mandate.id;
  const version = hash([scopeVersion, mandateId, ticket.status, prUrl || '']);
  return { ticketId: ticket.id, title: ticket.title, text: ticket.inputs.at(-1).text, status: ticket.status,
    scope: ticket.inputs[0].text, allowPush: state.settings.github.enabled,
    actions, scopeVersion, version, mandateId, ...(prUrl ? { prUrl } : {}) };
}

function refreshCards(state) {
  const policy = state.settings.cards?.enabled ? settingsVersion(state.settings) : null;
  const views = new Map();
  if (policy) for (const ticket of state.tickets) {
    const view = cardView(state, ticket, policy);
    if (view) views.set(ticket.id, { view, ticket });
  }
  const seen = new Set();
  for (const row of state.outbox) {
    if (row.kind !== 'card') continue;
    if (views.get(row.ticketId)?.view.version === row.card.version) {
      seen.add(row.ticketId); // Failed/uncertain deliveries require reconciliation.
    } else if (row.status === 'pending') {
      row.status = 'withdrawn'; row.error = '卡片授权或任务版本已更新。';
    }
  }
  for (const [id, { view, ticket }] of views) {
    if (seen.has(id)) continue;
    if (state.outbox.length >= 10000) break;
    const createdAt = now();
    state.outbox.push({ id: randomUUID(), ticketId: id, kind: 'card', status: 'pending', source: 'dingtalk',
      requesterId: ticket.requesterId, conversationId: ticket.conversationId, conversationType: ticket.origin.conversationType,
      text: ticket.title, card: { ...view, outTrackId: randomUUID() }, attempts: 0, createdAt, nextAt: createdAt });
  }
}

function assertCardActor(row, ticket, callback, settings) {
  if (!settings.cards?.enabled || ticket.source !== 'dingtalk' || !stillAllowed(ticket, settings)
    || row.card.ticketId !== ticket.id || row.conversationId !== ticket.conversationId || row.requesterId !== ticket.requesterId
    || callback.senderId !== ticket.requesterId || callback.corpId !== ticket.origin.corpId
    || callback.robotCode !== ticket.origin.robotCode) throw fault('当前用户或机器人无权操作此卡片。', 403);
  const group = ticket.origin.conversationType === '2';
  const spaceType = group ? 'IM_GROUP' : 'IM_ROBOT', spaceId = group ? row.conversationId : ticket.requesterId;
  if ((callback.spaceType !== undefined && callback.spaceType !== spaceType)
    || (callback.spaceId !== undefined && ![spaceId, `dtv1.card//${spaceType}.${spaceId}`].includes(callback.spaceId))
    || (callback.conversationId !== undefined && callback.conversationId !== row.conversationId)) throw fault('卡片会话不匹配。', 403);
}

export class WorkflowStore {
  constructor(runtimeDir) {
    this.store = new JsonStore(join(runtimeDir, 'dingtalk-superagent', 'workflow.json'), { version: 1, settings: defaultSettings(), settingsHistory: [], tickets: [], events: [], decisions: [], outbox: [], cursors: {} }, validate);
  }
  async snapshot() {
    const saved = await this.store.read(), state = structuredClone(saved.value);
    state.settings = validateSettings(state.settings);
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
        if (source === 'dingtalk' && (ticket.requesterId !== senderId || ticket.origin.corpId !== origin.corpId || ticket.origin.robotCode !== origin.robotCode)) throw fault('只有原发起人可在原会话补充此任务。', 403);
        if (ticket.status === 'cancelled') throw fault('已停止任务不能恢复，请创建新任务。', 409);
        if (!stillAllowed(ticket, state.settings)) throw fault('原任务授权已失效。', 403);
        bounded(ticket.inputs, 500, '任务消息');
      } else {
        bounded(state.tickets, 1000, '任务');
        ticket = { id: randomUUID(), title: text.split('\n')[0].slice(0, 100), source, conversationId, requesterId: senderId, repository: REPOSITORY, status: 'observed', createdAt: now(), updatedAt: now(), inputs: [], reports: [], history: [], grants: [], origin: origin ? selectMessage(origin) : null };
        state.tickets.push(ticket);
      }
      const input = { id: randomUUID(), text, senderId, source, at: now() }; ticket.inputs.push(input);
      if (ticket.status === 'working' && (source === 'local' || source === 'dingtalk' && senderId === ticket.requesterId)) {
        input.steering = { assignmentId: ticket.assignment.id, status: 'pending' };
      }
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
        queueTicket(ticket, state.settings, 'local-operator');
      } else if (action === 'stop') {
        stopTicket(state, ticket);
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
      const policy = settingsVersion(cfg);
      const ticket = state.tickets.find(candidate => {
        if (candidate.status !== 'queued') return false;
        const { mandate } = candidate;
        const sameInputs = mandate.inputCount === undefined || mandate.inputCount === candidate.inputs.length;
        if (sameInputs && mandate.policyVersion === policy && mandate.allowed.execute && stillAllowed(candidate, cfg)) return true;
        candidate.status = 'blocked';
        audit(state, candidate, 'authorization_changed', '排队后的输入或策略已变化，需要重新授权。');
        return false;
      });
      if (!ticket) return null;
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
      if (hasOutstandingInputs(ticket)) ticket.status = 'observed';
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
      refreshCards(state);
      for (const item of state.outbox) if (item.status === 'pending' && item.source === 'dingtalk' && state.settings.source.enabled) {
        const ticket = state.tickets.find(t => t.id === item.ticketId);
        if (!ticket || !stillAllowed(ticket, state.settings)) { item.status = 'withdrawn'; item.error = '目标会话或人员已不在当前授权范围。'; }
      }
      const message = state.outbox.find((item, index) => {
        const dueAt = Date.parse(item.nextAt);
        if (item.status !== 'pending' || !Number.isFinite(dueAt) || dueAt > Date.now()) return false;
        const enabled = item.source === 'dingtalk' ? state.settings.source.enabled : item.source === 'github' && state.settings.github.enabled;
        if (!enabled) return false;
        // Cards use their own authenticated delivery channel. An expired text
        // sessionWebhook must not prevent an actionable card from arriving.
        return !state.outbox.slice(0, index).some(prior => {
          if (prior.ticketId !== item.ticketId || prior.conversationId !== item.conversationId) return false;
          const sameChannel = item.kind === 'card' ? prior.card?.version === item.card.version : prior.kind !== 'card';
          return sameChannel && ['pending', 'sending', 'uncertain'].includes(prior.status);
        });
      });
      if (!message) return null;
      message.status = 'sending'; message.owner = owner; message.pid = process.pid; message.attempts++; return structuredClone(message);
    }); return saved.result;
  }
  async assertCardDelivery(outboxId) {
    const { value: state } = await this.store.read();
    const row = state.outbox.find(item => item.id === outboxId && item.kind === 'card' && item.status === 'sending');
    if (!row || cardView(state, find(state, row.ticketId))?.version !== row.card.version) throw fault('卡片授权或版本已变化，已停止投递。', 409);
  }
  async applyCardAction(callback, { workerReady = false } = {}) {
    const { eventId, outTrackId, action } = callback || {};
    if (!validId(eventId) || !validId(outTrackId) || !['approve', 'stop', 'supplement', 'view_pr'].includes(action)) throw fault('卡片动作或事件标识无效。');
    const saved = await this.store.update(state => {
      const row = state.outbox.find(item => item.kind === 'card' && item.card.outTrackId === outTrackId);
      if (row?.status === 'sending') throw fault('卡片投递回执正在写入，请稍后重试。', 503);
      if (!row || row.status !== 'sent') throw fault('卡片实例不存在或尚未确认送达。', 409);
      const ticket = find(state, row.ticketId);
      assertCardActor(row, ticket, callback, state.settings);
      const key = hash(['dingtalk-card', callback.corpId, callback.robotCode, eventId]);
      const prior = state.events.find(e => e.key === key);
      if (prior) {
        if (prior.outTrackId !== outTrackId || prior.action !== action || prior.senderId !== callback.senderId) throw fault('卡片事件 ID 已用于其他请求。', 409);
        if (prior.outcome === 'worker_unavailable') return { accepted: false, reason: prior.outcome };
        return { accepted: true, duplicate: true, action, ticketId: ticket.id };
      }
      const current = cardView(state, ticket);
      // After approval, the same control can stop the execution it authorized.
      // A different grant, new input/report, or policy change ends that right.
      const sameExecutionStop = action === 'stop' && ['queued', 'working'].includes(ticket.status)
        && current?.scopeVersion === row.card.scopeVersion
        && [row.authorizedMandateId, row.card.mandateId].includes(ticket.mandate.id);
      if (!current || (!sameExecutionStop && current.version !== row.card.version)) throw fault('卡片已过期，请使用原会话中的最新卡片。', 409);
      if (!row.card.actions.includes(action) || !current.actions.includes(action)) throw fault('当前卡片未授权此操作。', 403);
      if (row.usedActions?.includes(action)) throw fault('此卡片操作已经处理。', 409);
      bounded(state.events, 10000, '事件');
      const result = { accepted: true, duplicate: false, action, ticketId: ticket.id };
      const event = { id: randomUUID(), key, eventId, outTrackId, action, ticketId: ticket.id, source: 'dingtalk',
        conversationId: ticket.conversationId, senderId: callback.senderId, text: '卡片操作 ' + action, at: now() };
      if (action === 'approve') {
        if (workerReady !== true) {
          // The platform can redeliver a rejected click after an ACK is lost.
          // Record the decision before acknowledging; only a new click can retry.
          state.events.push({ ...event, outcome: 'worker_unavailable', text: '独立 Worker 未就绪，此次批准未入队。' });
          return { accepted: false, reason: 'worker_unavailable' };
        }
        queueTicket(ticket, state.settings, 'dingtalk:' + callback.senderId);
        row.authorizedMandateId = ticket.mandate.id;
      } else if (action === 'stop') {
        if (ticket.status === 'working') result.assignmentId = ticket.assignment?.id;
        stopTicket(state, ticket);
      } else if (action === 'supplement') {
        receipt(state, ticket, `请在原会话${ticket.origin.conversationType === '2' ? ' @机器人，' : ''}回复「任务 ${ticket.id} 补充内容」，补充信息将关联到这个任务。`, 'attention');
      } else {
        result.prUrl = current.prUrl;
        receipt(state, ticket, `任务 ${ticket.id} 的 PR：${current.prUrl}`, 'result');
      }
      (row.usedActions ??= []).push(action);
      const detail = `钉钉原发起人 ${callback.senderId}`;
      audit(state, ticket, 'card_' + action, detail);
      state.events.push(event);
      return result;
    });
    if (!saved.result.accepted) throw Object.assign(fault('独立 Worker 健康检查尚未通过。此次批准未入队。', 503), { code: saved.result.reason });
    return saved.result;
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
  async steeringBatch(id, assignmentId) {
    const state = (await this.store.read()).value, ticket = find(state, id);
    if (ticket.status !== 'working' || ticket.assignment?.id !== assignmentId ||
        !ticket.mandate.allowed.execute || ticket.mandate.policyVersion !== settingsVersion(state.settings) ||
        state.settings.paused || state.settings.mode !== 'manual' || !stillAllowed(ticket, state.settings)) return [];
    return ticket.inputs.filter(input => input.steering?.assignmentId === assignmentId && input.steering.status !== 'delivered');
  }
  async markSteering(id, assignmentId, receipts) {
    if (!receipts.length) return;
    const byId = new Map(receipts.map(({ inputId, status }) => [inputId, status]));
    await this.store.update(state => {
      const ticket = find(state, id);
      if (ticket.status !== 'working' || ticket.assignment?.id !== assignmentId) return;
      for (const input of ticket.inputs) {
        const status = byId.get(input.id);
        if (input.steering?.assignmentId !== assignmentId || input.steering.status === 'delivered' ||
            !['queued', 'delivered', 'unavailable', 'uncertain'].includes(status) || status === input.steering.status) continue;
        input.steering = { assignmentId, status, at: now() };
      }
    });
  }
  async assertDelivery(id, assignmentId, policyVersion) {
    const state = (await this.store.read()).value, ticket = find(state, id);
    if (ticket.status !== 'working' || ticket.assignment?.id !== assignmentId || !ticket.mandate.allowed.push || !state.settings.github.enabled || state.settings.paused || state.settings.mode !== 'manual' || settingsVersion(state.settings) !== policyVersion || !stillAllowed(ticket, state.settings)) throw fault('交付授权已变化，停止外部写入。', 409);
    if (hasOutstandingInputs(ticket)) throw fault('还有补充信息等待处理，请核对后再交付。', 409);
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
