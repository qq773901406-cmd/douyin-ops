import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { MediaAutomation, runMediaProcess, returnedWanFile, verifiedWanEventOutcome, createWanDownloadFetch } from '../server/media-automation.mjs';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';

async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'doufeng-media-test-'));
  const workspace = new JsonStore(join(dir, 'workspace.json'), normalizeState(), normalizeState);
  const image = join(dir, 'input.png'); await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
  const calls = [];
  const processRun = async (executable, args, config) => {
    calls.push({ executable, args, config });
    if (options.override) { const answer = await options.override(executable, args, config); if (answer) return answer; }
    if (args.includes('-show_streams')) return { code: 0, stdout: JSON.stringify({ format: { duration: args.at(-1).includes('wan') ? '3.5' : '20' }, streams: [{ codec_type: 'video', width: 720, height: 1280 }] }), stderr: '' };
    if (args[0].endsWith('free_wan.py') && !args.includes('--dry-run')) {
      const output = args[args.indexOf('--out-dir') + 1]; await mkdir(output); const asset = join(output, 'video.mp4'); await writeFile(asset, Buffer.alloc(64, 1));
      await writeFile(join(output, 'request.json'), JSON.stringify({ status: options.unknown ? 'unknown' : 'completed', video_produced: !options.unknown, output_file: asset }));
      return { code: options.unknown ? 2 : 0, stdout: '', stderr: options.unknown ? 'remote unavailable after submit' : '' };
    }
    if (args.includes('--out')) await writeFile(args[args.indexOf('--out') + 1], Buffer.alloc(64, 2));
    if (executable === 'test-ffmpeg' && args.at(-1).endsWith('.mp4')) await writeFile(args.at(-1), Buffer.alloc(64, 3));
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const media = new MediaAutomation(dir, { workspace, python: 'test-python', ffmpeg: 'test-ffmpeg', ffprobe: 'test-ffprobe', processRun, ...options.services });
  return { dir, workspace, image, calls, media, context: { task: { id: 'test-task' }, runId: 'run-1' } };
}
const article = { id: 'source-1', title: '测试资讯标题', url: 'https://www.ithome.com/0/123/456.htm', publishedAt: '2026-10-23T06:00:00Z', sourceName: 'IT之家', sourceUrl: 'https://www.ithome.com/' };

test('local news validates, decodes, archives to production studio and an unapproved draft idempotently', async () => {
  const f = await fixture(), input = { items: [article], day: '2026-10-23', platform: 'bilibili' };
  const result = await f.media.handlers()['media.news'].execute(input, f.context);
  assert.equal(result.status, 'completed'); assert.equal(result.output.publicationSubmitted, false);
  const state = (await f.workspace.read()).value;
  assert.equal(state.videos.length, 1); assert.equal(state.drafts.length, 1);
  assert.equal(state.videos[0].shots[0].reviewStatus, 'pending'); assert.equal(state.drafts[0].platform, 'bilibili'); assert.equal(state.drafts[0].status, '待检查');
  assert.ok(f.calls.some(c => c.args.includes('-xerror')));
  const count = f.calls.length;
  await f.media.handlers()['media.news'].execute(input, f.context);
  assert.equal(f.calls.length, count); assert.equal((await f.workspace.read()).value.drafts.length, 1);
});

test('Wan keeps executable args separate, reads real receipt and never re-submits a completed task under another run', async () => {
  const f = await fixture(), input = { imagePath: f.image, prompt: 'move slowly; $(do-not-execute)', title: '测试首帧', duration: 3.5 };
  const result = await f.media.handlers()['media.wan'].execute(input, f.context);
  assert.equal(result.status, 'completed');
  const actual = f.calls.filter(c => c.args[0].endsWith('free_wan.py') && !c.args.includes('--dry-run'));
  assert.equal(actual.length, 1); assert.ok(actual[0].args.includes('--prompt-file')); assert.ok(!actual[0].args.includes(input.prompt));
  assert.equal(await readFile(actual[0].args[actual[0].args.indexOf('--prompt-file') + 1], 'utf8'), input.prompt);
  const before = f.calls.length;
  await f.media.handlers()['media.wan'].execute(input, { ...f.context, runId: 'run-2' });
  assert.equal(f.calls.length, before);
  assert.equal(f.media.handlers()['media.wan'].readOnly, false);
});

