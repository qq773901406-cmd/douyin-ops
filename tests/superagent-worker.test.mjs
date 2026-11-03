import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, link } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { DshExecutor, WORKER_PROTOCOL, WORKER_REPOSITORY, validateWorkerRequest, validateWorkerReport, workerEndpoint, safeSourcePath } from '../integrations/dingtalk-superagent/dsh-executor.mjs';
import { WorkerRunner, headlessArgs, parseHeadlessResult, workerEnvironment, sourceFiles, collectChanges, checkWorkerDeployment } from '../integrations/dingtalk-superagent/worker-runner.mjs';

const token = 'test-only-worker-token-1234567890abcdef';
const commit = 'a'.repeat(40);
const request = (ticketId = 'ticket-1', assignmentId = 'assignment-1') => ({ assignmentId, ticket: { id: ticketId, repository: WORKER_REPOSITORY, mandate: { repository: WORKER_REPOSITORY, scope: 'Improve the copy.', allowed: { execute: true, merge: false } }, inputs: [{ text: 'Please improve the copy.' }] } });
const settings = { repository: WORKER_REPOSITORY, worker: { enabled: true, isolated: true, endpoint: 'http://127.0.0.1:4190' } };
const result = data => ({ ok: true, status: 200, json: async () => ({ protocol: WORKER_PROTOCOL, ...data }) });

async function fixture(t, execute) {
  const scratch = resolve('.codex_tmp'); await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'superagent-worker-')); const root = join(dir, 'state'), sourceDir = join(dir, 'source');
  await mkdir(root); await mkdir(join(sourceDir, 'public'), { recursive: true }); await writeFile(join(sourceDir, 'public', 'app.js'), 'before');
  const config = { root, sourceDir, dshBin: '/test/dsh', repository: WORKER_REPOSITORY, baseCommit: commit };
  const failures = [];
  const runner = new WorkerRunner(config, { guard: async () => {}, execute, env: {}, onFailure: error => failures.push(error.stack || error.message) });
  await runner.initialize();
  t.after(async () => { await runner.close(); assert.ok(resolve(dir).startsWith(scratch + sep)); await rm(dir, { recursive: true, force: true }); });
  return { dir, root, sourceDir, config, runner, failures };
}
async function settled(runner, assignmentId) {
  // Observe the runner's completion barrier. Polling its atomic state file every
  // 5 ms adds artificial Windows reader/rename contention and timing races.
  await runner.active.get(assignmentId)?.finished;
  const receipt = await runner.result(assignmentId);
  assert.equal(receipt.state, 'done'); return receipt;
}

test('Worker stays disabled without isolated authenticated loopback deployment', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return result({ ready: true }); };
  assert.equal((await new DshExecutor({ fetchImpl }).health()).ready, false);
  assert.equal((await new DshExecutor({ settings, fetchImpl, env: {} }).health()).ready, false);
  assert.equal(calls, 0);
  for (const url of ['https://127.0.0.1:4190', 'http://localhost:4190', 'http://192.168.1.5:4190', 'http://127.0.0.1:4190/path', 'http://u:p@127.0.0.1:4190', 'http://127.0.0.1:4190/?token=x']) assert.throws(() => workerEndpoint(url));
  const healthy = await new DshExecutor({ settings, fetchImpl, env: { SUPERAGENT_WORKER_TOKEN: token } }).health(); assert.equal(healthy.ready, true);
  await assert.rejects(checkWorkerDeployment({ repository: WORKER_REPOSITORY }, {}));
});

