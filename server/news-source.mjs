import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productVideoPython } from './product-video.mjs';

export const defaultNewsFeed = 'https://www.ithome.com/rss/';
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;
const execute = promisify(execFile);
const parser = fileURLToPath(new URL('../tools/news_feed/parse.py', import.meta.url));
const invalid = message => Object.assign(new Error(message), { status: 400 });
const hostnameOf = url => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

// Allow public unicast addresses only. IPv6 transition addresses are excluded
// because they can carry an IPv4 destination with different routing semantics.
function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    if (address.includes('.') || address.includes('%')) return false;
    const parts = address.toLowerCase().split(':');
    const first = Number.parseInt(parts[0], 16), second = Number.parseInt(parts[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
      && first !== 0x3ffe && first !== 0x3fff
      && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}

function publicUrl(value, httpsOnly = true) {
  if (typeof value !== 'string' || value.length > 4096) throw invalid('资讯地址无效或过长。');
  let url;
  try { url = new URL(value); } catch { throw invalid('请填写完整的 HTTPS RSS / Atom 地址。'); }
  if (!(httpsOnly ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol))
    || url.username || url.password || url.port) throw invalid('资讯地址须使用标准端口，且不能包含账号密码。');
  const hostname = hostnameOf(url).replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || !hostname.includes('.') && !isIP(hostname)
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(hostname)
    || hostname.endsWith('.home.arpa') || isIP(hostname) && !publicAddress(hostname)) {
    throw invalid('资讯来源必须是公开网站，不能访问本机或内网。');
  }
  url.hash = '';
  return url;
}

export function validateNewsSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('资讯设置必须是对象。');
  if (input.feedUrl !== undefined && typeof input.feedUrl !== 'string') throw invalid('RSS 地址必须是文本。');
  if (input.keywords !== undefined && typeof input.keywords !== 'string') throw invalid('关键词必须是逗号分隔的文本。');
  const text = String(input.keywords || '').trim();
  if ([...text].length > 200) throw invalid('关键词最多 200 字。');
  const keywords = [...new Set(text.split(/[,，]/).map(word => word.trim()).filter(Boolean))].join(',');
  return { feedUrl: publicUrl(String(input.feedUrl || defaultNewsFeed).trim()).href, keywords };
}

async function resolvePublic(url, deadline) {
  const hostname = hostnameOf(url);
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  let timer;
  const timeout = Math.min(5000, deadline - Date.now());
  if (timeout <= 0) throw new Error('资讯来源请求超时。');
  try {
    const records = await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('资讯来源 DNS 解析超时。')), timeout); })
    ]);
    if (!records.length || records.some(record => !publicAddress(record.address))) throw invalid('资讯来源解析到非公网地址，已停止读取。');
    return records.find(record => record.family === 4) || records[0];
  } finally { clearTimeout(timer); }
}

async function fetchOnce(url, deadline) {
  const address = await resolvePublic(url, deadline);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('资讯来源请求超时。');
  return new Promise((resolveResult, reject) => {
    let response, decoder, settled = false, request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        decoder?.destroy(); response?.destroy(); request?.destroy();
        reject(error);
      } else resolveResult(value);
    };
    const timer = setTimeout(() => finish(new Error('资讯来源请求超时。')), remaining);
    request = httpsRequest(url, {
      method: 'GET', agent: false, family: address.family,
      lookup: (_host, options, callback) => {
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'Doufeng-Local-News/1.0' }
    }, res => {
      response = res;
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        res.destroy();
        if (!location) finish(new Error('资讯来源重定向缺少目标地址。'));
        else finish(null, { location });
        return;
      }
      if (res.statusCode !== 200) { finish(new Error(`资讯来源返回 HTTP ${res.statusCode}。`)); return; }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BYTES) { finish(new Error('RSS 内容超过 2MB 限制。')); return; }
      const encoding = String(res.headers['content-encoding'] || 'identity').trim().toLowerCase();
      if (encoding === 'gzip') decoder = createGunzip();
      else if (encoding === 'deflate') decoder = createInflate();
      else if (encoding === 'br') decoder = createBrotliDecompress();
      else if (encoding !== 'identity') { finish(new Error('资讯来源使用了不支持的压缩格式。')); return; }
      const chunks = []; let received = 0, decoded = 0;
      res.on('data', chunk => {
        received += chunk.length;
        if (received > MAX_BYTES) finish(new Error('RSS 下载内容超过 2MB 限制。'));
      });
      res.on('aborted', () => finish(new Error('资讯来源连接中断。')));
      res.on('error', error => finish(error));
      const stream = decoder ? res.pipe(decoder) : res;
      stream.on('error', error => finish(error));
      stream.on('data', chunk => {
        decoded += chunk.length;
        if (decoded > MAX_BYTES) finish(new Error('RSS 解压内容超过 2MB 限制。'));
        else chunks.push(chunk);
      });
      stream.on('end', () => finish(null, { body: Buffer.concat(chunks) }));
    });
    request.on('error', error => finish(error));
    request.setTimeout(Math.min(15000, remaining), () => finish(new Error('资讯来源连接超时。')));
    request.end();
  });
}