test('remote unknown persists uncertainty and blocks all automatic retries without archive', async () => {
  const f = await fixture({ unknown: true }), input = { image: f.image, prompt: 'Move', duration: 3.5 };
  await assert.rejects(f.media.execute('wan', input, f.context), e => e.code === 'uncertain');
  assert.equal((await f.media.store.read()).value.jobs[0].remoteStatus, 'unknown');
  const count = f.calls.length;
  const recovered = new MediaAutomation(f.dir, { workspace: f.workspace, processRun: async () => { throw new Error('must not execute'); } });
  await assert.rejects(recovered.execute('wan', input, { ...f.context, runId: 'new-run' }), e => e.code === 'uncertain');
  assert.equal(f.calls.length, count); assert.equal((await f.workspace.read()).value.videos.length, 0);
});

test('missing media executable is actionable before any submission intent; dependencies never claim generated output', async () => {
  const f = await fixture({ override: async executable => { if (executable === 'test-ffmpeg') throw Object.assign(new Error('ffmpeg missing'), { code: 'ENOENT' }); } });
  await assert.rejects(f.media.execute('wan', { image: f.image, prompt: 'Move' }, f.context), e => e.code === 'requires_action');
  assert.equal((await f.media.store.read()).value.jobs.length, 0);
  assert.ok(!f.calls.some(c => c.args[0].endsWith('free_wan.py')));
});

test('missing ffprobe falls back to FFmpeg stream inspection and completed-only preview allowlist', async () => {
  const f = await fixture({ override: async (executable, args) => {
    if (executable === 'test-ffprobe') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    if (args.includes('-frames:v')) return { code: 0, stdout: '', stderr: '  Duration: 00:00:20.00, start: 0.0\n  Stream #0:0: Video: h264, yuv420p, 720x1280, 24 fps\n' };
  } });
  const result = await f.media.execute('news', { items: [article] }, f.context);
  assert.equal(result.output.media.seconds, 20); assert.equal(f.media.ffprobeAvailable, false);
  assert.equal((await f.media.mediaByPath(result.output.asset)).path, await realpath(result.output.asset));
  assert.equal(await f.media.mediaByPath(f.image), null);
  await writeFile(result.output.asset, Buffer.alloc(64, 8));
  await assert.rejects(f.media.mediaByPath(result.output.asset), /校验不一致/);
});

test('post-generation decode failure leaves output for review and does not archive it', async () => {
  const f = await fixture({ override: async (_executable, args) => args.includes('-xerror') ? { code: 1, stdout: '', stderr: 'corrupt frame' } : undefined });
  await assert.rejects(f.media.execute('news', { items: [article] }, f.context), /corrupt frame/);
  assert.equal((await f.workspace.read()).value.drafts.length, 0);
  assert.equal((await f.media.store.read()).value.jobs[0].status, 'requires_action');
});

test('feed input selects source items and productId resolves only stored product', async () => {
  const f = await fixture({ services: { newsCollect: async () => ({ items: [article], warnings: [] }) } });
  const result = await f.media.execute('news', { feedUrl: 'https://www.ithome.com/rss/' }, f.context);
  assert.equal(result.status, 'completed');
  await assert.rejects(f.media.execute('product', { productId: 'missing' }, { ...f.context, runId: 'other' }), /未找到/);
  assert.throws(() => f.media.validate('news', { feedUrl: 'https://127.0.0.1/' }), /本机或内网/);
});

