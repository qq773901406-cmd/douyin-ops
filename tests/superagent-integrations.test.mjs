import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { DingTalkStream } from '../integrations/dingtalk-superagent/stream-client.mjs';
import { DingTalkOutboundTransport } from '../integrations/dingtalk-superagent/outbound-transport.mjs';
import { GitHubSource } from '../integrations/dingtalk-superagent/github-source.mjs';
import { GitHubClient, GitHubDelivery } from '../integrations/dingtalk-superagent/github-delivery.mjs';
import { Assessor } from '../integrations/dingtalk-superagent/assessor.mjs';

const repository = 'qq773901406-cmd/douyin-ops';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const config = { enabled: true, corpId: 'corp', clientId: 'robot', allowedUserIds: ['owner'] };
const envelope = () => ({ headers: { messageId: 'transport-1' }, data: JSON.stringify({
  msgId: 'message-1', conversationId: 'conversation', conversationType: '1', senderStaffId: 'owner',
  chatbotCorpId: 'corp', senderCorpId: 'corp', robotCode: 'robot', msgtype: 'text', text: { content: '更新说明' },
  sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=secret', sessionWebhookExpiredTime: Date.now() + 60000,
}) });
class MockDWClient extends EventEmitter {
  constructor(config) { super(); this.config = config; this.acks = []; this.connected = false; this.registered = false; }
  registerCallbackListener(topic, listener) { this.listener = listener; return this; }
  async connect() {} // Returning does NOT mean connected.
  disconnect() { this.connected = false; this.registered = false; }
  socketCallBackResponse(...args) { this.acks.push(args); }
  async getAccessToken() { return 'token'; }
}
const sdk = async () => ({ DWClient: MockDWClient, TOPIC_ROBOT: '/v1.0/im/bot/messages/get' });

test('Stream reports dependency/configuration gaps and never equates connect return with readiness', async () => {
  const missing = new DingTalkStream({ config, onMessage: async () => ({ accepted: true }), env: {} });
  assert.equal((await missing.start()).state, 'unconfigured');
  const unavailable = new DingTalkStream({ config, env: { DINGTALK_CLIENT_SECRET: 'secret' }, loadSdk: async () => { throw Error('secret'); } });
  assert.equal((await unavailable.start()).state, 'unconfigured'); assert.doesNotMatch(JSON.stringify(unavailable.health()), /secret/);
  const stream = new DingTalkStream({ config, env: { DINGTALK_CLIENT_SECRET: 'secret' }, loadSdk: sdk, onMessage: async () => ({ accepted: true }) });
  assert.equal((await stream.start()).state, 'connecting'); assert.equal(stream.client.config.debug, false);
  stream.client.connected = true; assert.equal(stream.health().state, 'connecting');
  stream.client.registered = true; assert.equal(stream.health().state, 'connected');
  await stream.stop(); assert.equal(stream.health().state, 'disabled');
});

test('Stream ACK follows durable acceptance and replies never expose session capabilities to the host', async () => {
  let finish; const accepted = new Promise(done => { finish = done; }); let seen;
  const stream = new DingTalkStream({ config, env: { DINGTALK_CLIENT_SECRET: 'secret' }, loadSdk: sdk,
    onMessage: async (msg, route) => { seen = { msg, route }; await accepted; return { accepted: true }; }, fetchImpl: async () => json({ errcode: 0 }) });
  await stream.start(); const call = stream.client.listener(envelope());
  assert.equal(stream.client.acks.length, 0); assert.doesNotMatch(JSON.stringify(seen), /secret|sessionWebhook/);
  finish(); await call; assert.equal(stream.client.acks.length, 1);
  assert.equal((await stream.send({ conversationId: 'conversation', text: '已登记' })).sent, true);
  await stream.stop(); await assert.rejects(stream.send({ conversationId: 'conversation', text: '不能发送' }), { code: 'source_disabled' });
});

