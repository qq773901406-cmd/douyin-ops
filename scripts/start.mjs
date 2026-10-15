import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = resolve(process.env.DOUFENG_DATA_DIR || join(root, 'runtime'));
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 11)) throw new Error('需要 Node.js 20.11 或更新版本。');
const noOpen = process.argv.includes('--no-open');
const ports = process.env.PORT ? [Number(process.env.PORT)] : Array.from({ length: 11 }, (_, i) => 4174 + i);
if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('PORT 配置无效。');
async function status(port) {
  try { const response = await fetch(`http://127.0.0.1:${port}/api/system`, { signal: AbortSignal.timeout(1000) }); return response.ok ? await response.json() : null; } catch { return null; }
}
function available(port) {
  return new Promise(resolve => { const probe = createServer(); probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))); });
}
function show(port) {
  const url = `http://127.0.0.1:${port}/#home`;
  console.log(`豆蜂已就绪：${url}\n数据目录：${dataDir}`);
  if (!noOpen) {
    const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const browser = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true }); browser.on('error', () => console.log('请复制上方地址到浏览器打开。')); browser.unref();
  }
}
async function main() {
let selected;
for (const port of ports) {
  const existing = await status(port);
  if (existing?.service === 'douyin-ops-workbuddy-workbench' && resolve(existing.dataDir || '') === dataDir && resolve(existing.root || '') === resolve(root)) { show(port); return; }
  if (selected === undefined && await available(port)) selected = port;
}
if (!selected) throw new Error('可用端口已被占用。请设置 PORT 后重新启动。');
const logDir = join(dataDir, 'logs'); await mkdir(logDir, { recursive: true });
const timestamp = Date.now(); const output = await open(join(logDir, `${timestamp}.out.log`), 'a'); const errors = await open(join(logDir, `${timestamp}.err.log`), 'a');
const child = spawn(process.execPath, [join(root, 'server.mjs')], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', output.fd, errors.fd], env: { ...process.env, PORT: String(selected), HOST: '127.0.0.1', DOUFENG_DATA_DIR: dataDir } });
let spawnError; child.once('error', error => { spawnError = error; }); child.unref(); await output.close(); await errors.close();
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (spawnError) throw spawnError;
  const ready = await status(selected);
  if (ready?.pid === child.pid) { await writeFile(join(logDir, 'latest.json'), JSON.stringify({ pid: child.pid, port: selected, startedAt: new Date().toISOString() }, null, 2)); show(selected); return; }
  await delay(250);
}
throw new Error(`启动未就绪，请查看 ${logDir} 中的错误日志。`);
}
try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
