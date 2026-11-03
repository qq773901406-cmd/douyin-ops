import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { safeSourcePath, WORKER_REPOSITORY } from '../integrations/dingtalk-superagent/dsh-executor.mjs';

const run = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (path, parent) => path === parent || path.startsWith(parent + sep);
const sensitive = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bAKIA[A-Z0-9]{16}\b/;

function expectedOrigin(value) {
  return value === `https://github.com/${WORKER_REPOSITORY}` || value === `https://github.com/${WORKER_REPOSITORY}.git`
    || value === `git@github.com:${WORKER_REPOSITORY}.git` || value === `ssh://git@github.com/${WORKER_REPOSITORY}.git`;
}

// Read committed objects only; the working tree, Git history, hooks, credentials,
// browser state and runtime are never copied into the source snapshot.
export async function exportSource({ repositoryDir = process.cwd(), out, commit, env = process.env } = {}) {
  if (typeof out !== 'string' || !out.trim()) throw new Error('必须明确指定一个尚不存在的 --out 目录。');
  if (commit !== undefined && !/^[a-fA-F0-9]{40}$/.test(commit)) throw new Error('--commit 必须是完整的 40 位提交 SHA。');
  const repository = await realpath(resolve(repositoryDir)), output = resolve(out), manifestPath = `${output}.manifest.json`;
  if (output.split(/[\\/]/).some(part => /^(?:\.git|\.aws|\.ssh|\.codex|\.agents)$/i.test(part))) throw new Error('导出路径不能指向本机凭据或 Git 元数据目录。');
  // Requiring an existing, physical parent makes every write target reviewable,
  // and prevents junction traversal or creating unintended parent directories.
  const parent = await realpath(dirname(output));
  if (parent.toLowerCase() !== resolve(dirname(output)).toLowerCase()) throw new Error('导出目录的父路径不能经过符号链接或联接。');
  for (const path of [output, manifestPath]) {
    try { await lstat(path); throw new Error('导出目录或清单已存在，拒绝覆盖。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^GIT_/i.test(name)));
  Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' });
  const git = async (args, maxBuffer = 2 * 1024 * 1024) => {
    try { return (await run('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', repository, ...args], { env: gitEnv, windowsHide: true, encoding: 'buffer', maxBuffer })).stdout; }
    catch { throw new Error('读取固定仓库提交失败；未执行网络操作或读取工作区内容。'); }
  };
  const remote = (await git(['config', '--get', 'remote.origin.url'])).toString('utf8').trim();
  if (!expectedOrigin(remote)) throw new Error('origin 必须是允许的 GitHub 仓库，且不能内嵌凭据。');
  const top = await realpath((await git(['rev-parse', '--show-toplevel'])).toString('utf8').trim());
  if (top.toLowerCase() !== repository.toLowerCase()) throw new Error('--repo 必须指向仓库根目录。');
  const baseCommit = (await git(['rev-parse', '--verify', `${commit || 'HEAD'}^{commit}`])).toString('utf8').trim();
  if (!/^[a-f0-9]{40}$/.test(baseCommit) || commit && baseCommit !== commit.toLowerCase()) throw new Error('提交无法解析为明确的完整 SHA。');
  const entries = (await git(['ls-tree', '-r', '-z', baseCommit], 8 * 1024 * 1024)).toString('utf8').split('\0').filter(Boolean);
  const files = []; let totalBytes = 0, excluded = 0;
  const knownSecrets = Object.entries(env).filter(([name, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && typeof value === 'string' && value.length >= 8).map(([, value]) => value);
  for (const entry of entries) {
    const match = /^(\d{6}) ([a-z]+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Git 树条目无效。');
    const [, mode, type, , path] = match;
    // Runtime/third-party metadata never enters the export. A link whose path
    // could be an allowed source file OR source directory must still fail.
    const permitted = safeSourcePath(path), link = mode === '120000' || mode === '160000';
    if (!permitted && !(link && safeSourcePath(`${path}/check.mjs`))) { excluded++; continue; }
    if (mode === '120000' || mode === '160000' || type !== 'blob') throw new Error('基线包含符号链接或子模块，必须先人工审查。');
    if (!['100644', '100755'].includes(mode)) throw new Error('基线存在不支持的文件模式。');
    const buffer = await git(['show', `${baseCommit}:${path}`], 1024 * 1024 + 1);
    totalBytes += buffer.length;
    if (buffer.length > 1024 * 1024 || totalBytes > 16 * 1024 * 1024 || files.length >= 5000) throw new Error('净化源码超过 5000 文件、单文件 1 MiB 或总计 16 MiB 上限。');
    let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); } catch { throw new Error('允许路径中含非 UTF-8 文本文件，拒绝导出。'); }
    if (text.includes('\0')) throw new Error('允许路径中含二进制文件，拒绝导出。');
    if (sensitive.test(text) || knownSecrets.some(secret => text.includes(secret))) throw new Error('净化源码中检测到凭据特征，拒绝导出；请先审查提交。');
    files.push({ path, text, bytes: Buffer.byteLength(text), sha256: sha256(text) });
  }
  if (!files.length) throw new Error('此提交没有可导出的源码文件。');
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { version: 1, repository: WORKER_REPOSITORY, baseCommit,
    sourceDigest: sha256(JSON.stringify(files.map(file => [file.path, file.text]))),
    fileCount: files.length, totalBytes, excludedCount: excluded,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  await mkdir(output, { mode: 0o700 });
  // Never delete output on failure: an incomplete export stays visible and a
  // retry requires another explicitly named directory.
  for (const file of files) {
    const destination = resolve(output, file.path);
    if (!inside(destination, output)) throw new Error('导出路径越界。');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.text, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...manifest, output, manifestPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.length === 1 && args[0] === '--help') console.log('node scripts/superagent-export-source.mjs --out <NEW-directory> [--repo <repository-root>] [--commit <40-hex-SHA>]\nDefaults to the current repository and its resolved HEAD. Creates <out>.manifest.json outside the source directory.');
    else {
      for (let i = 0; i < args.length; i += 2) {
        const key = { '--out': 'out', '--repo': 'repositoryDir', '--commit': 'commit' }[args[i]];
        if (!key || !args[i + 1] || Object.hasOwn(options, key)) throw new Error('参数无效；使用 --help 查看用法。');
        options[key] = args[i + 1];
      }
      const result = await exportSource(options);
      console.log(JSON.stringify({ repository: result.repository, baseCommit: result.baseCommit, files: result.fileCount, bytes: result.totalBytes, excluded: result.excludedCount, output: result.output, manifestPath: result.manifestPath }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
