import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DailyProduction } from '../../../../server/daily-production.mjs';
import { JsonStore } from '../../../../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../../../../workbuddy/connector/lib/workspace-model.mjs';
import { defaultAutomation, normalizeAutomation, shanghaiDay } from '../../../../shared/automation-model.mjs';
import { inspectProductVideoEnvironment } from '../../../../server/product-video.mjs';

const execute = promisify(execFile);
const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const root = resolve(scriptRoot, process.argv[2] || '.');
const outputRelative = relative(scriptRoot, root);
if (outputRelative === '..' || outputRelative.startsWith('..' + sep) || isAbsolute(outputRelative)) throw new Error('Verification output must stay within the scenarios directory.');
const RealDate = Date;
const startedAt = new RealDate().toISOString();
let testTime = RealDate.parse('2026-10-20T06:00:00+08:00');
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [testTime])); }
  static now() { return testTime; }
};
const at = iso => { testTime = RealDate.parse(iso); };
const fixture = join(root, 'fixture.png');
const corruptFixture = join(root, 'corrupt.png');
const checks = [];
const allServices = [];
const sourceFiles = [
  'server/daily-production.mjs', 'server/product-video.mjs', 'server/product-source.mjs',
  'tools/product_video/render.py', 'workbuddy/connector/lib/workspace-model.mjs',
];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, createHash('sha256').update(await readFile(resolve(sourceRoot, name))).digest('hex')])));
const beforeHashes = await sourceHashes();
await mkdir(root, { recursive: true });
await execute('python', ['-c', 'from PIL import Image,ImageDraw; import sys; im=Image.new("RGB",(640,640),"#f1e0b7"); d=ImageDraw.Draw(im); d.rounded_rectangle((120,80,520,560),radius=70,fill="#72b3a0"); d.rectangle((210,170,430,200),fill="white"); im.save(sys.argv[1])', fixture], { windowsHide: true });
await writeFile(corruptFixture, 'This file has a PNG extension but is deliberately invalid.');
const environment = await inspectProductVideoEnvironment();
assert.equal(environment.ok, true, environment.message);

const product = (id, image = fixture, extra = {}) => ({ id, title: `验收商品${id}`, status: 'ready', sourceDate: '2026-10-20', captionZh: '这是隔离测试商品。图片与字幕由本地免费合成。', images: [{ name: `${id}.png`, path: image }], ...extra });
async function setup(name, products = []) {
  const dir = join(root, name);
  const workspace = new JsonStore(join(dir, 'workspace.json'), normalizeState(), normalizeState);
  await workspace.replace(normalizeState({ products }));
  const store = new JsonStore(join(dir, 'automation', 'queue.json'), defaultAutomation(), normalizeAutomation);
  await store.update(state => Object.assign(state.config, { accountId: 'TEST-ACCOUNT-NOT-REAL', browserId: 'TEST-BROWSER-NOT-REAL', verifiedAt: new Date().toISOString() }));
  const calls = [];
  let leaseCount = 0, releaseCount = 0;
  const automation = {
    store,
    lease: async () => { leaseCount++; return async () => { releaseCount++; }; },
    publisher: { publish: async (request, hooks) => {
      calls.push({ at: new Date().toISOString(), asset: request.approval.asset, accountId: request.approval.accountId, isSimulation: true });
      await hooks.guard(); await hooks.beforeSubmit();
      return { message: 'SIMULATED submission only; no browser or platform was contacted.', evidence: { simulation: true } };
    } },
  };
  const daily = new DailyProduction(dir, workspace, automation);
  allServices.push(daily);
  await daily.store.update(state => Object.assign(state.config, {
    sourceMode: 'products', enabled: true, startTime: '06:00', accountId: 'TEST-ACCOUNT-NOT-REAL', browserId: 'TEST-BROWSER-NOT-REAL',
    authorizedAt: '2026-10-19T10:00:00.000Z', firstDay: '2026-10-20',
  }));
  return { dir, daily, workspace, automation, calls, leases: () => ({ leaseCount, releaseCount }) };
}
async function verify(name, fn) {
  at('2026-10-20T06:00:00+08:00');
  const begin = performance.now();
  try {
    const details = await fn();
    checks.push({ name, result: 'PASS', elapsedMs: Math.round(performance.now() - begin), ...details });
  } catch (error) {
    checks.push({ name, result: 'FAIL', elapsedMs: Math.round(performance.now() - begin), error: error.stack });
  }
  console.log(JSON.stringify(checks.at(-1)));
  await writeFile(join(root, 'results.partial.json'), JSON.stringify(checks, null, 2));
}