test('Worker rejects missing grants, foreign repository and observation execution', () => {
  const input = request(); assert.equal(validateWorkerRequest(input).ticket.inputs.length, 1);
  input.ticket.executionPrompt = 'Only change user-facing wording.';
  assert.equal(validateWorkerRequest(input).ticket.executionPrompt, input.ticket.executionPrompt);
  assert.throws(() => validateWorkerRequest({ ...input, ticket: { ...input.ticket, executionPrompt: 'x'.repeat(12001) } }));
  for (const patch of [{ mode: 'observe' }, { repository: 'other/repo' }, { mandate: { ...input.ticket.mandate, allowed: { execute: false } } }, { mandate: { ...input.ticket.mandate, allowed: { execute: true, merge: true } } }]) assert.throws(() => validateWorkerRequest({ ...input, ticket: { ...input.ticket, ...patch } }));
  assert.throws(() => validateWorkerRequest({ ...input, assignmentId: '../other' }));
});

test('DSH command uses verified official headless flags and strips host credentials', () => {
  assert.deepEqual(headlessArgs('session-abc'), ['--profile', 'headless', '--json', '--permission-mode', 'workspace-write', '--approval-policy', 'never', '--session-id', 'session-abc', '-']);
  assert.ok(!headlessArgs().includes('--session-id')); assert.throws(() => headlessArgs('--bad'));
  const env = workerEnvironment({ root: '/isolated', path: '/usr/bin' }, { HOME: '/personal', SUPERAGENT_WORKER_TOKEN: token, SUPERAGENT_GITHUB_TOKEN: 'github-secret', AWS_ACCESS_KEY_ID: 'aws-secret', DEEPSEEK_API_KEY: 'worker-model-key' });
  assert.equal(env.HOME, join('/isolated', 'home')); assert.equal(env.DEEPSEEK_API_KEY, 'worker-model-key');
  assert.doesNotMatch(JSON.stringify(env), /github-secret|aws-secret|test-only|personal/);
});

test('DSH completion needs both exit zero and completed final, plus structured report', () => {
  const events = [{ type: 'session', sessionId: 'session-abc' }, { type: 'final', sessionId: 'session-abc', reason: { kind: 'completed' }, text: JSON.stringify({ status: 'ready', summary: 'Tests passed.', prUrl: 'https://fake.invalid' }) }];
  assert.equal(parseHeadlessResult(events, 0).status, 'ready'); assert.equal(parseHeadlessResult(events, 1).status, 'failed');
  assert.equal(parseHeadlessResult(events, 0, 'wrong').status, 'failed');
  assert.equal(parseHeadlessResult([events[0], { ...events[1], reason: null }], 0).status, 'failed');
  assert.equal(parseHeadlessResult([events[0], { ...events[1], text: 'Looks good' }], 0).status, 'blocked');
  assert.equal(parseHeadlessResult(events, 0).prUrl, undefined);
});

test('source and changes reject credentials, traversal and link files', async t => {
  const { sourceDir } = await fixture(t, async () => ({ status: 'ready', summary: 'ok' }));
  for (const path of ['runtime/x.json', '.git/config', '../server/a.js', 'public/../a.js', '.env', 'public/cookies.json', 'lib/private.key', 'public\\a.js', 'unknown/a.js']) assert.equal(safeSourcePath(path), false, path);
  assert.equal(safeSourcePath('server/app.mjs'), true);
  const before = await sourceFiles(sourceDir); await writeFile(join(sourceDir, 'public', 'app.js'), 'after');
  assert.deepEqual(await collectChanges(before, sourceDir), [{ path: 'public/app.js', content: 'after' }]);
  await writeFile(join(sourceDir, 'public', 'cookies.json'), '{}');
  await assert.rejects(sourceFiles(sourceDir), /受限文件/);
  assert.throws(() => validateWorkerReport({ status: 'ready', summary: 'ok', baseCommit: commit, changes: [{ path: 'runtime/x.json', content: 'secret' }] }));
});

test('Linux worker rejects hard links in the sanitized source', { skip: process.platform !== 'linux' }, async t => {
  const { sourceDir } = await fixture(t, async () => ({ status: 'ready', summary: 'ok' }));
  await link(join(sourceDir, 'public', 'app.js'), join(sourceDir, 'public', 'linked.js'));
  await assert.rejects(sourceFiles(sourceDir), /硬链接/);
});

