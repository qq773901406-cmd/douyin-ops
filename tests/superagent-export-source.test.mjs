import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { exportSource } from '../scripts/superagent-export-source.mjs';
import { WORKER_REPOSITORY } from '../integrations/dingtalk-superagent/dsh-executor.mjs';
import { sourceFiles, verifySourceManifest } from '../integrations/dingtalk-superagent/worker-runner.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const scratch = resolve('.codex_tmp'); await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'source-export-')), repositoryDir = join(dir, 'repo'), out = join(dir, 'snapshot');
  await mkdir(repositoryDir); await mkdir(join(repositoryDir, 'public')); await mkdir(join(repositoryDir, 'runtime'));
  const git = async (...args) => (await exec('git', ['-C', repositoryDir, ...args], { windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } })).stdout.trim();
  await git('init'); await git('remote', 'add', 'origin', `https://github.com/${WORKER_REPOSITORY}.git`);
  await writeFile(join(repositoryDir, 'public', 'app.js'), 'committed source\n');
  await writeFile(join(repositoryDir, 'runtime', 'account.json'), '{"private":"fixture"}');
  await writeFile(join(repositoryDir, '.env'), 'TOKEN=private-fixture');
  await git('add', '.'); await git('commit', '-m', 'fixture'); const commit = await git('rev-parse', 'HEAD');
  t.after(async () => { assert.ok(resolve(dir).startsWith(scratch + sep)); await rm(dir, { recursive: true, force: true }); });
  return { repositoryDir, out, git, commit };
}

test('source export reads committed blobs, excludes runtime and writes a verifiable external manifest', async t => {
  const { repositoryDir, out, commit } = await fixture(t);
  await writeFile(join(repositoryDir, 'public', 'app.js'), 'uncommitted private text');
  const result = await exportSource({ repositoryDir, out, env: {} });
  assert.equal(result.baseCommit, commit); assert.equal(result.fileCount, 1); assert.equal(result.excludedCount, 2);
  assert.equal(await readFile(join(out, 'public', 'app.js'), 'utf8'), 'committed source\n');
  for (const path of ['runtime', '.env', '.git']) await assert.rejects(lstat(join(out, path)), { code: 'ENOENT' });
  assert.equal(result.manifestPath, `${out}.manifest.json`);
  assert.ok(!JSON.stringify(JSON.parse(await readFile(result.manifestPath, 'utf8'))).includes('private-fixture'));
  const config = { sourceManifest: result.manifestPath, baseCommit: commit };
  await verifySourceManifest(config, await sourceFiles(out));
  await writeFile(join(out, 'public', 'app.js'), 'modified snapshot');
  await assert.rejects(verifySourceManifest(config, await sourceFiles(out)), /不一致/);
});

test('export refuses wrong origin, non-full commit and existing output', async t => {
  const { repositoryDir, out, git } = await fixture(t);
  await assert.rejects(exportSource({ repositoryDir, out, commit: 'HEAD' }), /40 位/);
  await git('remote', 'set-url', 'origin', 'https://username:password@github.com/other/repo.git');
  await assert.rejects(exportSource({ repositoryDir, out }), /origin/);
  await git('remote', 'set-url', 'origin', `git@github.com:${WORKER_REPOSITORY}.git`);
  await mkdir(out); await writeFile(join(out, 'keep.txt'), 'preserve');
  await assert.rejects(exportSource({ repositoryDir, out }), /拒绝覆盖/);
  assert.equal(await readFile(join(out, 'keep.txt'), 'utf8'), 'preserve');
});

test('export rejects binary and known credentials in eligible source before creating output', async t => {
  const { repositoryDir, out, git } = await fixture(t);
  await writeFile(join(repositoryDir, 'public', 'app.js'), Buffer.from([65, 0, 66]));
  await git('add', '.'); await git('commit', '-m', 'binary');
  await assert.rejects(exportSource({ repositoryDir, out }), /二进制/);
  await assert.rejects(lstat(out), { code: 'ENOENT' });
  await writeFile(join(repositoryDir, 'public', 'app.js'), 'const key = "' + 'ghp_' + 'a'.repeat(36) + '";');
  await git('add', '.'); await git('commit', '-m', 'secret fixture');
  await assert.rejects(exportSource({ repositoryDir, out }), /凭据特征/);
  await assert.rejects(lstat(out), { code: 'ENOENT' });
});

test('explicit commit remains fixed even when HEAD changes', async t => {
  const { repositoryDir, out, git, commit } = await fixture(t);
  await writeFile(join(repositoryDir, 'public', 'app.js'), 'new commit\n');
  await git('add', '.'); await git('commit', '-m', 'next');
  const result = await exportSource({ repositoryDir, out, commit, env: {} });
  assert.equal(result.baseCommit, commit); assert.equal(await readFile(join(out, 'public', 'app.js'), 'utf8'), 'committed source\n');
});

test('UTF-8 BOM is preserved byte-for-byte in the commit snapshot and manifest', async t => {
  const { repositoryDir, out, git } = await fixture(t), source = Buffer.from('\uFEFFconst value = 1;\r\n');
  await git('config', 'core.autocrlf', 'false');
  await writeFile(join(repositoryDir, 'public', 'app.js'), source);
  await git('add', '.'); await git('commit', '-m', 'BOM fixture');
  const result = await exportSource({ repositoryDir, out, env: {} });
  assert.deepEqual(await readFile(join(out, 'public', 'app.js')), source);
  await verifySourceManifest({ sourceManifest: result.manifestPath, baseCommit: result.baseCommit }, await sourceFiles(out));
});

test('excluded runtime gitlinks are skipped but links within eligible source are refused', async t => {
  const { repositoryDir, out, git, commit } = await fixture(t);
  await git('update-index', '--add', '--cacheinfo', `160000,${commit},runtime/thirdparty`);
  await git('commit', '-m', 'excluded gitlink');
  const result = await exportSource({ repositoryDir, out, env: {} });
  assert.equal(result.fileCount, 1); assert.equal(result.excludedCount, 3);
  await git('update-index', '--add', '--cacheinfo', `160000,${commit},public/vendor`);
  await git('commit', '-m', 'source gitlink');
  await assert.rejects(exportSource({ repositoryDir, out: `${out}-gitlink`, env: {} }), /符号链接或子模块/);
  await git('update-index', '--force-remove', 'public/vendor');
  const blob = await git('hash-object', '-w', 'public/app.js');
  await git('update-index', '--add', '--cacheinfo', `120000,${blob},public/link.js`);
  await git('commit', '-m', 'source symlink');
  await assert.rejects(exportSource({ repositoryDir, out: `${out}-symlink`, env: {} }), /符号链接或子模块/);
});
