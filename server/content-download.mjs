import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const invalid = message => Object.assign(new Error(message), { status: 400, code: 'IMAGE_DOWNLOAD_FAILED' });
const maxImageBytes = 6 * 1024 * 1024;
export const publicImageAddress = address => {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    const [a, b] = address.toLowerCase().split(':').map(value => Number.parseInt(value || '0', 16));
    return !address.includes('.') && a >= 0x2000 && a <= 0x3fff && ![0x2002, 0x3ffe, 0x3fff].includes(a) && !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
  }
  return false;
};
export function validatePublicImageUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw invalid('商品图片来源地址无效。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 4096
    || !host.includes('.') && !isIP(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)
    || host.endsWith('.home.arpa') || isIP(host) && !publicImageAddress(host)) throw invalid('商品图片必须来自公开 HTTPS 地址，不能读取本机或内网。');
  url.hash = ''; return url;
}
export function imageExtension(bytes) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.subarray(-8, -4).toString('ascii') === 'IEND') return '.png';
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return '.jpg';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return '.webp';
  return '';
}
async function pinnedAddress(url, lookup, deadline, signal) {
  signal?.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  let timer;
  try {
    const records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(invalid('图片来源 DNS 解析超时。')), Math.max(1, Math.min(5000, deadline - Date.now()))); })
    ]);
    signal?.throwIfAborted();
    if (!records.length || records.some(row => !publicImageAddress(row.address))) throw invalid('图片来源解析到非公网地址，已停止。');
    return records.find(row => row.family === 4) || records[0];
  } finally { clearTimeout(timer); }
}
async function fetchImage(url, { lookup, request, deadline, signal, maxBytes }) {
  const address = await pinnedAddress(url, lookup, deadline, signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw invalid('图片下载超时。');
  return new Promise((resolveResult, reject) => {
    let req, response, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { response?.destroy(); req?.destroy(); reject(error); } else resolveResult(value);
    };
    const timer = setTimeout(() => finish(invalid('图片下载超时。')), remaining);
    try {
      req = request(url, {
        method: 'GET', agent: false, signal, family: address.family,
        lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family),
        headers: { Accept: 'image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity', 'User-Agent': 'Doufeng-Product-Research/1.0' }
      }, res => {
        response = res;
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location; res.destroy();
          finish(location ? null : invalid('图片重定向缺少目标。'), { location }); return;
        }
        if (res.statusCode !== 200) { finish(invalid(`公开图片返回 HTTP ${res.statusCode}；未携带账号凭证或绕过权限。`)); return; }
        if (!/^(?:image\/(?:png|jpeg|jpg|webp)|application\/octet-stream)(?:;|$)/i.test(String(res.headers['content-type'] || ''))
          || !['', 'identity'].includes(String(res.headers['content-encoding'] || '')) || Number(res.headers['content-length']) > maxBytes) {
          finish(invalid('图片类型、编码或大小不符合下载限制。')); return;
        }
        let received = 0; const chunks = [];
        res.on('data', chunk => { received += chunk.length; if (received > maxBytes) finish(invalid('图片超过单张或本次总大小限制。')); else chunks.push(chunk); });
        res.on('aborted', () => finish(invalid('图片连接中断。')));
        res.on('error', () => finish(invalid('图片下载连接失败。')));
        res.on('end', () => finish(null, { body: Buffer.concat(chunks) }));
      });
      req.on('error', error => finish(signal?.aborted ? signal.reason || error : invalid('图片来源连接失败。')));
      req.setTimeout(Math.min(15000, remaining), () => finish(invalid('图片来源连接超时。')));
      req.end();
    } catch (error) { finish(error); }
  });
}

// Caller supplies a server-owned runtime directory, never a user-provided path.
export async function downloadPublicImage(input, directory, { signal, maxBytes = maxImageBytes, lookup = dnsLookup, request = httpsRequest } = {}) {
  maxBytes = Math.min(maxImageBytes, maxBytes);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw invalid('本次图片下载已达到总大小限制。');
  const deadline = Date.now() + 20000, visited = new Set();
  const originalUrl = validatePublicImageUrl(input).href;
  let url = new URL(originalUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal?.throwIfAborted();
    if (visited.has(url.href)) throw invalid('图片来源循环重定向。');
    visited.add(url.href);
    const result = await fetchImage(url, { lookup, request, deadline, signal, maxBytes });
    if (result.body) {
      const extension = imageExtension(result.body);
      if (!extension) throw invalid('下载内容未通过 PNG、JPEG 或 WebP 文件签名检查。');
      signal?.throwIfAborted();
      const sha256 = createHash('sha256').update(result.body).digest('hex'), name = `${sha256}${extension}`, path = join(resolve(directory), name);
      await mkdir(resolve(directory), { recursive: true });
      await writeFile(path, result.body);
      return { name, path, bytes: result.body.length, sha256, sourceUrl: originalUrl, finalUrl: url.href, rightsVerified: false };
    }
    if (redirects === 3) throw invalid('图片重定向超过 3 次。');
    url = validatePublicImageUrl(new URL(result.location, url).href);
  }
}
