import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DailyProduction } from '../server/daily-production.mjs';
import { AutomationService } from '../server/automation-service.mjs';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';

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
