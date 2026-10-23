import { createHash } from 'node:crypto';
import { mkdir, copyFile, realpath, stat, writeFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, extname, isAbsolute } from 'node:path';
import { shopPlatforms } from '../workbuddy/connector/lib/shop-products.mjs';
import { hashFile } from '../lib/fs-utils.mjs';

const fail = message => Object.assign(new Error(message), { status: 400, code: 'requires_action' });
export function distributionHandler(runtimeDir, workspace) {
  const validate = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['draftId', 'platforms'].includes(k))) throw fail('发布包参数无效。');
    if (typeof input.draftId !== 'string' || !input.draftId || !Array.isArray(input.platforms) || !input.platforms.length || input.platforms.length > 8 || input.platforms.some(p => !Object.hasOwn(shopPlatforms, p))) throw fail('请选择草稿和目标平台。');
    return { draftId: input.draftId, platforms: [...new Set(input.platforms)] };
  };
  return { readOnly: true, validate, async execute(input, context = {}) {
    input = validate(input);
    const draft = (await workspace.read()).value.drafts.find(d => d.id === input.draftId);
    if (!draft || !draft.asset || !isAbsolute(draft.asset) || /^\\\\/.test(draft.asset)) throw fail('发布草稿需要可读取的本机成片或图片素材。');
    const source = await realpath(draft.asset), info = await stat(source);
    if (!info.isFile() || !info.size || info.size > 4 * 1024 ** 3 || !/\.(mp4|mov|webm|mkv|m4v|png|jpe?g|webp)$/i.test(source)) throw fail('发布素材格式或大小不支持。');
    const sha256 = await hashFile(source);
    const content = { title: draft.pubTitle || draft.title || '', caption: draft.caption || '', tags: draft.hashtags || draft.topics || '', format: draft.format || '视频' };
    const key = createHash('sha256').update(JSON.stringify([input, content, sha256])).digest('hex');
    const directory = join(resolve(runtimeDir), 'distribution', key), manifestPath = join(directory, 'manifest.json');
    try { const existing = JSON.parse(await readFile(manifestPath, 'utf8')); return { status: 'completed', output: { ...existing, reused: true } }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (context.signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'cancelled' });
    await mkdir(directory, { recursive: true });
    const asset = join(directory, 'asset' + extname(source).toLowerCase());
    try { await copyFile(source, asset, constants.COPYFILE_EXCL); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (await hashFile(asset) !== sha256 || await hashFile(source) !== sha256) throw fail('复制过程中素材发生变化，未建立发布包。');
    const packages = input.platforms.map(platform => ({ platform, label: shopPlatforms[platform], ...content, asset, sha256, status: 'awaiting_approval', execution: platform === 'douyin' && content.format === '视频' ? 'approved-douyin-queue' : platform === 'bilibili' && content.format === '视频' ? 'agent-bilibili-workflow' : 'platform-executor-required' }));
    const result = { id: key, sourceDraftId: draft.id, createdAt: new Date().toISOString(), summary: `已准备 ${packages.length} 个平台发布包，尚未提交。`, packages, artifacts: [manifestPath], publicationSubmitted: false };
    await writeFile(manifestPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return { status: 'completed', output: result };
  } };
}
