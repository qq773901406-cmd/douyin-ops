import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TicketStore, MAX_TICKETS } from '../integrations/dingtalk-superagent/ticket-store.mjs';
import { normalizeConfig, authorizeMessage, REPOSITORY, MAX_MESSAGE_LENGTH } from '../integrations/dingtalk-superagent/policy.mjs';

const scratch = resolve(fileURLToPath(new URL('../.codex_tmp/', import.meta.url)));
const config = normalizeConfig({ enabled: true, corpId: 'corp-1', clientId: 'robot-1', allowedUserIds: ['owner'], allowedConversationIds: ['group-1'] });
const message = { eventId: 'msg-1', corpId: 'corp-1', conversationId: 'dm-1', conversationType: '1', senderId: 'owner', robotCode: 'robot-1', text: '检查开发需求', isInAtList: false };
const hash = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'dingtalk-ticket-'));
  t.after(async () => { const target = resolve(directory); assert.ok(target.startsWith(scratch + sep)); await rm(target, { recursive: true, force: true }); });
  return { directory, store: new TicketStore(directory), path: join(directory, 'dingtalk-superagent', 'tickets.json') };
}

test('DingTalk policy defaults closed and rejects execution or different repositories', () => {
  assert.deepEqual(normalizeConfig(), { mode: 'observe', enabled: false, corpId: '', clientId: '', allowedUserIds: [], allowedConversationIds: [], repository: REPOSITORY });
  assert.deepEqual(authorizeMessage(message, {}), { allowed: false, reason: 'source_disabled' });
  for (const input of [{ mode: 'execute' }, { autoMerge: true }, { execute: false }, { repository: 'other/repo' }, { enabled: 'true' }, { enabled: true }, { corpId: ' ' }, { allowedUserIds: [null] }, { allowedUserIds: Array(257).fill('owner') }]) assert.throws(() => normalizeConfig(input), { status: 400 });
  assert.deepEqual(normalizeConfig({ allowedUserIds: ['owner', 'owner'] }).allowedUserIds, ['owner']);
});

test('DingTalk authorization scopes every message to corporate robot and allowed users', () => {
  assert.deepEqual(authorizeMessage(message, config), { allowed: true, reason: 'observe_only' });
  for (const [patch, reason] of [
    [{ corpId: 'other' }, 'corp_not_allowed'], [{ senderCorpId: 'other' }, 'corp_not_allowed'],
    [{ robotCode: 'other' }, 'robot_not_allowed'], [{ senderId: 'other' }, 'user_not_allowed'],
    [{ senderId: '' }, 'invalid_message'], [{ conversationType: 1 }, 'invalid_message'],
    [{ text: '' }, 'invalid_message'], [{ text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }, 'invalid_message'],
    [{ eventId: 'bad\nID' }, 'invalid_message'], [{ isInAtList: 'true' }, 'invalid_message'],
  ]) assert.deepEqual(authorizeMessage({ ...message, ...patch }, config), { allowed: false, reason });
});

test('DingTalk group intake requires allowed user AND allowed group AND explicit robot mention', () => {
  const group = { ...message, conversationType: '2', conversationId: 'group-1', isInAtList: true };
  assert.equal(authorizeMessage(group, config).allowed, true);
  assert.equal(authorizeMessage({ ...group, senderId: 'stranger' }, config).reason, 'user_not_allowed');
  assert.equal(authorizeMessage({ ...group, conversationId: 'group-2' }, config).reason, 'conversation_not_allowed');
  assert.equal(authorizeMessage({ ...group, isInAtList: false }, config).reason, 'robot_not_mentioned');
  assert.equal(authorizeMessage(group, { ...config, allowedConversationIds: [] }).reason, 'conversation_not_allowed');
});

test('DingTalk rejected intake leaves no message or state file behind', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.ingest({ ...message, senderId: 'stranger', text: 'rejected sensitive text' }, config), { accepted: false, duplicate: false, reason: 'user_not_allowed' });
  assert.deepEqual((await f.store.snapshot()).tickets, []);
  await assert.rejects(access(f.path), { code: 'ENOENT' });
});

test('DingTalk Ticket persists only selected message fields, never payload credentials', async t => {
  const f = await fixture(t);
  const result = await f.store.ingest({ ...message, text: '  记录任务  ', sessionWebhook: 'https://secret-url.invalid/?token=do-not-store', appSecret: 'do-not-store', raw: { sensitive: 'do-not-store' }, senderNickname: 'do-not-store', executionAllowed: true, mode: 'execute', repository: 'attacker/repo' }, config);
  assert.equal(result.accepted, true); assert.equal(result.duplicate, false);
  assert.equal(result.ticket.status, 'observed'); assert.equal(result.ticket.executionAllowed, false);
  assert.equal(result.ticket.mode, 'observe'); assert.equal(result.ticket.repository, REPOSITORY);
  assert.deepEqual(result.ticket.messages, [{ ...message, text: '记录任务' }]);
  const raw = await readFile(f.path, 'utf8');
  assert.doesNotMatch(raw, /do-not-store|sessionWebhook|appSecret|senderNickname|attacker/);
  const snapshot = await f.store.snapshot();
  assert.deepEqual(snapshot.stats, { total: 1, observed: 1, cancelled: 0, capacity: MAX_TICKETS });
  result.ticket.messages[0].text = 'caller mutation';
  assert.equal((await f.store.snapshot()).tickets[0].messages[0].text, '记录任务');
});

