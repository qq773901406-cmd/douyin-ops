import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, stat, realpath, copyFile } from 'node:fs/promises';
import { join, extname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./tools/product_video/render.py', import.meta.url));
export function productVideoPython() {
  if (process.env.DOUFENG_PYTHON) return process.env.DOUFENG_PYTHON;
  const bundled = join(homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');
  return process.platform === 'win32' && existsSync(bundled) ? bundled : 'python';
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
