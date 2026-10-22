import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AutomationService } from '../server/automation-service.mjs';
import { DailyProduction } from '../server/daily-production.mjs';
import { DouyinTracking } from '../server/douyin-tracking.mjs';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';

const workId = '7584000000000000001';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function automaticProposal(target, observation, proofPatch = {}) {
  const content = `${target.title} ${target.caption}`;
  const bindingProof = {
    kind: 'douyin-rendered-dom-v1', targetRef: target.ref, browserId: target.browserId,
    assetSha256: target.sha256, submittedAt: target.submitStartedAt,
    accountId: target.accountId, workId: observation.workId,
    cardTitle: content, cardTime: target.submitStartedAt, previewTitle: content,
    previewUrl: observation.url, profileUrl: `https://www.douyin.com/user/self?modal_id=${observation.workId}`,
    cardMatches: 1, profileMatches: 1, stableSamples: 3, ...proofPatch,
  };
  return { requiresExplicitBinding: true, bindingProof, candidate: {
    ...observation, evidence: { url: observation.url, text: JSON.stringify({ bindingProof }) },
  } };
}

async function fixture(t) {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'doufeng-tracking-'));
  assert.equal(dirname(resolve(directory)), temporaryRoot);
  assert.ok(basename(directory).startsWith('doufeng-tracking-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = new JsonStore(join(directory, 'workspace.json'), normalizeState(), normalizeState);
  const automation = new AutomationService(directory);
  const dailyProduction = new DailyProduction(directory, workspace, automation);
  const id = randomUUID(), draftId = randomUUID(), queueId = randomUUID(), queueDraftId = randomUUID();
  // Yesterday at noon in Shanghai keeps same-day assertions stable at midnight.
  const now = Math.floor(Date.now() / 86400000) * 86400000 - 86400000 + 4 * 3600000;
  const at = offset => new Date(now + offset * 1000).toISOString();
  const binding = { accountId: 'test-account', browserId: 'test-browser' };
  await dailyProduction.store.update(state => {
    state.runs.push({
      id, status: 'submitted', title: '测试资讯', caption: '完整来源', binding, sha256: 'a'.repeat(64),
      submitStartedAt: at(0), draftId, sourceMode: 'news', previewOnly: false
    });
  });
  await automation.store.update(state => {
    state.items.push({
      id: queueId, status: 'submitted', sourceDraftId: queueDraftId, sourcePath: join(directory, 'queue.mp4'),
      fileName: 'queue.mp4', sourceSize: 1, sourceMtime: 1, title: '队列测试', caption: '',
      scheduledAt: at(0), submitStartedAt: at(0),
      approval: { ...binding, sha256: 'b'.repeat(64), asset: join(directory, 'queue.mp4'), title: '队列测试', caption: '', scheduledAt: at(0) }
    });
  });
  await workspace.update(state => {
    state.drafts.push({ id: draftId, sourceProductionId: id, title: '测试资讯', status: '待检查' });
    state.drafts.push({ id: queueDraftId, title: '队列测试', status: '待检查' });
  });
  const options = { workspace, automation, dailyProduction };
  const tracking = new DouyinTracking(directory, options);
  const observation = (patch = {}) => ({
    accountId: binding.accountId, workId, url: `https://www.douyin.com/video/${workId}`,
    reviewState: 'published', observedAt: at(30),
    evidence: { url: 'https://creator.douyin.com/creator-micro/content/manage', text: '测试资讯 已发布 播放 12 点赞 0' },
    metrics: { plays: 12, likes: 0 }, ...patch
  });
  return { directory, workspace, automation, dailyProduction, tracking, options, observation, at, id, draftId, ref: `daily:${id}`, queueRef: `queue:${queueId}` };
}

test('targets uses submission identities and excludes preview, active and unsubmitted records', async t => {
  const f = await fixture(t);
  await f.dailyProduction.store.update(state => {
    const source = state.runs[0];
    state.runs.push({ ...source, id: randomUUID(), previewOnly: true });
    state.runs.push({ ...source, id: randomUUID(), status: 'publishing' });
    state.runs.push({ ...source, id: randomUUID(), submitStartedAt: '' });
  });
  const targets = await f.tracking.targets();
  assert.deepEqual(targets.map(row => row.ref).sort(), [f.ref, f.queueRef].sort());
  assert.equal(targets.find(row => row.ref === f.ref).draftId, f.draftId);
  assert.equal(targets[0].boundWorkId, '');
  await f.tracking.recordObservation(f.ref, f.observation());
  assert.equal((await f.tracking.targets()).find(row => row.ref === f.ref).boundWorkId, workId);
});

test('repeated sampling is idempotent, preserves missing values and zero, and accepts corrected counts', async t => {
  const f = await fixture(t);
  await f.tracking.recordObservation(f.ref, f.observation());
  await f.tracking.projectPending();
  await f.workspace.update(state => { state.metrics[0].reflection = '保留我的复盘'; });
  assert.equal((await f.tracking.recordObservation(f.ref, f.observation())).accepted, false);
  await f.tracking.recordObservation(f.ref, f.observation({ observedAt: f.at(40), metrics: { plays: 9, likes: null, shares: 0 } }));
  await f.tracking.projectPending();
  await f.tracking.projectPending();
  const state = (await f.workspace.read()).value;
  assert.equal(state.metrics.length, 1);
  const metric = state.metrics[0];
  assert.equal(metric.plays, 9);
  assert.equal(metric.likes, 0);
  assert.equal(metric.shares, 0);
  assert.equal(Object.hasOwn(metric, 'completion'), false);
  assert.equal(Object.hasOwn(metric, 'mComments'), false);
  assert.equal(metric.metricObservedAt.likes, f.at(30));
  assert.equal(metric.metricObservedAt.plays, f.at(40));
  assert.equal(metric.reflection, '保留我的复盘');
  assert.equal(metric.draftId, f.draftId);
  assert.equal(state.drafts[0].status, '待检查');
  assert.equal(state.drafts[0].platformReview.state, 'published');
  assert.equal((await f.dailyProduction.store.read()).value.runs[0].status, 'submitted');
  for (const value of ['', '12', Infinity, -1, 1.2]) {
    await assert.rejects(f.tracking.recordObservation(f.ref, f.observation({ observedAt: f.at(50), metrics: { plays: value } })), /指标/);
  }
});

test('ownership rejects wrong accounts, URLs and duplicate daily/queue claims', async t => {
  const f = await fixture(t);
  await assert.rejects(f.tracking.recordObservation(f.ref, f.observation({ accountId: 'other' })), /账号/);
  await assert.rejects(f.tracking.recordObservation(f.ref, f.observation({ workId: Number(workId) })), /编号/);
  for (const url of ['https://www.douyin.com/', 'https://v.douyin.com/abc/', 'https://www.douyin.com/video/999']) {
    await assert.rejects(f.tracking.recordObservation(f.ref, f.observation({ url })), /链接/);
  }
  const second = new DouyinTracking(f.directory, f.options);
  const claims = await Promise.allSettled([f.tracking.recordObservation(f.ref, f.observation()), second.recordObservation(f.queueRef, f.observation())]);
  assert.equal(claims.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(claims.filter(row => row.status === 'rejected').length, 1);
  assert.match(claims.find(row => row.status === 'rejected').reason.message, /归属/);
  assert.equal((await f.tracking.snapshot()).records.length, 1);
});

test('rejected review retains submission protection and empty metrics create no false zero sample', async t => {
  const f = await fixture(t);
  await f.tracking.recordObservation(f.ref, f.observation({ reviewState: 'rejected', metrics: { plays: null } }));
  await f.tracking.projectPending();
  const daily = (await f.dailyProduction.store.read()).value;
  assert.equal(daily.runs[0].status, 'submitted');
  assert.equal(daily.runs[0].platformReview.state, 'rejected');
  assert.equal((await f.workspace.read()).value.metrics.length, 0);
  assert.equal((await f.tracking.snapshot()).records[0].samples.length, 0);
});

test('queue observations use the approved account and source draft without changing the approval', async t => {
  const f = await fixture(t);
  const before = (await f.automation.store.read()).value.items[0];
  await f.tracking.recordObservation(f.queueRef, f.observation({ reviewState: 'pending', metrics: { completion: 12.5 } }));
  assert.equal((await f.tracking.projectPending())[0].applied, true);
  const item = (await f.automation.store.read()).value.items[0];
  assert.deepEqual(item.approval, before.approval);
  assert.equal(item.status, 'submitted');
  assert.equal(item.platformReview.state, 'pending');
  const state = (await f.workspace.read()).value;
  assert.equal(state.metrics[0].draftId, before.sourceDraftId);
  assert.equal(state.metrics[0].mTitle, before.title);
  assert.equal(state.metrics[0].completion, 12.5);
  assert.equal(state.metrics[0].evidence.text, f.observation().evidence.text);
  assert.equal(Object.hasOwn(state.metrics[0], 'plays'), false);
  assert.equal(state.drafts.find(row => row.id === before.sourceDraftId).platformWorkId, workId);
});

test('newer observations win across tracker instances and stale deliveries do not add samples', async t => {
  const f = await fixture(t);
  const second = new DouyinTracking(f.directory, f.options);
  await Promise.all([
    f.tracking.recordObservation(f.ref, f.observation({ observedAt: f.at(30), reviewState: 'pending', metrics: { plays: 1 } })),
    second.recordObservation(f.ref, f.observation({ observedAt: f.at(50), metrics: { plays: 25 } }))
  ]);
  await Promise.all([f.tracking.projectPending(), second.projectPending()]);
  assert.equal((await f.tracking.recordObservation(f.ref, f.observation({ observedAt: f.at(40), metrics: { plays: 99 } }))).accepted, false);
  const metric = (await f.workspace.read()).value.metrics[0];
  assert.equal(metric.plays, 25);
  assert.equal((await f.workspace.read()).value.metrics.length, 1);
  assert.equal((await f.dailyProduction.store.read()).value.runs[0].platformReview.state, 'published');
});

test('a manual result changed during inspection is preserved and the observation remains recoverable', async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  await f.tracking.recordObservation(f.ref, f.observation({ observedAt: f.at(20) }));
  f.tracking.inspect = async target => {
    assert.equal(target.ref, f.ref);
    entered.resolve(); await resume.promise;
    return f.observation();
  };
  const running = f.tracking.checkNow(f.ref);
  await entered.promise;
  await f.dailyProduction.store.update(state => {
    Object.assign(state.runs[0], { status: 'failed', reconciledAt: f.at(35), reconciledResult: 'not-published' });
  });
  resume.resolve();
  const result = await running;
  assert.equal(result.projections[0].applied, false);
  assert.match(result.projections[0].error, /人工核实/);
  assert.equal((await f.dailyProduction.store.read()).value.runs[0].status, 'failed');
  assert.equal((await f.workspace.read()).value.metrics.length, 0);
  const record = (await f.tracking.snapshot()).records[0];
  assert.equal(record.observation.evidence.text, f.observation().evidence.text);
  assert.equal(record.projectedSequence, 0);
  const release = await f.automation.lease();
  await release();
});

test('workspace failure replays after restart without duplicating metrics or changing publish eligibility', async t => {
  const f = await fixture(t);
  await f.tracking.recordObservation(f.ref, f.observation());
  const realWorkspace = f.tracking.workspace;
  f.tracking.workspace = { update: async () => { throw new Error('模拟磁盘写入失败'); } };
  const result = await f.tracking.projectPending();
  assert.equal(result[0].applied, false);
  assert.equal((await f.dailyProduction.store.read()).value.runs[0].status, 'submitted');
  const restarted = new DouyinTracking(f.directory, { ...f.options, workspace: realWorkspace });
  assert.equal((await restarted.projectPending())[0].applied, true);
  await restarted.projectPending();
  const record = (await restarted.snapshot()).records[0];
  assert.equal(record.sequence, record.projectedSequence);
  assert.equal(record.projectionError, '');
  assert.equal((await f.workspace.read()).value.metrics.length, 1);
});

test('acknowledging an older projection leaves a concurrent new observation pending', async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  await f.tracking.recordObservation(f.ref, f.observation());
  const realWorkspace = f.tracking.workspace;
  f.tracking.workspace = { update: async callback => { entered.resolve(); await resume.promise; return realWorkspace.update(callback); } };
  const running = f.tracking.projectPending();
  await entered.promise;
  const second = new DouyinTracking(f.directory, f.options);
  await second.recordObservation(f.ref, f.observation({ observedAt: f.at(50), metrics: { plays: 30 } }));
  resume.resolve();
  await running;
  const pending = (await second.snapshot()).records[0];
  assert.equal(pending.sequence, 2);
  assert.equal(pending.projectedSequence, 0);
  assert.equal((await second.projectPending())[0].applied, true);
  assert.equal((await f.workspace.read()).value.metrics[0].plays, 30);
});