test('edit normalizes owned segments with safe concat names and preserves source audio policy', async () => {
  const f = await fixture(), clip = join(f.dir, 'clip $().mp4'); await writeFile(clip, Buffer.alloc(64));
  const result = await f.media.execute('edit', { title: '两段成片', clipPaths: [clip, clip], ratio: '1:1' }, f.context);
  assert.equal(result.status, 'completed');
  const concat = f.calls.find(c => c.args.includes('concat'));
  assert.ok(concat.args.includes('-safe')); assert.equal(concat.args[concat.args.indexOf('-safe') + 1], '1');
  assert.ok(f.calls.some(c => c.args.includes('anullsrc=r=48000:cl=stereo')));
  const manifest = await readFile(concat.args[concat.args.indexOf('-i') + 1], 'utf8');
  assert.equal(manifest, "file 'segment-0.mp4'\nfile 'segment-1.mp4'\n");
  assert.ok(!manifest.includes(clip));
});

test('cancelled contexts start no process and owned subprocess timeouts terminate', async () => {
  const controller = new AbortController(); controller.abort();
  const f = await fixture();
  await assert.rejects(f.media.execute('news', { items: [article] }, { ...f.context, signal: controller.signal }), e => e.code === 'cancelled');
  assert.equal(f.calls.length, 0);
  await assert.rejects(runMediaProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), e => e.code === 'timeout');
  const literal = '$(echo should-not-run)';
  const result = await runMediaProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(result.stdout, literal);
});

const wanOrigin = 'https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space';
const returnedPath = `/tmp/gradio/${'a'.repeat(64)}/returned.mp4`;
const returnedUrl = `${wanOrigin}/gradio_api/file=${returnedPath}`;
const mp4Bytes = () => { const bytes = Buffer.alloc(128, 7); bytes.write('ftyp', 4); return bytes; };
function downloadableReceipt(extra = {}) {
  return { space: 'zerogpu-aoti/wan2-2-fp8da-aoti-faster', anonymous: true, paid_subscription_or_trial: false, status: 'unknown', video_produced: false, error_type: 'URLError', error: 'SSL EOF while downloading',
    parameters: { duration_seconds: 3.5, prompt: 'A harmless ball moves slowly.' }, result: [{ path: returnedPath, url: returnedUrl, meta: { _type: 'gradio.FileData' } }, 42], download_url: returnedUrl, ...extra };
}
async function recoveryFixture(options = {}) {
  const f = await fixture(options), originalId = 'b'.repeat(32), directory = join(f.media.directory, 'jobs', originalId, 'wan');
  await mkdir(directory, { recursive: true });
  const receiptPath = join(directory, 'request.json'), receipt = downloadableReceipt(); await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  const original = { id: originalId, kind: 'wan', taskId: 'original-task', runId: 'original-run', directory, status: 'uncertain', platform: 'douyin', title: '原始 AI 图生视频', caption: '原始提示词', submitIntentAt: '2026-10-23T11:00:00Z', remoteStatus: 'unknown' };
  await f.media.store.update(state => state.jobs.push(original));
  return { ...f, original, receiptPath, originalRaw: await readFile(receiptPath, 'utf8'), recoveryContext: { task: { id: 'recovery-task' }, runId: 'recovery-run' } };
}

test('Wan恢复只GET已返回文件，原失败回执与原记录不变，归档保留AI属性和任务关系', async () => {
  const requests = [], f = await recoveryFixture({ services: { downloadFetch: async (url, options) => { requests.push({ url, options }); return new Response(mp4Bytes(), { headers: { 'Content-Type': 'video/mp4' } }); } } });
  const handler = f.media.handlers()['media.wanRecover']; assert.equal(handler.readOnly, true);
  const result = await handler.execute({ taskId: 'original-task' }, f.recoveryContext);
  assert.equal(result.status, 'completed'); assert.equal(requests.length, 1); assert.equal(requests[0].url, returnedUrl); assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[0].options.redirect, 'manual'); assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(result.output.remoteResubmitted, false); assert.equal(result.output.originalTaskId, 'original-task'); assert.equal(result.output.publicationSubmitted, false);
  assert.equal(await readFile(f.receiptPath, 'utf8'), f.originalRaw); assert.deepEqual((await f.media.store.read()).value.jobs.find(job => job.id === f.original.id), f.original);
  const wb = (await f.workspace.read()).value; assert.equal(wb.drafts[0].aiGenerated, true); assert.equal(wb.drafts[0].originalWanTaskId, 'original-task'); assert.equal(wb.drafts[0].status, '待检查'); assert.equal(wb.videos[0].provider, '免费 Wan2.2 公共 Space');
  assert.equal((await f.media.mediaByPath(result.output.asset)).path, await realpath(result.output.asset));
  assert.ok(!f.calls.some(call => call.args[0].endsWith('free_wan.py'))); assert.ok(f.calls.some(call => call.args.includes('-xerror')));
  const receipt = JSON.parse(await readFile(result.output.receipt, 'utf8')); assert.equal(receipt.status, 'completed'); assert.equal(receipt.attempts.length, 1); assert.equal(receipt.sourceReceiptUnchanged, true);
  await handler.execute({ taskId: 'original-task' }, { ...f.recoveryContext, runId: 'later' }); assert.equal(requests.length, 1); assert.equal((await f.workspace.read()).value.drafts.length, 1);
});

