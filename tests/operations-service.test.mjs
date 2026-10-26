import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationsService } from '../server/operations-service.mjs';

const items = [{ id: 'source-1', title: '实际来源标题', url: 'https://www.ithome.com/0/1.htm', publishedAt: '2026-10-23T07:00:00Z', sourceName: 'IT之家', sourceUrl: 'https://www.ithome.com/rss/' }];
const draft = { id: 'draft-1', platform: 'douyin', format: '视频', asset: 'D:\\fixtures\\verified.mp4', title: '成片', caption: '来源摘要', hashtags: '#资讯' };
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'operations-service-'));
  const calls = [], workspace = { read: async () => ({ value: { drafts: [draft], products: [] } }), update: async () => {} };
  const content = { validate: (_, input) => input, sources: async () => ({ sources: [], warnings: [] }), handlers: () => ({ capture: { readOnly: true, validate: input => input, execute: async input => ({ status: 'completed', output: input }) } }),
    run: async (kind, input) => { calls.push({ stage: kind, input }); return kind === 'research' ? { status: 'completed', output: { ids: ['research-1'], articles: items } } : { status: 'completed', output: { ids: ['idea-1'] } }; } };
  const media = { handlers: () => Object.fromEntries(['news', 'product'].map(kind => [`media.${kind}`, { readOnly: true, validate: input => input, execute: async input => { calls.push({ stage: 'media', input }); return { status: 'completed', output: { draftId: draft.id, artifact: draft.asset } }; } }])) };
  const automation = { publisher: {}, snapshot: async () => ({ revision: 'queue-revision' }), importDraft: async (input, revision) => { calls.push({ stage: 'queue', input, revision }); return { added: true, id: 'queue-1', status: 'pending' }; } };
  const dailyProduction = { store: { read: async () => ({ value: { config: { browserId: 'current-browser', accountId: '138528608' } } }) } };
  const bilibili = { handlers: () => ({}), snapshot: async () => ({ items: [] }) };
  const service = new OperationsService(directory, { workspace, content, media, automation, dailyProduction, bilibili, ...overrides });
  t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
  return { service, calls, content, media, workspace, automation };
}

test('资讯生产按真实来源→选题→制作→待审批顺序执行，绝不声明已发布', async t => {
  const { service, calls } = await fixture(t), handler = service.workflowHandler('news');
  const input = handler.validate({ feedUrl: 'https://www.ithome.com/rss/', enqueue: true });
  const result = await handler.execute(input, {});
  assert.deepEqual(calls.map(call => call.stage), ['research', 'ideas', 'media', 'queue']);
  assert.deepEqual(calls[2].input.items, items); assert.equal(calls[3].revision, 'queue-revision');
  assert.equal(calls[3].input.asset, draft.asset); assert.equal(result.output.publicationSubmitted, false);
  assert.deepEqual(result.output.researchIds, ['research-1']); assert.equal(result.output.queue.status, 'pending');
});

test('来源失败或没有文章时停止，不继续制作或入队', async t => {
  const { service, calls, content } = await fixture(t);
  content.run = async () => ({ status: 'requires_action', output: { reason: 'RSS 不可用' } });
  const handler = service.workflowHandler('news'); let result = await handler.execute(handler.validate({ enqueue: true }), {});
  assert.equal(result.status, 'requires_action'); assert.equal(calls.length, 0);
  content.run = async () => ({ status: 'completed', output: { ids: [], articles: [] } });
  result = await handler.execute(handler.validate({ enqueue: true }), {}); assert.equal(result.status, 'requires_action'); assert.equal(calls.length, 0);
});

test('制作 requires_action 不入队；生成错误平台草稿也不能进入抖音队列', async t => {
  const { service, calls, media, workspace } = await fixture(t);
  const handler = service.workflowHandler('news'), input = handler.validate({ enqueue: true });
  media.handlers = () => ({ 'media.news': { execute: async () => ({ status: 'requires_action', output: { reason: '编码器未配置' } }) } });
  assert.equal((await handler.execute(input, {})).status, 'requires_action'); assert.ok(!calls.some(call => call.stage === 'queue'));
  media.handlers = () => ({ 'media.news': { execute: async () => ({ status: 'completed', output: { draftId: draft.id } }) } });
  workspace.read = async () => ({ value: { drafts: [{ ...draft, platform: 'bilibili' }], products: [] } });
  await assert.rejects(handler.execute(input, {}), /只支持抖音视频/); assert.ok(!calls.some(call => call.stage === 'queue'));
});

test('B站只生成对应草稿，入队参数直接拒绝；商品流程不冒充采集新闻', async t => {
  const { service, calls } = await fixture(t), news = service.workflowHandler('news'), product = service.workflowHandler('product');
  assert.throws(() => news.validate({ platform: 'bilibili', enqueue: true }), /B站草稿不能加入/);
  const result = await product.execute(product.validate({ productId: 'product-1', platform: 'bilibili' }), {});
  assert.deepEqual(calls.map(call => call.stage), ['media']); assert.equal(calls[0].input.platform, 'bilibili'); assert.equal(result.output.publicationSubmitted, false);
});

test('取消发生在成片后不再入队；content.capture 自动注入当前账号绑定', async t => {
  const { service, calls } = await fixture(t), handler = service.workflowHandler('news'), controller = new AbortController(); controller.abort();
  await assert.rejects(handler.execute(handler.validate({ enqueue: true }), { signal: controller.signal }), /已取消/); assert.ok(!calls.some(call => call.stage === 'queue'));
  const capture = service.runner.handler('content.capture'); const result = await capture.execute({ url: 'https://www.douyin.com/video/123' }, {});
  assert.equal(result.output.browserId, 'current-browser'); assert.equal(result.output.accountId, '138528608');
});