test('projection writes independent evidence fields without overwriting a manual draft status', async t => {
  const f = await fixture(t);
  await f.tracking.recordObservation(f.ref, f.observation());
  const realWorkspace = f.tracking.workspace;
  f.tracking.workspace = {
    update: async callback => {
      await realWorkspace.update(state => { state.drafts[0].status = '人工核实未发布'; state.drafts[0].publishedUrl = ''; });
      return realWorkspace.update(callback);
    }
  };
  await f.tracking.projectPending();
  const draft = (await f.workspace.read()).value.drafts[0];
  assert.equal(draft.status, '人工核实未发布');
  assert.equal(draft.publishedUrl, '');
  assert.equal(draft.platformReview.state, 'published');
});

test('explicit binding remains available when discovery lacks proof for automatic linking', async t => {
  const f = await fixture(t), inspected = [];
  f.tracking.inspect = async target => { inspected.push(target.ref); return f.observation({ observedAt: f.at(50) }); };
  f.tracking.discover = async target => {
    assert.equal(target.ref, f.ref);
    return { requiresExplicitBinding: true, candidate: f.observation() };
  };
  const before = await f.tracking.checkNow(f.ref);
  assert.deepEqual(inspected, []);
  assert.match(before.results[0].error, /身份凭据不足/);
  await assert.rejects(f.tracking.bind(f.ref, 'https://www.douyin.com/video/999'), /未能唯一核实/);
  assert.equal((await f.tracking.snapshot()).records.length, 0);
  const bound = await f.tracking.bind(f.ref, f.observation().url);
  assert.equal(bound.projections[0].applied, true);
  assert.equal((await f.tracking.snapshot()).records[0].binding.source, 'manual');
  await f.tracking.checkNow(f.ref);
  assert.deepEqual(inspected, [f.ref]);
  assert.equal((await f.workspace.read()).value.metrics.length, 1);
  await assert.rejects(f.tracking.bind(f.ref, 'https://www.douyin.com/video/999'), /已经绑定/);
  const release = await f.automation.lease();
  await release();
});