test('Wan恢复拒绝任意URL、路径穿越、编码路径、账号凭据及缺少已返回FileData', () => {
  assert.equal(returnedWanFile(downloadableReceipt()).url, returnedUrl);
  const altered = [
    { result: [] }, { anonymous: false }, { space: 'other/space' }, { download_url: 'https://evil.example/movie.mp4' },
    { result: [{ path: returnedPath, url: `https://user:password@${new URL(wanOrigin).hostname}/gradio_api/file=${returnedPath}`, meta: { _type: 'gradio.FileData' } }] },
    { result: [{ path: '/tmp/gradio/../secrets.mp4', url: returnedUrl, meta: { _type: 'gradio.FileData' } }] },
    { result: [{ path: returnedPath, url: returnedUrl + '?download=1', meta: { _type: 'gradio.FileData' } }] },
    { result: [{ path: returnedPath, url: returnedUrl.replace('/tmp/', '/%74mp/'), meta: { _type: 'gradio.FileData' } }] },
  ];
  for (const extra of altered) assert.throws(() => returnedWanFile(downloadableReceipt(extra)));
});

test('Wan已观察副本的返回文件沿原副本下载，保留原FileData且拒绝路由失配', () => {
  const replica = 'observed-replica', app = `${wanOrigin}/--replicas/${replica}`, pinned = `${app}/gradio_api/file=${returnedPath}`;
  const receipt = downloadableReceipt({ observed_replica: replica, app_url: app, route_verified_at: '2026-10-26T00:00:00Z', download_url: pinned });
  const original = JSON.stringify(receipt);
  assert.equal(returnedWanFile(receipt).url, pinned);
  assert.equal(JSON.stringify(receipt), original);
  assert.equal(returnedWanFile({ ...receipt, result: [{ ...receipt.result[0], url: pinned }] }).url, pinned);
  for (const extra of [{ observed_replica: '../other' }, { observed_replica: 'other' }, { app_url: wanOrigin }, { app_url: 'https://other.hf.space/--replicas/observed-replica' },
    { route_verified_at: '' }, { download_url: returnedUrl }, { result: [{ ...receipt.result[0], url: pinned.replace(replica, 'other-replica') }] }])
    assert.throws(() => returnedWanFile({ ...receipt, ...extra }));
});

