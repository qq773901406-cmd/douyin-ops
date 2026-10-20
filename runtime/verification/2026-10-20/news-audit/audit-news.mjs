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
const directory = fileURLToPath(new URL(`./case-${Date.now()}/`, import.meta.url));
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
async function parse(name, xml, keywords = '') {
  const input = join(directory, `${name}.xml`);
  await writeFile(input, xml);
  const { stdout } = await execute(productVideoPython(), [
    join(root, 'tools/news_feed/parse.py'), '--input', input,
    '--url', feedUrl, '--now', now, `--keywords=${keywords}`
  ], { windowsHide: true, timeout: 15000, env: { ...process.env, PYTHONUTF8: '1' } });
  return JSON.parse(stdout);
}
const duplicate = await parse('duplicate-links', `<rss version="2.0"><channel><title>测试资讯</title>
<item><title>同一文章的早期标题</title><link>https://www.ithome.com/0/123/456.htm</link><pubDate>${now}</pubDate></item>
<item><title>同一文章更新后的标题</title><link>https://www.ithome.com/0/123/456.htm</link><pubDate>${now}</pubDate></item>
</channel></rss>`);
assert.equal(duplicate.items.length, 2);
assert.equal(new Set(duplicate.items.map(item => item.url)).size, 1);
const html = await parse('atom-html-title', `<feed xmlns="http://www.w3.org/2005/Atom"><title>测试资讯</title>
<entry><title type="html">&lt;b&gt;新手机&lt;/b&gt;支持AI &amp;amp; 影像处理</title>
<link href="https://www.ithome.com/0/123/457.htm"/><updated>${now}</updated></entry></feed>`);
assert.equal(html.items[0].title, '<b>新手机</b>支持AI &amp; 影像处理');
const longTitle = '重要资讯标题'.repeat(20) + '，但实际尚未发布，仅为传闻';
const long = await parse('long-title', `<rss version="2.0"><channel><title>测试资讯</title>
<item><title>${longTitle}</title><link>https://www.ithome.com/0/123/458.htm</link><pubDate>${now}</pubDate></item>
</channel></rss>`);
assert.equal(long.items[0].title.length, 120);
assert.equal(long.items[0].title.includes('仅为传闻'), false);
assert.deepEqual(long.warnings, []);

const workspace = { async read() { return { value: { products: [], videos: [], drafts: [], trash: [] } }; }, async update() { throw new Error('A duplicate-link failure must occur before writing workspace data'); } };
let publishCalls = 0;
const automation = {
  store: { async read() { return { value: { config: { enabled: false, accountId: 'audit', browserId: 'audit-browser' }, items: [] } }; } },
  async lease() { return async () => {}; },
  publisher: { async publish() { publishCalls++; throw new Error('Real publication is prohibited in this offline audit'); } }
};
const daily = new DailyProduction(join(directory, 'daily-case'), workspace, automation);
const clock = Date.now(), day = shanghaiDay(clock);
const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(clock);
await daily.store.update(state => {
  Object.assign(state.config, { enabled: true, sourceMode: 'news', newsFeedUrl: feedUrl, startTime: `${hour}:00`, firstDay: day, authorizedAt: now, accountId: 'audit', browserId: 'audit-browser' });
  state.newsItems = duplicate.items.map(item => ({ ...item, sourceUrl: feedUrl, id: createHash('sha256').update(item.title.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()).digest('hex') }));
  state.newsLastSync = { at: now, feedUrl };
});
// Replace only the network-bound collection method; parsing, candidate
// selection, rendering validation and persisted scheduler outcome stay real.
daily.syncSource = async () => ({ at: now, warnings: [], scanned: 2, existing: 2, added: 0 });
await daily.run(false);
const result = (await daily.store.read()).value;
assert.equal(result.runs[0].status, 'failed');
assert.match(result.runs[0].message, /重复链接/);
assert.equal(result.config.enabled, false);
assert.equal(publishCalls, 0);
const after = await versions();
const report = {
  checkedAt: new Date().toISOString(),
  sourcesUnchangedDuringAudit: JSON.stringify(before) === JSON.stringify(after),
  before, after,
  duplicateLink: { parsedItemCount: duplicate.items.length, uniqueUrlCount: 1, run: result.runs[0], planEnabledAfter: result.config.enabled, publishCalls },
  atomHtmlTitle: { expected: '新手机支持AI & 影像处理', actual: html.items[0].title },
  truncation: { originalTitle: longTitle, actualTitle: long.items[0].title, warnings: long.warnings }
};
await writeFile(join(directory, '..', 'news-audit-result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  sourcesUnchangedDuringAudit: report.sourcesUnchangedDuringAudit,
  duplicateLink: { parsedItems: duplicate.items.length, status: result.runs[0].status, enabled: result.config.enabled, message: result.runs[0].message, publishCalls },
  atomTitle: report.atomHtmlTitle,
  titleTruncatedWithoutWarning: true
}, null, 2));
