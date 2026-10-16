import { open, realpath, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const mediaTypes = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'
};
const maxUploadBytes = 4 * 1024 * 1024 * 1024;
const fail = (message, status) => Object.assign(new Error(message), { status });
const contained = path => path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);

export async function receiveMedia(req, uploadDir, original) {
  const extension = extname(original).toLowerCase();
  if (!Object.hasOwn(mediaTypes, extension)) throw fail('仅支持 MP4、MOV、WebM、PNG、JPG 和 WebP。', 400);
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxUploadBytes) throw fail('文件为空或超过 4GB。', 413);
  const isImage = mediaTypes[extension].startsWith('image/');
  if (isImage && length > 20 * 1024 * 1024) throw fail('图片不得超过 20MB。', 413);
  const name = basename(original, extname(original)).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-').slice(0, 80) || 'upload';
  const target = join(uploadDir, `${randomUUID()}-${name}${extension}`);
  let received = 0;
  let created = false;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > length || received > maxUploadBytes) callback(fail('文件大小超过上传限制。', 413));
      else callback(null, chunk);
    }
  });
  const output = createWriteStream(target, { flags: 'wx' });
  output.once('open', () => { created = true; });
  try {
    await pipeline(req, limit, output);
    if (received !== length) throw fail('上传未完成，请重新选择文件。', 400);
    if (isImage) {
      const file = await open(target, 'r'); const header = Buffer.alloc(12);
      try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
      const valid = extension === '.png' ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : extension === '.webp' ? header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP'
          : header[0] === 255 && header[1] === 216 && header[2] === 255;
      if (!valid) throw fail('图片内容与扩展名不符，请重新选择有效的图片。', 400);
    }
    return { path: target, size: received };
  } catch (error) {
    if (created) await unlink(target).catch(() => {});
    throw error;
  }
}

// Only files inside the uploads directory are exposed, including after symlink resolution.
export async function serveMedia(req, res, uploadDir, requestedPath) {
  if (!requestedPath || requestedPath.length > 5000) throw fail('请选择工作台中已上传的素材。', 400);
  const candidate = resolve(requestedPath);
  if (!contained(relative(uploadDir, candidate))) throw fail('只能预览已上传到工作台素材目录的文件。', 403);
  let target;
  try {
    const realRoot = await realpath(uploadDir);
    target = await realpath(candidate);
    if (!contained(relative(realRoot, target))) throw fail('素材路径超出工作台目录。', 403);
  } catch (error) {
    if (error.code === 'ENOENT') throw fail('素材不存在，可能已被移动或删除。', 404);
    throw error;
  }
  const type = mediaTypes[extname(target).toLowerCase()];
  if (!type) throw fail('不支持预览这个文件类型。', 415);
  const file = await open(target, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw fail('素材不是普通文件。', 400);
    let start = 0;
    let end = stat.size - 1;
    const range = req.headers.range;
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        if (!match[1]) { const suffix = Number(match[2]); start = suffix > 0 ? Math.max(0, stat.size - suffix) : stat.size; }
        else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
      }
      if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 }); res.end(); return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || stat.size === 0) { res.end(); return; }
    await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
  } finally { await file.close(); }
}