test('automatic checks discover confirmed submissions, project immediately, and resume bound sampling after restart', async t => {
  const f = await fixture(t), discovered = [], inspected = [];
  await f.automation.store.update(state => {
    state.items[0].status = 'published';
    state.items[0].caption = '队列完整文案';
    state.items[0].approval.caption = '队列完整文案';
  });
  const queueWorkId = '7584000000000000002';
  const observe = (target, at = 30) => f.observation({
    workId: target.ref === f.ref ? workId : queueWorkId,
    url: `https://www.douyin.com/video/${target.ref === f.ref ? workId : queueWorkId}`,
    observedAt: f.at(at),
  });
  f.tracking.inspect = async () => { throw new Error('Unbound records must use discovery'); };
  f.tracking.discover = async target => { discovered.push(target.ref); return automaticProposal(target, observe(target)); };
  const first = await f.tracking.checkNow();
  assert.deepEqual(discovered.sort(), [f.ref, f.queueRef].sort());
  assert.ok(first.results.every(row => row.accepted && row.automaticallyBound));
  assert.ok(first.projections.every(row => row.applied));
  const initial = await f.tracking.snapshot();
  assert.ok(initial.records.every(row => row.binding.source === 'automatic' && row.sequence === row.projectedSequence));
  assert.equal((await f.workspace.read()).value.metrics.length, 2);
  assert.equal((await f.dailyProduction.store.read()).value.runs[0].status, 'submitted');
  assert.equal((await f.automation.store.read()).value.items[0].status, 'published');

  const restarted = new DouyinTracking(f.directory, { ...f.options,
    inspect: async target => { inspected.push(target.ref); return observe(target, 50); },
    discover: async () => { throw new Error('Bound records must not be discovered again'); },
  });
  const second = await restarted.checkNow();
  assert.deepEqual(inspected.sort(), [f.ref, f.queueRef].sort());
  assert.ok(second.results.every(row => row.accepted && !row.automaticallyBound));
  const resumed = await restarted.snapshot();
  for (const record of resumed.records) {
    assert.equal(record.sequence, 2);
    assert.equal(record.projectedSequence, 2);
    assert.deepEqual(record.binding, initial.records.find(row => row.target.ref === record.target.ref).binding);
  }
  assert.equal((await f.workspace.read()).value.metrics.length, 2);
});

