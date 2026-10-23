import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, realpath, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { newVideo, newShot } from '../workbuddy/connector/lib/video-projects.mjs';
import { buildNewsVideoMetadata, selectNewsForVideo } from './news-video.mjs';
import { collectNews, validateNewsSettings } from './news-source.mjs';
import { productVideoPython } from './product-video.mjs';
import { hashFile } from '../lib/fs-utils.mjs';

const timestamp = () => new Date().toISOString();
const fail = (message, code = 'requires_action') => Object.assign(new Error(message), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail(`${label}为空或格式无效。`);
  return value.trim();
};
function cancelled(signal) { if (signal?.aborted) throw fail('制作已取消。', 'cancelled'); }

/** Spawn only the requested executable. Timeout/cancel terminates this owned process tree. */
export function runMediaProcess(executable, args, { signal, timeout = 960000, env = process.env, cwd } = {}) {
  return new Promise((resolveRun, reject) => {
    if (signal?.aborted) { reject(fail('制作已取消。', 'cancelled')); return; }
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopCode = '', stopPromise;
    const stop = code => {
      if (child.exitCode !== null || child.signalCode !== null || stopPromise) return;
      stopCode = code;
      // No process names or user supplied PIDs; only the still-owned child PID.
      stopPromise = process.platform === 'win32' && child.pid ? new Promise(done => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); done(); }); killer.once('close', done);
      }) : Promise.resolve().then(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } });
    };
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeout);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); });
    child.once('close', async code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); await stopPromise;
      if (stopCode) reject(Object.assign(fail(stopCode === 'cancelled' ? '制作已取消，所属进程已停止。' : '制作超时，所属进程已停止。', stopCode), { stdout, stderr }));
      else resolveRun({ code, stdout, stderr });
    });
  });
}

