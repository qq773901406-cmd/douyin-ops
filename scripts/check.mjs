import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directories = ['', 'public', 'server', 'shared', 'lib', 'scripts', 'tests', 'workbuddy/connector', 'workbuddy/connector/lib'];
let count = 0;
for (const directory of directories) {
  for (const item of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (!item.isFile() || !/\.(js|mjs)$/.test(item.name)) continue;
    const result = spawnSync(process.execPath, ['--check', join(root, directory, item.name)], { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) process.exit(1);
    count += 1;
  }
}
console.log(`静态语法检查通过：${count} 个文件。未执行功能测试。`);
