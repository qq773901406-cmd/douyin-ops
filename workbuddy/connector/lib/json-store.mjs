import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BackupStore } from './backup-store.mjs';
import { join } from 'node:path';

// Windows may briefly deny replacing an existing file while another reader or
// scanner holds it open. Retry only the rename of the already flushed temp file;
// the caller keeps its write lock and its business callback is never replayed.
export async function renameWithRetry(source, destination, { renameFile = rename, wait = delay, platform = process.platform } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await renameFile(source, destination); }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 7) throw error;
      await wait(Math.min(10 * 2 ** attempt, 160));
    }
  }
}

// HTTP and stdio processes share this lock; the JSON format stays readable by hand.
export class JsonStore {
  constructor(path, fallback, validate = value => value, { snapshots = false } = {}) {
    this.path = path;
    this.fallback = fallback;
    this.validate = validate;
    this.backups = snapshots ? new BackupStore(join(dirname(path), 'backups')) : null;
  }

  async read() {
    let raw;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { value: structuredClone(this.fallback), revision: 'missing', raw: null };
      throw error;
    }
    try {
      return { value: this.validate(JSON.parse(raw)), revision: createHash('sha256').update(raw).digest('hex'), raw };
    } catch (error) {
      throw Object.assign(new Error(`无法读取 ${this.path}：${error.message} 请检查原文件或 .bak 备份，原数据未覆盖。`), { status: 500 });
    }
  }

  async update(change, expectedRevision) {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    let lock;
    const deadline = Date.now() + 5000;
    while (!lock) {
      try { lock = await open(lockPath, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw Object.assign(new Error('数据正在被其他进程写入，请稍后重试。若持续出现，请关闭工作台和 MCP 后检查数据目录中的 .lock 文件。'), { status: 503 });
        await delay(60);
      }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const current = await this.read();
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw Object.assign(new Error('工作区已被其他页面或 WorkBuddy 更新。请先导出本页备份，再载入最新数据。'), { status: 409 });
      }
      let value = structuredClone(current.value);
      const result = await change(value);
      value = this.validate(value);
      const raw = JSON.stringify(value, null, 2);
      if (raw === current.raw) return { value, revision: current.revision, result };
      if (current.raw !== null && this.backups) await this.backups.create(current.value, 'auto', '修改前自动快照');
      if (current.raw !== null) await this.atomicWrite(`${this.path}.bak`, current.raw);
      await this.atomicWrite(this.path, raw);
      return { value, revision: createHash('sha256').update(raw).digest('hex'), result };
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  async replace(value, expectedRevision) {
    const valid = this.validate(value);
    return this.update(current => {
      for (const key of Object.keys(current)) delete current[key];
      Object.assign(current, valid);
    }, expectedRevision);
  }

  async atomicWrite(path, raw) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, 'wx');
      await file.writeFile(raw, 'utf8');
      await file.sync();
      await file.close(); file = null;
      await renameWithRetry(temporary, path);
    } finally {
      if (file) await file.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