test('automatic first binding requires complete matching content, account, time, identity and DOM evidence', async t => {
  const f = await fixture(t);
  f.tracking.inspect = async () => { throw new Error('Unexpected inspection'); };
  const malformed = [
    { kind: 'untrusted' }, { accountId: 'other' }, { workId: '999' }, { targetRef: f.queueRef },
    { browserId: 'other-browser' }, { assetSha256: 'c'.repeat(64) }, { submittedAt: f.at(1) },
    { cardTitle: '测试资讯' }, { previewTitle: '测试资讯' }, { cardTime: f.at(-61) },
    { cardTime: f.at(901) }, { cardMatches: 2 }, { profileMatches: 2 }, { stableSamples: 2 },
    { previewUrl: 'https://www.douyin.com/video/999' }, { profileUrl: 'https://www.douyin.com/user/other' },
    { previewUrl: `https://www.douyin.com/video/${workId}?modal_id=999` },
  ];
  for (const patch of malformed) {
    f.tracking.discover = async target => automaticProposal(target, f.observation(), patch);
    const result = await f.tracking.checkNow(f.ref);
    assert.ok(result.results[0].error, JSON.stringify(patch));
    assert.equal((await f.tracking.snapshot()).records.length, 0);
  }
  for (const tamper of [proposal => { delete proposal.bindingProof; }, proposal => { proposal.candidate.evidence.text = '{}'; }]) {
    f.tracking.discover = async target => { const proposal = automaticProposal(target, f.observation()); tamper(proposal); return proposal; };
    assert.ok((await f.tracking.checkNow(f.ref)).results[0].error);
    assert.equal((await f.tracking.snapshot()).records.length, 0);
  }
  assert.equal((await f.workspace.read()).value.metrics.length, 0);
});

