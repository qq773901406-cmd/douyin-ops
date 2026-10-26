import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, unlink, truncate } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { distributionHandler } from '../server/distribution-preparation.mjs';

async function fixture(t) {
  const scratch = resolve('.codex_tmp'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'distribution-')), asset = join(root, 'source.mp4'), bytes = Buffer.from('fixture video bytes');
  await writeFile(asset, bytes); const draft = { id: 'd1', title: '标题', caption: '正文', hashtags: '#标签', format: '视频', platform: 'douyin', asset };
  const workspace = { read: async () => ({ value: { drafts: [draft] } }) }, handler = distributionHandler(join(root, 'runtime'), workspace);
  t.after(() => { const path = relative(scratch, resolve(root)); assert.ok(path && !path.startsWith('..') && !isAbsolute(path)); return rm(root, { recursive: true, force: true }); }); return { handler, draft, bytes, root };
}

async function imageFixture(t) {
  const result = await fixture(t);
  const images = [join(result.root, 'first.png'), join(result.root, 'second.jpg'), join(result.root, 'third.webp')];
  const imageBytes = [Buffer.from('first PNG fixture'), Buffer.from('second JPEG fixture'), Buffer.from('third WebP fixture')];
  for (let index = 0; index < images.length; index++) await writeFile(images[index], imageBytes[index]);
  result.draft.format = '图文'; result.draft.images = images; delete result.draft.asset;
  return { ...result, imageBytes };
}

test('分发包复制真实素材并校验哈希，各平台保持待审批而非提交成功', async t => {
  const { handler, bytes, draft } = await fixture(t);
  const result = await handler.execute({ draftId: draft.id, platforms: ['douyin', 'bilibili', 'xiaohongshu'] });
  assert.equal(result.status, 'completed'); assert.equal(result.output.publicationSubmitted, false); assert.equal(result.output.packages.length, 3);
  for (const pack of result.output.packages) { assert.equal(pack.status, 'awaiting_approval'); assert.deepEqual(await readFile(pack.asset), bytes); assert.equal(pack.sha256, createHash('sha256').update(bytes).digest('hex')); }
  assert.equal(result.output.packages[0].execution, 'approved-douyin-queue'); assert.equal(result.output.packages[1].execution, 'agent-bilibili-workflow'); assert.equal(result.output.packages[2].execution, 'platform-executor-required');
  assert.deepEqual(await readFile(draft.asset), bytes);
});

test('相同素材/文案/平台幂等复用，文案变更产生独立发布包', async t => {
  const { handler, draft } = await fixture(t), input = { draftId: draft.id, platforms: ['douyin', 'douyin'] };
  const first = await handler.execute(input), second = await handler.execute(input);
  assert.equal(first.output.id, second.output.id); assert.equal(second.output.reused, true); assert.equal(second.output.packages.length, 1);
  draft.caption = '新正文'; const third = await handler.execute(input); assert.notEqual(third.output.id, first.output.id);
});

test('已生成包的素材被篡改或缺失不能假报复用成功', async t => {
  const { handler, draft } = await fixture(t), input = { draftId: draft.id, platforms: ['douyin'] };
  const result = await handler.execute(input), asset = result.output.packages[0].asset;
  await writeFile(asset, 'tampered'); await assert.rejects(handler.execute(input), /素材校验失败/);
  await unlink(asset); await assert.rejects(handler.execute(input), /素材缺失/);
});

