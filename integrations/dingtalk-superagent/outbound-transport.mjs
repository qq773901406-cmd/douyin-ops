// Webhook capabilities stay in memory, never in the durable outbox. The outbox
// stores only conversationId/text and waits for a fresh authorized message after
// a restart or expiration. Reference: official DingTalk appbot reply examples.
export class DeliveryError extends Error {
  constructor(message, { code = 'delivery_failed', retryable = false, uncertain = false, status = 503 } = {}) {
    super(message); Object.assign(this, { code, retryable, uncertain, status });
  }
}

export class DingTalkOutboundTransport {
  #routes = new Map();
  constructor({ fetchImpl = fetch, getAccessToken, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl; this.getAccessToken = getAccessToken; this.now = now;
  }
  remember(conversationId, raw) {
    let url;
    try { url = new URL(raw?.sessionWebhook); } catch { return false; }
    if (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com' || url.port || url.username || url.password
      || url.pathname !== '/robot/sendBySession' || !url.searchParams.get('session') || url.hash
      || !Number.isFinite(raw.sessionWebhookExpiredTime) || raw.sessionWebhookExpiredTime <= this.now()) return false;
    for (const [key, route] of this.#routes) if (route.expiresAt <= this.now()) this.#routes.delete(key);
    if (!this.#routes.has(conversationId) && this.#routes.size >= 1000) return false;
    this.#routes.set(conversationId, { url: url.href, expiresAt: raw.sessionWebhookExpiredTime });
    return true;
  }
  clear() { this.#routes.clear(); }
  async send({ conversationId, text, beforeSend }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new DeliveryError('回复内容无效。', { code: 'invalid_message', status: 400 });
    const route = this.#routes.get(conversationId);
    if (!route || route.expiresAt <= this.now()) {
      this.#routes.delete(conversationId);
      throw new DeliveryError('等待该会话的新授权消息，以更新回复通道。', { code: 'route_unavailable', retryable: true });
    }
    let token;
    try { token = await this.getAccessToken(); }
    catch { throw new DeliveryError('钉钉访问令牌暂不可用。', { code: 'token_unavailable', retryable: true }); }
    if (typeof token !== 'string' || !token) throw new DeliveryError('钉钉访问令牌不可用。', { code: 'token_unavailable', retryable: true });
    await beforeSend?.();
    if (route.expiresAt <= this.now() || this.#routes.get(conversationId) !== route) throw new DeliveryError('回复通道已失效，等待新的授权消息。', { code: 'route_unavailable', retryable: true });
    let response;
    try {
      response = await this.fetchImpl(route.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }) });
    } catch { throw new DeliveryError('钉钉投递结果未知，请核对原会话后处理。', { code: 'delivery_uncertain', uncertain: true }); }
    if (response.status === 429) throw new DeliveryError('钉钉发送限流。', { code: 'rate_limited', retryable: true });
    if (!response.ok) throw new DeliveryError(`钉钉发送未确认（HTTP ${response.status}）。`, { code: 'delivery_uncertain', uncertain: true });
    let body;
    try { body = await response.json(); } catch { throw new DeliveryError('钉钉发送响应无法确认。', { code: 'delivery_uncertain', uncertain: true }); }
    if (body?.errcode !== 0) throw new DeliveryError('钉钉拒绝了回复，请检查应用权限或会话有效期。', { code: 'delivery_rejected' });
    return { sent: true, delivery: 'dingtalk', conversationId };
  }
}
