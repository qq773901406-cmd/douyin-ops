import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBsk } from '../lib/bsk-client.mjs';
import { startBrowserSkillSession } from '../server/browser-skill-adapter.mjs';

test('BrowserSkill 子进程只接收一次 JSON 参数，接入会话可完成准备和领取', async t => {
  const temporaryRoot = fileURLToPath(new URL('../.codex_tmp/', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'bsk-client-test-'));
  const previousBinary = process.env.BSK_BIN;
  t.after(async () => {
    if (previousBinary === undefined) delete process.env.BSK_BIN;
    else process.env.BSK_BIN = previousBinary;
    assert.ok(resolve(directory).startsWith(resolve(temporaryRoot) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = join(directory, 'cli.mjs');
  await writeFile(fixture, `
    const args = process.argv.slice(2);
    if (args.filter(arg => arg === '--json').length > 1) {
      console.error('--json cannot be used multiple times');
      process.exit(2);
    }
    let payload = { args };
    if (args[0] === 'browsers') payload = [{ instance_id: 'fixture-browser' }];
    else if (args[1] === 'start') payload = { session_id: 'fixture-session', browser_instance_id: 'fixture-browser' };
    else if (args.includes('--claim')) payload = { state: 'active', session: { session_id: 'fixture-session' } };
    console.log(JSON.stringify(payload));
  `);
  process.env.BSK_BIN = process.execPath;

  for (const { args, options, expected } of [
    { args: ['args'], expected: ['args', '--json'] },
    { args: ['args', '--json'], expected: ['args', '--json'] },
    { args: ['args'], options: { json: false }, expected: ['args'] },
    { args: ['args', '--json'], options: { json: false }, expected: ['args', '--json'] },
  ]) {
    const result = await runBsk([fixture, ...args], options);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(JSON.parse(result.stdout).args, expected);
  }
  const result = await startBrowserSkillSession('fixture-browser', (args, timeout) => runBsk([fixture, ...args], { timeout }));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.sessionId, 'fixture-session');
});
