// Observation mode produces a local preview only. This module has no network
// client, webhook storage, outgoing queue or automatic delivery side effects.
export function observationReceipt(ticket) {
  return {
    delivery: 'preview-only', sent: false,
    text: `已记录观察任务 ${ticket.id}。当前仅验证消息接收和任务登记，尚未启动代码执行。`,
  };
}
