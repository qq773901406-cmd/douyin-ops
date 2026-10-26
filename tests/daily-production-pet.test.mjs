import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DailyProduction } from '../server/daily-production.mjs';
import { AutomationService } from '../server/automation-service.mjs';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
const scratch = resolve('.codex_tmp');
async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'daily-pet-'));
  const workspace = new JsonStore(join(directory, 'workbench.json'), normalizeState(), normalizeState);
  const automation = new AutomationService(directory), calls = [];
  let now = Date.parse('2026-10-26T10:00:00+08:00'), ready = true, mutate, failRender, fixedStory;
  const settings = { model: 'pet-local:1', referenceUrls: ['https://www.douyin.com/video/12345'], firstFrames: [join(directory, 'pet.png')], duration: 20, audioMode: 'original-music' };
  const pipeline = {
    check: async () => ({ ok: ready, message: ready ? 'SIMULATED ready' : '本机没有已安装的文本模型', checks: [] }),
    collect: async (input, { guard }) => {
      calls.push('collect'); assert.deepEqual(input.referenceUrls, settings.referenceUrls); await guard();
      return { at: new Date(now).toISOString(), warnings: [], sources: [{ url: settings.referenceUrls[0], title: '萌宠参考', summary: '小猫与小狗互相帮助，这是实际采集的隔离测试文字。', observedAt: new Date(now).toISOString() }] };
    },
    render: async (sources, root, context) => {
      calls.push('render'); await context.guard(); assert.equal(sources[0].url, settings.referenceUrls[0]);
      if (failRender) throw failRender;
      const output = join(root, context.runId); await mkdir(output, { recursive: true });
      const asset = join(output, 'video.mp4'), path = join(output, 'generation.json');
      const bytes = Buffer.from(`SIMULATED AI media: ${context.runId}; no platform or model contacted`);
      await writeFile(asset, bytes);
      const receipt = { status: 'completed', path, runId: context.runId, model: settings.model, inputHash: hash('input'), sourceHash: hash('sources'), storyHash: fixedStory || hash(context.runId), assetSha256: hash(bytes), shots: Array.from({ length: 4 }, (_, index) => ({ taskId: `isolated-shot-${index}`, sha256: hash(`shot-${index}`) })) };
      const result = { asset, title: '测试萌宠故事', caption: 'AI 生成萌宠测试故事，使用原创配乐。', seconds: 20, aiGenerated: true, contentDeclaration: 'ai-generated', generationReceipt: receipt, audioVerification: { decoded: true, nonSilent: true, rmsDb: -18 }, motionVerification: { checked: true, passed: true } };
      await writeFile(path, JSON.stringify(receipt));
      if (mutate) await mutate(result, context);
      return result;
    }
  };
  const daily = new DailyProduction(directory, workspace, automation, { now: () => now, intervalMs: 300000, petPipeline: pipeline,
    renderNews: async () => { calls.push('news-fallback'); throw new Error('No card fallback permitted'); } });
  automation.publisher = { publish: async ({ approval }, hooks) => {
    calls.push('publish'); assert.equal(approval.aiGenerated, true); assert.equal(approval.contentDeclaration, 'ai-generated');
    await hooks.guard(); await hooks.beforeSubmit(); return { message: 'SIMULATED submitted', evidence: { simulation: true } };
  } };
  await automation.store.update(state => Object.assign(state.config, { accountId: 'PET-TEST', browserId: 'ISOLATED', verifiedAt: new Date(now).toISOString() }));
  await daily.store.update(state => Object.assign(state.config, { accountId: 'PET-TEST', browserId: 'ISOLATED' }));
  const state = async () => (await daily.store.read()).value;
  const configure = async patch => daily.productionSettings({ productionMode: 'ai-pet', petSettings: { ...settings, ...patch } }, (await daily.store.read()).revision);
  const enable = async () => daily.toggle({ enabled: true, authorized: true }, (await daily.store.read()).revision);
  await configure(); await daily.start();
  t.after(async () => {
    daily.stop(); automation.stop(); assert.equal(daily.busy, false);
    assert.ok(resolve(directory).startsWith(scratch + sep)); await rm(directory, { recursive: true, force: true });
  });
  return { daily, automation, pipeline, settings, calls, state, configure, enable, workspace,
    advance: date => { now = Date.parse(date); }, block: () => { ready = false; }, corrupt: fn => { mutate = fn; },
    failRender: error => { failRender = error; }, story: value => { fixedStory = hash(value); } };
}

