import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BilibiliWorkflow } from '../server/bilibili-workflow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = join(root, '.codex_tmp');
const exec = promisify(execFile);
async function fixture(t) {
  await mkdir(temporaryRoot, { recursive: true });
  const dir = await mkdtemp(join(temporaryRoot, 'bili-test-'));
  t.after(async () => { assert.ok(resolve(dir).startsWith(resolve(temporaryRoot) + sep)); await rm(dir, { recursive: true, force: true }); });
  const video = join(dir, 'video.mp4'), evidence = join(dir, 'screen.png');
  await writeFile(video, 'unit fixture: no browser upload'); await writeFile(evidence, 'unit screenshot fixture');
  const workflow = new BilibiliWorkflow(join(dir, 'bilibili-publish'));
  const manifest = { videoPath: video, accountName: '测试账号', accountUid: '12345', browserId: 'test-browser', title: '测试视频', description: '', tags: ['测试'], aiGenerated: true, category: '人工智能' };
  const begin = { accountName: manifest.accountName, accountUid: manifest.accountUid, browserId: manifest.browserId, authorization: '测试夹具中的授权，不进行外部操作', evidence };
  return { dir, workflow, manifest, begin, evidence };
}
test('B站准备保存独立副本，同账号相同内容阻止重复准备', async t => {
  const { workflow, manifest } = await fixture(t);
  const job = await workflow.prepare(manifest);
  assert.notEqual(job.video.path, manifest.videoPath);
  assert.deepEqual(await readFile(job.video.path), await readFile(manifest.videoPath));
  await assert.rejects(workflow.prepare({ ...manifest, title: '不同标题' }), /已有记录/);
});
test('B站并发开始只能有一次成功，重建实例不能解除保护', async t => {
  const { workflow, manifest, begin } = await fixture(t);
  const job = await workflow.prepare(manifest);
  const results = await Promise.allSettled([workflow.beginSubmit(job.id, begin), workflow.beginSubmit(job.id, begin)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(new BilibiliWorkflow(workflow.directory).beginSubmit(job.id, begin), /禁止再次提交/);
});
test('B站素材副本变化或账号不一致时不能提交', async t => {
  const { workflow, manifest, begin } = await fixture(t);
  const job = await workflow.prepare(manifest);
  await assert.rejects(workflow.beginSubmit(job.id, { ...begin, accountUid: '99999' }), /不一致/);
  await writeFile(job.video.path, 'modified');
  await assert.rejects(workflow.beginSubmit(job.id, begin), /副本发生变化/);
  assert.equal((await workflow.show(job.id)).status, 'prepared');
});
test('B站审核中可以升级已发布，不能变更作品编号或重新开始', async t => {
  const { workflow, manifest, begin, evidence } = await fixture(t);
  const job = await workflow.prepare(manifest); await workflow.beginSubmit(job.id, begin);
  const receipt = { status: 'submitted', url: 'https://www.bilibili.com/video/BV1234567890/', evidence, note: '测试审核结果' };
  await workflow.finish(job.id, receipt);
  await assert.rejects(workflow.finish(job.id, { ...receipt, status: 'published', url: 'https://www.bilibili.com/video/BV0987654321/' }), /编号/);
  await workflow.finish(job.id, { ...receipt, status: 'published' });
  await assert.rejects(workflow.beginSubmit(job.id, begin), /禁止再次提交/);
});
test('B站结果不明保留保护，确认未投稿后才能重新准备', async t => {
  const { workflow, manifest, begin, evidence } = await fixture(t);
  const job = await workflow.prepare(manifest); await workflow.beginSubmit(job.id, begin);
  await workflow.finish(job.id, { status: 'uncertain', evidence, note: '测试断线' });
  await assert.rejects(workflow.prepare(manifest), /已有记录/);
  await assert.rejects(workflow.abandon(job.id, '误操作'), /只能放弃/);
  await workflow.confirmNotSubmitted(job.id, { authorization: '测试确认未投稿', evidence, note: '测试平台核实' });
  assert.equal((await workflow.prepare(manifest)).status, 'prepared');
});
test('B站 CLI 跟随工作台自定义数据目录，显式目录优先', async t => {
  const { workflow, manifest, dir } = await fixture(t);
  const job = await workflow.prepare(manifest);
  const invoke = args => exec(process.execPath, ['scripts/bilibili-workflow.mjs', ...args], { cwd: root, windowsHide: true, env: { ...process.env, DOUFENG_DATA_DIR: dir } });
  const result = JSON.parse((await invoke(['list'])).stdout);
  assert.equal(result.result.length, 1); assert.equal(result.result[0].id, job.id);
  const other = JSON.parse((await invoke(['list', '--data-dir', join(dir, 'empty')])).stdout);
  assert.deepEqual(other.result, []);
});
