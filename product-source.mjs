import { readdir, readFile, realpath, stat, mkdir, writeFile, unlink } from 'node:fs/promises';
import { basename, join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseProductReports, reportNames } from './workbuddy/connector/lib/shop-products.mjs';

const inside = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const imageType = bytes => bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? '.png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? '.jpg' : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? '.webp' : '';

// Import the upstream report contract directly, without executing report content.
export async function syncProductReports(folder, uploadDirectory, workspace) {
  const root = await realpath(folder);
  if (!(await stat(root)).isDirectory()) throw new Error('选品来源必须是本机日报目录。');
  const groups = []; let count = 0, bytes = 0, imageBytes = 0;
  async function scan(directory, depth) {
    const entries = await readdir(directory, { withFileTypes: true });
    count += entries.length;
    if (count > 5000) throw new Error('日报目录超过 5000 个条目，请选择较近的日期目录。');
    if (entries.some(entry => entry.isFile() && Object.values(reportNames).includes(entry.name))) { groups.push(directory); return; }
    if (depth >= 2) return;
    for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const child = await realpath(join(directory, entry.name));
      if (inside(root, child)) await scan(child, depth + 1);
    }
  }
  await scan(root, 0);
  const known = (await workspace.read()).value;
  const keys = new Set([...known.products, ...known.trash.filter(e => e.collection === 'products').map(e => e.item)].map(p => p.sourceKey).filter(Boolean));
  const result = { scanned: groups.length, added: 0, existing: 0, warnings: [], at: new Date().toISOString() };
  await mkdir(uploadDirectory, { recursive: true });
  for (const directory of groups) {
    const title = basename(directory), date = directory.split(/[\\/]/).findLast(part => /^\d{4}-\d{2}-\d{2}$/.test(part)) || '';
    const key = `${date || 'undated'}/${title.normalize('NFKC').toLowerCase()}`;
    if (keys.has(key)) { result.existing++; continue; }
    if (result.added >= 50) { result.warnings.push('本次新增已达 50 款，其余将在下次同步时继续导入。'); break; }
    const copies = [];
    try {
      const documents = {};
      for (const [name, file] of Object.entries(reportNames)) {
        let source; try { source = await realpath(join(directory, file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!inside(root, source)) throw new Error('报告路径超出来源目录。');
        const info = await stat(source);
        if (!info.isFile() || info.size > 200 * 1024) throw new Error('报告过大或不是普通文件。');
        bytes += info.size; if (bytes > 4 * 1024 ** 2) throw new Error('报告总量超过 4MB，请缩小来源目录。');
        documents[name] = (await readFile(source, 'utf8')).replace(/^\uFEFF/, '').slice(0, 12000);
      }
      const product = parseProductReports(title, documents, date);
      const imageDirectory = await realpath(join(directory, '06_素材', 'images'));
      if (!inside(root, imageDirectory)) throw new Error('图片路径超出来源目录。');
      const images = (await readdir(imageDirectory, { withFileTypes: true })).filter(e => e.isFile() && /\.(png|jpe?g|webp)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6);
      if (!images.length) throw new Error('缺少商品图片，待图片补齐后自动导入。');
      for (const image of images) {
        const source = await realpath(join(imageDirectory, image.name));
        if (!inside(root, source)) throw new Error('图片路径超出来源目录。');
        const info = await stat(source);
        if (!info.isFile() || !info.size || info.size > 20 * 1024 ** 2) throw new Error('图片为空或超过 20MB。');
        imageBytes += info.size;
        if (imageBytes > 200 * 1024 ** 2) throw new Error('本次图片同步已达 200MB，其余商品下次继续。');
        const data = await readFile(source), extension = imageType(data);
        if (data.length > 20 * 1024 ** 2) throw new Error('图片超过 20MB。');
        if (!extension) throw new Error('图片格式不支持或文件损坏。');
        const target = join(uploadDirectory, `${randomUUID()}-product${extension}`);
        await writeFile(target, data, { flag: 'wx' }); copies.push(target);
        product.images.push({ name: image.name, path: target, createdAt: result.at });
      }
      Object.assign(product, { id: randomUUID(), createdAt: result.at, updatedAt: result.at });
      const saved = await workspace.update(state => {
        if (state.products.some(p => p.sourceKey === product.sourceKey) || state.trash.some(e => e.collection === 'products' && e.item.sourceKey === product.sourceKey)) return false;
        state.products.push(product); return true;
      });
      if (saved.result) { result.added++; copies.length = 0; } else result.existing++;
      keys.add(key);
    } catch (error) {
      result.warnings.push(`${title}：${error.code === 'ENOENT' ? '商品图片目录尚未准备好。' : error.message}`);
    } finally { for (const path of copies) await unlink(path).catch(() => {}); }
    if (bytes > 4 * 1024 ** 2 || imageBytes > 200 * 1024 ** 2) break;
  }
  result.warnings = result.warnings.slice(0, 30);
  return result;
}