test('AI 萌宠设置可保存未配置状态，阻止缺模型启用且不要求资讯RSS', async t => {
  const f = await fixture(t);
  assert.equal((await f.state()).newsLastSync, null);
  await f.configure({ model: '', referenceUrls: [], firstFrames: [] }); f.block();
  await assert.rejects(f.enable(), /本机没有/);
  assert.equal((await f.state()).config.enabled, false);
  const view = await f.daily.snapshot();
  assert.equal(view.productionMode, 'ai-pet'); assert.equal(view.readiness.canEnable, false);
  assert.deepEqual(f.calls, []);
});

test('萌宠设置变化撤销授权，旧图卡回执保持原样且版本保护有效', async t => {
  const f = await fixture(t), old = { id: randomUUID(), day: '2026-10-23', previewOnly: false, sourceMode: 'news', status: 'submitted', submitStartedAt: '2026-10-22T22:00:00Z', title: '旧图卡', binding: { accountId: 'OLD' } };
  await f.daily.store.update(state => state.runs.push(old)); await f.enable();
  const stale = (await f.daily.store.read()).revision;
  await f.configure({ model: 'pet-local:2' });
  const state = await f.state(); assert.equal(state.config.enabled, false); assert.equal(state.config.authorizedAt, '');
  assert.equal(state.config.firstDay, ''); assert.deepEqual(state.runs[0], old);
  await assert.rejects(f.daily.productionSettings({ productionMode: 'cards' }, stale), /更新/);
});

test('旧配置默认首帧说明为空，保存说明保留其他设置并撤销授权且不改历史回执', async t => {
  const f = await fixture(t); assert.equal((await f.state()).config.petSettings.visualBrief, '');
  const old = { id: randomUUID(), day: '2026-10-23', previewOnly: false, status: 'failed', productionMode: 'ai-pet', binding: { petSettings: structuredClone(f.settings) } };
  await f.daily.store.update(state => state.runs.push(old)); await f.enable();
  await f.configure({ visualBrief: '' }); assert.equal((await f.state()).config.enabled, true);
  await f.configure({ visualBrief: '  两只小猫位于同一房间的地面。  ' });
  const state = await f.state(); assert.equal(state.config.enabled, false); assert.equal(state.config.authorizedAt, '');
  assert.equal(state.config.petSettings.visualBrief, '两只小猫位于同一房间的地面。');
  assert.equal(state.config.petSettings.model, f.settings.model); assert.deepEqual(state.config.petSettings.firstFrames, f.settings.firstFrames);
  assert.deepEqual(state.runs[0], old);
});

test('萌宠定时链路采集转化后一次发布且保留生成、声音、动作与来源凭据', async t => {
  const f = await fixture(t); await f.enable(); f.advance('2026-10-27T06:00:01+08:00');
  await f.daily.run(false, 'scheduler'); await f.daily.run(false, 'scheduler');
  const state = await f.state(); assert.deepEqual(f.calls, ['collect', 'render', 'publish']);
  assert.equal(state.runs.length, 1); assert.equal(state.runs[0].status, 'submitted'); assert.equal(state.runs[0].trigger, 'scheduler');
  assert.equal(state.runs[0].productionMode, 'ai-pet'); assert.equal(state.runs[0].audioVerification.nonSilent, true);
  assert.equal(state.runs[0].sourceReferences.length, 1); assert.equal(state.config.enabled, true);
  const draft = (await f.workspace.read()).value.drafts[0]; assert.equal(draft.aiGenerated, true); assert.equal(draft.contentDeclaration, 'ai-generated');
});

test('相同萌宠参考可在次日生成新剧情，不永久消耗参考URL', async t => {
  const f = await fixture(t); await f.enable(); f.advance('2026-10-27T06:00:01+08:00'); await f.daily.run(false, 'scheduler');
  f.advance('2026-10-28T06:00:01+08:00'); await f.daily.run(false, 'scheduler');
  assert.equal(f.calls.filter(call => call === 'publish').length, 2);
  assert.equal((await f.state()).runs.filter(run => run.status === 'submitted').length, 2);
});

