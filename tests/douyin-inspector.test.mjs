import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DouyinInspector, douyinWorkIdFromUrl, parseDouyinCardTime, parseDouyinMetrics, readDouyinManageDOM, readDouyinProfileDOM, selectDouyinCard, selectDouyinProfileWork } from '../server/douyin-inspector.mjs';

const workId = '1234567890123456789';
const target = {
  ref: 'queue:fixture', browserId: 'fixture-browser', accountId: 'fixture-account',
  sha256: 'a'.repeat(64),
  title: '测试作品', caption: '\n说明 #话题', submitStartedAt: '2026-10-20T02:00:30.000Z',
  boundWorkId: workId, boundUrl: `https://www.douyin.com/video/${workId}`,
};
const card = {
  title: '测试作品说明 #话题', time: '2026年10月20日 10:00', status: '已发布',
  cover: 'body > div:nth-of-type(1)',
  metrics: { 播放: '40', 点赞: '0', 评论: '0', 分享: '0', 收藏: '-', 完播率: '0%', '2秒跳出率': '62.22%', 吸粉量: '0' },
};
const manageUrl = 'https://creator.douyin.com/creator-micro/content/manage';
const preview = {
  url: `https://www.douyin.com/user/self?modal_id=${workId}`, accountIds: [target.accountId],
  items: [{ url: `https://www.douyin.com/video/${workId}`, title: card.title }],
};

function fixture({ cards = [card], freshCards = cards, managePages, manageSnapshots, search = null, manageTimeoutMs = 30000, pageAttempts = 2, accountId = target.accountId, previews = [preview], addedTabs = 1, userTab = true, defaultReader = false } = {}) {
  const calls = [];
  let clicked = false, readCount = 0, previewCount = 0, stopped = false, elapsed = 0;
  const publisher = {
    session: async (browserId, action) => {
      assert.equal(browserId, target.browserId);
      try { return await action('owned-session'); } finally { stopped = true; }
    },
    accountInSession: async () => ({ accountId }),
    command: async args => {
      calls.push(args);
      if (args[0] === 'navigate') return {};
      if (args[0] === 'evaluate' && args[1].includes('readDouyinProfileDOM')) return { value: previews[Math.min(previewCount++, previews.length - 1)] };
      if (args[0] === 'evaluate') {
        const pageCards = managePages ? managePages[Math.min(readCount, managePages.length - 1)] : readCount ? freshCards : cards;
        const snapshot = manageSnapshots ? manageSnapshots[Math.min(readCount, manageSnapshots.length - 1)] : { cards: pageCards, search };
        readCount++;
        return { value: { url: manageUrl, accountIds: [accountId], ...snapshot } };
      }
      if (['fill', 'press'].includes(args[0])) return {};
      if (args[0] === 'click') { clicked = true; return {}; }
      if (args[0] === 'tab' && args[1] === 'list') {
        const tabs = [{ tab_id: 1, active: !clicked, scope: 'agent', url: manageUrl }];
        if (userTab) tabs.push({ tab_id: 900, active: false, scope: 'user', url: 'https://example.com/user-tab' });
        if (clicked) for (let index = 0; index < addedTabs; index++) tabs.push({ tab_id: index + 2, active: index === 0, scope: 'agent', url: preview.url });
        return { tabs };
      }
      if (args[0] === 'tab' && args[1] === 'select') return {};
      throw new Error(`Unexpected command: ${args[0]}`);
    },
  };
  const inspector = new DouyinInspector({
    publisher, pause: async ms => { elapsed += ms; }, now: () => elapsed, manageTimeoutMs, pageAttempts, stableSamples: 3,
    ...(!defaultReader ? { previewReader: async () => previews[Math.min(previewCount++, previews.length - 1)] } : {}),
  });
  return { inspector, calls, stopped: () => stopped, previewCount: () => previewCount, elapsed: () => elapsed, manageReadCount: () => readCount };
}