async function eventRecoveryFixture({ failed = false, services = {} } = {}) {
  const f = await recoveryFixture({ services });
  const replica = 'observed-replica', app = `${wanOrigin}/--replicas/${replica}`;
  const original = downloadableReceipt({ result: undefined, download_url: undefined, observed_replica: replica, app_url: app,
    route_verified_at: '2026-10-26T00:00:00Z', session_hash: 'fixture-session', event_id: 'fixture-event' });
  const originalRaw = JSON.stringify(original, null, 2), sum = createHash('sha256').update(originalRaw).digest('hex');
  await writeFile(f.receiptPath, originalRaw);
  const evidence = { version: 1, status: failed ? 'failed' : 'completed', method: 'GET', remoteResubmitted: false,
    originalTaskId: f.original.taskId, originalMediaId: f.original.id, originalReceiptSha256: sum,
    space: original.space, app_url: app, observed_replica: replica, session_hash: original.session_hash, event_id: original.event_id,
    requestUrl: `${app}/gradio_api/queue/data?session_hash=${original.session_hash}`, httpStatus: 200, observedReplica: replica,
    startedAt: '2026-10-26T09:24:44Z', completedAt: '2026-10-26T09:24:45Z',
    completion: { msg: 'process_completed', event_id: original.event_id, success: !failed,
      output: failed ? { title: 'ZeroGPU quota exceeded', error: 'You have exceeded your ZeroGPU quota (105s requested vs. 71s left). Try again in 23:55:20. Authenticate with a Hugging Face token for more quota - https://huggingface.co/settings/tokens' }
        : { data: downloadableReceipt().result } } };
  const evidencePath = join(f.original.directory, 'result-recovery.json'); await writeFile(evidencePath, JSON.stringify(evidence));
  return { ...f, originalReceipt: original, originalRaw, sum, evidence, evidencePath, pinnedUrl: `${app}/gradio_api/file=${returnedPath}` };
}

test('跨进程原事件成功证据只恢复GET下载，原unknown回执与任务不变且幂等', async () => {
  const urls = [], f = await eventRecoveryFixture({ services: { downloadFetch: async url => { urls.push(url); return new Response(mp4Bytes()); } } });
  const beforeCalls = f.calls.length;
  const inspect = await f.media.inspectWanOutcome({ taskId: f.original.taskId });
  assert.equal(inspect.status, 'completed'); assert.equal(inspect.terminalFailure, false); assert.equal(f.calls.length, beforeCalls);
  const result = await f.media.recoverWan({ taskId: f.original.taskId }, f.recoveryContext);
  assert.equal(result.status, 'completed'); assert.deepEqual(urls, [f.pinnedUrl]);
  assert.equal(result.output.originalTaskId, f.original.taskId); assert.equal(result.output.originalMediaId, f.original.id); assert.equal(result.output.remoteResubmitted, false);
  const receipt = JSON.parse(await readFile(result.output.receipt, 'utf8'));
  assert.equal(receipt.eventEvidence.originalReceiptSha256, f.sum); assert.equal(receipt.eventEvidence.method, 'GET');
  assert.equal(receipt.eventEvidence.sha256, createHash('sha256').update(await readFile(f.evidencePath)).digest('hex'));
  await f.media.recoverWan({ taskId: f.original.taskId }, f.recoveryContext); assert.equal(urls.length, 1);
  assert.equal(await readFile(f.receiptPath, 'utf8'), f.originalRaw);
  assert.deepEqual((await f.media.store.read()).value.jobs.find(job => job.id === f.original.id), f.original);
  assert.ok(!f.calls.some(call => call.args[0].endsWith('free_wan.py')));
});

test('跨进程原事件明确额度失败提供可核实等待时间，不下载、不生成、不改未知历史', async () => {
  let gets = 0;
  const f = await eventRecoveryFixture({ failed: true, services: { downloadFetch: async () => { gets++; throw new Error('must not download'); } } });
  const outcome = await f.media.inspectWanOutcome({ taskId: f.original.taskId });
  assert.equal(outcome.status, 'failed'); assert.equal(outcome.terminalFailure, true); assert.equal(outcome.remoteFailure.quotaExceeded, true);
  assert.equal(outcome.remoteFailure.requestedSeconds, 105); assert.equal(outcome.remoteFailure.remainingSeconds, 71);
  assert.equal(outcome.remoteFailure.retryNotBefore, '2026-10-27T09:25:04.000Z'); assert.equal(outcome.remoteFailure.retrySafetySeconds, 300);
  await assert.rejects(f.media.recoverWan({ taskId: f.original.taskId }, f.recoveryContext), error => error.code === 'remote_failed' && error.terminalFailure && error.eventEvidence.originalReceiptSha256 === f.sum);
  assert.equal(gets, 0); assert.equal(f.calls.length, 0); assert.equal(await readFile(f.receiptPath, 'utf8'), f.originalRaw);
  assert.equal((await f.media.store.read()).value.jobs.length, 1); assert.equal((await f.workspace.read()).value.drafts.length, 0);
});