test('stopping while SDK loads prevents a late connection from starting', async () => {
  let release; const loading = new Promise(done => { release = done; });
  const stream = new DingTalkStream({ config, env: { DINGTALK_CLIENT_SECRET: 'secret' }, loadSdk: () => loading, onMessage: async () => ({ accepted: true }) });
  const started = stream.start(); await stream.stop(); release(await sdk()); await started;
  assert.equal(stream.client, null); assert.equal(stream.health().state, 'disabled');
});

test('rejected messages cannot register reply destinations; storage failures remain unacknowledged', async () => {
  const stream = new DingTalkStream({ config, env: { DINGTALK_CLIENT_SECRET: 'secret' }, loadSdk: sdk,
    onMessage: async () => ({ accepted: false }), fetchImpl: async () => { throw Error('must not send'); } });
  await stream.start(); await stream.client.listener(envelope()); assert.equal(stream.client.acks.length, 1);
  await assert.rejects(stream.send({ conversationId: 'conversation', text: 'x' }), { code: 'route_unavailable' });
  stream.onMessage = async () => { throw Error('database secret'); };
  await stream.client.listener(envelope()); assert.equal(stream.client.acks.length, 1); assert.doesNotMatch(JSON.stringify(stream.health()), /database secret/);
  await stream.stop();
});