test('未绑定作品只允许显式发现候选，不自动返回可投影观察', async () => {
  const f = fixture({ defaultReader: true });
  assert.equal(await f.inspector.inspect({ ...target, boundWorkId: '' }), null);
  assert.equal(f.calls.length, 0);
  const proposal = await f.inspector.discover({ ...target, boundWorkId: '', boundUrl: '' });
  assert.equal(proposal.requiresExplicitBinding, true);
  assert.equal(proposal.candidate.workId, workId);
  assert.equal(proposal.metadata.previewTitle, card.title);
  assert.deepEqual(proposal.bindingProof, {
    kind: 'douyin-rendered-dom-v1', targetRef: target.ref, browserId: target.browserId,
    assetSha256: target.sha256, submittedAt: target.submitStartedAt,
    accountId: target.accountId, workId, cardTitle: card.title, cardTime: '2026-10-20T02:00:00.000Z',
    previewTitle: card.title, previewUrl: preview.items[0].url, profileUrl: preview.url,
    cardMatches: 1, profileMatches: 1, stableSamples: 3,
  });
  assert.deepEqual(JSON.parse(proposal.candidate.evidence.text).bindingProof, proposal.bindingProof);
  assert.equal(f.stopped(), true);
});

test('绑定 ID、账号、稳定预览标题确认后返回审核和原始指标证据', async () => {
  const f = fixture();
  const result = await f.inspector.inspect(target);
  assert.equal(result.accountId, target.accountId);
  assert.equal(result.workId, workId);
  assert.equal(result.reviewState, 'published');
  assert.deepEqual(result.metrics, { plays: 40, likes: 0, mComments: 0, shares: 0, followers: 0, completion: 0 });
  assert.equal(result.publishedAt, '2026-10-20T02:00:00.000Z');
  const evidence = JSON.parse(result.evidence.text);
  assert.equal(evidence.previewTitle, card.title);
  assert.equal(evidence.rawMetrics['2秒跳出率'], '62.22%');
  assert.equal(f.previewCount(), 3);
  assert.equal(f.stopped(), true);
  assert.ok(f.calls.filter(args => args[0] === 'tab' && args[1] === 'list').every(args => args.includes('agent')));
  assert.deepEqual(f.calls.filter(args => args[0] === 'tab' && args[1] === 'select').map(args => args[2]), ['2', '1']);
  assert.ok(!f.calls.some(args => args.includes('borrow') || args.includes('close') || args.includes('900')));
});

test('元数据重复、账号不符和作品 ID 不符均不能归属到目标', async () => {
  const duplicated = fixture({ cards: [card, { ...card }] });
  assert.equal(await duplicated.inspector.inspect(target), null);
  assert.ok(!duplicated.calls.some(args => args[0] === 'click'));
  const otherAccount = fixture({ accountId: 'different-account' });
  await assert.rejects(otherAccount.inspector.inspect(target), /账号/);
  assert.equal(otherAccount.calls.length, 0);
  const otherId = fixture({ previews: [{ ...preview, items: [{ title: card.title, url: 'https://www.douyin.com/video/99999999' }] }] });
  assert.equal(await otherId.inspector.inspect(target), null);
  assert.ok([duplicated, otherAccount, otherId].every(f => f.stopped()));
});

test('中间跳转 ID 不作为结果，必须等到个人作品 anchor 连续稳定', async () => {
  const f = fixture({ previews: [
    { ...preview, items: [{ title: '其他作品', url: 'https://www.douyin.com/video/99999999' }] },
    { ...preview, items: [] },
    preview, preview, preview,
  ] });
  assert.equal((await f.inspector.inspect(target)).workId, workId);
  assert.equal(f.previewCount(), 5);
  const wrongTitle = fixture({ previews: [{ ...preview, items: [{ title: '推荐列表中的其他作品', url: preview.items[0].url }] }] });
  assert.equal(await wrongTitle.inspector.inspect(target), null);
  const autoplay = fixture({ previews: [
    { ...preview, url: 'https://www.douyin.com/user/self?modal_id=55555555' },
    { ...preview, url: 'https://www.douyin.com/user/self?modal_id=66666666' },
    { ...preview, url: 'https://www.douyin.com/user/self?modal_id=77777777' },
  ] });
  assert.equal((await autoplay.inspector.inspect(target)).workId, workId);
});

