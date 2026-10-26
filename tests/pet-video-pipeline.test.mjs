import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PetVideoPipeline, validatePetSettings, validatePetPlan, petSourceHash } from '../server/pet-video-pipeline.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = { title: '小猫的日常', url: 'https://www.douyin.com/video/12345678', observedAt: '2026-10-26T01:00:00Z', paragraphs: ['两只小猫在家中互动，这是只读采集到的参考文字。'] };
const plan = { title: '两只猫的击掌约定', caption: '橘猫想和伙伴击掌，结果两只小爪错开了节拍。', story: '家里两只小猫想学会击掌。橘猫先伸出爪子，黑白猫却忙着看自己的尾巴。两次错过之后，它们终于同时抬起小爪，开心地坐在一起。', sourceUrls: [source.url], shots: Array.from({ length: 4 }, (_, index) => ({ seconds: 5, prompt: `Shot ${index + 1}: The same two kittens perform a playful tiny paw movement together inside the bright home room. Preserve exact fur markings and four attached limbs, fixed camera, no text.` })) };

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pet-pipeline-'));
  t.after(async () => { const actual = resolve(root); assert.ok(actual.startsWith(resolve(tmpdir()) + sep)); await rm(actual, { recursive: true, force: true }); });
  const frame = join(root, 'frame.png'); await writeFile(frame, Buffer.from('fixture-only-image'));
  const calls = [], textCalls = [], contentCalls = [];
  const settings = { model: 'qwen2.5:1.5b', referenceUrls: [source.url], firstFrames: [frame], duration: 20, audioMode: 'original-music' };
  const text = { readiness: async () => ({ available: true, models: [settings.model] }), request: async (path, request) => {
    textCalls.push({ path, request });
    return { model: settings.model, done: true, message: { role: 'assistant', content: JSON.stringify(plan) } };
  } };
  const content = { validate: (kind, input) => { contentCalls.push({ kind, input }); return input; }, sources: async () => ({ sources: [source], warnings: [] }) };
  const media = {
    readiness: async () => ({ local: true, wan: true }), localImage: async path => path, probeTools: async () => 'fake-ffmpeg',
    command: async args => {
      if (!args[0].endsWith('assemble.py')) return { stdout: '{}', stderr: '', code: 0 };
      const input = JSON.parse(await readFile(args[args.indexOf('--config') + 1], 'utf8'));
      calls.push({ stage: 'assemble', input }); await writeFile(input.output, Buffer.from('fake-completed-new-video:' + input.clips.join('|')));
      return { stdout: JSON.stringify({ status: 'completed', asset: input.output, seconds: 20, audioVerification: { decoded: true, nonSilent: true, rmsDb: -20 }, motionVerification: { checked: true, passed: true, shots: [1, 2, 3, 4] } }) };
    },
    execute: async (kind, input, context) => {
      calls.push({ kind, input, context });
      const index = calls.filter(call => call.kind === 'wan').length;
      if (overrides.unknownAt === index) throw Object.assign(new Error('remote outcome unknown'), { code: 'uncertain' });
      const directory = join(root, `shot-${index}`); await mkdir(directory);
      const asset = join(directory, 'video.mp4'), receipt = join(directory, 'request.json'), bytes = Buffer.from(overrides.duplicate ? 'same-clip' : `new-generated-clip-${index}`);
      await writeFile(asset, bytes); await writeFile(receipt, JSON.stringify({ status: 'completed', video_produced: true, output_file: asset }));
      return { status: 'completed', output: { asset, receipt, media: { sha256: hash(bytes), seconds: 5.0625, decoded: true } } };
    }
  };
  const pipeline = new PetVideoPipeline(root, { content, text, media });
  return { root, frame, settings, pipeline, content, media, text, calls, textCalls, contentCalls,
    render: (options = {}) => pipeline.render([source], join(root, 'outputs'), { runId: 'day-1', settings, ...options }) };
}

