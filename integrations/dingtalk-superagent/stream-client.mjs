import { normalizeRobotMessage } from './dingtalk-source.mjs';
import { DingTalkOutboundTransport, DeliveryError } from './outbound-transport.mjs';

export class DingTalkStream {
  constructor({ config, onMessage, onHealth = () => {}, loadSdk = () => import('dingtalk-stream'), fetchImpl = fetch, env = process.env } = {}) {
    this.config = config || {}; this.onMessage = onMessage; this.onHealth = onHealth;
    this.loadSdk = loadSdk; this.env = env; this.client = null; this.timer = null;
    this.state = 'disabled'; this.message = '钉钉 Stream 已关闭。'; this.lastReceivedAt = null; this.generation = 0;
    this.outbound = new DingTalkOutboundTransport({ fetchImpl, getAccessToken: () => this.client?.getAccessToken() });
  }
  health() {
    const connected = !!this.client?.connected && !!this.client?.registered;
    return { state: connected ? 'connected' : this.client ? 'connecting' : this.state,
      message: connected ? '钉钉 Stream 已连接并注册。' : this.message,
      lastReceivedAt: this.lastReceivedAt, installed: !!this.client };
  }
  publish() { try { this.onHealth(this.health()); } catch {} }
  async start() {
    if (this.client) return this.health();
    const generation = ++this.generation;
    if (!this.config.enabled) return this.health();
    if (!this.config.clientId || !this.config.corpId || !this.config.allowedUserIds?.length || !this.env.DINGTALK_CLIENT_SECRET) {
      this.state = 'unconfigured'; this.message = '需要企业、机器人、人员白名单和本机 DINGTALK_CLIENT_SECRET。'; this.publish(); return this.health();
    }
    let sdk;
    try { sdk = await this.loadSdk(); }
    catch { this.state = 'unconfigured'; this.message = '缺少 dingtalk-stream 依赖，请按部署说明安装。'; this.publish(); return this.health(); }
    if (generation !== this.generation) return this.health();
    if (typeof sdk.DWClient !== 'function' || typeof this.onMessage !== 'function') throw new Error('Stream SDK 或消息处理器不可用。');
    this.client = new sdk.DWClient({ clientId: this.config.clientId, clientSecret: this.env.DINGTALK_CLIENT_SECRET,
      debug: false, keepAlive: true, autoReconnect: true, subscriptions: [] });
    const client = this.client;
    this.client.on('error', () => { if (generation !== this.generation) return; this.message = 'Stream 发生连接错误，正在等待重连。'; this.publish(); });
    this.client.registerCallbackListener(sdk.TOPIC_ROBOT || '/v1.0/im/bot/messages/get', async envelope => {
      if (generation !== this.generation) return;
      const ack = () => client.socketCallBackResponse(envelope.headers?.messageId, { status: 'SUCCESS' });
      let normalized, raw;
      try { normalized = normalizeRobotMessage(envelope); raw = typeof envelope.data === 'string' ? JSON.parse(envelope.data) : envelope.data; }
      catch { ack(); return; } // Invalid messages are permanently rejected, not retried.
      try {
        // The host must authorize and durably accept before returning accepted.
        const result = await this.onMessage(normalized, { conversationId: normalized.conversationId });
        if (generation !== this.generation) return;
        if (!result || typeof result.accepted !== 'boolean') throw new Error('Invalid intake receipt');
        if (result.accepted) this.outbound.remember(normalized.conversationId, raw);
        this.lastReceivedAt = new Date().toISOString(); ack(); this.publish();
      } catch {
        // Deliberately no ACK: DingTalk retries this event. Never log raw errors.
        this.message = '消息尚未完成持久化，等待平台重新投递。'; this.publish();
      }
    });
    this.state = 'connecting'; this.message = '正在连接钉钉 Stream，等待注册完成。';
    this.timer = setInterval(() => this.publish(), 5000); this.timer.unref?.(); this.publish();
    let startupTimeout;
    try {
      await Promise.race([
        Promise.resolve(client.connect()).catch(() => { if (generation === this.generation) this.message = '钉钉 Stream 连接失败，等待重连。'; }),
        new Promise(resolve => { startupTimeout = setTimeout(resolve, 15000); startupTimeout.unref?.(); }),
      ]);
    } catch { if (generation === this.generation) this.message = '钉钉 Stream 连接失败，等待重连。'; }
    finally { clearTimeout(startupTimeout); }
    this.publish(); return this.health();
  }
  async stop() {
    this.generation++;
    clearInterval(this.timer); this.timer = null;
    const client = this.client; this.client = null; this.outbound.clear();
    if (client) { try { await client.disconnect(); } catch {} }
    this.state = 'disabled'; this.message = '钉钉 Stream 已关闭。'; this.publish();
  }
  async send(message) {
    if (!this.client || !this.config.enabled) throw new DeliveryError('钉钉来源已关闭。', { code: 'source_disabled', retryable: true });
    const generation = this.generation;
    return this.outbound.send({ ...message, beforeSend: () => {
      if (generation !== this.generation || !this.client || !this.config.enabled) throw new DeliveryError('钉钉来源已关闭。', { code: 'source_disabled', retryable: true });
    } });
  }
}
