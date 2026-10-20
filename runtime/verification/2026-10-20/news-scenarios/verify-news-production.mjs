import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import https from 'node:https';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { JsonStore } from '../../../../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../../../../workbuddy/connector/lib/workspace-model.mjs';
import { defaultAutomation, normalizeAutomation } from '../../../../shared/automation-model.mjs';

const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const root = resolve(scriptRoot, process.argv[2] || 'preflight');
const outputRelative = relative(scriptRoot, root);
if (outputRelative === '..' || outputRelative.startsWith('..' + sep) || isAbsolute(outputRelative)) throw new Error('Output must stay inside news-scenarios.');
await mkdir(root, { recursive: true });
try { await stat(join(root, 'results.json')); throw new Error('Use a new output subdirectory to preserve prior evidence.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const RealDate = Date;
const startedAt = new RealDate().toISOString();
let testTime = RealDate.parse('2026-10-20T06:00:00+08:00');
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [testTime])); }
  static now() { return testTime; }
};
const at = iso => { testTime = RealDate.parse(iso); };
const files = ['server/daily-production.mjs', 'server/news-source.mjs', 'server/news-video.mjs', 'tools/news_feed/parse.py', 'tools/news_video/render.py', 'server/product-video.mjs', 'workbuddy/connector/lib/workspace-model.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async path => [path, createHash('sha256').update(await readFile(resolve(sourceRoot, path))).digest('hex')])));
const sourceHashesBefore = await hashes();
const routes = new Map(), networkLog = [], checks = [], services = [];
const fixtureHost = 'feeds.example.com';
const server = createServer((req, res) => {
  const fixture = routes.get(req.url);
  networkLog.push({ path: req.url, simulationTime: new Date().toISOString(), status: fixture?.status || 404 });
  res.writeHead(fixture?.status || 404, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
  res.end(fixture?.body || 'missing fixture');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const originalRequest = https.request, originalLookup = dnsPromises.lookup;
dnsPromises.lookup = async (hostname, options) => {
  assert.equal(hostname, fixtureHost, 'Unexpected network destination');
  const record = { address: '93.184.216.34', family: 4 };
  return options?.all ? [record] : record;
};
https.request = (url, options, callback) => {
  assert.equal(url.hostname, fixtureHost, 'Unexpected network destination');
  return httpRequest(new URL(url.pathname + url.search, `http://127.0.0.1:${port}`), {
    method: options.method, headers: options.headers, agent: false,
  }, callback);
};
syncBuiltinESMExports();
const { DailyProduction } = await import('../../../../server/daily-production.mjs');
const { collectNews } = await import('../../../../server/news-source.mjs');
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const item = (id, extra = {}) => ({ title: `隔离测试科技资讯${id}`, url: `https://news.example.com/articles/${id}?source=feed&edition=cn`, publishedAt: new RealDate(testTime - (Number(id) || 1) * 60000).toISOString(), ...extra });
function rss(items) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>隔离验收科技源</title><link>https://news.example.com/</link>${items.map(i => `<item><title>${esc(i.title)}</title><link>${esc(i.url)}</link>${i.publishedAt ? `<pubDate>${esc(i.publishedAt)}</pubDate>` : ''}</item>`).join('')}</channel></rss>`;
}
async function route(name, body, status = 200) {
  const path = `/${name}.xml`;
  routes.set(path, { body, status });
  await mkdir(join(root, 'fixtures'), { recursive: true });
  await writeFile(join(root, 'fixtures', `${name}-${status}-${networkLog.length}.xml`), body);
  return `https://${fixtureHost}${path}`;
}
async function setup(name, articles = [item(1), item(2), item(3)]) {
  const dir = join(root, name), feedUrl = await route(name, rss(articles));
  const workspace = new JsonStore(join(dir, 'workspace.json'), normalizeState(), normalizeState);
  await workspace.replace(normalizeState());
  const store = new JsonStore(join(dir, 'automation', 'queue.json'), defaultAutomation(), normalizeAutomation);
  await store.update(s => Object.assign(s.config, { accountId: 'TEST-ACCOUNT', browserId: 'TEST-BROWSER', verifiedAt: new Date().toISOString() }));
  const calls = [];
  let leases = 0, releases = 0;
  const automation = {
    store,
    lease: async () => { leases++; return async () => { releases++; }; },
    publisher: { publish: async (request, hooks) => {
      calls.push({ simulation: true, title: request.approval.title, asset: request.approval.asset, at: new Date().toISOString() });
      await hooks.guard(); await hooks.beforeSubmit();
      return { message: 'SIMULATED submission only; no browser or platform contacted.', evidence: { simulation: true } };
    } },
  };
  const daily = new DailyProduction(dir, workspace, automation);
  services.push(daily);
  await daily.store.update(s => Object.assign(s.config, {
    sourceMode: 'news', newsFeedUrl: feedUrl, newsKeywords: '', enabled: true, startTime: '06:00',
    accountId: 'TEST-ACCOUNT', browserId: 'TEST-BROWSER', authorizedAt: '2026-10-19T10:00:00.000Z', firstDay: '2026-10-20',
  }));
  return { dir, feedUrl, daily, workspace, calls, automation, leaseCounts: () => ({ leases, releases }) };
}
async function verify(name, run) {
  at('2026-10-20T06:00:00+08:00');
  const begin = performance.now();
  try { checks.push({ name, result: 'PASS', ...(await run()), elapsedMs: Math.round(performance.now() - begin) }); }
  catch (error) { checks.push({ name, result: 'FAIL', error: error.stack, elapsedMs: Math.round(performance.now() - begin) }); }
  console.log(JSON.stringify(checks.at(-1)));
  await writeFile(join(root, 'results.partial.json'), JSON.stringify(checks, null, 2));
}

try {
  await verify('rss-fetch-parse-date-filter-and-title-deduplication', async () => {
    const url = await route('rss-contract', rss([
      item(1), item('duplicate', { title: '隔离 测试科技资讯1' }), item(2),
      item('stale', { publishedAt: new RealDate(testTime - 49 * 3600000).toISOString() }),
      item('future', { publishedAt: new RealDate(testTime + 11 * 60000).toISOString() }),
      item('no-date', { publishedAt: '' }), item('private-link', { url: 'http://127.0.0.1/private' }),
    ]));
    const result = await collectNews({ feedUrl: url, keywords: '' }, join(root, 'rss-collection'));
    assert.equal(result.items.length, 2);
    assert.equal(new Set(result.items.map(i => i.id)).size, 2);
    assert.ok(result.items.every(i => i.url.includes('?source=feed&edition=cn')));
    assert.ok(result.warnings.some(w => w.includes('48 小时')));
    assert.ok(result.warnings.some(w => w.includes('日期和时区')));
    assert.ok(result.warnings.some(w => w.includes('非公开')));
    await writeFile(join(root, 'rss-collection.json'), JSON.stringify(result, null, 2));
    return { itemCount: result.items.length, warnings: result.warnings };
  });
  await verify('atom-and-keyword-filter', async () => {
    const url = await route('atom-contract', `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>ATOM科技来源</title><entry><title>人工智能芯片测试进展</title><link href="https://news.example.com/ai-chip"/><published>${new Date(testTime - 60000).toISOString()}</published></entry><entry><title>天文观测新消息</title><link href="https://news.example.com/space"/><updated>${new Date(testTime - 120000).toISOString()}</updated></entry></feed>`);
    const result = await collectNews({ feedUrl: url, keywords: '芯片，机器人' }, join(root, 'atom-collection'));
    assert.equal(result.items.length, 1); assert.equal(result.items[0].title, '人工智能芯片测试进展');
    return { itemCount: result.items.length, title: result.items[0].title, sourceName: result.items[0].sourceName };
  });
  await verify('preview-daily-limit-cross-day-dedup-and-empty-day', async () => {
    const ctx = await setup('daily-pipeline', [item(1), item(2), item(3), item(4)]);
    const first = await ctx.daily.syncSource(), second = await ctx.daily.syncSource();
    assert.equal(first.added, 4); assert.equal(second.added, 0); assert.equal(second.existing, 4);
    await ctx.daily.store.update(s => { s.config.enabled = false; });
    await ctx.daily.run(true);
    let saved = (await ctx.daily.store.read()).value;
    assert.equal(saved.runs[0].status, 'preview'); assert.equal(ctx.calls.length, 0);
    assert.equal(saved.runs[0].sourceArticles.length, 3); assert.equal(saved.runs[0].seconds, 36);
    await ctx.daily.store.update(s => { s.config.enabled = true; });
    await ctx.daily.run(); await ctx.daily.run();
    saved = (await ctx.daily.store.read()).value;
    assert.equal(ctx.calls.length, 1); assert.equal(saved.runs.length, 2);
    assert.deepEqual(saved.runs[0].newsItemIds, saved.runs[1].newsItemIds);
    at('2026-10-21T06:00:00+08:00');
    await ctx.daily.run(); await ctx.daily.run();
    saved = (await ctx.daily.store.read()).value;
    assert.equal(ctx.calls.length, 2); assert.equal(saved.runs[2].sourceArticles.length, 1);
    assert.equal(saved.runs[2].seconds, 20);
    assert.ok(saved.runs[2].newsItemIds.every(id => !saved.runs[1].newsItemIds.includes(id)));
    at('2026-10-22T06:00:00+08:00');
    await ctx.daily.run(); await ctx.daily.run();
    saved = (await ctx.daily.store.read()).value;
    assert.equal(saved.runs.length, 4); assert.equal(saved.runs[3].status, 'skipped');
    assert.equal(saved.config.enabled, true); assert.equal(ctx.calls.length, 2);
    const workspace = (await ctx.workspace.read()).value;
    assert.equal(workspace.videos.length, 3); assert.equal(workspace.drafts.length, 3);
    assert.equal(workspace.products.length, 0);
    assert.ok(workspace.videos.every(v => v.provider === '本地资讯图卡字幕合成' && v.cost === '0'));
    assert.ok(workspace.drafts.every(d => d.sourceMode === 'news' && d.status === '待检查'));
    const preview = saved.runs[0], sources = JSON.parse(await readFile(join(preview.directory, 'sources.json'), 'utf8'));
    assert.equal(sources.sources.length, 3);
    for (const article of preview.sourceArticles) assert.ok(preview.caption.includes(article.url));
    assert.ok((await stat(preview.asset)).size > 1000);
    await writeFile(join(ctx.dir, 'fake-publisher-calls.json'), JSON.stringify(ctx.calls, null, 2));
    return { evidenceDirectory: ctx.dir, statuses: saved.runs.map(r => ({ day: r.day, status: r.status, previewOnly: r.previewOnly, sourceCount: r.sourceArticles?.length || 0 })), realRenderedVideo: preview.asset, introCard: join(preview.directory, 'cards', 'intro.png'), newsCard: join(preview.directory, 'cards', 'news-1.png'), simulatedPublisherCalls: ctx.calls.length, ...ctx.leaseCounts() };
  });
  await verify('no-new-news-skips-with-plan-enabled', async () => {
    const ctx = await setup('empty-news', []);
    const before = networkLog.length;
    await ctx.daily.run(); await ctx.daily.run();
    const saved = (await ctx.daily.store.read()).value;
    assert.equal(saved.runs.length, 1); assert.equal(saved.runs[0].status, 'skipped');
    assert.equal(saved.config.enabled, true); assert.equal(ctx.calls.length, 0);
    assert.equal(networkLog.length - before, 1);
    assert.equal((await ctx.workspace.read()).value.videos.length, 0);
    return { evidenceDirectory: ctx.dir, status: saved.runs[0].status, enabled: saved.config.enabled, message: saved.runs[0].message };
  });
  await verify('source-outage-no-cache-skips-with-plan-enabled', async () => {
    const ctx = await setup('source-unavailable');
    await route('source-unavailable', 'SIMULATED source outage', 503);
    await ctx.daily.run();
    const saved = (await ctx.daily.store.read()).value;
    assert.equal(saved.runs[0].status, 'skipped'); assert.equal(saved.config.enabled, true);
    assert.equal(ctx.calls.length, 0);
    assert.ok(saved.runs[0].warnings.some(w => w.includes('503')));
    return { evidenceDirectory: ctx.dir, status: saved.runs[0].status, warnings: saved.runs[0].warnings };
  });
  await verify('source-outage-reuses-fresh-cache', async () => {
    const ctx = await setup('cache-fallback', [item(1)]);
    await ctx.daily.syncSource();
    await route('cache-fallback', 'SIMULATED source outage', 503);
    await ctx.daily.run();
    const saved = (await ctx.daily.store.read()).value;
    assert.equal(saved.runs[0].status, 'submitted'); assert.equal(ctx.calls.length, 1);
    assert.ok(saved.runs[0].warnings.some(w => w.includes('48 小时内的缓存')));
    return { evidenceDirectory: ctx.dir, status: saved.runs[0].status, simulatedPublisherCalls: ctx.calls.length, warnings: saved.runs[0].warnings };
  });
  await verify('submit-exception-protected-no-retry', async () => {
    const ctx = await setup('uncertain-submit', [item(1)]);
    ctx.automation.publisher.publish = async (request, hooks) => {
      ctx.calls.push({ simulation: true, asset: request.approval.asset });
      await hooks.guard(); await hooks.beforeSubmit();
      throw new Error('SIMULATED connection loss after submit');
    };
    await ctx.daily.run(); await ctx.daily.run();
    at('2026-10-21T06:00:00+08:00'); await ctx.daily.run();
    const saved = (await ctx.daily.store.read()).value;
    assert.equal(saved.runs.length, 1); assert.equal(saved.runs[0].status, 'uncertain');
    assert.ok(saved.runs[0].submitStartedAt); assert.equal(saved.config.enabled, false);
    assert.equal(ctx.calls.length, 1);
    assert.equal((await ctx.workspace.read()).value.drafts[0].productionStatus, 'uncertain');
    return { evidenceDirectory: ctx.dir, status: saved.runs[0].status, simulatedPublisherCalls: ctx.calls.length, enabled: saved.config.enabled };
  });
  await verify('beijing-six-oclock-and-expiry', async () => {
    const ctx = await setup('time-boundary', []);
    at('2026-10-20T05:59:59.999+08:00'); await ctx.daily.run();
    assert.equal((await ctx.daily.store.read()).value.runs.length, 0);
    at('2026-10-20T06:00:00.000+08:00'); await ctx.daily.run();
    assert.equal((await ctx.daily.store.read()).value.runs[0].status, 'skipped');
    const late = await setup('too-late');
    at('2026-10-20T12:00:00.001+08:00');
    const before = networkLog.length;
    await late.daily.run();
    assert.equal((await late.daily.store.read()).value.runs[0].status, 'skipped');
    assert.equal(networkLog.length, before);
    return { evidenceDirectories: [ctx.dir, late.dir], before06RunCount: 0, at06RunCount: 1, after12Fetched: false };
  });
  await verify('source-change-disables-authorization-and-clears-cache', async () => {
    const ctx = await setup('source-change', [item(1)]);
    await ctx.daily.syncSource();
    const before = await ctx.daily.store.read();
    await ctx.daily.contentSource({ mode: 'news', feedUrl: ctx.feedUrl, keywords: '人工智能' }, before.revision);
    const saved = (await ctx.daily.store.read()).value;
    assert.equal(saved.config.enabled, false); assert.equal(saved.config.authorizedAt, '');
    assert.equal(saved.newsItems.length, 0); assert.equal(saved.newsLastSync, null);
    assert.equal(ctx.calls.length, 0);
    return { evidenceDirectory: ctx.dir, enabled: saved.config.enabled, remainingCache: saved.newsItems.length };
  });
  await verify('local-source-and-entity-declarations-rejected', async () => {
    const before = networkLog.length;
    await assert.rejects(collectNews({ feedUrl: 'http://127.0.0.1/rss' }, join(root, 'invalid-source')));
    assert.equal(networkLog.length, before);
    const url = await route('entity-contract', '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a SYSTEM "file:///C:/secret">]><rss><channel><title>&a;</title></channel></rss>');
    await assert.rejects(collectNews({ feedUrl: url }, join(root, 'entity-source')), /DOCTYPE|实体/);
    return { localSourceFetched: false, entityFeedRejected: true };
  });
} finally {
  for (const service of services) service.stop();
  const sourceHashesAfter = await hashes();
  const report = {
    startedAt, finishedAt: new RealDate().toISOString(), root,
    scope: 'Real DailyProduction, collectNews RSS/Atom parser, JsonStore, normalizeState and offline Pillow/FFmpeg news rendering. HTTPS/DNS transport adapted only inside this process to a local HTTP fixture. Publisher stub only; no platform/browser or external network contacted.',
    sourceHashesBefore, sourceHashesAfter, sourcesChangedDuringVerification: files.filter(path => sourceHashesBefore[path] !== sourceHashesAfter[path]),
    summary: { total: checks.length, passed: checks.filter(c => c.result === 'PASS').length, failed: checks.filter(c => c.result === 'FAIL').length },
    checks, networkLog,
  };
  await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: join(root, 'results.json'), summary: report.summary, sourcesChangedDuringVerification: report.sourcesChangedDuringVerification }));
  https.request = originalRequest; dnsPromises.lookup = originalLookup; syncBuiltinESMExports(); globalThis.Date = RealDate;
  await new Promise(resolve => server.close(resolve));
  if (report.summary.failed) process.exitCode = 1;
}
