import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DailyProduction } from '../../../../server/daily-production.mjs';
import { productVideoPython } from '../../../../server/product-video.mjs';
import { shanghaiDay } from '../../../../shared/automation-model.mjs';

const execute = promisify(execFile);
const verifyAtomFix = process.argv.includes('--atom-fixed');
const directory = fileURLToPath(new URL(`./after-${Date.now()}/`, import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
await mkdir(directory, { recursive: true });
const files = ['server/news-source.mjs', 'server/news-video.mjs', 'tools/news_feed/parse.py', 'tools/news_video/render.py', 'server/daily-production.mjs'];
async function versions() {
  return Object.fromEntries(await Promise.all(files.map(async path => [path, {
    sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex'),
    modifiedAt: (await stat(join(root, path))).mtime.toISOString()
  }])));
}
const before = await versions();
const now = new Date().toISOString(), feedUrl = 'https://www.ithome.com/rss/';
async function parse(name, xml) {
  const input = join(directory, `${name}.xml`);
  await writeFile(input, xml);
  const { stdout } = await execute(productVideoPython(), [
    join(root, 'tools/news_feed/parse.py'), '--input', input, '--url', feedUrl, '--now', now
  ], { windowsHide: true, timeout: 15000, env: { ...process.env, PYTHONUTF8: '1' } });
  return JSON.parse(stdout);
}
const duplicate = await parse('duplicate-links', `<rss version="2.0"><channel><title>测试资讯</title>
<item><title>同一文章的早期标题</title><link>https://www.ithome.com/0/123/456.htm</link><pubDate>${now}</pubDate></item>
<item><title>同一文章更新后的标题</title><link>https://www.ithome.com/0/123/456.htm</link><pubDate>${now}</pubDate></item>
</channel></rss>`);
assert.equal(duplicate.items.length, 1);
const longTitle = '重要资讯标题'.repeat(20) + '，但实际尚未发布，仅为传闻';
const long = await parse('long-title', `<rss version="2.0"><channel><title>测试资讯</title>
<item><title>${longTitle}</title><link>https://www.ithome.com/0/123/458.htm</link><pubDate>${now}</pubDate></item>
</channel></rss>`);
assert.equal(long.items.length, 0);
assert.ok(long.warnings.some(warning => /超过 120 字.*未截断/.test(warning)));
const boundaryTitle = '标题完整保留'.repeat(20);
assert.equal([...boundaryTitle].length, 120);
const boundary = await parse('boundary-title', `<rss version="2.0"><channel><title>测试资讯</title>
<item><title>${boundaryTitle}</title><link>https://www.ithome.com/0/123/459.htm</link><pubDate>${now}</pubDate></item>
</channel></rss>`);
assert.equal(boundary.items[0].title, boundaryTitle);

const atomCases = [
  { name: 'html', title: '<title type="html">&lt;b&gt;新手机&lt;/b&gt;支持AI &amp;amp; 影像处理</title>', expected: '新手机支持AI & 影像处理' },
  { name: 'text-comparison', title: '<title type="text">新机 A &lt; B，温度 &gt; 40 度，字面量 &lt;b&gt;保持原样&lt;/b&gt;</title>', expected: '新机 A < B,温度 > 40 度,字面量 <b>保持原样</b>' },
  { name: 'xhtml', title: '<title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">AI <b>新进展</b> &amp; 新方案</div></title>', expected: 'AI 新进展 & 新方案' }
];
const atomResults = [];
for (const item of atomCases) {
  const result = await parse(`atom-${item.name}`, `<feed xmlns="http://www.w3.org/2005/Atom"><title>测试资讯</title>
<entry>${item.title}<link href="https://www.ithome.com/0/123/457.htm"/><updated>${now}</updated></entry></feed>`);
  atomResults.push({ name: item.name, expected: item.expected, actual: result.items[0].title, correct: result.items[0].title === item.expected });
}
assert.equal(atomResults.find(item => item.name === 'text-comparison').correct, true);
assert.equal(atomResults.find(item => item.name === 'xhtml').correct, true);
if (verifyAtomFix) assert.ok(atomResults.every(item => item.correct), 'All Atom title modes must preserve their intended visible text');

let data = { products: [], videos: [], drafts: [], trash: [] };
const workspace = {
  async read() { return { value: structuredClone(data) }; },
  async update(change) { const next = structuredClone(data), result = await change(next); data = next; return { value: structuredClone(data), result }; }
};
let simulatedPublishCalls = 0;
const automation = {
  store: { async read() { return { value: { config: { enabled: false, accountId: 'audit', browserId: 'audit-browser' }, items: [] } }; } },
  async lease() { return async () => {}; },
  publisher: { async publish(_item, { guard, beforeSubmit }) {
    await guard(); await beforeSubmit(); simulatedPublishCalls++;
    return { message: 'OFFLINE STUB: no real publication', evidence: { kind: 'offline-stub' } };
  } }
};
const daily = new DailyProduction(join(directory, 'daily-case'), workspace, automation);
const clock = Date.now(), day = shanghaiDay(clock);
const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(clock);
const article = { ...duplicate.items[0], id: 'old-title-id', sourceUrl: feedUrl };
const updatedArticle = { ...article, id: 'updated-title-id', title: '同一文章更新后的标题' };
await daily.store.update(state => {
  Object.assign(state.config, { enabled: true, sourceMode: 'news', newsFeedUrl: feedUrl, startTime: `${hour}:00`, firstDay: day, authorizedAt: now, accountId: 'audit', browserId: 'audit-browser' });
  state.newsItems = [article, updatedArticle];
  state.newsLastSync = { at: now, feedUrl };
});
const cachedState = (await daily.store.read()).value;
assert.equal((await daily.candidates(cachedState)).length, 1);
const priorPublished = structuredClone(cachedState);
priorPublished.newsItems = [updatedArticle];
priorPublished.runs = [{ id: 'prior-submitted', status: 'submitted', newsItemIds: [article.id], sourceArticles: [article] }];
assert.equal((await daily.candidates(priorPublished)).length, 0);
daily.syncSource = async () => ({ at: now, warnings: [], scanned: 2, existing: 2, added: 0 });
await daily.run(false);
const result = (await daily.store.read()).value;
assert.equal(result.runs[0].status, 'submitted');
assert.equal(result.config.enabled, true);
assert.equal(result.runs[0].sourceArticles.length, 1);
assert.equal(simulatedPublishCalls, 1);
const after = await versions();
const report = {
  checkedAt: new Date().toISOString(),
  sourcesUnchangedDuringAudit: JSON.stringify(before) === JSON.stringify(after),
  before, after,
  duplicateLink: { parsedItemCount: duplicate.items.length, cachedCandidateCount: 1, renamedAlreadySubmittedCandidateCount: 0, run: result.runs[0], planEnabledAfter: result.config.enabled, simulatedPublishCalls, realPublishCalls: 0 },
  longTitle: { originalTitle: longTitle, items: long.items, warnings: long.warnings, boundary120Preserved: true },
  atomResults
};
await writeFile(join(directory, '..', verifyAtomFix ? 'news-audit-result-atom-fixed.json' : 'news-audit-result-after.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  sourcesUnchangedDuringAudit: report.sourcesUnchangedDuringAudit,
  duplicateLinksFixed: true,
  renamedPublishedLinkSuppressed: true,
  longTitleSkippedWithWarning: true,
  runStatus: result.runs[0].status,
  enabled: result.config.enabled,
  realPublishCalls: 0,
  atomResults
}, null, 2));
