export const collectionLabels = { ideas: '选题', videos: '视频项目', drafts: '发布草稿', research: '观察', comments: '回复草稿', metrics: '效果记录', records: '知识记录' };
export const recordTitle = item => item.pubTitle || item.mTitle || item.title || item.comment || '未命名记录';

export function moveToTrash(state, collection, id) {
  if (!Object.hasOwn(collectionLabels, collection)) throw new Error('不支持删除这个集合。');
  const index = state[collection].findIndex(item => item.id === id);
  if (index < 0) throw new Error('记录已不存在。');
  const item = state[collection][index];
  state.trash ||= [];
  const entry = { id: crypto.randomUUID(), collection, item: structuredClone(item), deletedAt: new Date().toISOString() };
  state.trash.push(entry); state[collection].splice(index, 1);
  return entry;
}

export function restoreTrash(state, id) {
  const index = state.trash.findIndex(entry => entry.id === id);
  if (index < 0) throw new Error('回收站记录已不存在。');
  const entry = state.trash[index];
  if (!Object.hasOwn(collectionLabels, entry.collection)) throw new Error('记录类型不支持恢复。');
  if (state[entry.collection].some(item => item.id === entry.item.id)) throw new Error('工作区已有相同编号的记录，请先检查现有内容。');
  state[entry.collection].push(structuredClone(entry.item)); state.trash.splice(index, 1);
}

export function validateMetric(item) {
  if (!String(item.mTitle || item.title || '').trim()) throw new Error('请填写视频标题。');
  for (const key of ['plays', 'likes', 'mComments', 'shares', 'saves', 'followers', 'baseline', 'completion', 'retention', 'conversion']) {
    if (item[key] === '' || item[key] === undefined) continue;
    const number = Number(item[key]);
    if (!Number.isFinite(number) || number < 0 || (['completion', 'retention', 'conversion'].includes(key) ? number > 100 : !Number.isSafeInteger(number))) throw new Error('数量应为非负整数，百分比应在 0–100 之间。');
  }
  return item;
}
