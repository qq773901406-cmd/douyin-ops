import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, renameWithRetry } from '../workbuddy/connector/lib/json-store.mjs';
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

test('Windows 短暂占用只退避重命名同一个完整临时文件，原内容保持到成功替换', async t => {
  const { dir, file } = await fixture(t);
  const temporary = join(dir, 'prepared.tmp');
  await writeFile(file, 'old receipt'); await writeFile(temporary, 'new receipt');
  const attempts = [], waits = [], transient = ['EPERM', 'EBUSY', 'EACCES'];
  await renameWithRetry(temporary, file, {
    platform: 'win32', wait: async milliseconds => { waits.push(milliseconds); },
    renameFile: async (source, destination) => {
      attempts.push([source, destination]);
      assert.equal(await readFile(source, 'utf8'), 'new receipt');
      assert.equal(await readFile(destination, 'utf8'), 'old receipt');
      if (attempts.length <= transient.length) throw Object.assign(new Error('simulated sharing lock'), { code: transient[attempts.length - 1] });
      await rename(source, destination);
    }
  });
  assert.deepEqual(waits, [10, 20, 40]);
  assert.deepEqual(attempts, Array.from({ length: 4 }, () => [temporary, file]));
  assert.equal(await readFile(file, 'utf8'), 'new receipt');
  await assert.rejects(readFile(temporary), { code: 'ENOENT' });
});

test('Windows 持续拒绝重命名会有界失败，保留原错误与原目标文件', async t => {
  const { dir, file } = await fixture(t);
  const temporary = join(dir, 'prepared.tmp');
  await writeFile(file, 'old receipt'); await writeFile(temporary, 'new receipt');
  const failure = Object.assign(new Error('persistent access denied'), { code: 'EACCES' });
  let attempts = 0; const waits = [];
  await assert.rejects(renameWithRetry(temporary, file, { platform: 'win32', wait: async milliseconds => { waits.push(milliseconds); }, renameFile: async () => { attempts++; throw failure; } }), error => error === failure);
  assert.equal(attempts, 8); assert.deepEqual(waits, [10, 20, 40, 80, 160, 160, 160]);
  assert.equal(await readFile(file, 'utf8'), 'old receipt');
  assert.equal(await readFile(temporary, 'utf8'), 'new receipt');
});

test('其他平台的权限问题和 Windows 非占用错误不重试', async () => {
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'EIO'], ['win32', 'ENOENT']]) {
    let attempts = 0;
    const failure = Object.assign(new Error('not retryable'), { code });
    await assert.rejects(renameWithRetry('prepared.tmp', 'receipt.json', { platform, wait: async () => assert.fail('不应退避'), renameFile: async () => { attempts++; throw failure; } }), error => error === failure);
    assert.equal(attempts, 1);
  }
});
