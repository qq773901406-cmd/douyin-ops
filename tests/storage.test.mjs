import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';
import { BackupStore } from '../workbuddy/connector/lib/backup-store.mjs';

const temporaryRoot = fileURLToPath(new URL('../.codex_tmp/', import.meta.url));
async function fixture(t) {
  await mkdir(temporaryRoot, { recursive: true });
  const dir = await mkdtemp(join(temporaryRoot, 'storage-test-'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(temporaryRoot) + sep));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, file: join(dir, 'workbench.json'), store: new JsonStore(join(dir, 'workbench.json'), normalizeState(), normalizeState, { snapshots: true }) };
}
test('保存冲突返回 409 并保留较新数据', async t => {
  const { store } = await fixture(t);
  const first = await store.replace(normalizeState({ account: '第一次' }), 'missing');
  const newer = await store.update(state => { state.account = '最新'; }, first.revision);
  await assert.rejects(store.replace(normalizeState({ account: '过期' }), first.revision), { status: 409 });
  assert.equal((await store.read()).revision, newer.revision);
});
test('并发写入串行化且不丢失记录', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.update(state => { state.records.push({ id: String(i), title: `记录 ${i}` }); })));
  assert.equal((await store.read()).value.records.length, 8);
});
test('损坏的原文件不会被新保存覆盖', async t => {
  const { store, file } = await fixture(t);
  await writeFile(file, '{broken');
  await assert.rejects(store.replace(normalizeState()), /原数据未覆盖/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
test('自动快照、手动备份和 .bak 可以读取', async t => {
  const { store, dir, file } = await fixture(t);
  await store.replace(normalizeState({ account: '备份前' }));
  await store.update(state => { state.account = '备份后'; });
  assert.equal(JSON.parse(await readFile(file + '.bak', 'utf8')).account, '备份前');
  const backups = new BackupStore(join(dir, 'backups'));
  const list = await backups.list(); assert.equal(list.length, 1);
  assert.equal((await backups.read(list[0].id)).state.account, '备份前');
  const manual = await backups.create((await store.read()).value, 'manual', '验证');
  assert.equal((await backups.read(manual.id)).state.account, '备份后');
});
test('备份编号不能越过目录', async t => {
  const { dir } = await fixture(t);
  await assert.rejects(new BackupStore(join(dir, 'backups')).read('../workbench.json'), { status: 400 });
});