test('合法编码时长20.03秒保留真实回执，项目分镜使用整数秒且不阻断发布', async t => {
  const f = await fixture(t); f.corrupt(result => { result.seconds = 20.03; });
  await f.enable(); f.advance('2026-10-27T06:00:01+08:00'); await f.daily.run(false, 'scheduler');
  const state = await f.state(); assert.equal(state.runs[0].status, 'submitted'); assert.equal(state.runs[0].seconds, 20.03);
  assert.equal((await f.workspace.read()).value.videos[0].shots[0].seconds, 20);
});

test('媒体在生成凭据核验后被替换，不重新接受新哈希或提交发布', async t => {
  const f = await fixture(t), verify = f.daily.verifyPetRendered.bind(f.daily);
  f.daily.verifyPetRendered = async (rendered, target) => {
    const accepted = await verify(rendered, target); await writeFile(rendered.asset, 'replaced after verification'); return accepted;
  };
  await f.enable(); f.advance('2026-10-27T06:00:01+08:00'); await f.daily.run(false, 'scheduler');
  const run = (await f.state()).runs[0];
  assert.equal(run.status, 'failed'); assert.match(run.message, /视频文件发生变化/); assert.ok(!run.submitStartedAt);
  assert.equal(run.sha256, run.generationReceipt.assetSha256);
});

test('生成剧情重复时停止且不第二次提交', async t => {
  const f = await fixture(t); f.story('same-story'); await f.enable();
  f.advance('2026-10-27T06:00:01+08:00'); await f.daily.run(false, 'scheduler');
  f.advance('2026-10-28T06:00:01+08:00'); await f.daily.run(false, 'scheduler');
  const state = await f.state(); assert.equal(f.calls.filter(call => call === 'publish').length, 1);
  assert.equal(state.runs[1].status, 'failed'); assert.match(state.runs[1].message, /重复/); assert.equal(state.config.enabled, false);
});

test('无真实声音、无动作、无生成回执或伪图卡均不能进入发布', async t => {
  for (const [name, corrupt] of [
    ['no audio', result => { delete result.audioVerification; }],
    ['silence', result => { result.audioVerification.nonSilent = false; }],
    ['silent rms despite flag', result => { result.audioVerification.rmsDb = -90; }],
    ['no motion', result => { result.motionVerification.passed = false; }],
    ['no receipt', result => { delete result.generationReceipt; }],
    ['cards', result => { result.aiGenerated = false; }]
  ]) await t.test(name, async t => {
    const f = await fixture(t); f.corrupt(corrupt); await f.enable(); f.advance('2026-10-27T06:00:01+08:00');
    await f.daily.run(false, 'scheduler'); const state = await f.state();
    assert.equal(state.runs[0].status, 'failed'); assert.equal(state.config.enabled, false); assert.ok(!f.calls.includes('publish')); assert.ok(!f.calls.includes('news-fallback'));
  });
});

test('成片或持久生成回执哈希被改动会停止发布', async t => {
  const f = await fixture(t); f.corrupt(async result => { await writeFile(result.asset, 'tampered'); });
  await f.enable(); f.advance('2026-10-27T06:00:01+08:00'); await f.daily.run(false, 'scheduler');
  assert.match((await f.state()).runs[0].message, /回执不一致/); assert.ok(!f.calls.includes('publish'));
});

test('萌宠生成期间配置变化会停止，不能沿用旧授权提交', async t => {
  const f = await fixture(t); f.corrupt(async (_result, context) => {
    await f.daily.store.update(state => { state.config.petSettings.model = 'changed:1'; }); await context.guard();
  });
  await f.enable(); f.advance('2026-10-27T06:00:01+08:00'); await f.daily.run(false, 'scheduler');
  assert.match((await f.state()).runs[0].message, /设置已变化/); assert.ok(!f.calls.includes('publish'));
});

test('远端生成结果不明保留独立状态，阻止重启后自动生成或启用', async t => {
  const f = await fixture(t); f.failRender(Object.assign(new Error('remote result unknown'), { code: 'uncertain' }));
  await f.enable(); f.advance('2026-10-27T06:00:01+08:00'); await f.daily.run(false, 'scheduler');
  let state = await f.state(); assert.equal(state.runs[0].generationState, 'uncertain'); assert.equal(state.runs[0].status, 'failed'); assert.ok(!state.runs[0].submitStartedAt);
  f.daily.stop(); await f.daily.start(); f.advance('2026-10-28T06:00:01+08:00');
  await f.daily.run(false, 'scheduler'); await assert.rejects(f.enable(), /生成结果不明/);
  state = await f.state(); assert.equal(state.runs.length, 1); assert.equal(f.calls.filter(call => call === 'render').length, 1);
});

