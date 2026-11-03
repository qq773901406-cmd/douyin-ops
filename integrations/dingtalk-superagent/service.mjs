import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TicketStore } from './ticket-store.mjs';
import { normalizeConfig } from './policy.mjs';
import { normalizeRobotMessage } from './dingtalk-source.mjs';
import { observationReceipt } from './dingtalk-channel.mjs';

export class SuperagentService {
  constructor(runtimeDir) {
    this.configFile = join(runtimeDir, 'dingtalk-superagent', 'config.json');
    this.store = new TicketStore(runtimeDir);
    // Separate storage and authorization namespace: a demo cannot authorize a
    // real sender or occupy a real message's deduplication key.
    this.demoStore = new TicketStore(join(runtimeDir, 'dingtalk-superagent', 'local-demo'));
  }

  async configuration() {
    let input;
    try { input = JSON.parse(await readFile(this.configFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return normalizeConfig();
      throw Object.assign(new Error('AI 开发代理配置无法读取，请检查本机 config.json。'), { status: 503 });
    }
    // Credentials belong in environment variables in the future live source,
    // never in this file, an HTTP response or a recorded message.
    try { return normalizeConfig(input); }
    catch { throw Object.assign(new Error('AI 开发代理配置无效；仅支持观察模式和非敏感配置。'), { status: 503 }); }
  }

  async snapshot() {
    const [config, live, demo] = await Promise.all([this.configuration(), this.store.snapshot(), this.demoStore.snapshot()]);
    const tickets = [
      ...live.tickets.map(ticket => ({ ...ticket, source: 'dingtalk' })),
      ...demo.tickets.map(ticket => ({ ...ticket, source: 'local-demo' })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      config, revision: live.revision, demoRevision: demo.revision, tickets,
      stats: { observed: tickets.filter(t => t.status === 'observed').length, cancelled: tickets.filter(t => t.status === 'cancelled').length, working: 0, review: 0, failed: 0 },
      connection: { state: config.enabled ? 'unconfigured' : 'disabled', message: '本地观察模式：真实 Stream 接收尚未启用，可使用演示任务验证登记流程。' },
      capabilities: { execute: false, push: false, merge: false, send: false, liveStream: false },
    };
  }

  async demo() {
    const config = normalizeConfig({ enabled: true, corpId: 'local-demo-corp', clientId: 'local-demo-robot', allowedUserIds: ['local-demo-user'], allowedConversationIds: ['local-demo-conversation'] });
    // Stable event ID deliberately exercises at-least-once message delivery.
    // Repeated clicks and server restarts must never create a second Ticket.
    const message = normalizeRobotMessage({ data: {
      msgId: 'local-demo-message-v1', msgtype: 'text',
      chatbotCorpId: config.corpId, senderCorpId: config.corpId, robotCode: config.clientId,
      senderStaffId: 'local-demo-user', conversationId: 'local-demo-conversation',
      conversationType: '2', isInAtList: true,
      text: { content: '本地演示：请检查工作台的空状态文案，并提出改进建议。' },
    } });
    const result = await this.demoStore.ingest(message, config);
    const snapshot = await this.snapshot();
    const ticket = snapshot.tickets.find(item => item.source === 'local-demo');
    return { ...snapshot, receipt: ticket ? observationReceipt(ticket) : null, duplicate: result.duplicate === true };
  }

  async cancel(id, revision, demo = false) {
    if (typeof revision !== 'string' || !revision) throw Object.assign(new Error('请先刷新任务状态再取消。'), { status: 428 });
    await (demo ? this.demoStore : this.store).cancel(id, revision);
    return this.snapshot();
  }
}
