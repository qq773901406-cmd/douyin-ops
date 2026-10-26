import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsCatalog } from '../server/operations-catalog.mjs';
import { restorePendingForm, operationRequestBody } from '../public/operations-form.js';
import { createOperations } from '../public/operations.js';

const definition = kind => operationsCatalog.find(row => row.kind === kind);
const storedAttempt = body => JSON.parse(JSON.stringify({ key: 'timeout-request-key', fingerprint: JSON.stringify(body) }));
function roundTrip(kind, form, intent = 'run') {
  const original = operationRequestBody(definition(kind), kind, form, intent), pending = storedAttempt(original);
  const restored = restorePendingForm(pending, operationsCatalog);
  assert.ok(restored); assert.equal(restored.kind, kind);
  const retried = operationRequestBody(definition(kind), restored.kind, restored.formDraft, intent);
  // The actual submit path reuses pending.key exactly when this fingerprint is unchanged.
  assert.equal(JSON.stringify(retried), pending.fingerprint);
  return { original, restored, pending };
}

test('重载恢复旧版 pending 记录中的任务类型、名称、输入和原始时间，重试指纹保持一致', () => {
  const { restored } = roundTrip('media.wan', {
    name: '已经超时的首帧任务', at: '2025-06-10T09:15', repeat: 'once', imagePath: 'D:\\ai\\图片\\首帧.png',
    prompt: '镜头缓慢移动\n保持人物一致', title: '自定义名称', duration: '3.5', seed: '0', platform: 'bilibili',
  });
  assert.equal(restored.formDraft.at, '2025-06-10T09:15');
  assert.equal(restored.formDraft.seed, 0);
  assert.equal(restored.formDraft.name, '已经超时的首帧任务');
});

test('恢复明确留空的默认 RSS，不重新注入默认来源，多行链接保留顺序', () => {
  const { restored, original } = roundTrip('content.research', {
    name: '仅研究指定网页', at: '2025-06-10T09:15', repeat: 'once', feedUrl: '',
    urls: 'https://example.com/b\nhttps://example.com/a', angle: '',
  });
  assert.equal(restored.formDraft.feedUrl, ''); assert.equal(Object.hasOwn(original.input, 'feedUrl'), false);
  assert.equal(restored.formDraft.urls, 'https://example.com/b\nhttps://example.com/a');
});

test('恢复每天和每周排期保留起始时间、时区、星期和启用意图', () => {
  for (const repeat of ['daily', 'weekly']) {
    const { restored, original } = roundTrip('workflow.news', {
      name: '周期资讯', at: '2025-06-10T09:15', repeat, feedUrl: 'https://www.ithome.com/rss/', keywords: '', platform: 'douyin', enqueue: false,
    }, 'schedule');
    assert.equal(restored.formDraft.repeat, repeat); assert.equal(restored.formDraft.enqueue, false);
    assert.equal(original.enabled, true); assert.equal(original.schedule.timezone, 'Asia/Shanghai');
  }
});

test('恢复多平台和复选框输入不丢选项，保存与运行可定位同一已创建任务', () => {
  const { original, restored, pending } = roundTrip('distribution.prepare', {
    name: '多平台发布准备', at: '2025-06-10T09:15', repeat: 'once', draftId: 'draft-01', platforms: ['douyin', 'xiaohongshu'],
  }, 'save');
  assert.deepEqual(restored.formDraft.platforms, ['douyin', 'xiaohongshu']);
  assert.equal(JSON.stringify(operationRequestBody(definition(original.kind), original.kind, restored.formDraft, 'run')), pending.fingerprint);
  const product = roundTrip('content.productResearch', {
    name: '商品研究', at: '2025-06-10T09:15', repeat: 'once', urls: 'https://example.com/product', downloadImages: true,
  });
  assert.equal(product.restored.formDraft.downloadImages, true);
});

test('用户明确修改输入、名称、排期或启用意图仍形成不同任务指纹', () => {
  const { restored, pending } = roundTrip('media.wan', {
    name: '原始任务', at: '2025-06-10T09:15', repeat: 'once', imagePath: 'D:\\ai\\first.png', prompt: '抬起手', duration: '3.5', seed: '42', platform: 'douyin',
  });
  for (const changes of [{ name: '另一条任务' }, { prompt: '向左转身' }, { at: '2025-06-11T09:15' }, { imagePath: 'D:\\ai\\second.png' }, { seed: '43' }]) {
    const changed = operationRequestBody(definition(restored.kind), restored.kind, { ...restored.formDraft, ...changes }, 'run');
    assert.notEqual(JSON.stringify(changed), pending.fingerprint);
  }
  assert.notEqual(JSON.stringify(operationRequestBody(definition(restored.kind), restored.kind, restored.formDraft, 'schedule')), pending.fingerprint);
});

test('损坏、缺少 key、未知类型或失效排期的 pending 记录不恢复', () => {
  const valid = operationRequestBody(definition('content.diagnosis'), 'content.diagnosis', { name: '诊断', at: '2025-06-10T09:15', repeat: 'once' }, 'save');
  for (const attempt of [null, {}, { key: '', fingerprint: JSON.stringify(valid) }, { key: 'key', fingerprint: '{' }, storedAttempt({ ...valid, kind: 'removed.kind' }), storedAttempt({ ...valid, input: [] }), storedAttempt({ ...valid, schedule: { type: 'once', at: 'invalid' } })]) {
    assert.equal(restorePendingForm(attempt, operationsCatalog), null);
  }
});

test('Wan 恢复入口只预填原任务表单，下拉仅显示 Wan 任务且不提交执行', async t => {
  const elements = new Map(['[data-ops-status]', '[data-ops-list]', '[data-ops-editor]'].map(key => [key, { textContent: '', innerHTML: '' }]));
  const page = { querySelector: selector => elements.get(selector) };
  const snapshot = {
    catalog: operationsCatalog, products: [], drafts: [], runs: [], scheduler: { running: true, busy: false },
    tasks: [
      { id: 'wan-original', name: '待恢复视频', kind: 'media.wan', status: 'unknown', schedule: { type: 'once' } },
      { id: 'other-task', name: '其他制作任务', kind: 'media.news', status: 'completed', schedule: { type: 'once' } },
    ],
  };
  const originalDocument = globalThis.document, originalStorage = globalThis.sessionStorage;
  globalThis.document = { getElementById: id => id === 'operations-root' ? page : null, addEventListener() {} };
  globalThis.sessionStorage = { getItem: () => null };
  t.after(() => { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; if (originalStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = originalStorage; });
  const requests = [], navigations = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => { requests.push({ path, method: options.method || 'GET' }); return { ok: true, json: async () => snapshot }; });
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const operations = createOperations({ notify() {}, go: value => navigations.push(value) });
  await operations.mount();
  assert.match(elements.get('[data-ops-list]').innerHTML, /data-operation-kind="media.wanRecover" data-source-task-id="wan-original"/);
  const entry = { dataset: { operationKind: 'media.wanRecover', sourceTaskId: 'wan-original' } };
  await operations.handleClick({ target: { closest: selector => selector === '[data-operation-kind]' ? entry : null } });
  const html = operations.render();
  assert.match(html, /<select name="taskId" id="ops-taskId" required>/);
  assert.match(html, /<option value="wan-original" selected>待恢复视频（结果待核实）<\/option>/);
  assert.doesNotMatch(html, /<option value="other-task"/);
  assert.deepEqual(navigations, ['operations']); assert.deepEqual(requests, [{ path: '/api/operations', method: 'GET' }]);
});