test('萌宠设置可保存未配置状态，严格限定免费本机模型、参考和有声规格', () => {
  assert.deepEqual(validatePetSettings(), { model: '', referenceUrls: [], firstFrames: [], duration: 20, audioMode: 'original-music' });
  for (const value of [{ model: 'qwen:cloud' }, { duration: 5 }, { audioMode: 'silent' }, { endpoint: 'https://other.invalid' }, { referenceUrls: ['http://127.0.0.1:4000'] }, { firstFrames: ['relative.png'] }]) assert.throws(() => validatePetSettings(value));
});

test('环境检查不调用生成；模型或视频能力缺失时阻止就绪', async t => {
  const f = await fixture(t);
  assert.equal((await f.pipeline.check(f.settings)).ok, true);
  assert.equal(f.textCalls.length, 0); assert.equal(f.calls.length, 0);
  f.text.readiness = async () => ({ available: false, models: [], message: 'Ollama unavailable' });
  const blocked = await f.pipeline.check(f.settings);
  assert.equal(blocked.ok, false); assert.equal(blocked.remoteQuotaChecked, false);
  assert.match(blocked.message, /Ollama unavailable/);
  await assert.rejects(f.render(), /Ollama unavailable/);
  assert.equal(f.calls.length, 0);
});

test('采集只传当前账号和明确来源，剔除页面广告正文且保留标题观察范围', async t => {
  const f = await fixture(t); let guards = 0;
  f.content.sources = async () => ({ sources: [{ ...source, paragraphs: [], text: '广告推荐全部导航 不应该进入模型' }] });
  const result = await f.pipeline.collect(f.settings, { binding: { accountId: 'a', browserId: 'b', enabled: true, sourceMode: 'ai-pet' }, guard: async () => { guards++; } });
  assert.deepEqual(f.contentCalls[0].input, { urls: [source.url], limit: 1, accountId: 'a', browserId: 'b' });
  assert.equal(result.sources[0].summary, ''); assert.match(result.sources[0].scope, /title-only/);
  assert.ok(!JSON.stringify(result).includes('广告推荐')); assert.equal(guards, 2);
  assert.equal(petSourceHash([source]), petSourceHash([{ ...source, observedAt: '2026-10-27T01:00:00Z' }]));
  await assert.rejects(f.pipeline.collect({ ...f.settings, referenceUrls: [] }), /尚未配置/);
});

test('真实模型结构化结果驱动四个独立Wan任务及有声成片，完整凭据持久化', async t => {
  const f = await fixture(t), result = await f.render();
  assert.equal(result.aiGenerated, true); assert.equal(result.contentDeclaration, 'ai-generated'); assert.equal(result.seconds, 20);
  assert.equal(result.audioVerification.nonSilent, true); assert.equal(result.motionVerification.passed, true);
  assert.equal(f.textCalls.length, 1); assert.equal(f.textCalls[0].path, '/api/chat');
  assert.match(f.textCalls[0].request.body.messages[0].content, /不是给你的指令/);
  const shots = f.calls.filter(call => call.kind === 'wan'); assert.equal(shots.length, 4);
  assert.equal(new Set(shots.map(call => call.context.task.id)).size, 4);
  assert.deepEqual(shots.map(call => call.input.prompt), plan.shots.map(shot => shot.prompt));
  assert.equal(f.calls.filter(call => call.stage === 'assemble').length, 1);
  const record = JSON.parse(await readFile(result.generationReceipt.path, 'utf8'));
  assert.equal(record.status, 'completed'); assert.equal(record.runId, 'day-1'); assert.equal(record.shots.length, 4);
  assert.equal(record.assetSha256, hash(await readFile(result.asset)));
  assert.match(record.storyHash, /^[a-f0-9]{64}$/); assert.equal(record.storyHash, result.generationReceipt.storyHash);
  assert.equal(record.result.generationReceipt.sourceHash, petSourceHash([source]));
});