async function fetchFeed(feedUrl) {
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let url = publicUrl(feedUrl);
  const visited = new Set();
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (visited.has(url.href)) throw new Error('资讯来源出现循环重定向。');
    visited.add(url.href);
    const result = await fetchOnce(url, deadline);
    if (result.body) return { body: result.body, url: url.href };
    if (redirects === 3) throw new Error('资讯来源重定向超过 3 次。');
    let target;
    try { target = new URL(result.location, url).href; } catch { throw new Error('资讯来源重定向地址无效。'); }
    url = publicUrl(target);
  }
}

export async function collectNews(settings, directory) {
  const normalized = validateNewsSettings(settings), at = new Date().toISOString();
  const feed = await fetchFeed(normalized.feedUrl);
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(root, 'feed-'));
  const input = join(temporary, 'feed.xml');
  try {
    await writeFile(input, feed.body, { flag: 'wx' });
    let parsed;
    try {
      const { stdout } = await execute(productVideoPython(), [
        parser, '--input', input, '--url', feed.url, `--keywords=${normalized.keywords}`, '--now', at
      ], { timeout: 15000, windowsHide: true, maxBuffer: MAX_BYTES, env: { ...process.env, PYTHONUTF8: '1' } });
      parsed = JSON.parse(stdout);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('未找到 Python，无法读取资讯源，请设置 DOUFENG_PYTHON。');
      if (error.killed) throw new Error('资讯 XML 解析超时。');
      throw new Error(`资讯 XML 解析失败：${String(error.stderr || error.message).trim().split(/\r?\n/).at(-1)?.slice(0, 300) || '请检查 RSS / Atom 格式。'}`);
    }
    if (!Array.isArray(parsed.items) || parsed.items.length > 60) throw new Error('资讯解析结果无效。');
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 30).map(String) : [];
    const items = [], seen = new Set(), seenUrls = new Set(), now = Date.parse(at);
    let longTitles = 0;
    for (const item of parsed.items) {
      try {
        const title = String(item.title || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
        if ([...title].length > 120) { longTitles++; continue; }
        const published = Date.parse(item.publishedAt);
        if (!title || !Number.isFinite(published) || published < now - 48 * 3600000 || published > now + 10 * 60000) continue;
        const url = publicUrl(item.url, false).href;
        const sourceUrl = publicUrl(item.sourceUrl || feed.url, false).href;
        const id = createHash('sha256').update(title.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()).digest('hex');
        if (seen.has(id) || seenUrls.has(url)) continue;
        seen.add(id); seenUrls.add(url);
        items.push({ id, title, url, publishedAt: new Date(published).toISOString(), sourceName: [...String(item.sourceName || parsed.feedTitle || new URL(feed.url).hostname)].slice(0, 120).join(''), sourceUrl });
      } catch { warnings.push('已跳过链接无效或指向非公开地址的资讯。'); }
    }
    if (longTitles) warnings.push(`${longTitles} 条资讯标题超过 120 字，已跳过；未截断标题。`);
    items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    return { items, warnings: [...new Set(warnings)].slice(0, 30), at, feedTitle: [...String(parsed.feedTitle || new URL(feed.url).hostname)].slice(0, 120).join('') };
  } finally {
    await unlink(input).catch(() => {});
    await rmdir(temporary).catch(() => {});
  }
}
