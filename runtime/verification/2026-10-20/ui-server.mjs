import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = 'D:/ai';
const here = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(here, process.env.VERIFICATION_DATA_LABEL || 'ui-data');
await mkdir(dataDir, { recursive: true });
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
await writeFile(join(here, 'ui-server.json'), JSON.stringify({ port, dataDir, url: `http://127.0.0.1:${port}` }, null, 2));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root, windowsHide: true, stdio: 'inherit',
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DOUFENG_DATA_DIR: dataDir }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code || 0; });
