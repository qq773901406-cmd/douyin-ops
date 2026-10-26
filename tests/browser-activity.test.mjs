import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireBrowserActivity, acquireBrowserMaintenance, clearExitedBrowserMaintenance } from '../lib/browser-activity.mjs';

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'doufeng-browser-activity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('执行中命令阻止恢复；恢复栅栏阻止新命令，释放后可以继续', async t => {
  const directory = await sandbox(t);
  const releaseCommand = await acquireBrowserActivity(directory);
  assert.equal((await acquireBrowserMaintenance(directory)).ok, false);
  await releaseCommand();
  const guard = await acquireBrowserMaintenance(directory);
  assert.equal(guard.ok, true);
  await assert.rejects(acquireBrowserActivity(directory), { code: 'BROWSER_RECOVERING' });
  assert.equal((await acquireBrowserMaintenance(directory)).ok, false);
  await guard.release();
  await (await acquireBrowserActivity(directory))();
});
test('并发抢占不能同时获得恢复权限和浏览器执行权限', async t => {
  const directory = await sandbox(t);
  for (let i = 0; i < 20; i++) {
    const [command, maintenance] = await Promise.allSettled([acquireBrowserActivity(directory), acquireBrowserMaintenance(directory)]);
    const commandOwns = command.status === 'fulfilled';
    const maintenanceOwns = maintenance.status === 'fulfilled' && maintenance.value.ok;
    assert.equal(commandOwns && maintenanceOwns, false);
    if (commandOwns) await command.value();
    if (maintenanceOwns) await maintenance.value.release();
  }
});
test('退出进程遗留命令可以回收，无法识别的执行记录必须阻止恢复', async t => {
  const directory = await sandbox(t), claims = join(directory, 'background-services', 'browser-activity');
  await mkdir(claims, { recursive: true });
  await writeFile(join(claims, 'old.json'), JSON.stringify({ pid: 99999999, token: 'old' }));
  const guard = await acquireBrowserMaintenance(directory, { pidAlive: () => false });
  assert.equal(guard.ok, true); await guard.release();
  await writeFile(join(claims, 'broken.json'), '{}');
  await assert.rejects(acquireBrowserMaintenance(directory), { code: 'BROWSER_RECOVERING' });
});
test('宿主独占启动后只清理已退出恢复锁，活进程与坏记录保留', async t => {
  const directory = await sandbox(t), claims = join(directory, 'background-services', 'browser-activity');
  await mkdir(claims, { recursive: true });
  await writeFile(join(claims, 'maintenance.json'), JSON.stringify({ pid: 99999999, token: 'old' }));
  await clearExitedBrowserMaintenance(directory, { pidAlive: () => true });
  await assert.rejects(acquireBrowserActivity(directory));
  await clearExitedBrowserMaintenance(directory, { pidAlive: () => false });
  await (await acquireBrowserActivity(directory))();
  await writeFile(join(claims, 'maintenance.json'), 'null');
  await assert.rejects(acquireBrowserActivity(directory));
});