test('中断的萌宠生成在启动时暂停并保留生成结果待核实标志', async t => {
  const f = await fixture(t); await f.enable(); const config = structuredClone((await f.state()).config);
  f.daily.stop(); await f.daily.store.update(state => state.runs.push({ id: randomUUID(), day: '2026-10-27', productionMode: 'ai-pet', status: 'rendering', generationState: 'running', binding: config }));
  await f.daily.start(); const state = await f.state();
  assert.equal(state.config.enabled, false); assert.equal(state.runs[0].generationState, 'uncertain'); assert.equal(state.runs[0].status, 'failed');
  assert.deepEqual(f.calls, []);
});

async function uncertainPreview(f) {
  f.failRender(Object.assign(new Error('SIMULATED result stream lost'), { code: 'uncertain' }));
  await f.daily.run(true, 'preview');
  return structuredClone((await f.state()).runs.at(-1));
}
const abandonment = (run, extra = {}) => ({ id: run.id, action: 'abandon-preview', confirmed: true,
  note: '已核实原生成结果无法取回，明确放弃本次预览，保留未知回执。', ...extra });
const resolvePreview = async (f, run, extra = {}) => f.daily.resolveGeneration(abandonment(run, extra), (await f.daily.store.read()).revision);

const waitForResume = async f => { for (let index = 0; index < 400 && f.daily.busy; index++) await delay(5); assert.equal(f.daily.busy, false); };
test('预览断点续作只恢复原run并归档预览，保留失败快照且不会采集、启用或发布', async t => {
  const f = await fixture(t), original = await uncertainPreview(f), collectCount = f.calls.filter(call => call === 'collect').length;
  f.failRender(undefined); f.pipeline.resume = async (...args) => { f.calls.push('resume'); return f.pipeline.render(...args); };
  f.pipeline.inspectResume = async () => ({ status: 'ready', canResume: true, completedShots: 2, remainingShots: 2 });
  const before = await f.state(), revision = (await f.daily.store.read()).revision;
  const inspect = await f.daily.inspectGenerationResume(original.id); assert.equal(inspect.canResume, true); assert.deepEqual(await f.state(), before);
  await f.daily.resumeGeneration({ id: original.id, confirmed: true }, revision); await waitForResume(f);
  const after = await f.state(), run = after.runs.find(row => row.id === original.id);
  assert.equal(after.runs.length, 1); assert.equal(run.status, 'preview'); assert.equal(run.generationState, 'completed'); assert.ok(run.asset);
  assert.equal(after.config.enabled, false); assert.equal(f.calls.filter(call => call === 'collect').length, collectCount); assert.ok(!f.calls.includes('publish'));
  assert.deepEqual(after.generationResumptions[0].originalRun, original); assert.equal(after.generationResumptions[0].originalRunSha256, hash(JSON.stringify(original)));
  assert.equal(after.generationResumptions[0].status, 'completed'); assert.equal((await f.workspace.read()).value.drafts.filter(draft => draft.sourceProductionId === original.id).length, 1);
  await assert.rejects(f.daily.resumeGeneration({ id: original.id, confirmed: true }, (await f.daily.store.read()).revision), /仅可续作/);
  assert.equal(f.calls.filter(call => call === 'resume').length, 1);
});

test('续作入口拒绝缺确认、过期版本、弃置记录和任何非未发布预览', async t => {
  const f = await fixture(t), original = await uncertainPreview(f); f.pipeline.resume = async () => { throw new Error('must not run'); };
  const revision = (await f.daily.store.read()).revision;
  await assert.rejects(f.daily.resumeGeneration({ id: original.id, confirmed: false }, revision), /明确确认/);
  await assert.rejects(f.daily.resumeGeneration({ id: original.id, confirmed: true, retryNotBefore: 'past' }, revision), /明确确认/);
  await assert.rejects(f.daily.resumeGeneration({ id: original.id, confirmed: true }, 'stale'), /已有更新/);
  await resolvePreview(f, original); await assert.rejects(f.daily.resumeGeneration({ id: original.id, confirmed: true }, (await f.daily.store.read()).revision), /仅可续作/);
  for (const patch of [{ previewOnly: false, trigger: 'scheduler' }, { submitStartedAt: '2026-10-26T01:00:00Z' }, { asset: 'existing.mp4' }]) {
    await f.daily.store.update(state => { state.generationResolutions = []; Object.assign(state.runs[0], original, patch); });
    await assert.rejects(f.daily.resumeGeneration({ id: original.id, confirmed: true }, (await f.daily.store.read()).revision), /仅可续作/);
  }
  assert.equal((await f.state()).generationResumptions.length, 0);
});

