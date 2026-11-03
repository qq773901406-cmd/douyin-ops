import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { JsonStore } from '../../workbuddy/connector/lib/json-store.mjs';
import { authorizeMessage, normalizeConfig, selectMessage, REPOSITORY } from './policy.mjs';

// Stop intake at capacity; deleting old Tickets would also lose their dedup keys.
export const MAX_TICKETS = 1000;
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const eventKey = message => digest([message.corpId, message.robotCode, message.eventId]);
const conversationKey = message => digest([message.corpId, message.robotCode, message.conversationType, message.conversationId]);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const ticketFields = new Set(['id', 'eventKey', 'conversationKey', 'status', 'mode', 'executionAllowed', 'repository', 'createdAt', 'updatedAt', 'messages']);
const messageFields = new Set(['eventId', 'corpId', 'conversationId', 'senderId', 'robotCode', 'conversationType', 'text', 'isInAtList']);

function validateState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.tickets) || state.tickets.length > MAX_TICKETS || Object.keys(state).some(key => !['version', 'tickets'].includes(key))) throw fault('Ticket 数据格式无效，请保留原文件并核查备份。', 500);
  const ids = new Set(), events = new Set();
  for (const ticket of state.tickets) {
    if (!ticket || Object.keys(ticket).some(key => !ticketFields.has(key)) || !uuid(ticket.id) || ids.has(ticket.id)
      || !['observed', 'cancelled'].includes(ticket.status) || ticket.mode !== 'observe' || ticket.executionAllowed !== false
      || ticket.repository !== REPOSITORY || !instant(ticket.createdAt) || !instant(ticket.updatedAt)
      || Date.parse(ticket.updatedAt) < Date.parse(ticket.createdAt) || !Array.isArray(ticket.messages) || ticket.messages.length !== 1) throw fault('Ticket 记录无效，原数据未覆盖。', 500);
    const rawMessage = ticket.messages[0];
    if (!rawMessage || Object.keys(rawMessage).some(key => !messageFields.has(key))) throw fault('Ticket 消息含未知字段，原数据未覆盖。', 500);
    const message = selectMessage(rawMessage);
    if (ticket.eventKey !== eventKey(message) || events.has(ticket.eventKey) || ticket.conversationKey !== conversationKey(message)) throw fault('Ticket 去重索引或会话映射无效。', 500);
    ids.add(ticket.id); events.add(ticket.eventKey);
  }
  return state;
}

function publicSnapshot(saved) {
  const tickets = structuredClone(saved.value.tickets).reverse();
  return { revision: saved.revision, tickets, stats: {
    total: tickets.length,
    observed: tickets.filter(ticket => ticket.status === 'observed').length,
    cancelled: tickets.filter(ticket => ticket.status === 'cancelled').length,
    capacity: MAX_TICKETS,
  } };
}

export class TicketStore {
  constructor(runtimeDir) {
    this.store = new JsonStore(join(runtimeDir, 'dingtalk-superagent', 'tickets.json'), { version: 1, tickets: [] }, validateState);
  }

  async snapshot() { return publicSnapshot(await this.store.read()); }

  async ingest(input, configInput) {
    const config = normalizeConfig(configInput), decision = authorizeMessage(input, config);
    if (!decision.allowed) return { accepted: false, duplicate: false, reason: decision.reason };
    const message = selectMessage(input), key = eventKey(message);
    const saved = await this.store.update(state => {
      const existing = state.tickets.find(ticket => ticket.eventKey === key);
      if (existing) return { accepted: true, duplicate: true, reason: 'already_recorded', ticket: existing };
      if (state.tickets.length >= MAX_TICKETS) throw fault('Ticket 存储已满；接收已暂停，已有记录和去重索引保留。', 507);
      const now = new Date().toISOString();
      const ticket = {
        id: randomUUID(), eventKey: key, conversationKey: conversationKey(message),
        status: 'observed', mode: 'observe', executionAllowed: false, repository: config.repository,
        createdAt: now, updatedAt: now, messages: [message],
      };
      state.tickets.push(ticket);
      return { accepted: true, duplicate: false, reason: 'observe_only', ticket };
    });
    return { ...structuredClone(saved.result), revision: saved.revision };
  }

  async cancel(id, revision) {
    if (!uuid(id)) throw fault('Ticket ID 无效。');
    if (typeof revision !== 'string' || !revision) throw fault('请刷新 Ticket 状态后再操作。', 428);
    const saved = await this.store.update(state => {
      const ticket = state.tickets.find(item => item.id === id);
      if (!ticket) throw fault('Ticket 不存在。', 404);
      if (ticket.status !== 'observed') throw fault('只有观察中的 Ticket 可以取消。', 409);
      ticket.status = 'cancelled';
      ticket.updatedAt = new Date().toISOString();
    }, revision);
    return publicSnapshot(saved);
  }
}
