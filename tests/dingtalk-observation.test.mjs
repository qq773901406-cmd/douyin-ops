import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { normalizeRobotMessage } from '../integrations/dingtalk-superagent/dingtalk-source.mjs';
import { SuperagentService } from '../integrations/dingtalk-superagent/service.mjs';

const scratch = resolve('.codex_tmp');
async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'dingtalk-observe-'));
  t.after(async () => { assert.ok(resolve(dir).startsWith(scratch + sep)); await rm(dir, { recursive: true, force: true }); });
  return { dir, service: new SuperagentService(dir) };
}
const message = () => ({ msgId: 'event-1', msgtype: 'text', conversationId: 'conv-1', conversationType: '2', senderStaffId: 'owner', senderCorpId: 'corp', chatbotCorpId: 'corp', robotCode: 'robot', text: { content: '请审查文案' }, isInAtList: true });

test('robot adapter strips transport/session credentials and does not trust display identities', () => {
  const raw = { ...message(), senderId: 'not-staff-id', senderNick: '管理员', isAdmin: true, sessionWebhook: 'https://secret.invalid', clientSecret: 'secret' };
  const result = normalizeRobotMessage({ headers: { messageId: 'transport-id' }, data: JSON.stringify(raw) });
  assert.equal(result.eventId, 'event-1'); assert.equal(result.senderId, 'owner');
  assert.doesNotMatch(JSON.stringify(result), /sessionWebhook|clientSecret|secret|管理员|transport-id/);
  for (const patch of [{ senderStaffId: undefined }, { senderCorpId: 'other' }, { conversationType: '3' }, { msgtype: 'picture' }, { text: { content: ' ' } }]) {
    assert.throws(() => normalizeRobotMessage({ data: { ...message(), ...patch } }), /消息格式无效/);
  }
  assert.throws(() => normalizeRobotMessage({ data: '{' }));
  assert.throws(() => normalizeRobotMessage({ data: 'a'.repeat(65537) }));
});

test('local demo is durable, deduplicated, separated from real intake and never executable', async t => {
  const { dir, service } = await fixture(t);
  const empty = await service.snapshot(); assert.equal(empty.connection.state, 'disabled'); assert.deepEqual(empty.tickets, []);
  const first = await service.demo(), second = await service.demo();
  assert.equal(first.tickets.length, 1); assert.equal(second.duplicate, true);
  assert.equal(first.tickets[0].id, second.tickets[0].id);
  assert.equal(first.tickets[0].source, 'local-demo'); assert.equal(first.receipt.sent, false);
  assert.deepEqual(Object.values(first.capabilities), [false, false, false, false, false]);
  assert.equal((await service.store.snapshot()).tickets.length, 0);
  const restarted = new SuperagentService(dir); assert.equal((await restarted.demo()).duplicate, true);
  await assert.rejects(service.cancel(first.tickets[0].id, undefined, true), { status: 428 });
  await assert.rejects(service.cancel(first.tickets[0].id, first.demoRevision, false), { status: 409 });
  const cancelled = await restarted.cancel(first.tickets[0].id, second.demoRevision, true);
  assert.equal(cancelled.tickets[0].status, 'cancelled');
  assert.equal((await service.demo()).tickets[0].status, 'cancelled');
  await assert.rejects(service.cancel(first.tickets[0].id, second.demoRevision, true), { status: 409 });
});

test('invalid config fails closed without disclosing credentials', async t => {
  const { dir, service } = await fixture(t);
  const path = join(dir, 'dingtalk-superagent', 'config.json'); await mkdir(join(dir, 'dingtalk-superagent'), { recursive: true });
  for (const input of ['{"clientSecret":"very-private-secret"}', '{"mode":"execute"}', '{bad-json']) {
    await writeFile(path, input);
    await assert.rejects(service.snapshot(), error => error.status === 503 && !error.message.includes('very-private-secret'));
    assert.equal(await readFile(path, 'utf8'), input);
  }
});