test('多个新标签或返回后的卡片变化停止回采，仍只清理自己的会话', async () => {
  const multiple = fixture({ addedTabs: 2 });
  assert.equal(await multiple.inspector.inspect(target), null);
  assert.ok(!multiple.calls.some(args => args[0] === 'tab' && args[1] === 'select'));
  const changed = fixture({ freshCards: [{ ...card, time: '2026年10月20日 10:01' }] });
  assert.equal(await changed.inspector.inspect(target), null);
  assert.equal(multiple.stopped(), true);
  assert.equal(changed.stopped(), true);
});

test('作品搜索等到异步列表匹配目标，不将旧卡片提前判为未找到', async () => {
  const other = { ...card, title: '其他作品' };
  const search = 'body > input:nth-of-type(1)';
  const f = fixture({ search, pageAttempts: 4, managePages: [[other], [other], [card], [card]] });
  const result = await f.inspector.inspect(target);
  assert.equal(result.workId, workId);
  assert.deepEqual(f.calls.filter(args => ['fill', 'press'].includes(args[0])), [
    ['fill', '--selector', search, '--value', target.title, '--session', 'owned-session', '--timeout', '30000ms'],
    ['press', 'Enter', '--selector', search, '--session', 'owned-session', '--timeout', '30000ms'],
  ]);
  assert.equal(f.stopped(), true);
  const absent = fixture({ search, pageAttempts: 4, cards: [other] });
  await assert.rejects(absent.inspector.inspect(target), /作品搜索结果等待超时/);
  assert.equal(absent.calls.some(args => args[0] === 'click'), false);
});

test('管理页前两轮加载、第三轮搜索后慢响应仍在总截止时间内找到唯一作品', async () => {
  const search = 'body > input:nth-of-type(1)', other = { ...card, title: '其他作品' };
  const f = fixture({ manageSnapshots: [
    { cards: [], search: null }, { cards: [], search: null },
    { cards: [other], search }, { cards: [other], search }, { cards: [], search },
    { cards: [other], search }, { cards: [], search }, { cards: [card], search },
  ] });
  assert.equal((await f.inspector.inspect(target)).workId, workId);
  assert.ok(f.manageReadCount() > 5);
  assert.ok(f.elapsed() < 30000);
  assert.equal(f.calls.filter(args => args[0] === 'fill').length, 1);
  assert.equal(f.calls.filter(args => args[0] === 'press').length, 1);
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 1);
  assert.equal(f.stopped(), true);
});

test('管理页与搜索超时明确区分阶段，不输出文案且不会点击其他卡片', async () => {
  const search = 'body > input:nth-of-type(1)';
  const loading = fixture({ cards: [] });
  await assert.rejects(loading.inspector.inspect(target), error => /作品管理页加载超时/.test(error.message) && !error.message.includes(target.caption));
  assert.equal(loading.elapsed(), 30000);
  assert.equal(loading.calls.some(args => ['fill', 'press', 'click'].includes(args[0])), false);
  assert.equal(loading.stopped(), true);
  const searching = fixture({ manageSnapshots: [
    { cards: [], search: null }, { cards: [], search: null },
    { cards: [{ ...card, title: '无关作品' }], search },
  ] });
  await assert.rejects(searching.inspector.inspect(target), error => /作品搜索结果等待超时/.test(error.message) && !error.message.includes(target.caption));
  assert.equal(searching.elapsed(), 30000);
  assert.equal(searching.calls.some(args => args[0] === 'click'), false);
  assert.equal(searching.calls.filter(args => args[0] === 'fill').length, 1);
  assert.equal(searching.stopped(), true);
  const ambiguous = fixture({ search, cards: [card, { ...card }] });
  assert.equal(await ambiguous.inspector.inspect(target), null);
  assert.equal(ambiguous.calls.some(args => args[0] === 'click'), false);
});

test('私密、缺失、缩略和不合法指标不补零，百分比保留真实零值', () => {
  assert.deepEqual(parseDouyinMetrics({ 播放: '-', 点赞: '', 评论: null, 分享: '1.2万', 收藏: '-1', 吸粉量: '9007199254740992', 完播率: '101%' }), {});
  assert.deepEqual(parseDouyinMetrics({ 播放: '1,234', 点赞: '0', 完播率: '62.22%', '2秒跳出率': '50%' }), { plays: 1234, likes: 0, completion: 62.22 });
  assert.deepEqual(parseDouyinMetrics({ 播放: '1,23', 完播率: '0%' }), { completion: 0 });
});