test('不存在素材、未知平台和取消不产生成功发布包', async t => {
  const { handler, draft } = await fixture(t);
  assert.throws(() => handler.validate({ draftId: draft.id, platforms: ['shell'] }), /目标平台/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(handler.execute({ draftId: draft.id, platforms: ['douyin'] }, { signal: controller.signal }), /已取消/);
  await unlink(draft.asset); await assert.rejects(handler.execute({ draftId: draft.id, platforms: ['douyin'] }), { code: 'ENOENT' });
});

test('无 asset 的图文按 images 顺序复制全部图片并记录每张路径、大小和哈希', async t => {
  const { handler, draft, imageBytes } = await imageFixture(t);
  const result = await handler.execute({ draftId: draft.id, platforms: ['douyin', 'xiaohongshu'] });
  assert.equal(result.status, 'completed'); assert.equal(result.output.publicationSubmitted, false);
  for (const pack of result.output.packages) {
    assert.equal(pack.status, 'awaiting_approval'); assert.equal(pack.execution, 'platform-executor-required');
    assert.equal(pack.images.length, 3); assert.equal(pack.asset, pack.images[0]); assert.equal(pack.sha256, pack.imageFiles[0].sha256);
    assert.deepEqual(pack.images, pack.imageFiles.map(file => file.path));
    for (const [index, file] of pack.imageFiles.entries()) {
      assert.deepEqual(await readFile(file.path), imageBytes[index]);
      assert.equal(file.bytes, imageBytes[index].length);
      assert.equal(file.sha256, createHash('sha256').update(imageBytes[index]).digest('hex'));
      assert.notEqual(file.path, draft.images[index]);
      assert.deepEqual(await readFile(draft.images[index]), imageBytes[index]);
    }
  }
  const manifest = JSON.parse(await readFile(result.output.artifacts[0], 'utf8'));
  assert.deepEqual(manifest.packages, result.output.packages);
});

test('图片列表优先于旧 asset，重复图片按原顺序保留，空列表兼容单图 asset', async t => {
  const { handler, draft } = await imageFixture(t);
  draft.asset = join('missing', 'old-asset.png');
  draft.images = [draft.images[1], draft.images[0], draft.images[1]];
  const input = { draftId: draft.id, platforms: ['xiaohongshu'] }, first = await handler.execute(input);
  assert.equal(first.output.packages[0].images.length, 3);
  const files = first.output.packages[0].imageFiles;
  assert.equal(files[0].sha256, files[2].sha256); assert.notEqual(files[0].path, files[2].path);
  draft.asset = draft.images[1]; draft.images = [];
  const second = await handler.execute(input);
  assert.equal(second.output.packages[0].images.length, 1);
});

test('图文幂等身份覆盖全部图片、顺序、格式和文案', async t => {
  const { handler, draft } = await imageFixture(t), input = { draftId: draft.id, platforms: ['xiaohongshu'] };
  const first = await handler.execute(input), again = await handler.execute(input);
  assert.equal(again.output.id, first.output.id); assert.equal(again.output.reused, true);
  draft.images.reverse(); const reordered = await handler.execute(input); assert.notEqual(reordered.output.id, first.output.id);
  await writeFile(draft.images[1], 'changed middle image'); const changed = await handler.execute(input); assert.notEqual(changed.output.id, reordered.output.id);
  draft.caption = '修改后的图文正文'; const recaptioned = await handler.execute(input); assert.notEqual(recaptioned.output.id, changed.output.id);
  draft.pubTitle = '修改后的图文标题'; const retitled = await handler.execute(input); assert.notEqual(retitled.output.id, recaptioned.output.id);
  draft.hashtags = '#新的标签'; const retagged = await handler.execute(input); assert.notEqual(retagged.output.id, retitled.output.id);
  const previous = draft.images[0], sameBytes = join(previous + '.png'); await writeFile(sameBytes, await readFile(previous)); draft.images[0] = sameBytes;
  const extensionChanged = await handler.execute(input); assert.notEqual(extensionChanged.output.id, retagged.output.id);
});

test('图文复用验证非首图，损坏或缺失不能复用成功', async t => {
  const { handler, draft, imageBytes } = await imageFixture(t), input = { draftId: draft.id, platforms: ['xiaohongshu'] };
  const result = await handler.execute(input), second = result.output.packages[0].images[1], third = result.output.packages[0].images[2];
  await writeFile(second, 'tampered second image'); await assert.rejects(handler.execute(input), /素材校验失败/);
  await writeFile(second, imageBytes[1]); await unlink(third); await assert.rejects(handler.execute(input), /素材缺失/);
  assert.deepEqual(await readFile(draft.images[2]), imageBytes[2]);
});

test('发布包复用验证图文有序清单和元数据，视频旧包仍能复用', async t => {
  const { handler, draft } = await imageFixture(t), input = { draftId: draft.id, platforms: ['xiaohongshu'] };
  const result = await handler.execute(input), manifestPath = result.output.artifacts[0], original = await readFile(manifestPath, 'utf8');
  const mutations = [
    pack => { pack.images.reverse(); },
    pack => { pack.imageFiles[1].sha256 = 'changed'; },
    pack => { pack.imageFiles[1].bytes += 1; },
    pack => { pack.imageFiles[1].path = pack.imageFiles[0].path; },
    pack => { pack.caption = '未授权文案'; },
    pack => { pack.title = '未授权标题'; },
    pack => { pack.tags = '#未授权'; },
    pack => { pack.execution = 'approved-douyin-queue'; },
  ];
  for (const mutate of mutations) {
    const manifest = JSON.parse(original); mutate(manifest.packages[0]); await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(handler.execute(input), /清单与来源不一致/);
  }
  await writeFile(manifestPath, original); assert.equal((await handler.execute(input)).output.reused, true);
  draft.format = '视频'; draft.asset = join(result.output.packages[0].asset); delete draft.images;
  const video = await handler.execute(input);
  assert.equal(Object.hasOwn(video.output.packages[0], 'images'), false);
  const content = { title: draft.title, caption: draft.caption, tags: draft.hashtags, format: '视频' };
  assert.equal(video.output.id, createHash('sha256').update(JSON.stringify([input, content, video.output.packages[0].sha256])).digest('hex'));
  assert.equal((await handler.execute(input)).output.reused, true);
});

test('图文拒绝超限、无效格式、网络共享和无效图片列表，不截断用户图片', async t => {
  const { handler, draft } = await imageFixture(t), input = { draftId: draft.id, platforms: ['xiaohongshu'] }, first = draft.images[0];
  draft.images = Array(21).fill(first); await assert.rejects(handler.execute(input), /最多支持 20/);
  draft.images = 'not-an-array'; await assert.rejects(handler.execute(input), /图片清单/);
  draft.images = [{ path: first }]; await assert.rejects(handler.execute(input), /本机/);
  draft.images = ['https://example.com/image.png']; await assert.rejects(handler.execute(input), /本机/);
  draft.images = ['\\\\server\\share\\image.png']; await assert.rejects(handler.execute(input), /本机/);
  draft.images = [join(first + '.mp4')]; await writeFile(draft.images[0], 'video'); await assert.rejects(handler.execute(input), /仅支持/);
  draft.images = [first]; await truncate(first, 20 * 1024 ** 2 + 1); await assert.rejects(handler.execute(input), /20 MiB/);
});
