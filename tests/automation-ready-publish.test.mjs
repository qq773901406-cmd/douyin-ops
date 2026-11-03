import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutomationService } from '../server/automation-service.mjs';
import { defaultAutomation, normalizeAutomation, nextReadySlot, nextSlot, shanghaiDay } from '../shared/automation-model.mjs';

const scratch = fileURLToPath(new URL('../.codex_tmp/', import.meta.url));
const fixedNow = Date.parse('2026-10-29T10:12:10+08:00');

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const runtime = await mkdtemp(join(scratch, 'ready-publication-'));
  const inbox = join(runtime, 'inbox');
  await mkdir(inbox);
  const asset = join(runtime, 'original.mp4');
  await writeFile(asset, 'isolated video fixture bytes');
  const service = new AutomationService(runtime);
  service.publisher = { publish: async () => assert.fail('No real browser publication in a fixture') };
  const initial = defaultAutomation();
  Object.assign(initial.config, { folder: inbox, dailyTime: '06:00', accountId: 'fixture-account', browserId: 'fixture-browser', verifiedAt: new Date().toISOString() });
  await service.store.replace(initial);
  t.after(async () => {
    service.stop();
    assert.ok(resolve(runtime).startsWith(resolve(scratch) + sep));
    await rm(runtime, { recursive: true, force: true });
  });
  const importAI = async () => service.importDraft({ draftId: 'fixture-draft', asset, title: '双猫小剧场', caption: 'AI 生成的萌宠故事', aiGenerated: true, contentDeclaration: 'ai-generated' }, (await service.snapshot()).revision);
  const approve = async (id, overrides = {}) => {
    const state = await service.snapshot(), item = state.items.find(row => row.id === id);
    await service.approve(id, { reviewed: true, accountId: state.config.accountId, title: item.title, caption: item.caption, scheduleMode: 'when-ready', scheduledAt: state.readySuggestedAt, ...overrides }, state.revision);
    return (await service.snapshot()).items.find(row => row.id === id);
  };
  return { runtime, service, asset, importAI, approve };
}

test('when-ready uses a stable safe minute, with one reserved day per publication', () => {
  assert.equal(nextReadySlot([], '06:00', fixedNow), '2026-10-29T02:15:00.000Z');
  assert.equal(nextReadySlot([], '06:00', fixedNow + 20000), nextReadySlot([], '06:00', fixedNow));
  assert.equal(nextSlot([], '06:00', fixedNow), '2026-10-29T22:00:00.000Z', 'legacy approval still waits for configured daily time');
  for (const status of ['approved', 'running', 'submitted', 'published', 'uncertain']) {
    const rows = [{ status, scheduledAt: '2026-10-29T01:00:00Z' }];
    assert.equal(nextReadySlot(rows, '06:00', fixedNow), '2026-10-29T22:00:00.000Z', status);
  }
  const rows = ['2026-10-29', '2026-10-30'].map(day => ({ status: 'submitted', scheduledAt: `${day}T06:00:00+08:00` }));
  assert.equal(nextReadySlot(rows, '06:00', fixedNow), '2026-10-30T22:00:00.000Z');
  const midnight = Date.parse('2026-10-29T23:59:30+08:00');
  assert.equal(nextReadySlot([], '06:00', midnight), '2026-10-29T16:02:00.000Z');
});

test('AI declaration survives draft import and ordinary edit, and cannot be downgraded at edit or approval', async t => {
  const f = await fixture(t), { id } = await f.importAI();
  let state = await f.service.snapshot();
  assert.deepEqual(state.capabilities, { contentDeclaration: true, whenReadySchedule: true, expectedAssetHash: true });
  assert.equal(state.items[0].contentDeclaration, 'ai-generated');
  await f.service.edit(id, { title: '新标题', caption: '新文案' }, state.revision);
  state = await f.service.snapshot();
  assert.equal(state.items[0].contentDeclaration, 'ai-generated');
  await f.service.edit(id, { title: '新标题', caption: '新文案', contentDeclaration: undefined }, state.revision);
  state = await f.service.snapshot();
  assert.equal(state.items[0].contentDeclaration, 'ai-generated');
  for (const contentDeclaration of ['', null, 'external-source']) {
    await assert.rejects(f.service.edit(id, { title: '新标题', caption: '新文案', contentDeclaration }, state.revision), /AI 视频必须保留/);
    await assert.rejects(f.approve(id, { contentDeclaration }), /AI 视频必须保留/);
  }
  const approved = await f.approve(id);
  assert.equal(approved.contentDeclaration, 'ai-generated');
  assert.equal(approved.approval.contentDeclaration, 'ai-generated');
  assert.equal(approved.scheduleMode, 'when-ready');
  assert.equal(approved.approval.scheduleMode, 'when-ready');
  assert.equal((await readFile(approved.approval.asset, 'utf8')), 'isolated video fixture bytes');
  await assert.rejects(f.approve(id), /不能再次批准/);
});

test('legacy AI-only drafts infer the declaration when omitted or undefined but reject an explicit empty value', async t => {
  const f = await fixture(t);
  for (const contentDeclaration of ['', null]) {
    await assert.rejects(f.service.importDraft({ draftId: 'legacy-ai', asset: f.asset, title: '旧AI视频', caption: '', aiGenerated: true, contentDeclaration }, (await f.service.snapshot()).revision), /AI 视频必须保留/);
  }
  for (const [index, metadata] of [{}, { contentDeclaration: undefined }].entries()) {
    const imported = await f.service.importDraft({ draftId: `legacy-ai-${index}`, asset: f.asset, title: '旧AI视频', caption: '', aiGenerated: true, ...metadata }, (await f.service.snapshot()).revision);
    const item = (await f.service.snapshot()).items.find(row => row.id === imported.id);
    assert.equal(item.contentDeclaration, 'ai-generated');
    assert.equal(item.aiGenerated, true);
  }
});

