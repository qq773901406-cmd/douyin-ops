import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { WorkflowStore } from '../integrations/dingtalk-superagent/workflow-store.mjs';
import { WorkflowService } from '../integrations/dingtalk-superagent/workflow-service.mjs';
import { defaultSettings, settingsVersion } from '../integrations/dingtalk-superagent/workflow-settings.mjs';

async function fixture(t) {
  const root = resolve('.codex_tmp'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(join(root, 'superagent-workflow-'));
  t.after(async () => { assert.ok(resolve(dir).startsWith(root + sep)); await rm(dir, { recursive: true, force: true }); });
  return { dir, store: new WorkflowStore(dir) };
}
const request = (eventId = 'event-1', extra = {}) => ({ eventId, text: '修复工作台空状态', ...extra });
const manual = () => ({ ...defaultSettings(), mode: 'manual', worker: { enabled: true, isolated: true, endpoint: 'http://127.0.0.1:9101' } });
const message = extra => ({ eventId: 'ding-1', text: '请改文案', senderId: 'owner', corpId: 'corp', robotCode: 'robot', conversationId: 'cid$abc=123', conversationType: '2', isInAtList: true, ...extra });

test('workflow keeps followups in one ticket, immutable scope, dedup and restart history', async t => {
  const { dir, store } = await fixture(t);
  const initial = await store.ingest(request()), id = initial.ticketId, grant = initial.tickets[0].mandate;
  const extra = await store.ingest(request('event-2', { ticketId: id, text: '补充：保持原布局' }));
  assert.equal(extra.tickets.length, 1); assert.equal(extra.tickets[0].inputs.length, 2); assert.deepEqual(extra.tickets[0].mandate, grant);
  assert.equal((await new WorkflowStore(dir).ingest(request())).duplicate, true);
  assert.equal((await store.snapshot()).outbox[0].status, 'preview');
  const stopped = await store.action(id, 'stop', extra.revision);
  assert.equal(stopped.tickets[0].status, 'cancelled');
  await assert.rejects(store.ingest(request('event-3', { ticketId: id })), { status: 409 });
});

test('workflow configuration versions reject secrets, stale saves, and unsafe endpoints', async t => {
  const { store } = await fixture(t); const before = await store.snapshot();
  const legacy = defaultSettings(); delete legacy.cards;
  assert.equal(settingsVersion(legacy), createHash('sha256').update(JSON.stringify(legacy)).digest('hex'));
  await assert.rejects(store.saveSettings({ ...legacy, cards: { enabled: true, templateId: 'test.schema' } }, before.settingsRevision), /启用互动卡片/);
  for (const patch of [{ secret: 'never-save' }, { repository: 'evil/repo' }, { worker: { enabled: true, isolated: false, endpoint: 'http://remote.invalid' } }]) await assert.rejects(store.saveSettings({ ...defaultSettings(), ...patch }, before.settingsRevision));
  const next = await store.saveSettings(manual(), before.settingsRevision);
  assert.equal(next.settingsHistory.length, 1); assert.equal(next.settingsHistory[0].version, before.settingsRevision);
  await assert.rejects(store.saveSettings(defaultSettings(), before.settingsRevision), { status: 409 });
  await assert.rejects(store.saveSettings(defaultSettings()), { status: 428 });
});

test('authorized queue atomically reserves slots; policy changes block stale grants', async t => {
  const { store } = await fixture(t); let state = await store.snapshot();
  await store.saveSettings(manual(), state.settingsRevision);
  const first = await store.ingest(request()), second = await store.ingest(request('event-2'));
  state = await store.action(first.ticketId, 'queue', second.revision);
  state = await store.action(second.ticketId, 'queue', state.revision);
  const claims = await Promise.all([store.claim('one'), store.claim('two')]); assert.equal(claims.filter(Boolean).length, 1);
  const claim = claims.find(Boolean); await store.report(claim.ticket.id, claim.assignmentId, { status: 'waiting_answer', summary: '需要确定文案', question: '目标文案是什么？' });
  state = await store.snapshot(); assert.equal(state.tickets.find(x => x.id === claim.ticket.id).status, 'waiting_answer');
  await store.saveSettings({ ...state.settings, prompts: { ...state.settings.prompts, worker: '新增范围限制' } }, state.settingsRevision);
  assert.equal(await store.claim('three'), null);
  assert.equal((await store.snapshot()).tickets.find(x => x.id !== claim.ticket.id).status, 'blocked');
});

test('DingTalk authorization is enforced at intake and before delivery without storing webhook', async t => {
  const { dir, store } = await fixture(t); let state = await store.snapshot();
  const settings = { ...defaultSettings(), source: { enabled: true, corpId: 'corp', clientId: 'robot', allowedUserIds: ['owner'], allowedConversationIds: ['cid$abc=123'] } };
  await store.saveSettings(settings, state.settingsRevision);
  const origin = message({ sessionWebhook: 'secret-route', clientSecret: 'private-key' });
  const input = { source: 'dingtalk', eventId: origin.eventId, text: origin.text, conversationId: origin.conversationId, senderId: origin.senderId, origin };
  await assert.rejects(store.ingest({ ...input, senderId: 'spoofed' }), { status: 403 });
  state = await store.ingest(input);
  const raw = await readFile(join(dir, 'dingtalk-superagent/workflow.json'), 'utf8'); assert.doesNotMatch(raw, /secret-route|private-key|sessionWebhook/);
  await store.saveSettings({ ...settings, source: { ...settings.source, allowedConversationIds: [] } }, state.settingsRevision);
  assert.equal(await store.claimOutbound('host'), null); assert.equal((await store.snapshot()).outbox[0].status, 'withdrawn');
});

test('model decisions are auditable advice, cannot grant execution or override stale scope', async t => {
  const { store } = await fixture(t); const state = await store.ingest(request()), id = state.ticketId;
  await store.decision(id, { action: 'accept', reason: '需求明确', matchedRules: [] }, state.settingsRevision, 1);
  let next = await store.snapshot(); assert.equal(next.decisions[0].outcome, 'would_accept'); assert.equal(next.tickets[0].mandate.allowed.execute, false); assert.equal(next.tickets[0].status, 'observed');
  await store.ingest(request('new', { ticketId: id, text: '补充信息' }));
  await assert.rejects(store.decision(id, { action: 'stop', reason: '旧判断', matchedRules: [] }, state.settingsRevision, 1), { status: 409 });
});

test('outbox serialization and crash recovery retain uncertain deliveries without retry', async t => {
  const { store } = await fixture(t); let state = await store.snapshot();
  await store.saveSettings({ ...defaultSettings(), source: { enabled: true, corpId: 'corp', clientId: 'robot', allowedUserIds: ['owner'], allowedConversationIds: ['cid$abc=123'] } }, state.settingsRevision);
  const origin = message(); state = await store.ingest({ source: 'dingtalk', eventId: origin.eventId, text: origin.text, senderId: origin.senderId, conversationId: origin.conversationId, origin });
  await store.action(state.ticketId, 'complete', state.revision);
  const claims = await Promise.all([store.claimOutbound('a'), store.claimOutbound('b')]); assert.equal(claims.filter(Boolean).length, 1);
  await store.recover(() => false);
  const uncertain = await store.snapshot(), deliveryId = claims.find(Boolean).id;
  assert.equal(uncertain.outbox.find(m => m.id === deliveryId).status, 'uncertain'); assert.equal(await store.claimOutbound('c'), null);
  await assert.rejects(store.reconcileOutbound(deliveryId, 'retry', uncertain.revision), { status: 409 });
  await store.reconcileOutbound(deliveryId, 'sent', uncertain.revision);
  assert.ok(await store.claimOutbound('c'));
});

test('unread followups hold GitHub delivery for a new authorization', async t => {
  const { dir } = await fixture(t); let release;
  const worker = { health: async () => ({ ready: true }), execute: async () => new Promise(resolve => { release = resolve; }), stop: async () => ({ stopped: true }) };
  const service = new WorkflowService(dir, { executorFactory: () => worker, streamFactory: () => ({ start: async () => ({ state: 'disabled' }), stop: async () => {}, send: async () => {} }), deliveryFactory: () => ({ publishChanges: async () => ({ prUrl: 'https://github.com/qq773901406-cmd/douyin-ops/pull/12' }) }) });
  t.after(() => service.stop()); let state = await service.snapshot();
  await service.saveSettings({ ...manual(), github: { enabled: true, baseBranch: 'main' } }, state.settingsRevision);
  state = await service.request({ text: '修正文案', idempotencyKey: 'req-1' }); const id = state.tickets[0].id;
  state = await service.action(id, 'queue', state.revision);
  const claim = await service.store.claim('test'); await service.run(claim);
  state = await service.request({ text: '保留原布局', ticketId: id, idempotencyKey: 'req-2' });
  release({ status: 'ready', summary: '修改及测试完成', changes: [{ path: 'public/app.js', content: '// changed' }], baseCommit: 'a'.repeat(40) });
  await service.active.get(id).done;
  state = await service.snapshot(); assert.equal(state.tickets[0].status, 'observed'); assert.equal(state.tickets[0].prUrl, undefined); assert.equal(state.tickets[0].reports.length, 1);
  assert.match(state.tickets[0].reports[0].summary, /补充信息待处理/);
});

test('queued SDK input requires a matching consumed receipt before publishing the current assignment', async t => {
  const { dir } = await fixture(t);
  const finish = Promise.withResolvers(), forwarded = Promise.withResolvers();
  let steers = 0, publishes = 0;
  const worker = {
    health: async () => ({ ready: true, steering: true }),
    execute: () => finish.promise,
    steer: async ({ ticketId, assignmentId, inputId }) => {
      steers++; forwarded.resolve(inputId); return { ticketId, assignmentId, inputId, status: 'queued' };
    },
  };
  const service = new WorkflowService(dir, { executorFactory: () => worker,
    deliveryFactory: ({ beforeWrite }) => ({ publishChanges: async () => {
      await beforeWrite(); publishes++; return { prUrl: 'https://github.com/qq773901406-cmd/douyin-ops/pull/12' };
    } }) });
  let state = await service.snapshot();
  await service.saveSettings({ ...manual(), github: { enabled: true, baseBranch: 'main' } }, state.settingsRevision);
  t.after(() => service.stop());
  state = await service.request({ text: '修复任务标题', idempotencyKey: 'initial' });
  const ticketId = state.tickets[0].id;
  await service.action(ticketId, 'queue', state.revision);
  const claim = await service.store.claim('owner'); await service.run(claim);
  const entry = service.active.get(ticketId);
  const followup = { text: '标题保留原有符号', ticketId, idempotencyKey: 'followup' };
  await service.request(followup); const inputId = await forwarded.promise; await entry.pumping;
  await service.request(followup);
  assert.equal(steers, 1);
  assert.equal((await service.snapshot()).tickets[0].inputs[1].steering.status, 'queued');
  await assert.rejects(service.store.assertDelivery(ticketId, claim.assignmentId, claim.ticket.mandate.policyVersion), /补充信息/);
  finish.resolve({ status: 'ready', summary: '已根据补充验证', deliveredInputIds: [inputId], changes: [{ path: 'public/app.js', content: '// changed' }], baseCommit: 'a'.repeat(40) });
  await entry.done;
  const [ticket] = (await service.snapshot()).tickets;
  assert.equal(publishes, 1); assert.equal(ticket.status, 'awaiting_review');
  assert.equal(ticket.inputs[1].steering.status, 'delivered'); assert.match(ticket.prUrl, /pull\/12$/);
});

test('configuration revocation aborts active execution and denies every later delivery', async t => {
  const { dir } = await fixture(t); let release, signal, stopped = 0;
  const worker = { health: async () => ({ ready: true }), execute: async options => { signal = options.signal; return new Promise(resolve => { release = resolve; }); }, stop: async () => { stopped++; } };
  const service = new WorkflowService(dir, { executorFactory: () => worker, streamFactory: () => ({ start: async () => ({ state: 'disabled' }), stop: async () => {} }) });
  t.after(() => service.stop()); let state = await service.snapshot();
  await service.saveSettings({ ...manual(), github: { enabled: true, baseBranch: 'main' } }, state.settingsRevision);
  state = await service.request({ text: '只改标题', idempotencyKey: 'revoke' }); const id = state.tickets[0].id;
  await service.action(id, 'queue', state.revision); const claim = await service.store.claim('owner'); await service.run(claim);
  state = await service.snapshot(); const done = service.active.get(id).done;
  await service.saveSettings({ ...state.settings, mode: 'observe' }, state.settingsRevision);
  assert.equal(signal.aborted, true); assert.equal(stopped, 1);
  await assert.rejects(service.store.assertDelivery(id, claim.assignmentId, claim.ticket.mandate.policyVersion), { status: 409 });
  release({ status: 'blocked', summary: '已停止' }); await done;
  assert.equal((await service.snapshot()).tickets[0].status, 'blocked');
});

test('Stream clicks use live Worker readiness, survive replay, and stop the original active assignment', async t => {
  const { dir } = await fixture(t);
  let callbacks, online = false, stopped;
  const finish = Promise.withResolvers();
  const executor = {
    health: async () => ({ ready: online }),
    execute: () => finish.promise,
    stop: async identity => { stopped = identity; finish.resolve({ status: 'blocked', summary: '已停止' }); },
  };
  const service = new WorkflowService(dir, { executorFactory: () => executor, streamFactory: options => {
    callbacks = options; return { start: async () => ({ state: 'connected' }), stop: async () => {} };
  } });
  const source = { enabled: true, corpId: 'corp', clientId: 'robot', allowedUserIds: ['owner'], allowedConversationIds: ['cid$abc=123'] };
  await service.saveSettings({ ...manual(), source, cards: { enabled: true, templateId: 'example.schema' } }, (await service.snapshot()).settingsRevision);
  t.after(() => service.stop());
  assert.equal((await callbacks.onMessage(message())).accepted, true);
  const store = service.store;
  const ack = await store.claimOutbound('test');
  await store.finishOutbound(ack.id, { ok: true });
  const row = await store.claimOutbound('test');
  await store.finishOutbound(row.id, { ok: true });
  const event = { eventId: 'first-click', outTrackId: row.card.outTrackId, action: 'approve', senderId: 'owner',
    corpId: 'corp', robotCode: 'robot', spaceType: 'IM_GROUP', spaceId: 'cid$abc=123' };
  assert.deepEqual(await callbacks.onCardAction(event), { accepted: false, reason: 'worker_unavailable' });
  online = true;
  assert.equal((await callbacks.onCardAction(event)).accepted, false);
  const approved = await callbacks.onCardAction({ ...event, eventId: 'second-click' });
  assert.equal(approved.accepted, true);
  const claim = await store.claim('test'); await service.run(claim);
  const done = service.active.get(approved.ticketId).done;
  assert.equal((await callbacks.onCardAction({ ...event, eventId: 'third-click', action: 'stop' })).accepted, true);
  await done;
  assert.deepEqual(stopped, { ticketId: approved.ticketId, assignmentId: claim.assignmentId });
  assert.equal((await store.snapshot()).tickets[0].status, 'cancelled');
});

test('shutdown drains an in-flight queue claim before it can start a Worker', async t => {
  const { dir } = await fixture(t);
  let launches = 0;
  const service = new WorkflowService(dir, { executorFactory: () => ({
    health: async () => ({ ready: true }),
    execute: async () => { launches++; return { status: 'ready', summary: 'done' }; },
  }) });
  await service.saveSettings(manual(), (await service.snapshot()).settingsRevision);
  const created = await service.request({ text: '只检查标题', idempotencyKey: 'close' });
  await service.action(created.tickets[0].id, 'queue', created.revision);
  const claim = service.store.claim.bind(service.store);
  const claimed = Promise.withResolvers(), release = Promise.withResolvers();
  service.store.claim = async owner => {
    const result = await claim(owner); claimed.resolve(); await release.promise; return result;
  };
  service.running = true;
  const tick = service.tick(); await claimed.promise;
  const stopping = service.stop(); release.resolve();
  await Promise.all([tick, stopping]);
  assert.equal(launches, 0); assert.equal((await service.snapshot()).tickets[0].status, 'blocked');
});
