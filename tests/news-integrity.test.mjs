import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productVideoPython } from '../server/product-video.mjs';
import { DailyProduction } from '../server/daily-production.mjs';

const execute = promisify(execFile);
const parser = fileURLToPath(new URL('../tools/news_feed/parse.py', import.meta.url));
const now = '2026-10-20T07:00:00Z';
const feedUrl = 'https://www.ithome.com/rss/';
const escaped = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const entry = (title, index, extra = '') => `<entry>${title}<link href="https://www.ithome.com/news/${index}"/><updated>${now}</updated>${extra}</entry>`;
const feed = entries => `<feed xmlns="http://www.w3.org/2005/Atom"><title>测试资讯</title>${entries}</feed>`;

async function parse(t, xml) {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'doufeng-news-integrity-'));
  assert.equal(dirname(resolve(directory)), temporaryRoot);
  assert.ok(basename(directory).startsWith('doufeng-news-integrity-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const input = join(directory, 'feed.xml');
  await writeFile(input, xml);
  try {
    const { stdout } = await execute(productVideoPython(), [parser, '--input', input, '--url', feedUrl, '--now', now], {
      windowsHide: true, timeout: 15000, env: { ...process.env, PYTHONUTF8: '1' }
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('未安装可运行资讯解析器的 Python。'); return null; }
    throw error;
  }
}

test('Atom HTML 标题和来源转换成可读文本，实体只解码一层', async t => {
  const result = await parse(t, `<feed xmlns="http://www.w3.org/2005/Atom">
    <title type="html">${escaped('<b>科技</b> &amp; 资讯')}</title>
    ${entry(`<title type="html">${escaped('<b>新手机</b>支持AI &amp; 影像<br/>新进展<script>不应进入标题</script><style>也不应出现</style><!-- 注释 -->')}</title>`, 1,
      `<source><title type="html">${escaped('<i>原始来源</i> &amp; 报道')}</title><link href="https://www.ithome.com/"/></source>`)}
    ${entry(`<title type="html">${escaped('字面 &lt;b&gt; 与 &#x4e2d;文')}</title>`, 2)}
    </feed>`);
  if (!result) return;
  assert.equal(result.feedTitle, '科技 & 资讯');
  assert.equal(result.items[0].title, '新手机支持AI & 影像 新进展');
  assert.equal(result.items[0].sourceName, '原始来源 & 报道');
  assert.equal(result.items[1].title, '字面 <b> 与 中文');
  assert.equal(result.items[1].sourceName, '科技 & 资讯');
});

test('Atom text 保留字面比较符和标签，XHTML 保留可见文本', async t => {
  const literal = 'A < B, 温度 > 40, 字面 <b>标签</b> &amp;';
  const result = await parse(t, feed(
    entry(`<title type="text">${escaped(literal)}</title>`, 1)
    + entry(`<title>${escaped('默认文本 <b>也保留</b>')}</title>`, 2)
    + entry('<title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">AI <b>新进展</b> &amp; 新方案</div></title>', 3)
  ));
  if (!result) return;
  assert.deepEqual(result.items.map(item => item.title), [literal, '默认文本 <b>也保留</b>', 'AI 新进展 & 新方案']);
});

test('标题完整性和去重使用可见标题，长标题整条跳过且同 URL 不重复', async t => {
  const boundary = '标题完整保留'.repeat(20);
  const result = await parse(t, feed(
    entry(`<title type="html">${escaped(`<b>${boundary}</b>`)}</title>`, 1)
    + entry(`<title type="html">${escaped(`<b>${boundary}仅为传闻</b>`)}</title>`, 2)
    + entry(`<title type="html">${escaped('<b>同一标题</b>')}</title>`, 3)
    + entry('<title>同一标题</title>', 4)
    + entry('<title>同 URL 的不同标题</title>', 3)
  ));
  if (!result) return;
  assert.deepEqual(result.items.map(item => item.title), [boundary, '同一标题']);
  assert.ok(result.warnings.some(message => /超过 120 字.*未截断标题/.test(message)));
});

test('已提交新闻修改标题后仍按 URL 排除，并兼容旧 ID 记录', async () => {
  const publishedAt = new Date().toISOString();
  const original = { id: 'old-id', title: '原标题', url: 'https://www.ithome.com/news/1', publishedAt, sourceUrl: feedUrl };
  const renamed = { ...original, id: 'new-id', title: '更新标题' };
  const fresh = { ...original, id: 'fresh-id', title: '新资讯', url: 'https://www.ithome.com/news/2' };
  const daily = new DailyProduction(join(tmpdir(), 'doufeng-news-no-files'), {}, {});
  const state = { config: { sourceMode: 'news', newsFeedUrl: feedUrl }, newsItems: [original, renamed, fresh], runs: [] };
  assert.deepEqual((await daily.candidates(state)).map(item => item.url), [original.url, fresh.url]);
  state.runs = [{ status: 'submitted', newsItemIds: ['old-id'], sourceArticles: [original] }];
  assert.deepEqual((await daily.candidates(state)).map(item => item.id), ['fresh-id']);
  state.runs = [{ status: 'submitted', newsItemIds: ['fresh-id'] }];
  assert.deepEqual((await daily.candidates(state)).map(item => item.id), ['old-id']);
});
