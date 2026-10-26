// Run this foreground owner from the current user's persistent task host.
// It restores processes only; publishing authorization and receipts are untouched.
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, rename, unlink, appendFile, stat, access } from 'node:fs/promises';
import { resolve, join, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseBskJson } from '../lib/bsk-client.mjs';
import { workbenchHealth, workbenchFailure, browserHealth, browserFailure, shortDiagnostic, restartDelayMs, mayStart, mayStopOwnedChild, stalledRecoveryDecision } from '../lib/background-service-policy.mjs';
import { acquireBrowserMaintenance, clearExitedBrowserMaintenance } from '../lib/browser-activity.mjs';
import { acquireRecoveryGuard } from '../lib/background-recovery-guard.mjs';
import { createBrowserConnectionRecovery } from '../lib/browser-connection-recovery.mjs';
import { recoverOwnedBrowser } from '../lib/recover-owned-browser.mjs';

const execute = promisify(execFile);
const scriptRoot = fileURLToPath(new URL('../', import.meta.url));
const configFlag = process.argv.indexOf('--config');
if (configFlag >= 0 && !process.argv[configFlag + 1]) throw new Error('--config 需要绝对路径。');
const configPath = resolve(configFlag >= 0 ? process.argv[configFlag + 1] : join(scriptRoot, 'runtime', 'background-services', 'config.json'));
const config = JSON.parse(await readFile(configPath, 'utf8'));
for (const field of ['root', 'dataDir', 'bskBinary', 'nodeBinary']) {
  if (typeof config[field] !== 'string' || !isAbsolute(config[field])) throw new Error(`后台配置 ${field} 必须为绝对路径。`);
  config[field] = resolve(config[field]);
}
if (config.bskHome !== undefined && (typeof config.bskHome !== 'string' || !isAbsolute(config.bskHome))) throw new Error('bskHome 必须为绝对路径。');
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('后台配置 port 无效。');
if (config.browserLaunch) {
  const launch = config.browserLaunch;
  if (typeof launch.executable !== 'string' || !isAbsolute(launch.executable)
    || !['msedge.exe', 'chrome.exe'].includes(basename(launch.executable).toLowerCase())
    || typeof launch.profileDirectory !== 'string' || !/^(Default|Profile \d+)$/.test(launch.profileDirectory)) {
    throw new Error('browserLaunch 必须使用已验证的 Edge/Chrome 可执行文件和现有配置目录名。');
  }
  await access(launch.executable);
}
if (process.platform !== 'win32') throw new Error('此后台宿主使用 Windows 命名管道独占锁。');
await Promise.all([config.bskBinary, config.nodeBinary, join(config.root, 'server.mjs')].map(path => access(path)));

const outputDir = join(config.dataDir, 'background-services');
await mkdir(outputDir, { recursive: true });
const logPath = join(outputDir, 'events.jsonl');
const statePath = join(outputDir, 'state.json');
const identity = createHash('sha256').update(`${config.root.toLowerCase()}\n${config.dataDir.toLowerCase()}`).digest('hex').slice(0, 24);
// The OS removes this lock when its owner exits, including an abrupt termination.
const lock = createServer(socket => { socket.end(); socket.on('error', () => {}); });
try {
  await new Promise((accept, reject) => {
    lock.once('error', reject);
    lock.listen(`\\\\.\\pipe\\doufeng-background-${identity}`, accept);
  });
} catch (error) {
  if (error.code === 'EADDRINUSE') { console.error('该工作台已有后台宿主；本次重复启动已退出。'); process.exit(0); }
  throw error;
}
lock.on('error', error => { console.error(shortDiagnostic(error.message)); });

const env = { ...process.env, BSK_AUTO_START: '0', BSK_BIN: config.bskBinary };
if (config.bskHome) env.BSK_HOME = config.bskHome;
// An unspecified home means BrowserSkill's documented current-user default.
else delete env.BSK_HOME;
const startedAt = new Date().toISOString();
let stopping = false;
let logging = Promise.resolve();
let latestBrowserStatus = null;
let connection = null;
const priorState = await readFile(statePath, 'utf8').then(JSON.parse).catch(() => null);
const services = Object.fromEntries(['browser', 'workbench'].map(name => [name, {
  name, process: null, owned: false, starts: 0, restarts: 0, failureCount: 0,
  nextStartAt: 0, healthySince: null, lastExit: null, health: { state: 'unchecked' },
  stallCount: 0, stalledSince: null, lastHealthyPid: null, lastSessionCount: null,
  lastRecoveryAt: Number(priorState?.services?.[name]?.lastRecoveryAt) || 0,
  recoveryAttempts: Number(priorState?.services?.[name]?.recoveryAttempts) || 0,
  recovery: { action: 'none' },
}]));