await verify('preview-does-not-publish-and-once-per-day', async () => {
  const ctx = await setup('preview-once-per-day', [product('A'), product('B')]);
  await ctx.daily.store.update(s => { s.config.enabled = false; });
  await ctx.daily.run(true);
  let saved = (await ctx.daily.store.read()).value;
  assert.equal(saved.runs[0].status, 'preview');
  assert.equal(saved.config.enabled, false);
  assert.equal(ctx.calls.length, 0);
  assert.ok((await stat(saved.runs[0].asset)).size > 1000);
  const firstVideo = saved.runs[0].asset;
  await ctx.daily.store.update(s => { s.config.enabled = true; });
  await ctx.daily.run(false);
  await ctx.daily.run(false);
  saved = (await ctx.daily.store.read()).value;
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(saved.runs.map(r => r.status), ['preview', 'submitted']);
  assert.equal(saved.runs[0].productId, saved.runs[1].productId);
  at('2026-10-21T06:00:00+08:00');
  await ctx.daily.run(false); await ctx.daily.run(false);
  saved = (await ctx.daily.store.read()).value;
  assert.equal(ctx.calls.length, 2);
  assert.equal(saved.runs[2].status, 'submitted');
  assert.notEqual(saved.runs[2].productKey, saved.runs[1].productKey);
  const workspace = (await ctx.workspace.read()).value;
  assert.equal(workspace.videos.length, 3);
  assert.equal(workspace.drafts.length, 3);
  assert.equal(workspace.drafts[1].productionStatus, 'submitted');
  assert.equal(workspace.drafts[1].status, '待检查');
  assert.ok(workspace.videos.every(v => v.cost === '0' && v.provider === '本地图片字幕合成'));
  await writeFile(join(ctx.dir, 'fake-publisher-calls.json'), JSON.stringify(ctx.calls, null, 2));
  return { evidenceDirectory: ctx.dir, realRenderedVideo: firstVideo, simulatedPublisherCalls: ctx.calls.length, statuses: saved.runs.map(r => ({ day: r.day, preview: r.previewOnly, status: r.status, productId: r.productId })), ...ctx.leases() };
});

await verify('beijing-time-boundaries-and-six-hour-window', async () => {
  assert.equal(shanghaiDay(RealDate.parse('2026-10-19T15:59:59.999Z')), '2026-10-19');
  assert.equal(shanghaiDay(RealDate.parse('2026-10-19T16:00:00.000Z')), '2026-10-20');
  const before = await setup('before-six', []);
  at('2026-10-20T05:59:59.999+08:00');
  await before.daily.run();
  assert.equal((await before.daily.store.read()).value.runs.length, 0);
  at('2026-10-20T06:00:00.000+08:00');
  await before.daily.run();
  let run = (await before.daily.store.read()).value.runs[0];
  assert.equal(run.status, 'failed');
  assert.match(run.message, /没有尚未发布/);
  const exact = await setup('exactly-six-hours-late', []);
  at('2026-10-20T12:00:00.000+08:00');
  await exact.daily.run();
  assert.equal((await exact.daily.store.read()).value.runs[0].status, 'failed');
  const late = await setup('over-six-hours-late', [product('A')]);
  at('2026-10-20T12:00:00.001+08:00');
  await late.daily.run(); await late.daily.run();
  const saved = (await late.daily.store.read()).value;
  assert.equal(saved.runs.length, 1); assert.equal(saved.runs[0].status, 'skipped');
  assert.equal(late.calls.length, 0);
  assert.equal((await late.workspace.read()).value.videos.length, 0);
  return { evidenceDirectories: [before.dir, exact.dir, late.dir], before06RunCount: 0, exactly06Status: run.status, exactly12Status: 'failed-no-product-not-expired', after12Status: 'skipped' };
});

await verify('no-products-fails-and-pauses', async () => {
  const ctx = await setup('no-products', []);
  await ctx.daily.run(); await ctx.daily.run();
  const saved = (await ctx.daily.store.read()).value;
  assert.equal(saved.runs.length, 1); assert.equal(saved.runs[0].status, 'failed');
  assert.equal(saved.config.enabled, false); assert.equal(ctx.calls.length, 0);
  return { evidenceDirectory: ctx.dir, status: saved.runs[0].status, message: saved.runs[0].message, scheduleEnabled: saved.config.enabled };
});

await verify('missing-first-image-skips-to-next-product', async () => {
  const ctx = await setup('missing-image-fallback', [product('A', join(root, 'does-not-exist.png')), product('B')]);
  await ctx.daily.run(true);
  const saved = (await ctx.daily.store.read()).value;
  assert.equal(saved.runs[0].status, 'preview'); assert.equal(saved.runs[0].productId, 'B');
  assert.ok(saved.runs[0].warnings.some(w => w.includes('文件已移动或不存在')));
  assert.equal(ctx.calls.length, 0);
  return { evidenceDirectory: ctx.dir, selectedProductId: saved.runs[0].productId, warnings: saved.runs[0].warnings, realRenderedVideo: saved.runs[0].asset };
});

