import { mkdir, open, readFile, readdir, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
const unavailable = () => Object.assign(new Error('浏览器连接正在恢复，请稍后重新检查；当前操作未执行。'), { code: 'BROWSER_RECOVERING' });
const read = async path => {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.token !== 'string') throw unavailable();
    return value;
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw unavailable(); }
};

async function createClaim(path) {
  const value = { pid: process.pid, token: randomUUID(), at: new Date().toISOString() };
  const temporary = `${path}.${value.token}.tmp`;
  const file = await open(temporary, 'wx');
  try {
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    // Publish a complete claim with exclusive creation. A crash can leave an
    // ignored temp file, never an empty maintenance marker that blocks forever.
    await link(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return async () => {
    const current = await read(path);
    if (current?.token === value.token) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  };
}

// The maintenance marker and command claims use a two-sided handshake. A command
// registers before its second marker check; recovery registers before scanning
// claims. Thus neither can slip between the other's check and action.
export async function acquireBrowserActivity(dataDir) {
  const directory = join(dataDir, 'background-services', 'browser-activity');
  const maintenance = join(directory, 'maintenance.json');
  await mkdir(directory, { recursive: true });
  if (await read(maintenance)) throw unavailable();
  const release = await createClaim(join(directory, `${randomUUID()}.json`));
  try { if (await read(maintenance)) throw unavailable(); }
  catch (error) { await release(); throw error; }
  return release;
}

export async function acquireBrowserMaintenance(dataDir, { pidAlive = alive } = {}) {
  const directory = join(dataDir, 'background-services', 'browser-activity');
  const path = join(directory, 'maintenance.json');
  await mkdir(directory, { recursive: true });
  let release;
  try { release = await createClaim(path); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Reclaim only an identified exited owner. Atomic rename is not a lock;
    // leave stale maintenance for the owning supervisor's startup cleanup.
    return { ok: false, reason: '浏览器恢复锁已存在，等待原恢复过程结束。' };
  }
  try {
    for (const name of await readdir(directory)) {
      if (name === 'maintenance.json' || !name.endsWith('.json')) continue;
      const claim = await read(join(directory, name));
      if (!claim) continue;
      if (pidAlive(claim.pid)) {
        await release();
        return { ok: false, reason: '仍有浏览器命令执行中，恢复已延后。' };
      }
      // The UUID is never reused by a new command, so deleting this exited
      // owner's claim cannot remove another command's lease.
      await unlink(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return { ok: true, release };
  } catch (error) { await release(); throw error; }
}

// Call only after acquiring the supervisor's OS-enforced singleton lock.
export async function clearExitedBrowserMaintenance(dataDir, { pidAlive = alive } = {}) {
  const path = join(dataDir, 'background-services', 'browser-activity', 'maintenance.json');
  const owner = await read(path);
  if (owner && !pidAlive(owner.pid)) await unlink(path);
}
