import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, link } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { DshExecutor, WORKER_PROTOCOL, WORKER_REPOSITORY, validateWorkerRequest, validateWorkerReport, workerEndpoint, safeSourcePath } from '../integrations/dingtalk-superagent/dsh-executor.mjs';
import { WorkerRunner, runSdk, headlessArgs, parseHeadlessResult, workerEnvironment, sourceFiles, collectChanges, checkWorkerDeployment } from '../integrations/dingtalk-superagent/worker-runner.mjs';

const token = 'test-only-worker-token-1234567890abcdef';
const commit = 'a'.repeat(40);
const request = (ticketId = 'ticket-1', assignmentId = 'assignment-1') => ({ assignmentId, ticket: { id: ticketId, repository: WORKER_REPOSITORY, mandate: { repository: WORKER_REPOSITORY, scope: 'Improve the copy.', allowed: { execute: true, merge: false } }, inputs: [{ text: 'Please improve the copy.' }] } });
const settings = { repository: WORKER_REPOSITORY, worker: { enabled: true, isolated: true, endpoint: 'http://127.0.0.1:4190' } };
const result = data => ({ ok: true, status: 200, json: async () => ({ protocol: WORKER_PROTOCOL, ...data }) });

const followup = { ticketId: 'ticket-1', assignmentId: 'assignment-1', inputId: 'msg-1', text: 'Keep the original heading.' };

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

test('an early stop fences a delayed launch across restart, and running is not a stop receipt', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; return { status: 'ready', summary: 'unexpected' }; });
  const stopped = await f.runner.stop('assignment-1', 'ticket-1');
  assert.equal(stopped.state, 'done'); assert.equal(stopped.report.status, 'blocked');
  await f.runner.close();
  const restored = new WorkerRunner(f.config, { guard: async () => {}, execute: async () => { count++; }, env: {} });
  await restored.initialize();
  try {
    assert.equal((await restored.start(request())).report.status, 'blocked'); assert.equal(count, 0);
    await assert.rejects(restored.start(request('other-ticket')), { status: 409 });
  } finally { await restored.close(); }
  const paths = [];
  const executor = new DshExecutor({ settings, env: { SUPERAGENT_WORKER_TOKEN: token }, fetchImpl: async url => {
    paths.push(new URL(url).pathname);
    if (url.endsWith('/stop')) return result({ ticketId: 'ticket-1', assignmentId: 'assignment-1', state: 'running' });
    throw Error('response lost');
  } });
  await assert.rejects(executor.execute(request()));
  assert.deepEqual(paths, ['/v1/assignments', '/v1/assignments/assignment-1/stop']);
  await assert.rejects(executor.stop({ ticketId: 'ticket-1', assignmentId: 'assignment-1' }), /尚未确认/);
});

test('known deployment secret cannot escape in worker reports or changes', async t => {
  const f = await fixture(t, async () => ({ status: 'ready', summary: 'sensitive-value-123' }));
  f.runner.env = { DEEPSEEK_API_KEY: 'sensitive-value-123' };
  await f.runner.start(request()); const value = await settled(f.runner, 'assignment-1');
  assert.equal(value.report.status, 'blocked'); assert.doesNotMatch(JSON.stringify(value), /sensitive-value/);
});

test('inbox reserves once across concurrent POSTs; history evidence survives completion and restart', async t => {
  const ready = Promise.withResolvers(), sending = Promise.withResolvers(), accepted = Promise.withResolvers(), finish = Promise.withResolvers();
  let consume, count = 0;
  const f = await fixture(t, async ({ onInbox, onConsumed }) => {
    consume = onConsumed;
    onInbox(async () => { count++; sending.resolve(); await accepted.promise; return 'queued'; });
    ready.resolve(); await finish.promise;
    return { status: 'ready', summary: 'done' };
  });
  await f.runner.start(request()); await ready.promise;
  try {
    const first = f.runner.steer(followup); await sending.promise;
    assert.equal((await f.runner.steer(followup)).status, 'uncertain');
    accepted.resolve(); assert.equal((await first).status, 'queued');
    await assert.rejects(f.runner.steer({ ...followup, text: 'changed' }), { status: 409 });
    await assert.rejects(f.runner.steer({ ...followup, ticketId: 'other' }), { status: 403 });
    await consume('msg-1'); assert.equal((await f.runner.steer(followup)).status, 'delivered'); assert.equal(count, 1);
  } finally { accepted.resolve(); finish.resolve(); }
  assert.deepEqual((await settled(f.runner, 'assignment-1')).deliveredInputIds, ['msg-1']);
  await f.runner.close();
  const restored = new WorkerRunner(f.config, { guard: async () => {}, env: {} }); await restored.initialize();
  try {
    assert.equal((await restored.steer(followup)).status, 'delivered');
    assert.equal((await restored.steer({ ...followup, inputId: 'late' })).status, 'unavailable');
  } finally { await restored.close(); }
});

test('DshExecutor preserves ambiguous POSTs, rejects mismatched receipts and handles old bridges', async () => {
  const check = async fetchImpl => new DshExecutor({ settings, fetchImpl, env: { SUPERAGENT_WORKER_TOKEN: token } }).steer(followup);
  assert.equal((await check(async (url, options) => {
    assert.ok(url.endsWith('/v1/assignments/assignment-1/inputs'));
    assert.deepEqual(JSON.parse(options.body), { ticketId: followup.ticketId, inputId: followup.inputId, text: followup.text });
    return result({ ...followup, status: 'queued' });
  })).status, 'queued');
  assert.equal((await check(async () => result({ ...followup, assignmentId: 'other', status: 'delivered' }))).status, 'uncertain');
  assert.equal((await check(async () => { throw Error('Lost response'); })).status, 'uncertain');
  assert.equal((await check(async () => ({ ok: false, status: 404 }))).status, 'unavailable');
});