export class MediaAutomation {
  constructor(runtimeDir, { workspace, projectRoot = root, python = productVideoPython(), ffprobe = process.env.DOUFENG_FFPROBE || 'ffprobe', ffmpeg = process.env.DOUFENG_FFMPEG || '', depsDir = process.env.DOUFENG_WAN_DEPS || '', processRun = runMediaProcess, newsCollect = collectNews } = {}) {
    this.directory = join(resolve(runtimeDir), 'media-automation');
    this.store = new JsonStore(join(this.directory, 'state.json'), { version: 1, jobs: [] });
    Object.assign(this, { workspace, projectRoot, python, ffprobe, ffmpeg, depsDir, processRun, newsCollect });
  }
  validate(kind, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('制作输入必须为对象。');
    const allowed = kind === 'wan' ? ['image', 'imagePath', 'prompt', 'title', 'duration', 'seed', 'platform'] : kind === 'news' ? ['items', 'day', 'platform', 'feedUrl', 'keywords'] : kind === 'edit' ? ['clipPaths', 'title', 'ratio', 'platform'] : ['product', 'productId', 'platform'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw fail('制作输入包含不支持的字段。');
    if (input.platform && !['douyin', 'bilibili'].includes(input.platform)) throw fail('制作草稿平台必须为 douyin 或 bilibili。');
    const platform = input.platform || 'douyin';
    if (kind === 'news') {
      if (input.items && (input.feedUrl || input.keywords)) throw fail('资讯输入请选择已有 items 或 RSS 来源。');
      return input.items ? { ...buildNewsVideoMetadata(input.items, { day: input.day }), platform } : { ...validateNewsSettings(input), day: input.day, platform };
    }
    if (kind === 'edit') {
      if (!Array.isArray(input.clipPaths) || input.clipPaths.length < 1 || input.clipPaths.length > 12) throw fail('剪辑需要 1–12 个本地视频路径。');
      if (input.ratio && !['9:16', '16:9', '1:1'].includes(input.ratio)) throw fail('剪辑画幅须为 9:16、16:9 或 1:1。');
      return { title: text(input.title, 120, '成片标题'), clipPaths: input.clipPaths.map(path => text(path, 2000, '镜头路径')), ratio: input.ratio || '9:16', platform };
    }
    if (kind === 'product') {
      if (input.productId) { if (input.product) throw fail('请选择 productId 或 product 对象。'); return { productId: text(input.productId, 100, '商品编号'), platform }; }
      const p = input.product;
      if (!p || !Array.isArray(p.images) || p.images.length < 1 || p.images.length > 6) throw fail('商品需要 1–6 张本地图片。');
      return { product: { id: String(p.id || '').slice(0, 100), title: text(p.title, 30, '商品标题'), caption: text(p.captionZh || p.caption || p.hook || `${p.title}。商品图片展示，具体规格请查看商品资料。`, 450, '商品文案'), images: p.images.map(i => ({ path: text(i?.path, 2000, '本地图片路径') })) }, platform };
    }
    const duration = input.duration ?? 3.5, seed = input.seed ?? 42;
    if (!Number.isFinite(duration) || duration < 0.5 || duration > 5 || !Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw fail('免费 Wan 时长须为 0.5–5 秒，seed 须为 0–2147483647 整数。');
    if (input.image && input.imagePath && input.image !== input.imagePath) throw fail('首帧路径不一致。');
    return { image: text(input.imagePath || input.image, 2000, '首帧路径'), prompt: text(input.prompt, 6000, '动作提示词'), title: text(input.title || '免费 Wan 首帧视频', 120, '标题'), duration, seed, platform };
  }
  handlers() {
    return Object.fromEntries(['wan', 'news', 'product', 'edit'].map(kind => [`media.${kind}`, {
      readOnly: kind !== 'wan', validate: input => { this.validate(kind, input); return input; },
      execute: (input, context) => this.execute(kind, input, context),
    }]));
  }
  async command(args, context = {}, timeout = 30000, executable = this.python) {
    const result = await this.processRun(executable, args, { signal: context.signal, timeout, env: { ...process.env, PYTHONUTF8: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_TELEMETRY: '1' }, cwd: this.projectRoot });
    if (result.code !== 0) throw fail(`制作工具未完成：${String(result.stderr || result.stdout || result.code).slice(-600)}`);
    return result;
  }
  async localImage(path) {
    if (!isAbsolute(path) || /^\\\\/.test(path)) throw fail('图片必须为本机完整路径。');
    const actual = await realpath(path), info = await stat(actual);
    if (/^\\\\/.test(actual) || !info.isFile() || !info.size || info.size > 20 * 1024 ** 2) throw fail('图片文件无效或超过 20MB。');
    const header = (await readFile(actual)).subarray(0, 12);
    const valid = header.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP';
    if (!valid) throw fail('首帧或商品图片必须为 JPEG、PNG 或 WebP。');
    return actual;
  }
  async probeTools(context) {
    let ffmpeg = this.ffmpeg;
    if (!ffmpeg) {
      const result = await this.command(['-c', 'import imageio_ffmpeg,json;print(json.dumps(imageio_ffmpeg.get_ffmpeg_exe()))'], context);
      ffmpeg = JSON.parse(result.stdout.trim());
    }
    await this.command(['-version'], context, 15000, ffmpeg);
    try { await this.command(['-version'], context, 15000, this.ffprobe); this.ffprobeAvailable = true; }
    catch (error) { if (error.code === 'cancelled' || context.signal?.aborted) throw error; this.ffprobeAvailable = false; }
    return ffmpeg;
  }
  async inspectMedia(asset, ffmpeg, context) {
    if (this.ffprobeAvailable !== false) {
      return JSON.parse((await this.command(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', asset], context, 30000, this.ffprobe)).stdout);
    }
    // imageio-ffmpeg bundles ffmpeg but not ffprobe. Decode a real frame and read
    // FFmpeg's stream report; missing ffprobe alone must not block local renders.
    const result = await this.command(['-hide_banner', '-i', asset, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], context, 30000, ffmpeg);
    const report = result.stderr, duration = report.match(/^\s*Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/m);
    const line = report.split(/\r?\n/).find(row => /^\s*Stream #\d+:\d+.*Video:/.test(row));
    const dimensions = line?.match(/[, ](\d{2,6})x(\d{2,6})(?:[ ,\[]|$)/);
    if (!duration || !dimensions) throw fail('FFmpeg 已执行，但无法确认媒体时长和视频尺寸。');
    return { format: { duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) }, streams: [{ codec_type: 'video', width: Number(dimensions[1]), height: Number(dimensions[2]) }, ...(/^\s*Stream #\d+:\d+.*Audio:/m.test(report) ? [{ codec_type: 'audio' }] : [])] };
  }
  async readiness(context = {}) {
    const result = { local: false, wan: false, ffprobe: false, checkedAt: timestamp(), errors: [] };
    try { await this.probeTools(context); result.local = true; result.ffprobe = this.ffprobeAvailable; result.metadataInspector = this.ffprobeAvailable ? 'ffprobe' : 'ffmpeg-stream-report-and-decode'; }
    catch (error) { result.errors.push(`本地媒体环境：${error.message}`); }
    try {
      const deps = this.depsDir ? `;sys.path.append(${JSON.stringify(this.depsDir)})` : '';
      await this.command(['-c', `import sys${deps};import gradio_client;assert gradio_client.__version__=='2.7.2', 'gradio_client==2.7.2 required'`], context);
      result.wan = result.local;
    } catch (error) { result.errors.push(`免费 Wan 依赖：${error.message}`); }
    result.remoteQuotaChecked = false;
    result.summary = result.wan ? '本地工具和 Wan 客户端依赖就绪；未请求远端额度或生成。' : result.local ? '本地媒体工具可用；免费 Wan 尚有依赖需处理。' : '媒体工具尚未就绪。';
    return result;
  }
  async check(context = {}) { return this.readiness(context); }
  async mediaByPath(input) {
    const requested = typeof input === 'string' ? input : input?.path;
    if (typeof requested !== 'string' || !isAbsolute(requested)) throw fail('需要已完成成片的完整路径。');
    const actual = await realpath(requested), records = (await this.store.read()).value.jobs;
    for (const record of records.filter(j => j.status === 'completed' && j.asset)) {
      if (actual === await realpath(record.asset) && await hashFile(actual) === record.media.sha256) return { directory: record.directory, path: actual };
    }
    throw fail('仅可预览此制作服务已核验并归档的成片。');
  }
  async verifyMedia(asset, ffmpeg, context) {
    const info = await stat(asset);
    if (!info.isFile() || info.size < 32 || info.size > 1024 ** 3) throw fail('输出媒体为空或超过 1GB。');
    const probe = await this.inspectMedia(asset, ffmpeg, context), video = probe.streams?.find(s => s.codec_type === 'video'), seconds = Number(probe.format?.duration || video?.duration);
    if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width < 16 || video.height < 16 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 120) throw fail('ffprobe 未确认有效视频轨、尺寸与 0–120 秒时长。');
    await this.command(['-v', 'error', '-xerror', '-i', asset, '-map', '0:v:0', '-f', 'null', '-'], context, 180000, ffmpeg);
    return { width: video.width, height: video.height, seconds, bytes: info.size, sha256: await hashFile(asset), checkedAt: timestamp(), decoded: true };
  }
  async archive(record) {
    if (!this.workspace) throw fail('工作区存储未连接，成片已保留但尚未归档。');
    const videoId = `media-${record.id}`, draftId = `media-draft-${record.id}`, at = timestamp();
    await this.workspace.update(state => {
      if (!state.videos.some(v => v.id === videoId)) state.videos.push({ ...newVideo(), id: videoId, title: record.title, subject: record.title, asset: record.asset, status: 'completed', provider: record.kind === 'wan' ? '免费 Wan2.2 公共 Space' : '本地静音图卡字幕', budget: 'free', cost: '0', notes: '已通过媒体轨道与完整解码检查；画面质量、版权和发布内容仍待检查。', createdAt: at, updatedAt: at, shots: [newShot({ seconds: Math.max(1, Math.round(record.media.seconds)), action: record.caption || record.title, asset: record.asset, reviewStatus: 'pending' })] });
      if (!state.drafts.some(d => d.id === draftId)) state.drafts.push({ id: draftId, sourceVideoId: videoId, sourceMediaTaskId: record.taskId, platform: record.platform, pubTitle: record.title, title: record.title, caption: record.caption, asset: record.asset, format: '视频', status: '待检查', aiGenerated: record.kind === 'wan', createdAt: at, updatedAt: at });
    });
    return { summary: '视频制作、实际媒体检查和草稿归档完成；未发布。', videoId, draftId, asset: record.asset, media: record.media, receipt: record.kind === 'wan' ? join(record.directory, 'request.json') : this.store.path, publicationSubmitted: false };
  }
  async execute(kind, raw, context = {}) {
    let input = this.validate(kind, raw);
    const taskId = text(context.task?.id, 200, '任务编号'), runId = text(context.runId, 200, '运行编号');
    // A remote generation task has one durable intent across all retries/restarts.
    const id = digest(kind === 'wan' ? ['wan', taskId] : [kind, taskId, runId]).slice(0, 32), inputHash = digest(raw);
    let existing = (await this.store.read()).value.jobs.find(j => j.id === id);
    if (existing) {
      if (existing.inputHash !== inputHash) throw fail('同一制作任务的输入已变化，请新建任务。');
      if (existing.status === 'completed') {
        if (await hashFile(existing.asset) !== existing.media.sha256) throw fail('已归档视频发生变化，停止复用。');
        return { status: 'completed', output: await this.archive(existing) };
      }
      throw fail('此任务已保存制作意图或结果不明；请核对 request.json，不会再次提交。', existing.kind === 'wan' ? 'uncertain' : 'requires_action');
    }
    cancelled(context.signal);
    if (kind === 'news' && !input.items) {
      const collected = await this.newsCollect(input, join(this.directory, 'source-cache'));
      cancelled(context.signal);
      const selected = selectNewsForVideo(collected.items, { day: input.day });
      if (!selected.items.length) throw fail('资讯源近 48 小时没有可制作的有效条目。');
      input = { ...buildNewsVideoMetadata(selected.items, { day: input.day }), platform: input.platform };
    }
    if (kind === 'product' && input.productId) {
      const product = (await this.workspace?.read())?.value.products.find(p => p.id === input.productId);
      if (!product) throw fail('未找到已保存商品，请先完成选品或导入。');
      input = this.validate('product', { product, platform: input.platform });
    }
    let ffmpeg;
    try {
      ffmpeg = await this.probeTools(context);
      if (kind === 'wan') await this.localImage(input.image);
      if (kind === 'product') for (const image of input.product.images) await this.localImage(image.path);
    } catch (error) { throw fail(`制作前检查未通过：${error.message}`, error.code === 'cancelled' ? 'cancelled' : 'requires_action'); }
    const directory = join(this.directory, 'jobs', id), outputDir = kind === 'wan' ? join(directory, 'wan') : directory, asset = join(outputDir, 'video.mp4');
    await this.store.update(state => {
      if (state.jobs.some(j => j.id === id)) throw fail('任务已有制作意图，不能并行提交。', kind === 'wan' ? 'uncertain' : 'requires_action');
      state.jobs.push({ id, kind, taskId, runId, inputHash, directory: outputDir, status: 'preparing', createdAt: timestamp(), platform: input.platform });
    });
    const update = async fields => { const saved = await this.store.update(state => Object.assign(state.jobs.find(j => j.id === id), fields)); return saved.value.jobs.find(j => j.id === id); };
    await mkdir(directory, { recursive: true });
    try {
      cancelled(context.signal);
      await context.reportProgress?.({ phase: 'rendering', message: kind === 'wan' ? '正在执行免费首帧生成；远端结果不明时不重试。' : '正在制作本地图卡与字幕。' });
      let title, caption;
      if (kind === 'wan') {
        const promptFile = join(directory, 'prompt.txt'); await writeFile(promptFile, input.prompt, { encoding: 'utf8', flag: 'wx' });
        const args = [join(this.projectRoot, 'tools/video_generation/free_wan.py'), '--image', input.image, '--prompt-file', promptFile, '--out-dir', outputDir, '--duration', String(input.duration), '--seed', String(input.seed)];
        if (this.depsDir) args.push('--deps-dir', this.depsDir);
        // Validation and dependency import are offline and precede submission intent.
        await this.command([...args, '--dry-run'], context);
        const deps = this.depsDir ? `;sys.path.append(${JSON.stringify(this.depsDir)})` : '';
        await this.command(['-c', `import sys${deps};import gradio_client;assert gradio_client.__version__=='2.7.2', 'gradio_client==2.7.2 required'`], context);
        await update({ status: 'submitting', submitIntentAt: timestamp() });
        await this.command(args, context, 900000);
        const receipt = JSON.parse(await readFile(join(outputDir, 'request.json'), 'utf8'));
        if (receipt.status !== 'completed' || receipt.video_produced !== true || resolve(receipt.output_file || '') !== asset) throw fail('远端未提供已完成的媒体回执，禁止重复提交。', 'uncertain');
        title = input.title; caption = input.prompt;
      } else if (kind === 'edit') {
        const [width, height] = input.ratio === '16:9' ? [1280, 720] : input.ratio === '1:1' ? [720, 720] : [720, 1280];
        let total = 0; const sources = [];
        for (const [index, path] of input.clipPaths.entries()) {
          cancelled(context.signal);
          if (!isAbsolute(path) || /^\\\\/.test(path)) throw fail('剪辑仅接受本机完整视频路径。');
          const actual = await realpath(path), info = await stat(actual);
          if (/^\\\\/.test(actual) || !info.isFile() || !info.size || info.size > 1024 ** 3) throw fail('镜头文件无效或超过 1GB。');
          const probe = await this.inspectMedia(actual, ffmpeg, context);
          const seconds = Number(probe.format?.duration), audio = probe.streams?.some(s => s.codec_type === 'audio');
          if (!probe.streams?.some(s => s.codec_type === 'video') || !Number.isFinite(seconds) || seconds <= 0 || (total += seconds) > 120) throw fail('剪辑镜头需包含视频轨，总时长最多 120 秒。');
          sources.push({ path: actual, sha256: await hashFile(actual), seconds });
          const args = ['-n', '-v', 'error', '-i', actual];
          if (!audio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
          args.push('-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-t', String(seconds), '-shortest', join(directory, `segment-${index}.mp4`));
          await this.command(args, context, 180000, ffmpeg);
        }
        const manifest = join(directory, 'concat.txt');
        await writeFile(manifest, sources.map((_, index) => `file 'segment-${index}.mp4'`).join('\n') + '\n', { flag: 'wx' });
        await writeFile(join(directory, 'sources.json'), JSON.stringify(sources, null, 2), { flag: 'wx' });
        await this.command(['-n', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', manifest, '-c', 'copy', '-movflags', '+faststart', asset], context, 180000, ffmpeg);
        title = input.title; caption = `${sources.length} 个已有镜头按顺序拼接；统一 ${input.ratio} 画幅，保留原镜头声音，无音轨镜头补静音。`;
      } else {
        let config;
        if (kind === 'news') {
          config = { schemaVersion: 1, ...input }; title = input.title; caption = input.caption;
          await writeFile(join(directory, 'sources.json'), JSON.stringify({ sources: input.items, createdAt: timestamp() }, null, 2), { flag: 'wx' });
        } else {
          const images = [];
          for (const [index, item] of input.product.images.entries()) { const source = await this.localImage(item.path), target = join(directory, `image-${index}${extname(source) || '.png'}`); await copyFile(source, target); images.push(target); }
          title = input.product.title; caption = input.product.caption; config = { title, caption, images };
        }
        const configFile = join(directory, 'input.json'); await writeFile(configFile, JSON.stringify(config), { flag: 'wx' });
        await update({ status: 'rendering' });
        await this.command([join(this.projectRoot, `tools/${kind === 'news' ? 'news' : 'product'}_video/render.py`), '--config', configFile, '--out', asset], context, 960000);
      }
      const media = await this.verifyMedia(asset, ffmpeg, context);
      if (kind === 'wan' && Math.abs(media.seconds - input.duration) > 0.6) throw fail('实际生成时长与请求不符，保留输出待检查。');
      const complete = await update({ status: 'completed', asset, media, title, caption, finishedAt: timestamp() });
      return { status: 'completed', output: await this.archive(complete) };
    } catch (error) {
      let receipt; try { receipt = JSON.parse(await readFile(join(outputDir, 'request.json'), 'utf8')); } catch {}
      const current = (await this.store.read()).value.jobs.find(j => j.id === id);
      if (current.status === 'completed') throw error; // Projection can safely resume without generation.
      const remoteUnknown = kind === 'wan' && !!current.submitIntentAt && receipt?.status !== 'failed_before_submit';
      const status = remoteUnknown ? 'uncertain' : error.code === 'cancelled' ? 'cancelled' : 'requires_action';
      await update({ status, error: String(error.message).slice(0, 1000), remoteStatus: receipt?.status || '', finishedAt: timestamp() });
      throw fail(remoteUnknown ? `生成结果需核实，未重试：${error.message}` : error.message, status);
    }
  }
}