function log(event) {
  const record = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
  logging = logging.catch(() => {}).then(async () => {
    const size = await stat(logPath).then(value => value.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
    if (size + Buffer.byteLength(record) > 1024 * 1024) {
      await unlink(`${logPath}.1`).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rename(logPath, `${logPath}.1`);
    }
    await appendFile(logPath, record);
  });
  return logging;
}

function publicState(service) {
  return {
    health: service.health, ownedPid: mayStopOwnedChild(service) ? service.process.pid : null,
    starts: service.starts, restarts: service.restarts, lastExit: service.lastExit,
    nextStartAt: service.nextStartAt ? new Date(service.nextStartAt).toISOString() : null,
    healthySince: service.healthySince ? new Date(service.healthySince).toISOString() : null,
    stallCount: service.stallCount, recovery: service.recovery,
    recoveryAttempts: service.recoveryAttempts, lastRecoveryAt: service.lastRecoveryAt,
  };
}

async function saveState() {
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({
      at: new Date().toISOString(), startedAt, pid: process.pid, stopping,
      configPath, root: config.root, dataDir: config.dataDir, port: config.port,
      intervalMs: 30_000,
      connection,
      services: Object.fromEntries(Object.entries(services).map(([name, service]) => [name, publicState(service)])),
    }, null, 2) + '\n');
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, statePath); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        await delay(50 * (attempt + 1));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function probeBrowser() {
  latestBrowserStatus = null;
  try {
    const result = await execute(config.bskBinary, ['status', '--json'], { env, windowsHide: true, timeout: 8_000, maxBuffer: 1024 * 1024 });
    latestBrowserStatus = parseBskJson(result.stdout);
    return browserHealth(latestBrowserStatus);
  } catch (error) {
    const reply = parseBskJson(String(error.stdout || '')) || parseBskJson(String(error.stderr || ''));
    return browserFailure({ code: error.code, killed: error.killed, signal: error.signal, message: reply?.message || String(error.stderr || error.message || '') });
  }
}

async function probeWorkbench() {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/system`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { state: 'conflict', error: `HTTP ${response.status}` };
    return workbenchHealth(await response.json(), config);
  } catch (error) { return workbenchFailure(error); }
}

function start(service) {
  const browser = service.name === 'browser';
  const executable = browser ? config.bskBinary : config.nodeBinary;
  const args = browser ? ['daemon', 'start', '--foreground', '--daemon-idle', '60m', '--json'] : [join(config.root, 'server.mjs')];
  const child = spawn(executable, args, {
    cwd: config.root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: browser ? env : { ...env, PORT: String(config.port), HOST: '127.0.0.1', DOUFENG_DATA_DIR: config.dataDir },
  });
  service.process = child; service.owned = true;
  service.stallCount = 0; service.stalledSince = null;
  service.lastHealthyPid = null; service.lastSessionCount = null;
  service.restarts = service.starts; service.starts += 1;
  service.health = { state: 'starting', pid: child.pid ?? null };
  // Keep only a bounded, redacted startup/error excerpt. Never collect stdout,
  // page observations, browser status payloads, cookies or session credentials.
  let lastError = '';
  child.stderr.on('data', chunk => { lastError = shortDiagnostic(chunk.toString()); });
  child.once('error', error => { lastError = shortDiagnostic(`${error.code || 'SPAWN_ERROR'}: ${error.message}`); });
  child.once('close', (code, signal) => {
    if (service.process !== child) return;
    service.lastExit = { at: new Date().toISOString(), pid: child.pid ?? null, code, signal, error: lastError };
    service.process = null; service.owned = false; service.healthySince = null;
    service.health = { state: 'exited', error: lastError || `exit=${code}; signal=${signal || 'none'}` };
    if (!stopping) {
      service.failureCount += 1;
      service.nextStartAt = Date.now() + restartDelayMs(service.failureCount);
    }
    void log({ event: 'child-exit', service: service.name, ...service.lastExit }).catch(() => {});
    void saveState().catch(() => {});
  });
  void log({ event: 'child-start', service: service.name, pid: child.pid ?? null, starts: service.starts }).catch(() => {});
}

const connectionStatePath = join(outputDir, 'browser-connection.json');
const connectionRecovery = createBrowserConnectionRecovery({
  loadState: async () => {
    try { return JSON.parse(await readFile(connectionStatePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  },
  saveState: async state => {
    const temporary = `${connectionStatePath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(state, null, 2) + '\n'); await rename(temporary, connectionStatePath); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  },
  launchBrowser: async () => {
    const guard = await acquireRecoveryGuard({ dataDir: config.dataDir, service: 'browser' });
    if (!guard.ok) return { deferred: true, reason: guard.reason };
    let maintenance;
    try {
      maintenance = await acquireBrowserMaintenance(config.dataDir);
      if (!maintenance.ok) return { deferred: true, reason: maintenance.reason };
      const health = await probeBrowser();
      if (health.state !== 'healthy' || health.browserCount !== 0 || health.sessionCount !== 0) return { deferred: true, reason: '连接状态已变化，下一轮重新核实。' };
      // No temporary profile, URL or page action: use the explicitly configured
      // existing browser profile. Never terminate the user's browser process.
      // The WinExe launcher explicitly breaks away from the service JobObject;
      // restarting this supervisor must never close the user's Chrome/Edge.
      await execute(join(outputDir, 'DoufengBackgroundHost.exe'), ['--launch-browser', configPath], {
        windowsHide: true, timeout: 10_000, cwd: config.root,
      });
      await log({ event: 'browser-launch-attempt', profile: config.browserLaunch.profileDirectory });
    } finally { try { if (maintenance?.ok) await maintenance.release(); } finally { await guard.release(); } }
  },
});

