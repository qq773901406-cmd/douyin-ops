import { mkdir, readdir, realpath, stat, lstat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isInside } from '../lib/fs-utils.mjs';

const fault = message => Object.assign(new Error(message), { status: 400, code: 'requires_action', actionable: true });
const stamp = clock => new Date(typeof clock === 'function' ? clock() : clock.now()).toISOString();
const transient = name => /(?:\.lock|\.lease|\.lease\.recovery|\.tmp)$/i.test(name);
const slash = path => path.replaceAll('\\', '/');
const signature = info => ({ size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino });
const same = (left, right) => ['size', 'mtimeMs', 'ctimeMs', 'ino'].every(key => left[key] === right[key]);

async function canonicalDestination(path) {
  const tail = []; let ancestor = resolve(path);
  for (;;) {
    try { return resolve(await realpath(ancestor), ...tail.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor); if (parent === ancestor) throw error;
      tail.push(basename(ancestor)); ancestor = parent;
    }
  }
}

async function hash(path, signal) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) { signal?.throwIfAborted(); digest.update(chunk); }
  return digest.digest('hex');
}

async function inventory(root, signal) {
  const files = [], excluded = [], issues = [];
  async function walk(directory) {
    signal?.throwIfAborted();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { issues.push({ path: slash(relative(root, directory)), message: `无法列出目录：${error.message}` }); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name), name = slash(relative(root, path));
      if (transient(entry.name)) { excluded.push({ path: name, reason: '瞬态锁、租约或临时写入文件' }); continue; }
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) { issues.push({ path: name, message: '符号链接未跟随，避免备份目录之外的数据。' }); continue; }
        if (info.isDirectory()) await walk(path);
        else if (info.isFile()) files.push({ path: name, ...signature(info) });
        else issues.push({ path: name, message: '不是常规文件，未复制。' });
      } catch (error) { issues.push({ path: name, message: `读取文件信息失败：${error.message}` }); }
    }
  }
  await walk(root); return { files, excluded, issues };
}

/** Copies all ordinary runtime files, including media and publication ledgers.
 * This is a verified live copy, not a transactional snapshot: each file is
 * checked with SHA-256 and source metadata before/after copying. A final tree
 * scan reports observed concurrent writes. Writers are never frozen here.
 */