test('uncertain, preview and missing submission credentials never enter automatic discovery', async t => {
  const f = await fixture(t), discovered = [];
  await f.dailyProduction.store.update(state => {
    const source = state.runs[0];
    source.status = 'uncertain';
    state.runs.push({ ...source, id: randomUUID(), status: 'submitted', previewOnly: true });
    state.runs.push({ ...source, id: randomUUID(), status: 'submitted', submitStartedAt: '' });
    state.runs.push({ ...source, id: randomUUID(), status: 'submitted', sha256: '' });
  });
  await f.automation.store.update(state => { state.items[0].status = 'uncertain'; });
  f.tracking.inspect = async () => { throw new Error('Unexpected inspection'); };
  f.tracking.discover = async target => { discovered.push(target.ref); return automaticProposal(target, f.observation()); };
  assert.deepEqual((await f.tracking.checkNow()).results, []);
  assert.match((await f.tracking.checkNow(f.ref)).results[0].error, /提交结果不确定/);
  assert.deepEqual(discovered, []);
  assert.equal((await f.tracking.snapshot()).records.length, 0);
  // Explicit recovery remains allowed for an uncertain submission.
  await f.tracking.bind(f.ref, f.observation().url);
  assert.equal((await f.tracking.snapshot()).records[0].binding.source, 'manual');
  assert.equal((await f.dailyProduction.store.read()).value.runs[0].status, 'uncertain');
});

