import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { productVideoPython } from '../server/product-video.mjs';

test('Wan延后首次GET并保存原事件终态：断线只读恢复，不重提交或归因用户', { timeout: 20000 }, async t => {
  try {
    await promisify(execFile)(productVideoPython(), [fileURLToPath(new URL('./free_wan_recovery_test.py', import.meta.url))],
      { windowsHide: true, timeout: 15000, env: { ...process.env, PYTHONUTF8: '1' } });
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('本机未安装 Python。'); return; }
    throw error;
  }
});