test('作品 URL 严格校验 ID；时间真实有效且标题仅精确匹配', () => {
  assert.equal(douyinWorkIdFromUrl(preview.url), workId);
  for (const url of [
    'https://example.com/video/123', 'https://www.douyin.com.evil.test/video/123',
    'https://user:password@www.douyin.com/video/123', 'http://www.douyin.com/video/123',
    'https://www.douyin.com/user/self?modal_id=123&modal_id=456',
    'https://www.douyin.com/video/123?modal_id=456',
  ]) assert.equal(douyinWorkIdFromUrl(url), null);
  assert.equal(parseDouyinCardTime('2026年2月30日 10:00'), null);
  assert.equal(parseDouyinCardTime('2024年2月29日 10:00'), '2024-02-29T02:00:00.000Z');
  assert.equal(selectDouyinCard([{ ...card, title: card.title + '追加文字' }], target), null);
  assert.equal(selectDouyinCard([{ ...card, time: '2026年10月19日 10:00' }], target), null);
  assert.equal(selectDouyinCard([card], { ...target, submitStartedAt: '' }), null);
  assert.equal(selectDouyinCard([card], target), card);
  assert.equal(selectDouyinProfileWork({ ...preview, accountIds: ['other-account'] }, card.title, target.accountId), null);
  assert.equal(selectDouyinProfileWork({ ...preview, url: 'https://www.douyin.com/user/other' }, card.title, target.accountId), null);
  assert.equal(selectDouyinProfileWork({ ...preview, items: [...preview.items, ...preview.items] }, card.title, target.accountId), null);
});

test('DOM 指标读取不把 metric-item-container 作为第二条指标', () => {
  const node = (innerText = '', extra = {}) => ({
    innerText, textContent: innerText, nodeType: 1, tagName: 'DIV', className: '', children: [],
    parentElement: null, getClientRects: () => [1], querySelectorAll: () => [], ...extra,
  });
  const metric = node('播放40', {
    className: 'metric-item-abc',
    querySelectorAll: selector => selector.includes('metric-label-') ? [node('播放')] : selector.includes('metric-value-') ? [node('40')] : [],
  });
  const container = node('播放40', { ...metric, className: 'metric-item-container-abc', children: [metric] });
  const domCard = node('测试作品已发布播放40', {
    querySelectorAll: selector => {
      if (selector.includes('info-title-text-')) return [node(card.title)];
      if (selector.includes('info-time-')) return [node(card.time)];
      if (selector.includes('info-status-')) return [node(card.status)];
      if (selector.includes('video-card-cover-')) return [node()];
      if (selector.includes('metric-item-')) return [container, metric];
      return [];
    },
  });
  const result = vm.runInNewContext(`(${readDouyinManageDOM.toString()})()`, {
    document: { querySelectorAll: selector => selector.includes('video-card-content-') ? [domCard] : [] },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), location: { href: manageUrl },
  });
  assert.equal(result.cards[0].metrics.播放, '40');
});

test('个人作品 DOM 仅采集已观察列表里的可见段落和作品链接', () => {
  const title = { innerText: card.title, getClientRects: () => [1] };
  const hiddenTitle = { ...title, getClientRects: () => [] };
  const anchor = { href: preview.items[0].url, getClientRects: () => [1], querySelectorAll: selector => selector === 'p' ? [hiddenTitle, title, { ...title }] : [] };
  const hiddenAnchor = { ...anchor, getClientRects: () => [] };
  const ambiguousAnchor = { ...anchor, querySelectorAll: () => [title, { ...title, innerText: '另一条可见标题' }] };
  const onlyHiddenAnchor = { ...anchor, querySelectorAll: () => [hiddenTitle] };
  const selectors = [];
  const result = vm.runInNewContext(`(${readDouyinProfileDOM.toString()})()`, {
    document: {
      body: { innerText: `个人主页\n抖音号：${target.accountId}\n作品` },
      querySelectorAll: selector => { selectors.push(selector); return [anchor, hiddenAnchor, ambiguousAnchor, onlyHiddenAnchor]; },
    },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), location: { href: preview.url },
  });
  assert.deepEqual(selectors, ['ul[data-e2e="scroll-list"] a[href]']);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, card.title);
  assert.equal(result.accountIds[0], target.accountId);
});