test('automatic binding keeps cross-target duplicate protection and does not accept title-only posts', async t => {
  const f = await fixture(t);
  f.tracking.inspect = async () => { throw new Error('Unexpected inspection'); };
  f.tracking.discover = async target => automaticProposal(target, f.observation());
  const titleOnly = await f.tracking.checkNow(f.queueRef);
  assert.match(titleOnly.results[0].error, /身份凭据不足/);
  assert.equal((await f.tracking.snapshot()).records.length, 0);
  await f.automation.store.update(state => {
    state.items[0].caption = '队列完整文案'; state.items[0].approval.caption = '队列完整文案';
  });
  const result = await f.tracking.checkNow();
  assert.equal(result.results.find(row => row.ref === f.ref).automaticallyBound, true);
  assert.match(result.results.find(row => row.ref === f.queueRef).error, /另一条提交记录/);
  assert.equal((await f.tracking.snapshot()).records.length, 1);
  assert.equal((await f.workspace.read()).value.metrics.length, 1);
});

test('unavailable discovery keeps the target unbound and a changed submission cannot acquire an automatic binding', async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  f.tracking.inspect = async () => { throw new Error('Unexpected inspection'); };
  f.tracking.discover = async () => null;
  const unavailable = await f.tracking.checkNow(f.ref);
  assert.equal(unavailable.results[0].unresolved, true);
  assert.match(unavailable.results[0].error, /尚未自动绑定/);
  assert.equal((await f.tracking.snapshot()).records.length, 0);
  f.tracking.discover = async target => { entered.resolve(); await resume.promise; return automaticProposal(target, f.observation()); };
  const running = f.tracking.checkNow(f.ref);
  await entered.promise;
  await f.dailyProduction.store.update(state => { state.runs[0].status = 'uncertain'; });
  resume.resolve();
  const changed = await running;
  assert.match(changed.results[0].error, /检查期间已变化/);
  assert.equal((await f.tracking.snapshot()).records.length, 0);
  assert.equal((await f.workspace.read()).value.metrics.length, 0);
});

test('unresolved checks visibly report stale data and preserve the last verified observation', async t => {
  const f = await fixture(t);
  await f.tracking.recordObservation(f.ref, f.observation());
  await f.tracking.projectPending();
  const previousRecord = (await f.tracking.snapshot()).records[0];
  const previousWorkspace = (await f.workspace.read()).value;
  f.tracking.inspect = async () => null;

  const result = await f.tracking.checkNow(f.ref);
  assert.equal(result.results[0].accepted, false);
  assert.equal(result.results[0].unresolved, true);
  assert.match(result.results[0].error, /未采到.*保留上次数据/);
  const snapshot = await f.tracking.snapshot();
  assert.match(snapshot.scheduler.error, /未采到.*保留上次数据/);
  assert.deepEqual(snapshot.records[0], previousRecord);
  assert.deepEqual((await f.workspace.read()).value, previousWorkspace);

  f.tracking.inspect = async () => f.observation({ observedAt: f.at(50), metrics: { plays: 25 } });
  assert.equal((await f.tracking.checkNow(f.ref)).results[0].accepted, true);
  assert.equal((await f.tracking.snapshot()).scheduler.error, '');
  assert.equal((await f.workspace.read()).value.metrics[0].plays, 25);
});