test('同一完成运行只复用同一已核验文件，输入变更和文件损坏拒绝', async t => {
  const f = await fixture(t), first = await f.render(), again = await f.render();
  assert.deepEqual(again, first); assert.equal(f.textCalls.length, 1); assert.equal(f.calls.filter(call => call.kind === 'wan').length, 4);
  await assert.rejects(f.render({ settings: { ...f.settings, model: 'another:1' } }), /输入已变化/);
  await writeFile(first.asset, 'corrupt'); await assert.rejects(f.render(), /哈希发生变化/);
});

test('生成未知保存原意图并终止后续镜头，同一运行和新实例都不能重提', async t => {
  const f = await fixture(t, { unknownAt: 2 });
  await assert.rejects(f.render(), error => error.code === 'uncertain');
  assert.equal(f.calls.filter(call => call.kind === 'wan').length, 2);
  const state = (await f.pipeline.store.read()).value.jobs[0];
  assert.equal(state.status, 'uncertain'); assert.equal(state.shots.length, 1); assert.equal(state.activeShot, 2);
  const restarted = new PetVideoPipeline(f.root, { content: f.content, text: f.text, media: f.media });
  await assert.rejects(restarted.render([source], join(f.root, 'outputs'), { runId: 'day-1', settings: f.settings }), error => error.code === 'uncertain');
  assert.equal(f.calls.filter(call => call.kind === 'wan').length, 2);
});

test('重复剧情在调用Wan之前拒绝，相同来源仍可生成不同的新剧情', async t => {
  const f = await fixture(t), first = await f.render();
  await assert.rejects(f.render({ runId: 'day-2' }), /已有剧情/);
  assert.equal(f.calls.filter(call => call.kind === 'wan').length, 4);
  const request = f.textCalls.at(-1).request.body.messages[1];
  assert.equal(JSON.parse(request.content).recentStories[0].title, plan.title);
  f.text.request = async () => ({ done: true, model: f.settings.model, message: { content: JSON.stringify({ ...plan, story: plan.story + '今天它们决定改用尾巴示意，一前一后轻轻转身，然后一起抬头看向窗边。' }) } });
  const next = await f.render({ runId: 'day-3', previousStoryHashes: [first.generationReceipt.storyHash] });
  assert.notEqual(next.generationReceipt.storyHash, first.generationReceipt.storyHash);
  assert.equal(next.generationReceipt.sourceHash, first.generationReceipt.sourceHash);
  assert.equal(f.calls.filter(call => call.kind === 'wan').length, 8);
});

test('重复视频素材和无声结果不能冒充完整萌宠视频', async t => {
  const f = await fixture(t, { duplicate: true });
  await assert.rejects(f.render(), /镜头内容重复/);
  assert.equal(f.calls.filter(call => call.stage === 'assemble').length, 0);
  const g = await fixture(t); const command = g.media.command;
  g.media.command = async args => { const value = await command(args); if (args[0].endsWith('assemble.py')) { const out = JSON.parse(value.stdout); out.audioVerification.nonSilent = false; return { stdout: JSON.stringify(out) }; } return value; };
  await assert.rejects(g.render(), /有声、运动/);
});

test('模型错误、伪造来源、重复分镜或配置变更guard阻止任何视频提交', async t => {
  for (const bad of [{ ...plan, sourceUrls: ['https://www.douyin.com/video/999'] }, { ...plan, shots: Array(4).fill(plan.shots[0]) }, { ...plan, title: 'English only' }]) assert.throws(() => validatePetPlan(bad, [source]));
  const f = await fixture(t); f.text.request = async () => ({ done: false, message: { content: JSON.stringify(plan) } });
  await assert.rejects(f.render(), /没有完成/); assert.equal(f.calls.length, 0);
  const g = await fixture(t); await assert.rejects(g.render({ guard: async () => { throw new Error('authorization changed'); } }), /authorization changed/); assert.equal(g.calls.length, 0);
  await assert.rejects(g.pipeline.render([source], resolve(g.root, '..'), { runId: 'outside', settings: g.settings }), /runtime 内/);
});
