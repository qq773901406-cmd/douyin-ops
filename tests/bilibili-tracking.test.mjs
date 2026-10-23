import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BilibiliTracking, bilibiliWorkURL, parseBilibiliMetrics, observationFromBilibiliDOM } from '../server/bilibili-tracking.mjs';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';

const target = { jobId: 'existing-job', title: '已提交的测试作品', account: { uid: '12345', name: '测试账号' }, bvid: 'BV1234567890', url: 'https://www.bilibili.com/video/BV1234567890/' };
const page = () => ({ url: target.url, titles: [target.title], authors: [{ uid: '12345', name: '测试账号' }], videoVisible: true, metrics: { plays: '1,234', likes: '5', shares: '1.2万' }, cards: [] });

test('exact official BV URLs and unrounded visible metric values only', () => {
  assert.equal(bilibiliWorkURL(target.url).bvid, target.bvid);
  for (const url of ['https://www.bilibili.com.evil.test/video/BV1234567890/', 'http://www.bilibili.com/video/BV1234567890/', 'https://user:pass@www.bilibili.com/video/BV1234567890/']) assert.equal(bilibiliWorkURL(url), null);
  assert.deepEqual(parseBilibiliMetrics({ plays: '1,234', likes: '0', shares: '1.2万', coins: '点赞', saves: '-1' }), { plays: 1234, likes: 0 });
});

test('public confirmation requires matching title, owner and visible video; missing values do not become zeros', () => {
  const observation = observationFromBilibiliDOM(page(), target);
  assert.equal(observation.reviewState, 'published'); assert.deepEqual(observation.metrics, { plays: 1234, likes: 5 });
  for (const override of [{ authors: [{ uid: 'other' }] }, { titles: ['another video'] }, { videoVisible: false }, { needsHuman: true }, { unavailable: true }]) assert.throws(() => observationFromBilibiliDOM({ ...page(), ...override }, target), e => e.code === 'requires_action');
});

test('manage cards require exact BV identity and unambiguous review status', () => {
  const manage = { url: 'https://member.bilibili.com/platform/upload-manager/article', cards: [{ link: target.url, text: `${target.title}\n审核中` }] };
  assert.equal(observationFromBilibiliDOM(manage, target).reviewState, 'pending');
  assert.throws(() => observationFromBilibiliDOM({ ...manage, cards: [{ link: target.url, text: `${target.title} 审核中 已发布` }] }, target), /不明确/);
  assert.throws(() => observationFromBilibiliDOM({ ...manage, cards: [{ link: 'https://evil.test/?bvid=BV1234567890', text: `${target.title} 已发布` }] }, target), /唯一匹配/);
});

async function fixture({ needsHuman = false, projectionFail = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'doufeng-bili-test-'));
  const workspace = new JsonStore(join(dir, 'workspace.json'), normalizeState(), normalizeState);
  const original = JSON.stringify([{ id: target.jobId, title: target.title, account: target.account, status: 'submitted', receipt: { url: target.url, evidence: 'original-evidence' } }]);
  const calls = [], ids = [];
  const workflow = { list: async () => JSON.parse(original) };
  const run = async args => {
    calls.push(args); let value = { ok: true };
    if (args[0] === 'browsers') { const id = `fresh-browser-${ids.length}`; ids.push(id); value = [{ instance_id: id }]; }
    if (args[0] === 'session' && args[1] === 'start') value = { session_id: `own-session-${ids.length}`, browser_instance_id: ids.at(-1) };
    if (args.includes('--claim')) value = { state: 'active', session: { session_id: `own-session-${ids.length}` } };
    if (args[0] === 'evaluate') value = { value: { ...page(), needsHuman } };
    return { ok: true, stdout: JSON.stringify(value) };
  };
  const service = new BilibiliTracking(dir, { workspace: projectionFail ? { update: async () => { throw new Error('projection unavailable'); } } : workspace, workflow, run, clock: () => '2026-10-23T07:00:00.000Z' });
  return { service, workspace, workflow, calls, original, dir };
}

test('fresh browser/session IDs each time, only read operations, idempotent daily projection, original receipt immutable', async () => {
  const f = await fixture();
  await f.service.checkNow(target.jobId);
  await f.service.checkNow(target.jobId);
  assert.equal(f.calls.filter(c => c[0] === 'browsers').length, 2);
  assert.deepEqual(f.calls.filter(c => c[0] === 'session' && c[1] === 'stop').map(c => c[2]), ['own-session-1', 'own-session-2']);
  assert.ok(f.calls.every(c => ['browsers', 'session', 'navigate', 'evaluate'].includes(c[0])));
  assert.equal(JSON.stringify(await f.workflow.list()), f.original);
  const state = (await f.workspace.read()).value;
  assert.equal(state.metrics.length, 1); assert.equal(state.records.length, 1); assert.equal(state.metrics[0].plays, 1234);
  const tracked = (await f.service.snapshot()).records[0];
  assert.equal(tracked.sequence, 2); assert.equal(tracked.projectedSequence, 2);
});

test('login requests action and cleans its session without recording published', async () => {
  const f = await fixture({ needsHuman: true });
  await assert.rejects(f.service.checkNow(target.jobId), e => e.code === 'requires_action');
  assert.equal((await f.service.store.read()).value.records.length, 0);
  assert.ok(f.calls.some(c => c[0] === 'session' && c[1] === 'stop'));
});

test('projection failure retains observation and replay updates the same metric instead of dropping evidence', async () => {
  const f = await fixture({ projectionFail: true });
  await assert.rejects(f.service.checkNow(target.jobId), /projection unavailable/);
  let record = (await f.service.store.read()).value.records[0];
  assert.equal(record.sequence, 1); assert.equal(record.projectedSequence, 0);
  assert.match(record.projectionError, /projection unavailable/);
  f.service.workspace = f.workspace; await f.service.project(record); await f.service.project(record);
  assert.equal((await f.workspace.read()).value.metrics.length, 1);
  record = (await f.service.store.read()).value.records[0]; assert.equal(record.projectedSequence, 1);
  assert.ok((await readFile(f.service.store.path, 'utf8')).includes('visible-dom'));
});

test('only submitted/published ledger jobs with exact BV links can become tracking targets', async () => {
  const f = await fixture(); f.service.workflow = { list: async () => [{ id: 'unknown', status: 'uncertain', receipt: { url: target.url } }, { id: 'draft', status: 'prepared', receipt: { url: target.url } }] };
  await assert.rejects(f.service.checkNow(), /没有带 BV/); assert.equal(f.calls.length, 0);
});