await verify('submit-exception-becomes-uncertain-without-retry', async () => {
  const ctx = await setup('uncertain-submit', [product('A'), product('B')]);
  ctx.automation.publisher.publish = async (request, hooks) => {
    ctx.calls.push({ simulation: true, asset: request.approval.asset });
    await hooks.guard(); await hooks.beforeSubmit();
    throw new Error('SIMULATED: connection lost after submit callback');
  };
  await ctx.daily.run(); await ctx.daily.run();
  at('2026-10-21T06:00:00+08:00');
  await ctx.daily.run();
  const saved = (await ctx.daily.store.read()).value;
  assert.equal(saved.runs.length, 1); assert.equal(saved.runs[0].status, 'uncertain');
  assert.ok(saved.runs[0].submitStartedAt);
  assert.equal(saved.config.enabled, false); assert.equal(ctx.calls.length, 1);
  assert.equal((await ctx.workspace.read()).value.drafts[0].productionStatus, 'uncertain');
  return { evidenceDirectory: ctx.dir, status: saved.runs[0].status, simulatedPublisherCalls: ctx.calls.length, scheduleEnabled: saved.config.enabled, submitStartedAt: saved.runs[0].submitStartedAt };
});

await verify('interrupted-startup-recovery', async () => {
  const result = [];
  for (const [name, status, submitted, expected] of [
    ['interrupted-selecting', 'selecting', false, 'failed'],
    ['interrupted-rendering', 'rendering', false, 'failed'],
    ['interrupted-publishing-before-submit', 'publishing', false, 'failed'],
    ['interrupted-publishing-after-submit', 'publishing', true, 'uncertain'],
  ]) {
    const ctx = await setup(name, [product('A')]);
    await ctx.daily.store.update(s => s.runs.push({ id: name, day: '2026-10-20', previewOnly: false, status, ...(submitted ? { submitStartedAt: new Date().toISOString() } : {}) }));
    await ctx.daily.start(); ctx.daily.stop();
    const saved = (await ctx.daily.store.read()).value;
    assert.equal(saved.runs[0].status, expected); assert.equal(saved.config.enabled, false);
    assert.equal(ctx.calls.length, 0);
    result.push({ evidenceDirectory: ctx.dir, originalStatus: status, submitStarted: submitted, recoveredStatus: expected });
  }
  return { variants: result };
});

await verify('public-preview-endpoint-eventually-renders-without-publish', async () => {
  const ctx = await setup('public-preview-endpoint', [product('A')]);
  await ctx.daily.store.update(s => { s.config.enabled = false; });
  await ctx.daily.preview((await ctx.daily.store.read()).revision);
  const deadline = performance.now() + 90000;
  while (ctx.daily.busy && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(ctx.daily.busy, false);
  const saved = (await ctx.daily.store.read()).value;
  assert.equal(saved.runs[0].status, 'preview'); assert.equal(ctx.calls.length, 0);
  const media = await ctx.daily.media(saved.runs[0].id);
  assert.equal(media.path, saved.runs[0].asset);
  return { evidenceDirectory: ctx.dir, status: saved.runs[0].status, simulatedPublisherCalls: 0, realRenderedVideo: saved.runs[0].asset };
});

await verify('corrupt-first-image-skips-to-next-product', async () => {
  const ctx = await setup('corrupt-image-fallback-probe', [product('A', corruptFixture), product('B')]);
  await ctx.daily.run();
  const saved = (await ctx.daily.store.read()).value;
  assert.equal(saved.runs[0].status, 'submitted', saved.runs[0].message);
  assert.equal(saved.runs[0].productId, 'B');
  assert.equal(saved.config.enabled, true);
  assert.equal(ctx.calls.length, 1);
  return { evidenceDirectory: ctx.dir, observedStatus: saved.runs[0].status, selectedProductId: saved.runs[0].productId, scheduleEnabled: saved.config.enabled, message: saved.runs[0].message, warnings: saved.runs[0].warnings, simulatedPublisherCalls: ctx.calls.length };
});

for (const service of allServices) service.stop();
const afterHashes = await sourceHashes();
const report = {
  startedAt, finishedAt: new RealDate().toISOString(), root,
  scope: 'Real DailyProduction, JsonStore, normalizeState, local Python/Pillow/FFmpeg rendering. Fake account, fake browser, fake publisher only. No web publication and no platform connection.',
  clock: 'Date injected with Beijing schedule times inside this isolated Node process.',
  environment, sourceHashesBefore: beforeHashes, sourceHashesAfter: afterHashes,
  sourcesChangedDuringVerification: sourceFiles.filter(name => beforeHashes[name] !== afterHashes[name]),
  summary: { total: checks.length, passed: checks.filter(c => c.result === 'PASS').length, failed: checks.filter(c => c.result === 'FAIL').length },
  checks,
};
await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ summary: report.summary, report: join(root, 'results.json'), sourcesChangedDuringVerification: report.sourcesChangedDuringVerification }));
globalThis.Date = RealDate;
if (report.summary.failed) process.exitCode = 1;
