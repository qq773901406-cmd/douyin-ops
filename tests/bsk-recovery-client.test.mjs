import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBsk } from '../lib/bsk-client.mjs';
import { acquireBrowserMaintenance } from '../lib/browser-activity.mjs';

test('命令栅栏拒绝执行；CLI成功后锁清理失败仍保留成功结果', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bsk-client-recovery-'));
  const previousDir = process.env.DOUFENG_DATA_DIR, previousBinary = process.env.BSK_BIN;
  process.env.DOUFENG_DATA_DIR = directory; process.env.BSK_BIN = process.execPath;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.DOUFENG_DATA_DIR; else process.env.DOUFENG_DATA_DIR = previousDir;
    if (previousBinary === undefined) delete process.env.BSK_BIN; else process.env.BSK_BIN = previousBinary;
    await rm(directory, { recursive: true, force: true });
  });
  const maintenance = await acquireBrowserMaintenance(directory);
  const blocked = await runBsk(['-e', 'process.stdout.write("should not execute")'], { json: false });
  assert.equal(blocked.code, 'BROWSER_RECOVERING');
  assert.equal(blocked.stdout, '');
  await maintenance.release();
  const successful = await runBsk(['-e', `
    const fs = require('node:fs'), path = require('node:path');
    const directory = path.join(process.env.DOUFENG_DATA_DIR, 'background-services', 'browser-activity');
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) fs.writeFileSync(path.join(directory, name), '{}');
    process.stdout.write(JSON.stringify({submitted:true,autoStart:process.env.BSK_AUTO_START}));
  `], { json: false });
  assert.equal(successful.ok, true);
  assert.deepEqual(JSON.parse(successful.stdout), { submitted: true, autoStart: '0' });
  assert.ok(successful.cleanupError);
});