export async function createRuntimeBackup(runtimeDir, { backupDir, clock = () => new Date(), signal, reportProgress, beforeCopy } = {}) {
  if (!backupDir || !isAbsolute(backupDir) || /^\\\\/.test(backupDir)) throw fault('请明确配置本机完整备份目录 backupDir。');
  const source = await realpath(resolve(runtimeDir));
  if (!(await stat(source)).isDirectory()) throw fault('runtime 来源不是目录。');
  const destinationRoot = await canonicalDestination(backupDir);
  if (isInside(source, destinationRoot)) throw fault('完整备份目录必须位于 runtime 之外，防止递归复制。');
  await mkdir(destinationRoot, { recursive: true });
  const actualRoot = await realpath(destinationRoot);
  if (isInside(source, actualRoot)) throw fault('完整备份目录实际指向 runtime 内部。');
  const startedAt = stamp(clock), backupId = `${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
  const directory = join(actualRoot, backupId), dataDir = join(directory, 'data');
  await mkdir(directory); await mkdir(dataDir);
  const manifest = { version: 1, id: backupId, source, directory, startedAt, finishedAt: '', status: 'running', consistency: '经逐文件哈希核对的在线副本；不是跨文件事务快照。复制期间未锁定生产写入，未包含复制结束后的新变化。', files: [], excluded: [], issues: [], observedChanges: [], fileCount: 0, totalBytes: 0 };
  const manifestPath = join(directory, 'manifest.json');
  // Incomplete backups remain explicitly incomplete after interruption.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  try {
    const initial = await inventory(source, signal);
    manifest.excluded = initial.excluded; manifest.issues = initial.issues;
    for (let index = 0; index < initial.files.length; index++) {
      signal?.throwIfAborted();
      const entry = initial.files[index], origin = join(source, entry.path), target = join(dataDir, entry.path);
      try {
        if (beforeCopy) await beforeCopy({ source: origin, target, index });
        const actualSource = await realpath(origin);
        if (!isInside(source, actualSource) || actualSource !== resolve(origin)) throw new Error('来源路径已变化或变成符号链接。');
        const before = signature(await stat(origin));
        const beforeHash = await hash(origin, signal);
        await mkdir(dirname(target), { recursive: true });
        await pipeline(createReadStream(origin), createWriteStream(target, { flags: 'wx' }), { signal });
        const copiedHash = await hash(target, signal), sourceHash = await hash(origin, signal), after = signature(await stat(origin));
        const stable = same(before, after) && same(entry, before) && beforeHash === copiedHash && copiedHash === sourceHash;
        manifest.files.push({ path: entry.path, size: (await stat(target)).size, sha256: copiedHash, sourceSha256: sourceHash, sourceBefore: before, sourceAfter: after, stable });
        manifest.fileCount++; manifest.totalBytes += (await stat(target)).size;
        if (!stable) manifest.issues.push({ path: entry.path, message: '来源在备份扫描或复制期间发生变化；保留副本但不声明一致。' });
      } catch (error) {
        if (signal?.aborted) throw error;
        manifest.issues.push({ path: entry.path, message: `复制或校验失败：${error.message}` });
      }
      if (reportProgress) await reportProgress({ stage: 'backup', completedFiles: index + 1, totalFiles: initial.files.length, bytes: manifest.totalBytes });
    }
    const final = await inventory(source, signal), first = new Map(initial.files.map(entry => [entry.path, entry])), last = new Map(final.files.map(entry => [entry.path, entry]));
    for (const [path, entry] of first) if (!last.has(path) || !same(entry, last.get(path))) manifest.observedChanges.push({ path, change: last.has(path) ? 'modified' : 'removed' });
    for (const path of last.keys()) if (!first.has(path)) manifest.observedChanges.push({ path, change: 'added' });
    for (const issue of final.issues) if (!manifest.issues.some(existing => existing.path === issue.path && existing.message === issue.message)) manifest.issues.push(issue);
    manifest.status = manifest.issues.length || manifest.observedChanges.length ? 'requires_action' : 'completed';
  } catch (error) { manifest.status = signal?.aborted ? 'interrupted' : 'requires_action'; manifest.issues.push({ path: '', message: String(error.message || error) }); }
  manifest.finishedAt = stamp(clock);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const summary = manifest.status === 'completed' ? 'runtime 文件、媒体和账本已复制并校验；一致性边界见 manifest。' : '已保留备份及校验报告，但存在变化或未复制项，请查看 manifest 后重新安排备份。';
  return { status: manifest.status === 'completed' ? 'completed' : 'requires_action', output: { summary, backupId, directory, manifestPath, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, consistency: manifest.consistency, stable: manifest.status === 'completed', issues: manifest.issues, observedChanges: manifest.observedChanges }, message: summary };
}

export function runtimeBackupHandler(runtimeDir, options = {}) {
  return {
    readOnly: true,
    validate(input) {
      if (!input || !isAbsolute(input.backupDir || '') || /^\\\\/.test(input.backupDir)) throw fault('完整备份需要本机绝对路径 backupDir。');
      if (isInside(resolve(runtimeDir), resolve(input.backupDir))) throw fault('完整备份目录必须位于 runtime 之外。');
      return { backupDir: resolve(input.backupDir) };
    },
    // Durable task progress would mutate the very task ledger being copied.
    // Keep this handler's ledger unchanged until the backup result is saved.
    execute: (input, context) => createRuntimeBackup(runtimeDir, { ...options, ...input, signal: context.signal }),
  };
}
