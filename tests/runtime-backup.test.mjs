import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRuntimeBackup, runtimeBackupHandler } from '../server/runtime-backup.mjs';
import { TaskRunner } from '../server/task-runner.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-backup-')), runtime = join(root, 'runtime'), backupDir = join(root, 'backups');
  await mkdir(join(runtime, 'media'), { recursive: true }); await mkdir(join(runtime, 'daily-production'));
  await writeFile(join(runtime, 'media', 'movie.mp4'), Buffer.from([0, 1, 2, 3, 255]));
  await writeFile(join(runtime, 'daily-production', 'state.json'), JSON.stringify({ runs: [{ id: 'receipt', status: 'submitted' }] }));
  await writeFile(join(runtime, 'state.json.lock'), 'active lock');
  t.after(() => rm(root, { recursive: true, force: true })); return { root, runtime, backupDir };
}

test('全量备份包含媒体和真实账本，逐文件哈希吻合，排除活跃锁，来源未变', async t => {
  const { runtime, backupDir } = await fixture(t);
  const result = await createRuntimeBackup(runtime, { backupDir }); assert.equal(result.status, 'completed'); assert.equal(result.output.fileCount, 2);
  const manifest = JSON.parse(await readFile(result.output.manifestPath, 'utf8'));
  assert.match(manifest.consistency, /不是跨文件事务快照/); assert.equal(manifest.excluded[0].path, 'state.json.lock');
  for (const entry of manifest.files) {
    const original = await readFile(join(runtime, entry.path)), copied = await readFile(join(result.output.directory, 'data', entry.path));
    assert.deepEqual(original, copied); assert.equal(entry.sha256, createHash('sha256').update(copied).digest('hex')); assert.equal(entry.stable, true);
  }
  const second = await createRuntimeBackup(runtime, { backupDir }); assert.notEqual(result.output.directory, second.output.directory);
  assert.equal(await readFile(join(runtime, 'state.json.lock'), 'utf8'), 'active lock');
});

test('缺少目录、相对路径、runtime 内部目录均拒绝', async t => {
  const { runtime } = await fixture(t);
  await assert.rejects(createRuntimeBackup(runtime), /backupDir/);
  await assert.rejects(createRuntimeBackup(runtime, { backupDir: './backups' }), /backupDir/);
  await assert.rejects(createRuntimeBackup(runtime, { backupDir: join(runtime, 'backups') }), /runtime 之外/);
  assert.throws(() => runtimeBackupHandler(runtime).validate({ backupDir: runtime }), /runtime 之外/);
});

test('备份期间源文件变化保留证据并 requires_action，不冒充一致快照', async t => {
  const { runtime, backupDir } = await fixture(t);
  let changed = false;
  const result = await createRuntimeBackup(runtime, { backupDir, beforeCopy: async ({ source }) => { if (!changed) { changed = true; await writeFile(source, 'modified during backup'); } } });
  assert.equal(result.status, 'requires_action'); assert.equal(result.output.stable, false);
  const manifest = JSON.parse(await readFile(result.output.manifestPath, 'utf8')); assert.ok(manifest.issues.length); assert.ok(manifest.observedChanges.length);
  assert.ok(manifest.files.some(file => !file.stable));
});

test('中断备份留下明确未完成 manifest', async t => {
  const { runtime, backupDir } = await fixture(t), controller = new AbortController(); controller.abort(new Error('stopped'));
  const result = await createRuntimeBackup(runtime, { backupDir, signal: controller.signal });
  assert.equal(result.status, 'requires_action'); const manifest = JSON.parse(await readFile(result.output.manifestPath, 'utf8')); assert.equal(manifest.status, 'interrupted'); assert.equal(manifest.files.length, 0);
});

test('任务执行器的备份 handler 不用进度写入污染正在复制的任务账本', async t => {
  const { runtime, backupDir } = await fixture(t);
  const runner = new TaskRunner(runtime, { handlers: { backup: runtimeBackupHandler(runtime) } });
  t.after(() => runner.stop()); await runner.initialize();
  const state = await runner.create({ kind: 'backup', input: { backupDir }, schedule: { type: 'once', at: new Date().toISOString() }, enabled: true });
  const result = await runner.runNow(state.tasks[0].id); assert.equal(result.status, 'completed'); assert.equal(result.output.stable, true);
  const manifest = JSON.parse(await readFile(result.output.manifestPath, 'utf8'));
  assert.ok(manifest.files.some(file => file.path === 'tasks/state.json'));
  assert.ok(manifest.excluded.some(file => file.path === 'tasks/runner.lease'));
  await runner.stop();
});