async function recoverStalled(service) {
  const decision = stalledRecoveryDecision(service, Date.now());
  const previous = service.recovery;
  service.recovery = decision;
  if (decision.action === 'recover') {
    service.recovery = await recoverOwnedBrowser({ service,
      acquireGuard: () => acquireRecoveryGuard({ dataDir: config.dataDir, service: service.name }),
      acquireMaintenance: () => acquireBrowserMaintenance(config.dataDir),
      probe: () => service.name === 'browser' ? probeBrowser() : probeWorkbench(),
      stopChild: async child => {
        service.recoveryAttempts++;
        await saveState();
        const closed = new Promise(accept => child.once('close', () => accept(true)));
        child.kill();
        return Promise.race([closed, delay(5_000).then(() => false)]);
      },
      startChild: start, log,
    });
  }
  if (JSON.stringify(service.recovery) !== JSON.stringify(previous) && service.recovery.action !== 'none') {
    await log({ event: 'recovery', service: service.name, ...service.recovery });
  }
}

async function tick() {
  const results = await Promise.all([probeBrowser(), probeWorkbench()]);
  if (stopping) return;
  for (const [index, service] of Object.values(services).entries()) {
    const health = results[index];
    const previous = service.health;
    service.health = health;
    if (health.daemonResponsive) { service.lastHealthyPid = health.pid; service.lastSessionCount = health.sessionCount; }
    if (health.state === 'healthy') {
      service.stallCount = 0; service.stalledSince = null;
      service.lastHealthyPid = health.pid;
      if (service.name === 'browser') service.lastSessionCount = health.sessionCount;
      if (previous.pid !== health.pid) service.healthySince = null;
      service.healthySince ??= Date.now();
      service.nextStartAt = 0;
      if (Date.now() - service.healthySince >= 10 * 60_000) { service.failureCount = 0; service.recoveryAttempts = 0; }
    } else {
      service.healthySince = null;
      if (health.state === 'unknown' && health.recoverable) { service.stallCount++; service.stalledSince ??= Date.now(); }
      else { service.stallCount = 0; service.stalledSince = null; }
    }
    if (previous.state !== health.state || previous.pid !== health.pid || previous.error !== health.error) {
      await log({ event: 'health', service: service.name, ...health });
    }
    if (mayStart({ health, ownedChildRunning: mayStopOwnedChild(service), nextStartAt: service.nextStartAt, now: Date.now(), stopping })) start(service);
    await recoverStalled(service);
  }
  const previousConnection = connection;
  connection = await connectionRecovery.check({ health: services.browser.health, status: latestBrowserStatus,
    launchConfigured: Boolean(config.browserLaunch), allowLaunch: !stopping });
  if (connection.status !== previousConnection?.status || connection.message !== previousConnection?.message) {
    await log({ event: 'browser-connection', status: connection.status, needsUserAction: connection.needsUserAction, message: connection.message });
  }
  await saveState();
}

async function stop(reason, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  await log({ event: 'stopping', reason }).catch(() => {});
  for (const service of Object.values(services)) {
    if (!mayStopOwnedChild(service)) continue;
    const child = service.process;
    const closed = new Promise(accept => child.once('close', accept));
    try { child.kill(); } catch {}
    await Promise.race([closed, delay(3_000)]);
  }
  await saveState().catch(() => {}); await logging.catch(() => {});
  lock.close();
  process.exit(exitCode);
}
process.once('SIGINT', () => { void stop('SIGINT'); });
process.once('SIGTERM', () => { void stop('SIGTERM'); });
process.once('uncaughtException', error => { console.error(shortDiagnostic(error.message)); void stop('uncaughtException', 1); });
process.once('unhandledRejection', error => { console.error(shortDiagnostic(error?.message || error)); void stop('unhandledRejection', 1); });
await log({ event: 'supervisor-start', pid: process.pid });
await clearExitedBrowserMaintenance(config.dataDir).catch(error => log({ event: 'recovery-lock-error', error: shortDiagnostic(error.message) }));
while (!stopping) {
  try { await tick(); }
  catch (error) { await log({ event: 'supervisor-error', error: shortDiagnostic(error.message) }).catch(() => {}); }
  await delay(30_000);
}