test('原事件证据拒绝其他任务/文件/事件/副本/POST/伪终态，未知不变且不下载', async () => {
  const f = await eventRecoveryFixture();
  for (const patch of [{ originalTaskId: 'other' }, { originalMediaId: 'a'.repeat(32) }, { originalReceiptSha256: 'a'.repeat(64) },
    { method: 'POST' }, { remoteResubmitted: true }, { session_hash: 'other' }, { event_id: 'other' }, { app_url: wanOrigin },
    { observedReplica: 'other' }, { httpStatus: 302 }, { requestUrl: f.evidence.requestUrl + '&x=1' },
    { completion: { ...f.evidence.completion, event_id: 'other' } }, { completion: { ...f.evidence.completion, success: false } },
    { completedAt: '2026-10-25T00:00:00Z' }, { status: 'failed' }])
    assert.throws(() => verifiedWanEventOutcome(f.originalReceipt, { ...f.evidence, ...patch }, f.original, f.sum));
  await writeFile(f.evidencePath, JSON.stringify({ ...f.evidence, originalReceiptSha256: '0'.repeat(64) }));
  await assert.rejects(f.media.recoverWan({ taskId: f.original.taskId }, f.recoveryContext), /原任务不匹配/);
  assert.equal((await f.media.store.read()).value.jobs.length, 1); assert.equal(f.calls.length, 0);
});

test('失败事件带文件或不明确错误不能算额度失败，不规范额度字符串没有自动续做时间', async () => {
  const f = await eventRecoveryFixture({ failed: true }), check = evidence => verifiedWanEventOutcome(f.originalReceipt, evidence, f.original, f.sum);
  for (const output of [{ ...f.evidence.completion.output, data: downloadableReceipt().result }, { error: '' }, { error: null }])
    assert.throws(() => check({ ...f.evidence, completion: { ...f.evidence.completion, output } }));
  for (const error of ['Temporary transport error', 'You have exceeded your ZeroGPU quota (71s requested vs. 105s left). Try again in 23:55:20.',
    'You have exceeded your ZeroGPU quota (105s requested vs. 71s left). Try again in 99:55:20.',
    'You have exceeded your ZeroGPU quota (105s requested vs. 71s left). Try again now.']) {
    const outcome = check({ ...f.evidence, completion: { ...f.evidence.completion, output: { ...f.evidence.completion.output, error } } });
    assert.equal(outcome.status, 'failed'); assert.equal(outcome.remoteFailure.quotaExceeded, false); assert.equal(outcome.remoteFailure.retryNotBefore, undefined);
  }
});

test('原事件证据下载期间改变则不归档，也不修改原回执', async () => {
  let f;
  f = await eventRecoveryFixture({ services: { downloadFetch: async () => { await writeFile(f.evidencePath, JSON.stringify({ ...f.evidence, completedAt: '2026-10-26T09:24:46Z' })); return new Response(mp4Bytes()); } } });
  await assert.rejects(f.media.recoverWan({ taskId: f.original.taskId }, f.recoveryContext), /GET 证据在恢复期间发生变化/);
  assert.equal(await readFile(f.receiptPath, 'utf8'), f.originalRaw); assert.equal((await f.workspace.read()).value.drafts.length, 0);
});

test('Wan恢复网络GET最多2次，成功不重新submit；重定向/登录响应直接停止', async () => {
  let gets = 0;
  const f = await recoveryFixture({ services: { downloadFetch: async () => { gets++; if (gets === 1) throw new Error('connection reset'); return new Response(mp4Bytes()); } } });
  const result = await f.media.recoverWan({ taskId: 'original-task' }, f.recoveryContext); assert.equal(result.status, 'completed'); assert.equal(gets, 2);
  const saved = JSON.parse(await readFile(result.output.receipt, 'utf8')); assert.deepEqual(saved.attempts.map(attempt => attempt.status), ['failed', 'downloaded']);
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://evil.example/video' } }), new Response('login required', { status: 403 })]) {
    let count = 0; const blocked = await recoveryFixture({ services: { downloadFetch: async () => { count++; return response; } } });
    await assert.rejects(blocked.media.recoverWan({ taskId: 'original-task' }, blocked.recoveryContext), /下载恢复未完成/); assert.equal(count, 1); assert.equal((await blocked.workspace.read()).value.drafts.length, 0);
  }
});

