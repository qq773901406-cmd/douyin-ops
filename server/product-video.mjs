import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { mkdir, writeFile, stat, realpath, copyFile, access } from 'node:fs/promises';
import { join, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveMediaPython } from '../lib/python-runtime.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../tools/product_video/render.py', import.meta.url));
export function productVideoPython() {
  return resolveMediaPython({ projectRoot: fileURLToPath(new URL('../', import.meta.url)) });
}

export async function inspectProductVideoEnvironment() {
  const checkedAt = new Date().toISOString();
  try {
    const { stdout } = await execute(productVideoPython(), [script, '--check'], { timeout: 25000, windowsHide: true, maxBuffer: 128 * 1024, env: { ...process.env, PYTHONUTF8: '1' } });
    if (JSON.parse(stdout.trim()).ok !== true) throw new Error('合成环境返回内容不完整。');
    return { ok: true, checkedAt, message: 'Python、图片处理库、中文字体及 FFmpeg 可用；尚未生成视频。' };
  } catch (error) {
    const detail = String(error.stderr || error.message || '');
    const message = error.code === 'ENOENT' ? '未找到 Python，请设置 DOUFENG_PYTHON。'
      : /No module named ['"]PIL/.test(detail) ? '当前 Python 缺少 Pillow，请安装到所选解释器中。'
      : /No module named ['"]imageio_ffmpeg/.test(detail) ? '当前 Python 缺少 imageio-ffmpeg，请安装到所选解释器中。'
      : error.killed ? '合成环境检查超时，请检查本机 Python 和 FFmpeg。'
      : `合成环境不可用：${detail.trim().split(/\r?\n/).at(-1)?.slice(0, 300) || '请检查依赖和中文字体。'}`;
    return { ok: false, checkedAt, message };
  }
}

export async function usableProductImages(product) {
  const candidates = [], images = [], warnings = [];
  for (const image of (product.images || []).slice(0, 20)) {
    try {
      if (typeof image.path !== 'string' || !isAbsolute(image.path) || !/\.(png|jpe?g|webp)$/i.test(image.path)) throw new Error('不是支持的本地图片');
      const source = await realpath(image.path), info = await stat(source);
      if (!info.isFile() || !info.size || info.size > 20 * 1024 ** 2) throw new Error('图片为空、不是文件或超过 20MB');
      await access(source, constants.R_OK);
      candidates.push({ ...image, path: source });
    } catch (error) {
      warnings.push(`${image.name || '商品图片'}：${['ENOENT', 'ENOTDIR'].includes(error.code) ? '文件已移动或不存在' : error.code === 'EACCES' ? '无法读取文件' : error.message}`);
    }
  }
  if (!candidates.length) return { images, warnings };
  let checked;
  try {
    // Send the whole batch through stdin to avoid Windows command-line limits.
    const pending = execute(productVideoPython(), [script, '--check-images'], { timeout: 60000, windowsHide: true, maxBuffer: 128 * 1024, env: { ...process.env, PYTHONUTF8: '1' } });
    // An interpreter startup failure can close stdin early; execFile reports it.
    pending.child.stdin.on('error', () => {});
    pending.child.stdin.end(JSON.stringify(candidates.map(image => image.path)));
    const { stdout } = await pending;
    checked = JSON.parse(stdout.trim()).images;
    if (!Array.isArray(checked) || checked.length !== candidates.length || checked.some(item => typeof item?.ok !== 'boolean' || !item.ok && typeof item.error !== 'string')) throw new Error('图片检查返回内容不完整。');
  } catch (error) {
    const detail = String(error.stderr || error.message || '');
    const reason = error.code === 'ENOENT' ? '未找到 Python，请设置 DOUFENG_PYTHON。'
      : /No module named ['"]PIL/.test(detail) ? '当前 Python 缺少 Pillow，请安装到所选解释器中。'
      : /No module named ['"]imageio_ffmpeg/.test(detail) ? '当前 Python 缺少 imageio-ffmpeg，请安装到所选解释器中。'
      : error.killed ? '图片解码检查超时，请检查本机 Python 和图片。'
      : detail.trim().split(/\r?\n/).at(-1)?.slice(0, 300) || '请检查 Python 和图片处理库。';
    throw new Error(`无法检查商品图片：${reason}`);
  }
  for (const [index, result] of checked.entries()) {
    const image = candidates[index];
    if (!result.ok) warnings.push(`${image.name || '商品图片'}：${result.error}`);
    else if (images.length < 6) images.push(image);
  }
  return { images, warnings };
}

export async function renderProductVideo(product, outputRoot) {
  const title = [...String(product.title || '').trim()].slice(0, 30).join('');
  if (!title || !Array.isArray(product.images) || !product.images.length) throw new Error('商品缺少名称或本地图片，无法制作视频。');
  const directory = join(outputRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  const images = [];
  for (const [index, image] of product.images.slice(0, 6).entries()) {
    if (!isAbsolute(image.path) || !/\.(png|jpe?g|webp)$/i.test(image.path)) throw new Error('合成仅接受已保存到本机的商品图片。');
    const source = await realpath(image.path), info = await stat(source);
    if (!info.isFile() || !info.size || info.size > 20 * 1024 ** 2) throw new Error('商品图片无效或超过 20MB。');
    const target = join(directory, `image-${index}${extname(source)}`);
    await copyFile(source, target); images.push(target);
  }
  const original = String(product.captionZh || product.hook || '').trim();
  const caption = [...original.replace(/^#{1,6}\s+/gm, '').replace(/\*\*/g, '')].slice(0, 450).join('') || `${title}。商品图片展示，具体规格请查看商品资料。`;
  const config = join(directory, 'input.json'), asset = join(directory, 'video.mp4');
  await writeFile(config, JSON.stringify({ title, caption, images }), 'utf8');
  let metadata;
  try {
    const { stdout } = await execute(productVideoPython(), [script, '--config', config, '--out', asset], { timeout: 16 * 60000, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } });
    metadata = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? '找不到 Python，请安装 Pillow 和 imageio-ffmpeg，或设置 DOUFENG_PYTHON。' : `本地视频合成失败：${String(error.stderr || error.message).slice(-800)}`);
  }
  if (!(await stat(asset)).size) throw new Error('合成未产生有效视频。');
  if (!Number.isInteger(metadata.seconds) || metadata.seconds < 1 || metadata.seconds > 120) throw new Error('合成返回的视频时长无效。');
  return { asset, title, caption, directory, seconds: metadata.seconds };
}
