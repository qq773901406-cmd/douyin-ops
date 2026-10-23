import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaAutomation, runMediaProcess } from '../server/media-automation.mjs';
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
  assert.equal((await f.media.mediaByPath(result.output.asset)).path, result.output.asset);
  await assert.rejects(f.media.mediaByPath(f.image), /仅可预览/);
  await writeFile(result.output.asset, Buffer.alloc(64, 8));
  await assert.rejects(f.media.mediaByPath(result.output.asset), /仅可预览/);
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