test('Wan恢复体积限制、MP4文件头、实际时长与完整解码均必须通过', async () => {
  const scenarios = [
    { services: { downloadFetch: async () => new Response(mp4Bytes()), recoveryMaxBytes: 64 } },
    { services: { downloadFetch: async () => new Response(Buffer.alloc(128, 1)) } },
    { services: { downloadFetch: async () => new Response(mp4Bytes()) }, override: async (_executable, args) => args.includes('-show_streams') ? { code: 0, stdout: JSON.stringify({ format: { duration: 9 }, streams: [{ codec_type: 'video', width: 720, height: 1280 }] }), stderr: '' } : undefined },
    { services: { downloadFetch: async () => new Response(mp4Bytes()) }, override: async (_executable, args) => args.includes('-xerror') ? { code: 1, stdout: '', stderr: 'decode error' } : undefined },
  ];
  for (const options of scenarios) {
    const f = await recoveryFixture(options); await assert.rejects(f.media.recoverWan({ taskId: 'original-task' }, f.recoveryContext), /下载恢复未完成/);
    assert.equal((await f.workspace.read()).value.drafts.length, 0); assert.equal(await readFile(f.receiptPath, 'utf8'), f.originalRaw);
    assert.equal((await f.media.store.read()).value.jobs.find(job => job.kind === 'wanRecover').status, 'requires_action');
  }
});

test('Wan恢复取消不启动新GET，进行中的下载可中断并保留原生成证据', async () => {
  let count = 0;
  const controller = new AbortController(), f = await recoveryFixture({ services: { downloadFetch: async () => { count++; return new Response(new ReadableStream({ start(stream) { stream.enqueue(mp4Bytes()); setTimeout(() => controller.abort(), 10); } })); } } });
  await assert.rejects(f.media.recoverWan({ taskId: 'original-task' }, { ...f.recoveryContext, signal: controller.signal }), error => error.code === 'cancelled'); assert.equal(count, 1);
  assert.equal(await readFile(f.receiptPath, 'utf8'), f.originalRaw); assert.equal((await f.workspace.read()).value.drafts.length, 0);
  await assert.rejects(f.media.recoverWan({ taskId: 'original-task' }, { ...f.recoveryContext, signal: controller.signal }), error => error.code === 'cancelled'); assert.equal(count, 1);
});

test('后续Wan任务下载失败有完整返回文件时自动GET恢复，生成命令始终只提交一次', async () => {
  let submits = 0, gets = 0;
  const f = await fixture({ services: { downloadFetch: async () => { gets++; return new Response(mp4Bytes()); } }, override: async (_executable, args) => {
    if (args[0].endsWith('free_wan.py') && !args.includes('--dry-run')) {
      submits++; const output = args[args.indexOf('--out-dir') + 1]; await mkdir(output); await writeFile(join(output, 'request.json'), JSON.stringify(downloadableReceipt()));
      return { code: 2, stdout: '', stderr: 'SSL download EOF after completed generation' };
    }
  } });
  const result = await f.media.execute('wan', { image: f.image, prompt: 'Move the ball', title: '测试球', duration: 3.5 }, f.context);
  assert.equal(result.status, 'completed'); assert.equal(result.output.downloadRecovery, true); assert.equal(submits, 1); assert.equal(gets, 1);
  const jobs = (await f.media.store.read()).value.jobs; assert.equal(jobs.find(job => job.kind === 'wan').status, 'uncertain'); assert.equal(jobs.find(job => job.kind === 'wanRecover').status, 'completed');
  assert.equal(JSON.parse(await readFile(join(jobs.find(job => job.kind === 'wan').directory, 'request.json'), 'utf8')).status, 'unknown');
});

