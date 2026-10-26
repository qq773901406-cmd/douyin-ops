import { createHash } from 'node:crypto';
import { mkdir, copyFile, realpath, stat, writeFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, extname, isAbsolute } from 'node:path';
import { shopPlatforms } from '../workbuddy/connector/lib/shop-products.mjs';
import { hashFile } from '../lib/fs-utils.mjs';

const fail = message => Object.assign(new Error(message), { status: 400, code: 'requires_action' });
const checkCancelled = context => { if (context.signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'cancelled' }); };
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 20 * 1024 ** 2;
export function distributionHandler(runtimeDir, workspace) {
  const validate = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['draftId', 'platforms'].includes(k))) throw fail('发布包参数无效。');
    if (typeof input.draftId !== 'string' || !input.draftId || !Array.isArray(input.platforms) || !input.platforms.length || input.platforms.length > 8 || input.platforms.some(p => !Object.hasOwn(shopPlatforms, p))) throw fail('请选择草稿和目标平台。');
    return { draftId: input.draftId, platforms: [...new Set(input.platforms)] };
  };
  return { readOnly: true, validate, async execute(input, context = {}) {
    input = validate(input);
    const draft = (await workspace.read()).value.drafts.find(d => d.id === input.draftId);
    if (!draft) throw fail('发布草稿需要可读取的本机成片或图片素材。');
    const content = { title: draft.pubTitle || draft.title || '', caption: draft.caption || '', tags: draft.hashtags || draft.topics || '', format: draft.format || '视频' };
    const isImagePost = content.format === '图文';
    if (isImagePost && draft.images !== undefined && !Array.isArray(draft.images)) throw fail('图文图片清单需要按顺序提供本机图片路径。');
    const sourcePaths = isImagePost && draft.images?.length ? draft.images : [draft.asset];
    if (sourcePaths.length > MAX_IMAGES) throw fail(`图文发布包最多支持 ${MAX_IMAGES} 张图片。`);
    const sources = [];
    for (const path of sourcePaths) {
      checkCancelled(context);
      if (typeof path !== 'string' || !path || !isAbsolute(path) || /^\\\\/.test(path)) throw fail('发布草稿需要可读取的本机成片或图片素材。');
      const source = await realpath(path);
      if (/^\\\\/.test(source)) throw fail('发布素材实际路径不能使用网络共享。');
      const info = await stat(source);
      const allowedExtension = isImagePost ? /\.(png|jpe?g|webp)$/i : /\.(mp4|mov|webm|mkv|m4v|png|jpe?g|webp)$/i;
      if (!info.isFile() || !info.size || info.size > (isImagePost ? MAX_IMAGE_BYTES : 4 * 1024 ** 3) || !allowedExtension.test(source)) throw fail(isImagePost ? '图文素材仅支持 PNG、JPEG、WebP 图片，每张不超过 20 MiB。' : '发布素材格式或大小不支持。');
      sources.push({ source, extension: extname(source).toLowerCase(), bytes: info.size, sha256: await hashFile(source) });
    }
    // Keep the video identity unchanged so previously prepared video manifests remain reusable.
    const identity = isImagePost ? sources.map(({ extension, bytes, sha256 }) => ({ extension, bytes, sha256 })) : sources[0].sha256;
    const key = createHash('sha256').update(JSON.stringify([input, content, identity])).digest('hex');
    const directory = join(resolve(runtimeDir), 'distribution', key), manifestPath = join(directory, 'manifest.json');
    const files = sources.map((source, index) => ({ path: join(directory, (isImagePost ? `image-${String(index + 1).padStart(3, '0')}` : 'asset') + source.extension), sha256: source.sha256, bytes: source.bytes }));
    const asset = files[0].path, sha256 = files[0].sha256;
    const packages = input.platforms.map(platform => ({ platform, label: shopPlatforms[platform], ...content, asset, sha256,
      ...(isImagePost ? { images: files.map(file => file.path), imageFiles: files } : {}),
      status: 'awaiting_approval', execution: platform === 'douyin' && content.format === '视频' ? 'approved-douyin-queue' : platform === 'bilibili' && content.format === '视频' ? 'agent-bilibili-workflow' : 'platform-executor-required' }));
    const sameFields = (actual, expected) => actual && Object.entries(expected).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value));
    const checkSourceUnchanged = async () => {
      for (const source of sources) if (await hashFile(source.source) !== source.sha256) throw fail('复制过程中素材发生变化，未建立发布包。');
    };
    const readExisting = async () => {
      const existing = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (existing.id !== key || existing.sourceDraftId !== draft.id || existing.publicationSubmitted !== false || !Array.isArray(existing.packages)
        || existing.packages.length !== packages.length || existing.packages.some((item, index) => !sameFields(item, packages[index]))) throw fail('已有发布包清单与来源不一致，请检查原清单。');
      for (const file of files) {
        checkCancelled(context);
        let actual;
        try { actual = await hashFile(file.path); } catch { throw fail('已有发布包的素材缺失或无法读取，请检查原发布包。'); }
        if (actual !== file.sha256) throw fail('已有发布包的素材校验失败，未将损坏副本标记为完成。');
      }
      await checkSourceUnchanged();
      return { status: 'completed', output: { ...existing, reused: true } };
    };
    try { return await readExisting(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    checkCancelled(context);
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < sources.length; index++) {
      checkCancelled(context);
      try { await copyFile(sources[index].source, files[index].path, constants.COPYFILE_EXCL); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (await hashFile(files[index].path) !== files[index].sha256) throw fail('复制过程中素材发生变化，未建立发布包。');
    }
    await checkSourceUnchanged();
    checkCancelled(context);
    const result = { id: key, sourceDraftId: draft.id, createdAt: new Date().toISOString(), summary: `已准备 ${packages.length} 个平台发布包，尚未提交。`, packages, artifacts: [manifestPath], publicationSubmitted: false };
    try { await writeFile(manifestPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return readExisting(); throw error; }
    return { status: 'completed', output: result };
  } };
}