test('额度未恢复的续作返回等待状态，保留原镜头并继续阻止启用', async t => {
  const f = await fixture(t), original = await uncertainPreview(f), retryNotBefore = '2026-10-27T09:25:04Z';
  f.pipeline.resume = async () => { throw Object.assign(new Error('免费额度尚未恢复'), { code: 'quota_wait', retryNotBefore }); };
  f.pipeline.inspectResume = async () => ({ status: 'quota_wait', canResume: false, retryNotBefore, completedShots: 2, remainingShots: 2 });
  assert.equal((await f.daily.inspectGenerationResume(original.id)).status, 'quota_wait');
  await f.daily.resumeGeneration({ id: original.id, confirmed: true }, (await f.daily.store.read()).revision); await waitForResume(f);
  const state = await f.state(); assert.equal(state.runs[0].status, 'failed'); assert.equal(state.runs[0].generationState, 'uncertain');
  assert.equal(state.runs[0].generationWait.retryNotBefore, retryNotBefore); assert.equal(state.generationResumptions[0].status, 'quota_wait');
  assert.equal(state.config.enabled, false); assert.equal((await f.workspace.read()).value.drafts.length, 0); assert.ok(!f.calls.includes('publish'));
  await assert.rejects(f.enable(), /生成结果不明/);
});

test('人工处置未知预览只追加审计，原回执不改且不自动重生成或启用', async t => {
  const f = await fixture(t), original = await uncertainPreview(f), beforeCalls = [...f.calls];
  const evidencePath = join(f.daily.runtimeDir, 'original-event-read.json'), bytes = '{"session_not_found":true,"generationResubmitted":false}';
  await writeFile(evidencePath, bytes);
  const before = await f.daily.snapshot();
  assert.deepEqual(before.generationResolutionStatus, [{ runId: original.id, abandoned: false, canAbandon: true }]);
  await resolvePreview(f, original, { evidencePath });
  const state = await f.state(), resolution = state.generationResolutions[0];
  assert.deepEqual(state.runs[0], original); assert.deepEqual(f.calls, beforeCalls); assert.equal(state.config.enabled, false);
  assert.equal(resolution.originalRunSha256, hash(JSON.stringify(original))); assert.equal(resolution.originalRevision, before.revision);
  assert.equal(resolution.originalGenerationState, 'uncertain'); assert.equal(resolution.originalReceiptPreserved, true);
  assert.equal(resolution.publicationSubmitted, false); assert.equal(resolution.evidence.sha256, hash(bytes)); assert.equal(await readFile(evidencePath, 'utf8'), bytes);
  const after = await f.daily.snapshot();
  assert.deepEqual(after.generationResolutionStatus, [{ runId: original.id, abandoned: true, canAbandon: false }]);
  assert.equal(after.readiness.checks.find(check => check.id === 'receipts').state, 'ok');
  await assert.rejects(resolvePreview(f, original), /仅可处置/);
  f.daily.stop(); await f.daily.start(); f.failRender(undefined); await f.daily.run(true, 'preview');
  const next = await f.state(); assert.equal(next.runs.length, 2); assert.notEqual(next.runs[1].id, original.id);
  assert.equal(next.runs[1].status, 'preview'); assert.deepEqual(next.runs[0], original); assert.ok(!f.calls.includes('publish'));
});

