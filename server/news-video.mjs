import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { productVideoPython } from './product-video.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../tools/news_video/render.py', import.meta.url));

function text(value, label, maximum) {
  if (typeof value !== 'string') throw new Error(`${label}缺失。`);
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized || [...normalized].length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label}为空、含控制字符或超过 ${maximum} 字，无法完整制作资讯卡片。`);
  }
  return normalized;
}

function sourceLink(value, label) {
  if (typeof value !== 'string' || value.length > 2000 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label}格式无效或超过 2000 字符。`);
  }
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label}不是有效的网址。`); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error(`${label}必须是无账号密码的 HTTP(S) 来源网址。`);
  }
  // Preserve the complete supplied URL, including its query, for attribution.
  return value;
}

function dayInShanghai(value) {
  const day = value ?? new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('资讯日期必须为 YYYY-MM-DD。');
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) throw new Error('资讯日期无效。');
  return day;
}

function buildNewsVideoMetadata(items, { day } = {}) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 3) throw new Error('每条资讯视频需要 1–3 条有来源的资讯。');
  const date = dayInShanghai(day);
  const sources = items.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 条资讯格式无效。`);
    let publishedAt = '';
    if (item.publishedAt != null && item.publishedAt !== '') {
      if (typeof item.publishedAt !== 'string' || !Number.isFinite(Date.parse(item.publishedAt))) {
        throw new Error(`第 ${index + 1} 条资讯的发布时间无效。`);
      }
      publishedAt = new Date(item.publishedAt).toISOString();
    }
    return {
      id: text(String(item.id ?? ''), `第 ${index + 1} 条资讯编号`, 300),
      // Keep complete headlines within the readable card area; never truncate.
      title: text(item.title, `第 ${index + 1} 条资讯标题`, 160),
      url: sourceLink(item.url, `第 ${index + 1} 条资讯链接`),
      publishedAt,
      sourceName: text(item.sourceName, `第 ${index + 1} 条来源名称`, 70),
      sourceUrl: sourceLink(item.sourceUrl, `第 ${index + 1} 条来源主页`)
    };
  });
  if (new Set(sources.map(item => item.url)).size !== sources.length) throw new Error('本次资讯包含重复链接，请去重后制作。');
  const title = `${date.slice(5, 7)}月${date.slice(8, 10)}日资讯速览`;
  const caption = [
    `${title}｜资讯标题速览·非现场画面`,
    '根据来源公开标题制作图卡，完整内容以原文为准。',
    ...sources.map((item, index) => `${index + 1}. ${item.title}\n来源：${item.sourceName}\n${item.url}`)
  ].join('\n\n');
  if (caption.length > 1000) throw new Error('资讯说明和完整来源链接超过 1000 字符，请减少资讯条数或选择链接较短的资讯；不能省略出处。');
  return { day: date, items: sources, title, caption };
}

/** Choose in source order while retaining complete attribution within the caption budget. */
export function selectNewsForVideo(candidates, { day } = {}) {
  if (!Array.isArray(candidates)) throw new Error('资讯候选必须是数组。');
  if (!candidates.length) return { items: [], warnings: [] };
  const date = dayInShanghai(day);
  let items = [];
  const warnings = [];
  for (const candidate of candidates) {
    if (items.length === 3) break;
    try {
      items = buildNewsVideoMetadata([...items, candidate], { day: date }).items;
    } catch (error) {
      if (warnings.length < 30) {
        const label = typeof candidate?.title === 'string'
          ? [...candidate.title.replace(/\s+/gu, ' ').trim()].slice(0, 80).join('') : '无有效标题的资讯';
        warnings.push(`跳过“${label}”：${error.message}`);
      }
    }
  }
  return { items, warnings };
}

/** Render supplied source headlines as original graphics; never fetch source bodies or media. */
export async function renderNewsVideo(items, outputRoot, { day } = {}) {
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) throw new Error('资讯视频输出目录不能为空。');
  const { day: date, items: sources, title, caption } = buildNewsVideoMetadata(items, { day });
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true });
  const directory = join(root, randomUUID());
  await mkdir(directory);
  const config = join(directory, 'input.json'), asset = join(directory, 'video.mp4');
  const input = { schemaVersion: 1, day: date, title, caption, items: sources };
  await writeFile(config, `${JSON.stringify(input, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(join(directory, 'sources.json'), `${JSON.stringify({
    schemaVersion: 1, createdAt: new Date().toISOString(), day: date, sources
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  let metadata;
  try {
    const { stdout } = await execute(productVideoPython(), [script, '--config', config, '--out', asset], {
      timeout: 16 * 60000, windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: '1' }
    });
    metadata = JSON.parse(stdout.trim());
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().slice(-800);
    throw new Error(error.code === 'ENOENT'
      ? '找不到 Python，请配置 DOUFENG_PYTHON 及已有的 Pillow、imageio-ffmpeg 环境。'
      : `本地资讯视频合成失败：${detail}`);
  }
  const info = await stat(asset);
  if (!info.isFile() || !info.size) throw new Error('资讯合成未产生有效视频。');
  if (metadata?.seconds !== 12 + sources.length * 8 || metadata.width !== 720 || metadata.height !== 1280) {
    throw new Error('资讯合成返回的时长或尺寸无效。');
  }
  return { asset, title, caption, directory, seconds: metadata.seconds };
}
