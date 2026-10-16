import { validateVideo } from './video-projects.mjs';
import { collectionLabels } from './workspace-actions.mjs';
import { validateProduct } from './shop-products.mjs';

export const collections = ['records', 'drafts', 'metrics', 'ideas', 'research', 'comments', 'videos', 'products'];

export function normalizeState(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('工作区必须是 JSON 对象。');
  const state = { account: '我的账号', persona: '', audience: '', pillars: '', diagnosis: null, ...input };
  if (input.schemaVersion && input.schemaVersion > 5) throw new Error('数据来自更新的软件版本，请先升级工作台。');
  state.schemaVersion = 5;
  state.trash = input.trash ?? [];
  if (!Array.isArray(state.trash) || state.trash.some(entry => !entry || typeof entry.id !== 'string' || !Object.hasOwn(collectionLabels, entry.collection) || !entry.item || typeof entry.item !== 'object' || Array.isArray(entry.item))) throw new Error('回收站数据格式不正确。');
  for (const key of ['account', 'persona', 'audience', 'pillars']) {
    if (typeof state[key] !== 'string') throw new Error(`${key} 必须是文本。`);
  }
  for (const key of collections) {
    state[key] = input[key] ?? [];
    if (!Array.isArray(state[key]) || state[key].some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error(`${key} 必须是记录列表。`);
    }
    const ids = new Set();
    for (const item of state[key]) {
      if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error(`${key} 中存在缺失或重复的记录编号。`);
      ids.add(item.id);
    }
  }
  const trashIds = new Set();
  for (const entry of state.trash) {
    if (!entry.id || trashIds.has(entry.id) || typeof entry.item.id !== 'string' || !entry.item.id) throw new Error('回收站中存在缺失或重复的记录编号。');
    trashIds.add(entry.id);
    if (entry.collection === 'videos') entry.item = validateVideo(entry.item);
    if (entry.collection === 'products') entry.item = validateProduct(entry.item);
  }
  if (state.diagnosis !== null && (!Array.isArray(state.diagnosis?.scores) || state.diagnosis.scores.length !== 5 || state.diagnosis.scores.some(n => !Number.isFinite(n) || n < 1 || n > 5))) {
    throw new Error('诊断需要五个 1–5 分的评分。');
  }
  state.videos = state.videos.map(video => {
    if (typeof video.id !== 'string' || !video.id) throw new Error('视频项目缺少 id。');
    return validateVideo(video);
  });
  state.products = state.products.map(validateProduct);
  return state;
}