test('未知预览处置需要明确确认、说明与最新版本，暂停且空闲才接受', async t => {
  const f = await fixture(t), run = await uncertainPreview(f), originalRevision = (await f.daily.store.read()).revision;
  for (const patch of [{ confirmed: false }, { action: 'retry' }, { note: '未确认' }, { unknown: true }]) await assert.rejects(resolvePreview(f, run, patch), /明确确认/);
  await f.daily.store.update(state => { state.config.newsKeywords = 'changed'; });
  await assert.rejects(f.daily.resolveGeneration(abandonment(run), originalRevision), /已有更新/);
  f.daily.busy = true; await assert.rejects(resolvePreview(f, run), /任务正在处理/); f.daily.busy = false;
  await f.daily.store.update(state => Object.assign(state.config, { enabled: true, authorizedAt: new Date().toISOString(), firstDay: '2026-10-27' }));
  await assert.rejects(resolvePreview(f, run), /先暂停/);
  await f.daily.store.update(state => { state.config.enabled = false; state.runs.push({ id: randomUUID(), status: 'rendering' }); });
  await assert.rejects(resolvePreview(f, run), /所有任务结束/);
  assert.equal((await f.state()).generationResolutions.length, 0);
});

test('处置不接受定时生成、发布状态或任何发布与成片痕迹', async t => {
  for (const patch of [
    { previewOnly: false, trigger: 'scheduler' }, { trigger: 'scheduler' }, { status: 'uncertain' }, { status: 'submitted' },
    { productionMode: 'cards' }, { generationState: 'completed' }, { finishedAt: '' },
    { submitStartedAt: '2026-10-26T02:00:00Z' }, { evidence: {} }, { publishedUrl: 'https://www.douyin.com/video/123' },
    { boundWorkId: '123' }, { platformWorkId: '123' }, { reconciledResult: 'not-published' },
    { asset: 'returned.mp4' }, { draftId: randomUUID() }, { videoId: randomUUID() }
  ]) await t.test(JSON.stringify(patch), async t => {
    const f = await fixture(t), run = await uncertainPreview(f);
    await f.daily.store.update(state => Object.assign(state.runs[0], patch));
    await assert.rejects(resolvePreview(f, run), /仅可处置/);
    assert.equal((await f.state()).generationResolutions.length, 0);
  });
});

test('关联草稿或活跃发布队列阻止处置未知预览', async t => {
  const f = await fixture(t), run = await uncertainPreview(f);
  await f.workspace.update(state => state.drafts.push({ id: randomUUID(), sourceProductionId: run.id, title: 'SIMULATED prior draft', platform: 'douyin', status: '待检查' }));
  await assert.rejects(resolvePreview(f, run), /关联草稿/);
  await f.workspace.update(state => { state.drafts = []; });
  await f.automation.store.update(state => { state.config.enabled = true; });
  await assert.rejects(resolvePreview(f, run), /发布队列/);
  assert.equal((await f.state()).generationResolutions.length, 0);
});

test('核实证据必须在当前runtime内，保存内容摘要且不读取外部文件', async t => {
  const f = await fixture(t), run = await uncertainPreview(f);
  await assert.rejects(resolvePreview(f, run, { evidencePath: 'relative.json' }), /绝对文件/);
  await assert.rejects(resolvePreview(f, run, { evidencePath: resolve('package.json') }), /runtime/);
  const empty = join(f.daily.runtimeDir, 'empty.json'); await writeFile(empty, '');
  await assert.rejects(resolvePreview(f, run, { evidencePath: empty }), /非空文件/);
  assert.equal((await f.state()).generationResolutions.length, 0);
});

test('已处置预览快照后续变化会重新阻塞，不允许重写处置或放行其他未知发布', async t => {
  const f = await fixture(t), run = await uncertainPreview(f); await resolvePreview(f, run);
  await f.daily.store.update(state => { state.runs[0].message += ' changed'; });
  let view = await f.daily.snapshot();
  assert.deepEqual(view.generationResolutionStatus, [{ runId: run.id, abandoned: false, canAbandon: false }]);
  await assert.rejects(f.enable(), /生成结果不明/);
  await assert.rejects(resolvePreview(f, run), /仅可处置/);
  await f.daily.store.update(state => { state.runs[0] = run; state.runs.push({ id: randomUUID(), status: 'uncertain', submitStartedAt: '2026-10-26T02:00:00Z' }); });
  view = await f.daily.snapshot(); assert.equal(view.readiness.checks.find(check => check.id === 'receipts').state, 'blocked');
  await assert.rejects(f.enable(), /提交结果待核实/); assert.equal((await f.state()).config.enabled, false);
});