test('DingTalk concurrent intake across stores atomically deduplicates and survives restart', async t => {
  const f = await fixture(t), other = new TicketStore(f.directory);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? other : f.store).ingest(message, config)));
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  assert.equal(new Set(results.map(result => result.ticket.id)).size, 1);
  const before = await readFile(f.path, 'utf8');
  const replay = await new TicketStore(f.directory).ingest({ ...message, text: 'retry carrying changed text' }, config);
  assert.equal(replay.duplicate, true); assert.equal(replay.ticket.messages[0].text, message.text);
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal((await f.store.snapshot()).tickets.length, 1);
});

test('DingTalk new messages share conversation mapping but corporate namespaces stay separate', async t => {
  const f = await fixture(t);
  const first = await f.store.ingest(message, config);
  const second = await f.store.ingest({ ...message, eventId: 'msg-2' }, config);
  assert.notEqual(first.ticket.id, second.ticket.id);
  assert.equal(first.ticket.conversationKey, second.ticket.conversationKey);
  const otherCorp = await f.store.ingest({ ...message, corpId: 'corp-2' }, { ...config, corpId: 'corp-2' });
  const otherRobot = await f.store.ingest({ ...message, robotCode: 'robot-2' }, { ...config, clientId: 'robot-2' });
  assert.equal(otherCorp.duplicate, false); assert.equal(otherRobot.duplicate, false);
  assert.notEqual(otherCorp.ticket.conversationKey, first.ticket.conversationKey);
  assert.notEqual(otherRobot.ticket.conversationKey, first.ticket.conversationKey);
  assert.equal((await f.store.snapshot()).tickets.length, 4);
});

test('DingTalk policy is rechecked on replay and revoked senders cannot retrieve prior tickets', async t => {
  const f = await fixture(t);
  await f.store.ingest(message, config);
  const result = await f.store.ingest(message, { ...config, allowedUserIds: ['new-owner'] });
  assert.deepEqual(result, { accepted: false, duplicate: false, reason: 'user_not_allowed' });
});

test('DingTalk cancel requires current revision and cannot enable execution or replay a cancelled ticket', async t => {
  const f = await fixture(t);
  const first = await f.store.ingest(message, config), id = first.ticket.id;
  await assert.rejects(f.store.cancel(id), { status: 428 });
  const next = await f.store.ingest({ ...message, eventId: 'msg-2' }, config);
  await assert.rejects(f.store.cancel(id, first.revision), { status: 409 });
  const cancelled = await f.store.cancel(id, next.revision);
  assert.equal(cancelled.tickets.find(ticket => ticket.id === id).status, 'cancelled');
  assert.deepEqual(cancelled.stats, { total: 2, observed: 1, cancelled: 1, capacity: MAX_TICKETS });
  await assert.rejects(f.store.cancel(id, cancelled.revision), { status: 409 });
  const replay = await f.store.ingest(message, config);
  assert.equal(replay.duplicate, true); assert.equal(replay.ticket.status, 'cancelled');
  assert.equal(replay.ticket.executionAllowed, false);
  assert.equal(typeof f.store.run, 'undefined'); assert.equal(typeof f.store.execute, 'undefined');
});

test('DingTalk corrupt state is preserved without replacement from fallback', async t => {
  const f = await fixture(t);
  await f.store.ingest(message, config);
  const broken = '{broken-json';
  await writeFile(f.path, broken);
  await assert.rejects(f.store.snapshot(), { status: 500 });
  await assert.rejects(f.store.ingest({ ...message, eventId: 'msg-2' }, config), { status: 500 });
  assert.equal(await readFile(f.path, 'utf8'), broken);
  await assert.rejects(access(f.path + '.lock'), { code: 'ENOENT' });
});

test('DingTalk invalid persisted execution flags or duplicate event indexes fail closed', async t => {
  const f = await fixture(t);
  await f.store.ingest(message, config);
  const valid = JSON.parse(await readFile(f.path, 'utf8'));
  for (const mutate of [
    state => { state.tickets[0].executionAllowed = true; },
    state => { state.tickets[0].messages[0].sessionWebhook = 'sensitive'; },
    state => { state.tickets.push({ ...state.tickets[0], id: randomUUID() }); },
    state => { state.tickets[0].eventKey = 'corrupted'; },
  ]) {
    const state = structuredClone(valid); mutate(state);
    const raw = JSON.stringify(state); await writeFile(f.path, raw);
    await assert.rejects(f.store.snapshot(), { status: 500 });
    await assert.rejects(f.store.ingest({ ...message, eventId: 'next' }, config), { status: 500 });
    assert.equal(await readFile(f.path, 'utf8'), raw);
  }
});

test('DingTalk capacity pauses new intake while retaining deduplication for old messages', async t => {
  const f = await fixture(t);
  const { ticket } = await f.store.ingest(message, config);
  const state = { version: 1, tickets: Array.from({ length: MAX_TICKETS }, (_, index) => {
    const entry = structuredClone(ticket), msg = { ...message, eventId: `full-${index}` };
    entry.id = randomUUID(); entry.messages = [msg]; entry.eventKey = hash([msg.corpId, msg.robotCode, msg.eventId]);
    return entry;
  }) };
  await writeFile(f.path, JSON.stringify(state, null, 2));
  const before = await readFile(f.path, 'utf8');
  await assert.rejects(f.store.ingest(message, config), { status: 507 });
  assert.equal(await readFile(f.path, 'utf8'), before);
  const duplicate = await f.store.ingest({ ...message, eventId: 'full-0' }, config);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await f.store.snapshot()).tickets.length, MAX_TICKETS);
});
