import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, mkdir, unlink, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const address = 'http://127.0.0.1:11434';
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
const read = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export async function probeLocalModel({ fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  try {
    const response = await fetchImpl(`${address}/api/version`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) return { state: 'conflict', message: '本地模型端口返回非预期响应。' };
    const body = await response.json();
    if (typeof body.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(body.version)) return { state: 'conflict', message: '本地模型版本无法核实。' };
    return { state: 'healthy', version: body.version, address };
  } catch (error) {
    const refused = error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED';
    return { state: refused ? 'absent' : 'unknown', message: refused ? '项目本地模型尚未启动。' : '本地模型响应不明，不创建重复实例。' };
  }
}

// Startup is opt-in through a local installation receipt. This helper never
// installs, updates, pulls models, restarts, or terminates existing processes.
export async function ensureProjectLocalModel(runtimeDir, { probe = probeLocalModel, spawnImpl = spawn, pidAlive = alive, pause = delay } = {}) {
  const directory = join(resolve(runtimeDir), 'ollama'), config = await read(join(directory, 'runtime.json'));
  if (!config?.enabled) return { state: 'unconfigured', message: '项目本地模型未安装或未启用。' };
  if (config.version !== 1 || !/^[a-f0-9]{64}$/.test(config.binarySha256 || '')) throw new Error('本地模型安装凭据无效。');
  const health = await probe();
  if (health.state !== 'absent') return health;
  const binary = await realpath(join(directory, 'bin', 'ollama.exe')), expected = resolve(directory, 'bin');
  if (!binary.toLowerCase().startsWith((expected + sep).toLowerCase())) throw new Error('本地模型程序不在项目安装目录内。');
  if (createHash('sha256').update(await readFile(binary)).digest('hex') !== config.binarySha256) throw new Error('本地模型程序校验失败，请保留安装凭据。');
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, 'start.lock'), token = randomUUID();
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await read(lockPath);
    if (owner && !pidAlive(owner.pid)) {
      // A stale lock is kept for inspection; guessing ownership cannot trigger
      // extra model processes after an interrupted setup.
      return { state: 'blocked', message: '上次模型启动中断，保留启动锁等待核对。' };
    }
    return { state: 'starting', message: '已有本地模型启动过程。' };
  }
  let child, output, errors;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })); await lock.sync(); await lock.close(); lock = null;
    const current = await probe();
    if (current.state !== 'absent') return current;
    const prior = await read(join(directory, 'process.json'));
    if (prior?.pid && pidAlive(prior.pid)) return { state: 'blocked', message: '已启动的项目模型尚未就绪，不新建实例。' };
    await mkdir(join(directory, 'models'), { recursive: true });
    output = await open(join(directory, 'stdout.log'), 'a'); errors = await open(join(directory, 'stderr.log'), 'a');
    child = spawnImpl(binary, ['serve'], { cwd: directory, windowsHide: true, shell: false,
      env: { ...process.env, OLLAMA_MODELS: join(directory, 'models'), OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NO_CLOUD: '1', OLLAMA_CONTEXT_LENGTH: '4096', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_KEEP_ALIVE: '1m' },
      stdio: ['ignore', output.fd, errors.fd] });
    let spawnError;
    child.on('error', error => { spawnError = error; }); child.unref?.();
    const marker = await open(join(directory, 'process.json'), 'w');
    try { await marker.writeFile(JSON.stringify({ pid: child.pid || null, binary, at: new Date().toISOString(), noCloud: true, models: join(directory, 'models') }, null, 2)); await marker.sync(); }
    finally { await marker.close(); }
    for (let attempt = 0; attempt < 30; attempt++) {
      if (spawnError) throw spawnError;
      const ready = await probe();
      if (ready.state === 'healthy') return { ...ready, owned: true, pid: child.pid };
      if (ready.state === 'conflict') return ready;
      if (child.exitCode !== null && child.exitCode !== undefined) throw new Error(`本地模型进程已退出（${child.exitCode}），请查看项目模型日志。`);
      await pause(1000);
    }
    return { state: 'starting', owned: true, pid: child.pid, message: '本地模型尚未返回就绪状态，未创建第二个实例。' };
  } finally {
    await lock?.close(); await output?.close(); await errors?.close();
    const owner = await read(lockPath);
    if (owner?.token === token) await unlink(lockPath);
  }
}
