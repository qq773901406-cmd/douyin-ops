import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { inspectProductVideoEnvironment, usableProductImages } from '../server/product-video.mjs';

test('商品图片解码筛选跳过损坏文件，并保留后面的正常图片', async t => {
  const environment = await inspectProductVideoEnvironment();
  if (!environment.ok) { t.skip(environment.message); return; }
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'doufeng-product-images-'));
  assert.equal(dirname(resolve(directory)), temporaryRoot);
  assert.ok(basename(directory).startsWith('doufeng-product-images-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const broken = join(directory, 'broken.png'), truncated = join(directory, 'truncated.png'), valid = join(directory, 'valid.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await writeFile(broken, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  // The truncated image has readable dimensions but cannot decode its pixels.
  await writeFile(truncated, png.subarray(0, 42));
  await writeFile(valid, png);
  // Six undecodable files must not hide a good seventh candidate.
  const images = [...Array.from({ length: 5 }, (_, index) => ({ name: `broken-${index}.png`, path: broken })), { name: 'truncated.png', path: truncated }, { name: 'valid.png', path: valid }];
  const result = await usableProductImages({ images });
  assert.deepEqual(result.images.map(image => image.name), ['valid.png']);
  assert.equal(result.warnings.length, 6);
  assert.ok(result.warnings.every(message => /(?:broken-\d|truncated)\.png：图片无法解码/.test(message)));
  const rejected = await usableProductImages({ images: images.slice(0, 1) });
  assert.equal(rejected.images.length, 0);
  assert.equal(rejected.warnings.length, 1);
});