test('normalization rejects declaration and schedule tampering but accepts legacy rows without either field', async t => {
  const f = await fixture(t), { id } = await f.importAI();
  await f.approve(id);
  const state = (await f.service.store.read()).value;
  for (const mutate of [
    row => { delete row.approval.contentDeclaration; },
    row => { row.approval.contentDeclaration = 'external-source'; },
    row => { delete row.contentDeclaration; },
    row => { row.approval.scheduleMode = 'daily-time'; }
  ]) {
    const changed = structuredClone(state); mutate(changed.items[0]);
    assert.throws(() => normalizeAutomation(changed), /声明|排期方式/);
  }
  const legacy = structuredClone(state), row = legacy.items[0];
  delete row.aiGenerated; delete row.contentDeclaration; delete row.approval.contentDeclaration;
  delete row.scheduleMode; delete row.approval.scheduleMode;
  assert.equal(normalizeAutomation(legacy), legacy);
});

test('approval freezes only the reviewed hash and removes rejected copies without approving the queue item', async t => {
  const f = await fixture(t), { id } = await f.importAI();
  for (const expectedSha256 of ['', null, 123, 'A'.repeat(64), 'a'.repeat(63)]) {
    await assert.rejects(f.approve(id, { expectedSha256 }), { status: 400 });
  }
  const before = await f.service.snapshot();
  await assert.rejects(f.approve(id, { expectedSha256: '0'.repeat(64) }), { status: 409 });
  const rejected = await f.service.snapshot();
  assert.equal(rejected.revision, before.revision);
  assert.equal(rejected.items[0].status, 'pending');
  assert.equal(rejected.items[0].approval, null);
  assert.deepEqual(await readdir(f.service.mediaDir), []);
  const expectedSha256 = createHash('sha256').update(await readFile(f.asset)).digest('hex');
  const approved = await f.approve(id, { expectedSha256 });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approval.sha256, expectedSha256);
  assert.equal((await readdir(f.service.mediaDir)).length, 1);
});

test('when-ready accounts for same-account daily production receipts, without consuming previews or other accounts', async t => {
  const f = await fixture(t), now = Date.now(), today = shanghaiDay(now);
  await mkdir(join(f.runtime, 'daily-production'));
  const path = join(f.runtime, 'daily-production', 'state.json');
  const run = { id: 'daily-fixture', day: today, status: 'submitted', previewOnly: false, binding: { accountId: 'fixture-account' } };
  for (const other of [{ ...run, previewOnly: true }, { ...run, binding: { accountId: 'another-account' } }]) {
    await writeFile(path, JSON.stringify({ version: 1, config: { enabled: false }, runs: [other] }));
    assert.equal(await f.service.readySlot([], (await f.service.snapshot()).config, fixedNow), nextReadySlot([], '06:00', fixedNow));
  }
  const fixedRun = { ...run, day: shanghaiDay(fixedNow) };
  await writeFile(path, JSON.stringify({ version: 1, config: { enabled: false }, runs: [fixedRun] }));
  const config = (await f.service.snapshot()).config;
  assert.equal(await f.service.readySlot([], config, fixedNow), '2026-10-29T22:00:00.000Z');
  await writeFile(path, JSON.stringify({ version: 1, config: { enabled: false }, runs: [run] }));
  const state = await f.service.snapshot();
  assert.notEqual(shanghaiDay(Date.parse(state.readySuggestedAt)), today);
  const { id } = await f.importAI();
  const approved = await f.approve(id);
  assert.notEqual(shanghaiDay(Date.parse(approved.scheduledAt)), today);
});

test('ordinary approval keeps its daily-time behavior and rejects a stale ready proposal', async t => {
  const f = await fixture(t), { id } = await f.importAI();
  const state = await f.service.snapshot();
  await assert.rejects(f.approve(id, { scheduledAt: new Date(Date.parse(state.readySuggestedAt) - 60000).toISOString() }), { status: 409 });
  const approved = await f.approve(id, { scheduleMode: undefined, scheduledAt: state.suggestedAt });
  assert.equal(approved.scheduledAt, state.suggestedAt);
  assert.equal(approved.scheduleMode, 'daily-time');
});

test('formal tick passes the AI declaration to publisher and keeps uncertain submissions protected', async t => {
  const f = await fixture(t), { id } = await f.importAI();
  const approved = await f.approve(id);
  let calls = 0;
  f.service.publisher = { publish: async (item, { guard, beforeSubmit }) => {
    calls++;
    assert.equal(item.approval.contentDeclaration, 'ai-generated');
    assert.equal(item.approval.sha256, approved.approval.sha256);
    await guard(); await beforeSubmit();
    throw new Error('fixture transport interruption after submit intent');
  } };
  await f.service.store.update(state => { state.config.enabled = true; });
  const originalNow = Date.now;
  Date.now = () => Date.parse(approved.scheduledAt) + 1000;
  try { await f.service.tick(); await f.service.tick(); }
  finally { Date.now = originalNow; }
  const saved = (await f.service.store.read()).value;
  assert.equal(calls, 1);
  assert.equal(saved.items[0].status, 'uncertain');
  assert.ok(saved.items[0].submitStartedAt);
  assert.equal(saved.config.enabled, false);
  await assert.rejects(f.approve(id), /不能再次批准/);
});
