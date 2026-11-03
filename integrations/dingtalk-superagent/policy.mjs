// Stage one has no execution switch. Accepting a message only records a Ticket.
export const REPOSITORY = 'qq773901406-cmd/douyin-ops';
export const MAX_MESSAGE_LENGTH = 8000;
const fault = message => Object.assign(new Error(message), { status: 400 });
const configFields = new Set(['mode', 'enabled', 'corpId', 'clientId', 'allowedUserIds', 'allowedConversationIds', 'repository']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function identifier(value, name, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u0020\u007f]/.test(value) || (!empty && !value)) throw fault(`${name} 必须是有效的 ID。`);
  return value;
}

function allowlist(value, name) {
  if (!Array.isArray(value) || value.length > 256) throw fault(`${name} 必须是最多 256 项的 ID 列表。`);
  return [...new Set(value.map(id => identifier(id, name)))];
}

export function normalizeConfig(input = {}) {
  if (!object(input) || Object.keys(input).some(key => !configFields.has(key))) throw fault('钉钉观察模式配置包含不支持的字段。');
  if (input.mode !== undefined && input.mode !== 'observe') throw fault('当前只支持 observe 观察模式。');
  if (input.repository !== undefined && input.repository !== REPOSITORY) throw fault('当前只允许已配置的 douyin-ops 仓库。');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw fault('enabled 必须是布尔值。');
  const config = {
    mode: 'observe', enabled: input.enabled ?? false,
    corpId: identifier(input.corpId ?? '', 'corpId', { empty: true }),
    clientId: identifier(input.clientId ?? '', 'clientId', { empty: true }),
    allowedUserIds: allowlist(input.allowedUserIds ?? [], 'allowedUserIds'),
    allowedConversationIds: allowlist(input.allowedConversationIds ?? [], 'allowedConversationIds'),
    repository: REPOSITORY,
  };
  if (config.enabled && (!config.corpId || !config.clientId || !config.allowedUserIds.length)) throw fault('启用前必须配置企业 ID、机器人 Client ID 和允许发起任务的 userId。');
  return config;
}

// These are already normalized identity fields from the trusted Source adapter.
// Raw payloads (including sessionWebhook and secrets) must never be persisted.
export function selectMessage(input) {
  if (!object(input)) throw fault('消息必须是对象。');
  const message = {};
  for (const key of ['eventId', 'corpId', 'conversationId', 'senderId', 'robotCode']) message[key] = identifier(input[key], key);
  if (!['1', '2'].includes(input.conversationType)) throw fault('conversationType 必须是单聊 1 或群聊 2。');
  message.conversationType = input.conversationType;
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_MESSAGE_LENGTH || /\u0000/.test(input.text)) throw fault(`消息正文必须为 1–${MAX_MESSAGE_LENGTH} 字符的文本。`);
  message.text = input.text.trim();
  if (input.isInAtList !== undefined && typeof input.isInAtList !== 'boolean') throw fault('isInAtList 必须是布尔值。');
  message.isInAtList = input.isInAtList === true;
  return message;
}

export function authorizeMessage(input, configInput) {
  const config = normalizeConfig(configInput);
  if (!config.enabled) return { allowed: false, reason: 'source_disabled' };
  let message;
  try { message = selectMessage(input); } catch { return { allowed: false, reason: 'invalid_message' }; }
  if (message.corpId !== config.corpId || (input.senderCorpId !== undefined && input.senderCorpId !== config.corpId)) return { allowed: false, reason: 'corp_not_allowed' };
  if (message.robotCode !== config.clientId) return { allowed: false, reason: 'robot_not_allowed' };
  if (!config.allowedUserIds.includes(message.senderId)) return { allowed: false, reason: 'user_not_allowed' };
  if (message.conversationType === '2') {
    if (!config.allowedConversationIds.includes(message.conversationId)) return { allowed: false, reason: 'conversation_not_allowed' };
    if (!message.isInAtList) return { allowed: false, reason: 'robot_not_mentioned' };
  }
  return { allowed: true, reason: 'observe_only' };
}