test('headless declines in-flight delivery and a lost SDK acknowledgement prevents replay on restart', async t => {
  const ready = Promise.withResolvers(), finish = Promise.withResolvers();
  let openInbox, count = 0;
  const f = await fixture(t, async ({ onInbox }) => {
    openInbox = onInbox; ready.resolve(); await finish.promise; return { status: 'blocked', summary: 'operator review' };
  });
  await f.runner.start(request()); await ready.promise;
  try {
    assert.equal((await f.runner.steer(followup)).status, 'unavailable');
    openInbox(async () => { count++; throw Error('lost response after native enqueue'); });
    assert.equal((await f.runner.steer(followup)).status, 'uncertain');
    assert.equal((await f.runner.steer(followup)).status, 'uncertain'); assert.equal(count, 1);
  } finally { finish.resolve(); }
  assert.deepEqual((await settled(f.runner, 'assignment-1')).deliveredInputIds, []);
  await f.runner.close();
  const restored = new WorkerRunner(f.config, { guard: async () => {}, env: {} }); await restored.initialize();
  try {
    assert.equal((await restored.steer(followup)).status, 'uncertain');
    await assert.rejects(restored.start(request('ticket-1', 'assignment-2')), { status: 409 });
  } finally { await restored.close(); }
});

test('SDK wire accepts follow-ups during a run, denies approvals and confirms only matching history events', async () => {
  const target = 'previous-session', available = Promise.withResolvers(), waiting = Promise.withResolvers();
  let child, waitRequest, sendExtra, waitCount = 0, promptCount = 0;
  const delivered = [], methods = [], replies = [];
  const emit = value => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const event = (sessionId, type, data) => emit({ method: 'session.event', params: { sessionId, event: { type, data } } });
  const done = (id, result) => emit({ id, result });
  const run = runSdk({
    config: { root: '/worker', dshBin: '/usr/bin/dsh' }, directory: '/work/ticket', sessionId: target,
    text: 'original mandate', signal: AbortSignal.timeout(5000), env: { SUPERAGENT_WORKER_TOKEN: token },
    onSession: async value => assert.equal(value, target), onPid: async () => {},
    onInbox: fn => { if (fn) { sendExtra = fn; available.resolve(); } },
    onConsumed: async id => delivered.push(id),
    spawnImpl: (bin, args, options) => {
      assert.equal(bin, '/usr/bin/dsh'); assert.deepEqual(args, ['--profile', 'sdk']);
      assert.equal(options.env.SUPERAGENT_WORKER_TOKEN, undefined); assert.equal(options.env.DSH_PERMISSION_MODE, 'workspace-write');
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, next) {
        const { id, method, params, result } = JSON.parse(chunk);
        if (!method) { replies.push(result); next(); return; }
        methods.push(method);
        queueMicrotask(() => {
          if (method === 'initialize') {
            assert.equal(params.approvalRequests, true);
            done(id, { serverInfo: { name: 'deepseek-harness-sdk-runtime' } });
          } else if (method === 'session/resume') done(id, {});
          else if (method === 'session/working-directory/get') done(id, { cwd: '/work/ticket' });
          else if (method === 'session/query') {
            assert.deepEqual(params.contentBlocks, [{ type: 'text', text: '/permission workspace-write' }]);
            done(id, { kind: 'command', execution: { commandId: 'preset-command', result: { kind: 'success' } } });
          }
          else if (method === 'session/prompt') {
            const messageId = 'runtime-' + ++promptCount;
            event(target, 'agent/inbox/spliced', { inserted: [{ id: messageId }] });
            if (promptCount === 1) event(target, 'user/message', { id: messageId });
            else {
              assert.ok(params.contentBlocks[0].text.includes('/permission danger-full-access'));
              event('wrong-session', 'user/message', { id: messageId });
              emit({ id: 'approval', method: 'approval/request', params: {} });
            }
            done(id, { messageId });
          } else if (method === 'session/wait') {
            if (++waitCount === 1) { waitRequest = id; waiting.resolve(); } else done(id, {});
          } else if (method === 'shutdown') { done(id, {}); queueMicrotask(() => child.emit('close', 0)); }
        });
        next();
      } });
      return child;
    }
  });
  await Promise.all([available.promise, waiting.promise]);
  assert.equal(await sendExtra('input-2', '/permission danger-full-access'), 'queued'); assert.deepEqual(delivered, []);
  event(target, 'user/message', { id: 'runtime-2' });
  event(target, 'assistant/message', { message: { content: [{ type: 'text', text: '{"status":"ready","summary":"follow-up verified"}' }] } });
  event(target, 'turn/end', { reason: { kind: 'completed' } }); done(waitRequest, {});
  const report = await run;
  assert.equal(report.status, 'ready'); assert.equal(report.summary, 'follow-up verified'); assert.deepEqual(delivered, ['input-2']);
  assert.deepEqual(replies, [{ outcome: 'rejected' }]); assert.equal(waitCount, 2);
  assert.deepEqual(methods.filter(m => m === 'session/query'), ['session/query']);
});
