// Pure boundary adapter. Only a verified Stream transport may call this in a
// future live source. Local replay does not establish a DingTalk identity.
const invalid = () => Object.assign(new Error('机器人文本消息格式无效。'), { status: 400 });
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);

export function normalizeRobotMessage(envelope) {
  if (!envelope || typeof envelope !== 'object') throw invalid();
  let body = envelope.data;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > 64 * 1024) throw invalid();
    try { body = JSON.parse(body); } catch { throw invalid(); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || body.msgtype !== 'text' || !['1', '2'].includes(body.conversationType)
    || ![body.msgId, body.conversationId, body.senderStaffId, body.chatbotCorpId, body.senderCorpId, body.robotCode].every(identifier)
    || body.senderCorpId !== body.chatbotCorpId
    || typeof body.text?.content !== 'string' || !body.text.content.trim()
    || body.text.content.length > 8000) throw invalid();
  // Explicit allowlist: sessionWebhook, access tokens, transport payloads,
  // display names and administrator claims never enter the Ticket store.
  return {
    eventId: body.msgId, corpId: body.chatbotCorpId,
    conversationId: body.conversationId, conversationType: body.conversationType,
    senderId: body.senderStaffId, robotCode: body.robotCode,
    text: body.text.content.trim(), isInAtList: body.isInAtList === true,
  };
}