test('runner persists actual file changes, duplicate assignments and same-session continuation', async t => {
  let count = 0; const sessions = [];
  const f = await fixture(t, async ({ directory, sessionId, onSession }) => {
    count++; sessions.push(sessionId); await onSession('session-real-fixture');
    await writeFile(join(directory, 'public', 'app.js'), `after-${count}`);
    return { status: 'ready', summary: 'verified fixture', sessionId: 'session-real-fixture' };
  });
  await f.runner.start(request()); const first = await settled(f.runner, 'assignment-1');
  assert.equal(first.report.status, 'ready', f.failures.join('\n'));
  assert.equal(first.report.baseCommit, commit); assert.deepEqual(first.report.changes, [{ path: 'public/app.js', content: 'after-1' }]);
  await f.runner.start(request()); assert.equal(count, 1);
  const changed = request(); changed.ticket.inputs[0].text = 'altered'; await assert.rejects(f.runner.start(changed), { status: 409 });
  await f.runner.start(request('ticket-1', 'assignment-2')); await settled(f.runner, 'assignment-2');
  assert.deepEqual(sessions, [undefined, 'session-real-fixture']);
  await f.runner.close();
  const restored = new WorkerRunner(f.config, { guard: async () => {}, execute: async () => { throw Error('must not run'); }, env: {} }); await restored.initialize();
  assert.equal((await restored.start(request())).state, 'done'); await restored.close();
});

test('stop awaits process completion, preserves workspace and does not allow overlap', async t => {
  const started = Promise.withResolvers();
  const f = await fixture(t, async ({ signal }) => {
    const cancelled = new Promise(done => { if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true }); });
    started.resolve(); await cancelled; return { status: 'blocked', summary: 'Stopped' };
  });
  await f.runner.start(request());
  await assert.rejects(f.runner.start(request('ticket-1', 'assignment-2')), { status: 409 });
  await assert.rejects(f.runner.stop('assignment-1', 'wrong-ticket'), { status: 403 });
  // Synchronize with actual listener registration instead of a guessed delay.
  await started.promise;
  const stopped = await f.runner.stop('assignment-1', 'ticket-1'); assert.equal(stopped.state, 'done'); assert.equal(stopped.report.status, 'blocked');
  assert.equal(await readFile(join(f.root, 'work', 'ticket-1', 'public', 'app.js'), 'utf8'), 'before');
});

test('executor authenticates, polls, validates identity and returns actual diff', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? result({ assignmentId: 'assignment-1', ticketId: 'ticket-1', state: 'running' }) : result({ assignmentId: 'assignment-1', ticketId: 'ticket-1', state: 'done', sessionId: 'session-abc', report: { status: 'ready', summary: 'ok', baseCommit: commit, changes: [{ path: 'public/app.js', content: 'new' }] } });
  };
  const executor = new DshExecutor({ settings, fetchImpl, env: { SUPERAGENT_WORKER_TOKEN: token }, pollMs: 1 });
  const output = await executor.execute(request()); assert.equal(output.changes.length, 1); assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.doesNotMatch(calls[0].options.body, /test-only-worker-token/);
  const wrong = new DshExecutor({ settings, env: { SUPERAGENT_WORKER_TOKEN: token }, fetchImpl: async () => result({ assignmentId: 'wrong', ticketId: 'wrong', state: 'done', report: { status: 'ready', summary: 'bad' } }) });
  await assert.rejects(wrong.execute(request()), /不属于/);
});

test('known deployment secret cannot escape in worker reports or changes', async t => {
  const f = await fixture(t, async () => ({ status: 'ready', summary: 'sensitive-value-123' }));
  f.runner.env = { DEEPSEEK_API_KEY: 'sensitive-value-123' };
  await f.runner.start(request()); const value = await settled(f.runner, 'assignment-1');
  assert.equal(value.report.status, 'blocked'); assert.doesNotMatch(JSON.stringify(value), /sensitive-value/);
});
