// Local daily publishing queue. All schedule times use Asia/Shanghai (UTC+08:00).
export const automationStatuses = { pending: '待审批', approved: '已批准', running: '正在发布', submitted: '已提交待审核', published: '已确认发布', failed: '执行失败', uncertain: '结果待核实', missed: '已错过时间', cancelled: '已取消' };
export const editableStatuses = ['pending', 'failed', 'missed', 'cancelled'];
export const shanghaiDay = time => new Date(Number(time) + 8 * 3600000).toISOString().slice(0, 10);
export const defaultAutomation = () => ({ version: 1, config: { folder: '', dailyTime: '20:00', timeZone: 'Asia/Shanghai', enabled: false, browserId: '', accountId: '', verifiedAt: '' }, items: [], events: [] });
export function normalizeAutomation(input) {
  if (!input || input.version !== 1 || !input.config || !Array.isArray(input.items) || !Array.isArray(input.events)) throw new Error('自动发布数据格式不正确，请保留原文件检查。');
  const c = input.config;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.dailyTime) || c.timeZone !== 'Asia/Shanghai' || typeof c.enabled !== 'boolean') throw new Error('自动发布时间配置无效。');
  for (const key of ['folder', 'browserId', 'accountId', 'verifiedAt']) if (typeof c[key] !== 'string') throw new Error('自动发布设置格式无效。');
  const ids = new Set();
  for (const item of input.items) {
    if (!item || !/^[a-f0-9-]{36}$/.test(item.id) || ids.has(item.id) || !Object.hasOwn(automationStatuses, item.status) || typeof item.sourcePath !== 'string' || typeof item.fileName !== 'string' || typeof item.title !== 'string' || typeof item.caption !== 'string' || !Number.isFinite(item.sourceSize) || item.sourceSize <= 0 || !Number.isFinite(item.sourceMtime)) throw new Error('自动发布队列格式无效。');
    ids.add(item.id);
    if (['approved', 'running', 'submitted', 'published', 'uncertain'].includes(item.status)) {
      const a = item.approval;
      if (!a || !/^[a-f0-9]{64}$/.test(a.sha256) || typeof a.asset !== 'string' || !a.asset || typeof a.accountId !== 'string' || !a.accountId || typeof a.browserId !== 'string' || !a.browserId || !Number.isFinite(Date.parse(item.scheduledAt))) throw new Error('自动发布条目缺少完整审批记录。');
      if (a.title !== item.title || a.caption !== item.caption || a.scheduledAt !== item.scheduledAt) throw new Error('视频内容或排期与审批记录不一致，已停止读取。');
      validatePublishText(a.title, a.caption);
    }
  }
  return input;
}
export function nextSlot(items, dailyTime, now = Date.now()) {
  const used = new Set(items.filter(item => ['approved', 'running', 'submitted', 'published', 'uncertain'].includes(item.status)).map(item => shanghaiDay(Date.parse(item.scheduledAt))));
  for (let offset = 0; offset < 3660; offset++) {
    const day = shanghaiDay(now + offset * 86400000), at = new Date(`${day}T${dailyTime}:00+08:00`);
    if (at.getTime() > now + 60000 && !used.has(day)) return at.toISOString();
  }
  throw new Error('未来排期已满，请先整理队列。');
}
export function validatePublishText(title, caption) {
  if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 30) throw new Error('请填写 1–30 字的作品标题。');
  if (typeof caption !== 'string' || [...caption].length > 1000) throw new Error('发布文案不能超过 1000 字。');
  return { title: title.trim(), caption: caption.trim() };
}
