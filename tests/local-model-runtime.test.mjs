import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ensureProjectLocalModel, probeLocalModel } from '../lib/local-model-runtime.mjs';

async function fixture(t) {
  const scratch = resolve('.codex_tmp'); await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'local-model-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(scratch + sep)); await rm(directory, { recursive: true, force: true }); });
  const root = join(directory, 'ollama'); await mkdir(join(root, 'bin'), { recursive: true });
  const bytes = Buffer.from('isolated test executable, never run');
  await writeFile(join(root, 'bin/ollama.exe'), bytes);
  const config = { version: 1, enabled: true, binarySha256: createHash('sha256').update(bytes).digest('hex') };
  return { directory, root, config, configure: () => writeFile(join(root, 'runtime.json'), JSON.stringify(config)) };
}

test('missing opt-in installation never probes or starts a model', async t => {
  const f = await fixture(t);
  const result = await ensureProjectLocalModel(f.directory, { probe: () => { throw new Error('must not probe'); } });
  assert.equal(result.state, 'unconfigured');
});

test('healthy, unknown, and occupied model ports never create another process', async t => {
  const f = await fixture(t); await f.configure();
  for (const state of ['healthy', 'unknown', 'conflict']) {
    const result = await ensureProjectLocalModel(f.directory, { probe: async () => ({ state }), spawnImpl: () => { throw new Error('must not spawn'); } });
    assert.equal(result.state, state);
  }
});

test('project-owned local model starts hidden with isolated storage and cloud disabled', async t => {
  const f = await fixture(t); await f.configure();
  let calls = 0, invocation;
  const child = new EventEmitter(); child.pid = 987654321; child.exitCode = null; child.unref = () => {};
  const result = await ensureProjectLocalModel(f.directory, {
    probe: async () => ({ state: ++calls > 2 ? 'healthy' : 'absent' }),
    spawnImpl: (binary, args, options) => { invocation = { binary, args, options }; return child; },
  });
  assert.equal(result.state, 'healthy'); assert.equal(result.owned, true);
  assert.equal(invocation.binary, join(f.root, 'bin/ollama.exe'));
  assert.deepEqual(invocation.args, ['serve']);
  assert.equal(invocation.options.windowsHide, true); assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.OLLAMA_MODELS, join(f.root, 'models'));
  assert.equal(invocation.options.env.OLLAMA_NO_CLOUD, '1');
  assert.equal(invocation.options.env.OLLAMA_HOST, '127.0.0.1:11434');
  assert.equal(JSON.parse(await readFile(join(f.root, 'process.json'))).pid, child.pid);
});

test('corrupt binaries or still-running prior owners cannot launch another model', async t => {
  const f = await fixture(t); await f.configure();
  const options = { probe: async () => ({ state: 'absent' }), spawnImpl: () => { throw new Error('must not spawn'); } };
  await writeFile(join(f.root, 'process.json'), JSON.stringify({ pid: 1234 }));
  const result = await ensureProjectLocalModel(f.directory, { ...options, pidAlive: () => true });
  assert.equal(result.state, 'blocked');
  await writeFile(join(f.root, 'bin/ollama.exe'), 'modified');
  await assert.rejects(ensureProjectLocalModel(f.directory, options), /校验失败/);
});

test('only refused connections are absent; timeouts and invalid responses remain blocked', async () => {
  assert.equal((await probeLocalModel({ fetchImpl: async () => { throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }); } })).state, 'absent');
  assert.equal((await probeLocalModel({ fetchImpl: async () => { throw new Error('timeout'); } })).state, 'unknown');
  assert.equal((await probeLocalModel({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: 'not-ollama' }) }) })).state, 'conflict');
  assert.equal((await probeLocalModel({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.40.11' }) }) })).state, 'healthy');
});