test('Wan恢复超时最多两次GET，仍失败就保留证据并停止', async () => {
  let gets = 0;
  const f = await recoveryFixture({ services: { recoveryTimeoutMs: 10, downloadFetch: async () => { gets++; return new Promise(() => {}); } } });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(f.media.recoverWan({ taskId: 'original-task' }, f.recoveryContext), /下载恢复未完成/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(gets, 2); const job = (await f.media.store.read()).value.jobs.find(row => row.kind === 'wanRecover');
  const receipt = JSON.parse(await readFile(job.recoveryReceipt, 'utf8')); assert.equal(receipt.attempts.length, 2); assert.equal(receipt.status, 'requires_action'); assert.equal(receipt.remoteResubmitted, false);
});

test('Wan恢复不覆盖已有归档路径的素材', async () => {
  const f = await recoveryFixture({ services: { downloadFetch: async () => new Response(mp4Bytes()) } });
  const id = createHash('sha256').update(JSON.stringify(['wan-recovery', f.original.id, f.recoveryContext.task.id])).digest('hex').slice(0, 32);
  const directory = join(f.media.directory, 'jobs', id, 'wan-recovery'), asset = join(directory, 'video.mp4');
  await mkdir(directory, { recursive: true }); await writeFile(asset, 'existing material that must remain unchanged');
  await assert.rejects(f.media.recoverWan({ taskId: 'original-task' }, f.recoveryContext), /下载恢复未完成/);
  assert.equal(await readFile(asset, 'utf8'), 'existing material that must remain unchanged'); assert.equal((await f.workspace.read()).value.drafts.length, 0);
});

test('Wan专用HTTPS客户端只对已返回文件使用独立env代理，TLS校验与请求header不放宽', async () => {
  const agents = [], calls = [], originalFetch = globalThis.fetch;
  class FakeAgent { constructor(options) { this.options = options; this.destroyed = false; agents.push(this); } destroy() { this.destroyed = true; } }
  const request = (url, options, callback) => {
    calls.push({ url, options }); const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => {
      const response = Readable.from([mp4Bytes()]); response.statusCode = 200; response.headers = { 'content-type': 'video/mp4', 'content-length': '128' }; callback(response);
    }); return req;
  };
  const client = createWanDownloadFetch({ Agent: FakeAgent, request, proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1', UNRELATED_SECRET: 'not-forwarded' } });
  const response = await client(returnedUrl, { method: 'GET', headers: { Authorization: 'should-never-pass', Cookie: 'should-never-pass' } });
  assert.deepEqual(Buffer.from(await new Response(response.body).arrayBuffer()), mp4Bytes());
  assert.equal(calls.length, 1); assert.equal(calls[0].options.agent, agents[0]); assert.equal(calls[0].options.rejectUnauthorized, true); assert.equal(agents[0].options.rejectUnauthorized, true);
  assert.deepEqual(agents[0].options.proxyEnv, { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1' });
  assert.deepEqual(Object.keys(calls[0].options.headers), ['Accept']); assert.equal(calls[0].options.method, 'GET'); assert.equal(agents[0].destroyed, true); assert.equal(globalThis.fetch, originalFetch);
});

test('Wan专用HTTPS客户端拒绝任意目标与非GET，返回重定向状态但绝不跟随', async () => {
  let count = 0;
  class FakeAgent { destroy() {} }
  const request = (_url, _options, callback) => { count++; const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => {
    const response = Readable.from([]); response.statusCode = 302; response.headers = { location: 'https://unapproved.example/' }; callback(response);
  }); return req; };
  const client = createWanDownloadFetch({ Agent: FakeAgent, request, proxyEnv: {} });
  await assert.rejects(client('https://unapproved.example/movie.mp4'), /仅允许/);
  await assert.rejects(client(returnedUrl, { method: 'POST' }), /仅允许/); assert.equal(count, 0);
  const response = await client(returnedUrl); assert.equal(response.status, 302); assert.equal(response.body, null); assert.equal(count, 1);
});
