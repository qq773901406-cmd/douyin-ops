import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AutomationService } from '../automation-service.mjs';
import { defaultAutomation } from '../automation-model.mjs';

const temporaryRoot = fileURLToPath(new URL('../.codex_tmp/', import.meta.url));
async function fixture(t) {
  await mkdir(temporaryRoot, { recursive: true });
  const dir = await mkdtemp(join(temporaryRoot, 'automation-test-'));
  const service = new AutomationService(dir);
  t.after(async () => { service.stop(); assert.ok(resolve(dir).startsWith(resolve(temporaryRoot) + sep)); await rm(dir, { recursive: true, force: true }); });
  service.publisher = { publish: async () => assert.fail('测试不能调用真实发布程序') };
  const state = defaultAutomation(), scheduledAt = new Date().toISOString();
  state.config.enabled = true; state.config.accountId = 'test-account'; state.config.browserId = 'test-browser';
  state.items.push({ id: randomUUID(), sourcePath: join(dir, 'video.mp4'), fileName: 'video.mp4', sourceSize: 1, sourceMtime: 1, title: '测试', caption: '', status: 'running', scheduledAt, approval: { sha256: 'a'.repeat(64), asset: join(dir, 'video.mp4'), accountId: 'test-account', browserId: 'test-browser', title: '测试', caption: '', scheduledAt } });
  await service.store.replace(state);
  return { service, dir };
}
test('调度恢复中发现另一活跃进程获得执行锁时不能改写其运行状态', async t => {
  const { service } = await fixture(t);
  const update = service.store.update.bind(service.store);
  let first = true;
  service.store.update = async (...args) => {
    if (first) { first = false; await writeFile(join(service.directory, 'runner.lock'), JSON.stringify({ pid: process.pid })); }
    return update(...args);
  };
  await assert.rejects(service.start(), /另一个发布进程|已有豆蜂服务/);
  const saved = (await service.store.read()).value;
  assert.equal(saved.items[0].status, 'running'); assert.equal(saved.config.enabled, true);
});
test('确认没有活跃执行锁时把中断任务标为待核实且暂停', async t => {
  const { service } = await fixture(t);
  await service.start();
  const saved = (await service.store.read()).value;
  assert.equal(saved.items[0].status, 'uncertain'); assert.equal(saved.config.enabled, false);
});
