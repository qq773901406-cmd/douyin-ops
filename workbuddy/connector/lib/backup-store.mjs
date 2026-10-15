import { mkdir, readdir, readFile, open, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeState, collections } from './workspace-model.mjs';

const validId = /^(auto|manual|restore)-\d{13}-[a-f0-9-]{36}\.json$/;
export class BackupStore {
  constructor(directory) { this.directory = directory; }
  path(id) {
    if (!validId.test(id)) throw Object.assign(new Error('备份编号无效。'), { status: 400 });
    return join(this.directory, id);
  }
  async create(state, kind = 'manual', label = '') {
    if (!['auto', 'manual', 'restore'].includes(kind)) throw new Error('备份类型无效。');
    const valid = normalizeState(state);
    await mkdir(this.directory, { recursive: true });
    const id = `${kind}-${Date.now()}-${randomUUID()}.json`;
    const temporary = this.path(id) + '.tmp';
    const data = { format: 'doufeng-workspace', version: 1, createdAt: new Date().toISOString(), kind, label: String(label).slice(0, 100), state: valid };
    let file;
    try {
      file = await open(temporary, 'wx'); await file.writeFile(JSON.stringify(data, null, 2)); await file.sync();
      await file.close(); file = null; await rename(temporary, this.path(id));
    } finally { if (file) await file.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    if (kind === 'auto') {
      const previous = (await readdir(this.directory)).filter(name => validId.test(name) && name.startsWith('auto-')).sort().reverse().slice(30);
      for (const name of previous) await unlink(this.path(name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return { id, createdAt: data.createdAt, kind, label: data.label };
  }
  async read(id) {
    let data;
    try { data = JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('备份不存在。'), { status: 404 }); throw new Error('备份无法读取，请保留原文件并检查内容。'); }
    if (data.format !== 'doufeng-workspace' || data.version !== 1 || !data.state || typeof data.state !== 'object' || Array.isArray(data.state)) throw new Error('不支持此备份格式。');
    return { ...data, state: normalizeState(data.state) };
  }
  async list() {
    let names;
    try { names = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const id of names.filter(name => validId.test(name)).sort().reverse()) {
      try {
        const [data, info] = await Promise.all([this.read(id), stat(this.path(id))]);
        result.push({ id, createdAt: data.createdAt, kind: data.kind, label: data.label, bytes: info.size, counts: Object.fromEntries(collections.map(key => [key, data.state[key].length])), available: true });
      } catch { result.push({ id, available: false, label: '文件损坏或格式不兼容' }); }
    }
    return result.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  }
}