test('outbound rejects attacker hosts and expired routes; ambiguous POST outcomes cannot auto retry', async () => {
  let now = 1000, calls = 0;
  const transport = new DingTalkOutboundTransport({ now: () => now, getAccessToken: async () => 'secret', fetchImpl: async (url, options) => { calls++; assert.equal(options.redirect, 'error'); throw Error('URL contains secret'); } });
  const route = { sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=secret', sessionWebhookExpiredTime: 2000 };
  assert.equal(transport.remember('conv', { ...route, sessionWebhook: 'https://evil.invalid/?session=secret' }), false);
  assert.equal(transport.remember('conv', route), true);
  await assert.rejects(transport.send({ conversationId: 'conv', text: 'result' }), error => error.uncertain === true && error.retryable === false && !error.message.includes('secret'));
  now = 3000; await assert.rejects(transport.send({ conversationId: 'conv', text: 'result' }), { code: 'route_unavailable' }); assert.equal(calls, 1);
});

test('Assessor uses local structured output and rejects fabricated tickets/rules/permissions', async () => {
  let output = { action: 'attach', ticketId: 'ticket-1', reason: '明确引用任务', matchedRules: ['r1'] }, request;
  const assessor = new Assessor({ settings: { model: 'local-model' }, fetchImpl: async (url, options) => { request = { url: String(url), body: JSON.parse(options.body) }; return json({ done: true, message: { content: JSON.stringify(output) } }); } });
  const input = { text: '继续 ticket-1', tickets: [{ id: 'ticket-1' }], rules: [{ id: 'r1', instruction: '更新文档' }] };
  assert.equal((await assessor.assess(input)).ticketId, 'ticket-1'); assert.equal(request.url, 'http://127.0.0.1:11434/api/chat'); assert.equal(request.body.stream, false);
  for (const patch of [{ ticketId: 'invented' }, { matchedRules: ['invented'] }, { execute: true }, { action: 'merge' }]) {
    const saved = output; output = { ...saved, ...patch }; await assert.rejects(assessor.assess(input), { code: 'assessment_unavailable' }); output = saved;
  }
  const remote = new Assessor({ settings: { model: 'x', endpoint: 'https://evil.invalid' }, fetchImpl: () => { throw Error('must not connect'); } });
  await assert.rejects(remote.assess(input), /仅支持本机/);
});

test('GitHub Source returns stable events and advances cursor only after receiver persistence', async () => {
  const at = '2026-11-02T02:00:00Z', calls = [];
  const source = new GitHubSource({ token: 'test-token', now: () => new Date('2026-11-02T03:00:00Z'), fetchImpl: async (url, options) => {
    calls.push(String(url)); assert.equal(options.redirect, 'error'); const path = new URL(url).pathname;
    if (path.endsWith('/issues')) return json([{ id: 11, number: 1, updated_at: at, title: '任务', body: '内容', state: 'open', user: { login: 'owner' } }]);
    if (path.endsWith('/issues/comments')) return json([{ id: 12, updated_at: at, body: '继续', issue_url: `https://api.github.com/repos/${repository}/issues/1`, user: { login: 'owner' } }]);
    if (path.endsWith('/pulls/comments')) return json([]);
    if (path.endsWith('/check-runs')) return json({ check_runs: [] });
    throw Error('Unexpected request');
  } });
  const first = await source.poll({ cursor: at }); const second = await source.poll({ cursor: at });
  assert.deepEqual(first, second); assert.equal(first.events.length, 2); assert.equal(first.cursor, '2026-11-02T03:00:00.000Z');
  source.onEvent = async () => { throw Error('durable write failed'); }; await assert.rejects(source.poll({ cursor: at }), /durable write failed/);
  assert.ok(calls[0].includes('since=2026-11-02T01%3A59%3A00.000Z'));
});

test('GitHub source includes PR lifecycle, approval reviews and check status with no writes', async () => {
  const at = '2026-11-02T02:00:00Z', sha = 'a'.repeat(40);
  const source = new GitHubSource({ fetchImpl: async (url, options) => {
    assert.equal(options.method, 'GET'); const path = new URL(url).pathname;
    if (path.endsWith('/pulls/1')) return json({ id: 2, number: 1, updated_at: at, title: 'PR', state: 'closed', merged_at: at, head: { sha } });
    if (path.endsWith('/reviews')) return json([{ id: 3, submitted_at: at, state: 'APPROVED', user: { login: 'reviewer' } }]);
    if (path.endsWith('/check-runs')) return json({ check_runs: [{ id: path.includes('/main/') ? 5 : 4, completed_at: at, status: 'completed', conclusion: 'success', name: 'tests', app: { slug: 'actions' } }] });
    return json([]);
  } });
  const result = await source.poll({ pullNumbers: [1] });
  assert.deepEqual(result.events.map(e => e.kind).sort(), ['check', 'default-check', 'pull-state', 'review']);
  assert.equal(result.events.find(e => e.kind === 'pull-state').state, 'merged');
  const ci = result.events.find(e => e.kind === 'default-check'); assert.equal(ci.number, null); assert.equal(ci.conversationId, `github:${repository}#branch:main`);
});

test('GitHub rejects cross-repository access and unsafe writes without disclosing credentials', async () => {
  assert.throws(() => new GitHubDelivery({ repository: 'other/repo' }));
  const client = new GitHubClient({ token: 'secret', fetchImpl: async () => { throw Error('secret'); } });
  await assert.rejects(client.request('/pulls/1/merge', { method: 'POST', body: {} }), { code: 'operation_not_allowed' });
  await assert.rejects(client.request('/pulls', { method: 'POST', body: {} }), error => error.uncertain === true && !error.message.includes('secret'));
});

test('GitHub draft PR creation is idempotent and never enables merge', async () => {
  let posted = 0, existing = false;
  const pr = { number: 5, html_url: `https://github.com/${repository}/pull/5`, state: 'open', draft: true, head: { ref: 'codex/ticket-test', repo: { full_name: repository } }, base: { ref: 'main' } };
  const delivery = new GitHubDelivery({ token: 'secret', fetchImpl: async (url, options) => {
    if (options.method === 'GET') return json(existing ? [pr] : []);
    posted++; const body = JSON.parse(options.body); assert.equal(body.draft, true); assert.equal(body.maintainer_can_modify, false); existing = true; return json(pr, 201);
  } });
  const input = { head: 'codex/ticket-test', title: '改进说明', body: '验证结果' };
  assert.equal((await delivery.createDraftPR(input)).existing, false); assert.equal((await delivery.createDraftPR(input)).existing, true); assert.equal(posted, 1);
  assert.equal(delivery.merge, undefined);
});

test('GitHub issue replies deduplicate completed sends and leave uncertain sends for reconciliation', async () => {
  const comments = []; let posts = 0;
  const delivery = new GitHubDelivery({ token: 'secret', fetchImpl: async (url, options) => {
    assert.ok(new URL(url).pathname.endsWith('/issues/7/comments'));
    if (options.method === 'GET') return json(comments);
    posts++; comments.push({ id: 44, body: JSON.parse(options.body).body }); return json({ id: 44 }, 201);
  } });
  assert.equal((await delivery.commentIssue(7, '任务已完成')).existing, false);
  assert.equal((await delivery.commentIssue(7, '任务已完成')).existing, true); assert.equal(posts, 1);
});

test('GitHub publish preflight rejects protected paths and oversized changes before network access', async () => {
  const delivery = new GitHubDelivery({ token: 'secret', fetchImpl: async () => { throw Error('must not connect'); } });
  const input = { ticketId: '12345678-1234-1234-1234-123456789abc', baseCommit: 'a'.repeat(40), title: 'change', body: 'body' };
  for (const path of ['runtime/account.json', '../secret', '/etc/passwd', 'C:/secret', '.env', '.git/config', '.github/workflows/steal.yml', 'public/storage-state.json']) {
    await assert.rejects(delivery.publishChanges({ ...input, changes: [{ path, content: 'x' }] }), { code: 'path_not_allowed' });
  }
  await assert.rejects(delivery.publishChanges({ ...input, changes: [{ path: 'public/a.js', content: 'x'.repeat(1024 * 1024 + 1) }] }), { code: 'invalid_input' });
});

test('GitHub publish creates verified objects and one new branch, preserving existing divergent work', async () => {
  const id = '12345678-1234-1234-1234-123456789abc', base = 'a'.repeat(40), baseTree = 'b'.repeat(40), newTree = 'c'.repeat(40), commit = 'd'.repeat(40);
  const content = 'export const updated = true;\n', bytes = Buffer.from(content), blob = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  let branchExists = false, conflict = false; const writes = [];
  const input = { ticketId: id, baseCommit: base, title: 'change', body: 'validated', changes: [{ path: 'public/demo.js', content }] };
  const delivery = new GitHubDelivery({ token: 'secret', fetchImpl: async (url, options) => {
    const path = new URL(url).pathname.split(`/repos/${repository}`)[1], body = options.body && JSON.parse(options.body);
    if (options.method === 'POST') writes.push(path);
    if (path === `/git/commits/${base}`) return json({ sha: base, tree: { sha: baseTree } });
    if (path.startsWith('/git/ref/')) return branchExists ? json({ object: { sha: commit } }) : json({}, 404);
    if (path === '/git/blobs') return json({ sha: blob });
    if (path === '/git/trees') { assert.equal(body.base_tree, baseTree); assert.equal(body.tree[0].sha, blob); return json({ sha: newTree }); }
    if (path === '/git/commits') return json({ sha: commit });
    if (path === '/git/refs') { assert.equal(body.ref, `refs/heads/codex/ticket-${id}`); branchExists = true; return json({ object: { sha: commit } }); }
    if (path === `/git/commits/${commit}`) return json({ sha: commit, tree: { sha: conflict ? baseTree : newTree }, message: `change\n\nSuperagent-Ticket: ${id}`, parents: [{ sha: base }] });
    if (path === '/pulls' && options.method === 'GET') return json([]);
    if (path === '/pulls') return json({ number: 10, html_url: `https://github.com/${repository}/pull/10`, state: 'open', draft: true });
    throw Error('Unexpected');
  } });
  assert.equal((await delivery.publishChanges(input)).commitSha, commit); assert.equal(writes.filter(path => path === '/git/refs').length, 1);
  conflict = true; await assert.rejects(delivery.publishChanges(input), { code: 'branch_conflict' }); assert.equal(writes.filter(path => path === '/git/refs').length, 1);
});

test('GitHub revalidates every write and a revoked or aborted grant prevents the request', async () => {
  const calls = []; let permitted = true, guards = 0;
  const controller = new AbortController();
  const delivery = new GitHubDelivery({ token: 'secret', signal: controller.signal,
    beforeWrite: async () => { guards++; if (!permitted) throw Object.assign(Error('revoked'), { status: 403 }); },
    fetchImpl: async (url, options) => { calls.push(options.method); return json({ sha: 'a'.repeat(40) }); } });
  await delivery.request('/git/blobs', { method: 'POST', body: { content: 'a', encoding: 'utf-8' } });
  permitted = false; await assert.rejects(delivery.request('/git/trees', { method: 'POST', body: {} }), { status: 403 });
  assert.deepEqual(calls, ['POST']); assert.equal(guards, 2);
  permitted = true; controller.abort(); await assert.rejects(delivery.request('/git/commits', { method: 'POST', body: {} }), { code: 'delivery_cancelled' });
  assert.deepEqual(calls, ['POST']);
  const client = new GitHubClient({ token: 'secret' });
  await assert.rejects(client.request('/git/refs/heads/main', { method: 'PATCH', body: { sha: 'a'.repeat(40), force: false } }), { code: 'operation_not_allowed' });
  await assert.rejects(client.request('/git/refs/heads/codex/ticket-12345678-1234-1234-1234-123456789abc', { method: 'PATCH', body: { sha: 'a'.repeat(40), force: true } }), { code: 'operation_not_allowed' });
});

test('GitHub PR revisions require exact trusted head and use non-force updates', async () => {
  const id = '12345678-1234-1234-1234-123456789abc', base = 'a'.repeat(40), baseTree = 'b'.repeat(40), oldTree = 'c'.repeat(40), newTree = 'd'.repeat(40), oldHead = 'e'.repeat(40), newHead = 'f'.repeat(40);
  const content = 'revision', blob = createHash('sha1').update(Buffer.from(`blob ${content.length}\0${content}`)).digest('hex');
  const input = { ticketId: id, baseCommit: base, expectedHead: oldHead, baseBranch: 'main', changes: [{ path: 'public/demo.js', content }], title: 'change', body: 'verified' };
  let currentHead = oldHead, patched = 0, raced = false, refReads = 0;
  const delivery = new GitHubDelivery({ token: 'secret', fetchImpl: async (url, options) => {
    const path = new URL(url).pathname.split(`/repos/${repository}`)[1], body = options.body && JSON.parse(options.body);
    if (path === `/git/commits/${base}`) return json({ sha: base, tree: { sha: baseTree } });
    if (path.startsWith('/git/ref/')) { refReads++; return json({ object: { sha: raced && refReads > 1 ? '1'.repeat(40) : currentHead } }); }
    if (path === '/git/blobs') return json({ sha: blob });
    if (path === '/git/trees') return json({ sha: newTree });
    if (path === `/git/commits/${currentHead}`) return json({ sha: currentHead, tree: { sha: oldTree }, message: 'old', parents: [{ sha: base }] });
    if (path === '/git/commits') { assert.deepEqual(body.parents, [oldHead]); return json({ sha: newHead }); }
    if (options.method === 'PATCH') { patched++; assert.equal(body.force, false); assert.equal(body.sha, newHead); currentHead = newHead; return json({ object: { sha: newHead } }); }
    if (path === '/pulls' && options.method === 'GET') return json([{ number: 9, state: 'open', draft: true, html_url: `https://github.com/${repository}/pull/9`, head: { ref: `codex/ticket-${id}`, repo: { full_name: repository } }, base: { ref: 'main' } }]);
    throw Error('Unexpected');
  } });
  assert.equal((await delivery.publishChanges(input)).commitSha, newHead); assert.equal(patched, 1);
  currentHead = oldHead; raced = true; refReads = 0;
  await assert.rejects(delivery.publishChanges(input), { code: 'branch_conflict' }); assert.equal(patched, 1);
});
