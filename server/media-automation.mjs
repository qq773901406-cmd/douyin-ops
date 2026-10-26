import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { mkdir, readFile, writeFile, stat, realpath, copyFile, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { newVideo, newShot } from '../workbuddy/connector/lib/video-projects.mjs';
import { buildNewsVideoMetadata, selectNewsForVideo } from './news-video.mjs';
import { collectNews, validateNewsSettings } from './news-source.mjs';
import { productVideoPython } from './product-video.mjs';
import { hashFile, isInside } from '../lib/fs-utils.mjs';

const timestamp = () => new Date().toISOString();
const fail = (message, code = 'requires_action') => Object.assign(new Error(message), { code, status: code === 'requires_action' ? 400 : 409 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const WAN_SPACE = 'zerogpu-aoti/wan2-2-fp8da-aoti-faster';
const WAN_ORIGIN = 'https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space';
const RECOVERY_MAX_BYTES = 128 * 1024 ** 2;
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail(`${label}为空或格式无效。`);
  return value.trim();
};
function cancelled(signal) { if (signal?.aborted) throw fail('制作已取消。', 'cancelled'); }

// Dedicated to returned Wan files: honoring the configured HTTPS proxy here
// must not change the DNS/proxy behavior of RSS, browser, or local API clients.
export function createWanDownloadFetch({ Agent = HttpsAgent, request = httpsRequest, proxyEnv = process.env } = {}) {
  return async (address, { signal, method = 'GET' } = {}) => {
    let url; try { url = new URL(address); } catch { throw fail('Wan 下载地址无效。'); }
    if (method !== 'GET' || url.origin !== WAN_ORIGIN || url.username || url.password || url.search || url.hash || url.href !== address
      || !/^(?:\/--replicas\/[A-Za-z0-9][A-Za-z0-9-]{0,127})?\/gradio_api\/file=\/tmp\/gradio\/[a-f0-9]{64}\/[a-zA-Z0-9_.-]+\.mp4$/.test(url.pathname) || url.pathname.includes('..')) throw fail('专用下载客户端仅允许固定 Wan 返回文件的 GET 请求。');
    cancelled(signal);
    const env = Object.fromEntries(['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'].filter(key => typeof proxyEnv[key] === 'string').map(key => [key, proxyEnv[key]]));
    const agent = new Agent({ proxyEnv: env, keepAlive: false, rejectUnauthorized: true });
    return new Promise((resolveRequest, reject) => {
      let req;
      const failRequest = error => { agent.destroy(); reject(error); };
      try {
        req = request(url, { method: 'GET', agent, signal, rejectUnauthorized: true, headers: { Accept: 'video/mp4, application/octet-stream;q=0.9' } }, response => {
          const status = response.statusCode || 0;
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers || {})) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
          const destroyAgent = () => agent.destroy();
          response.once('end', destroyAgent); response.once('close', destroyAgent);
          if (status < 200 || status >= 300) {
            // Do not read an authentication/error page or follow Location.
            response.destroy(); agent.destroy();
            resolveRequest({ ok: false, status, headers, url: url.href, redirected: false, body: null });
            return;
          }
          resolveRequest({ ok: true, status, headers, url: url.href, redirected: false, body: Readable.toWeb(response) });
        });
        req.once('error', failRequest); req.end();
      } catch (error) { req?.destroy(); failRequest(error); }
    });
  };
}

const wanDownloadFetch = createWanDownloadFetch();

export function returnedWanFile(receipt) {
  if (!receipt || receipt.space !== WAN_SPACE || receipt.anonymous !== true || receipt.paid_subscription_or_trial !== false || !Array.isArray(receipt.result)) throw fail('原回执没有已返回的匿名免费 Wan 文件，不能恢复下载或重新生成。');
  const file = receipt.result[0];
  if (!file || typeof file.path !== 'string' || !/^\/tmp\/gradio\/[a-f0-9]{64}\/[a-zA-Z0-9_.-]+\.mp4$/.test(file.path) || file.path.includes('..') || file.meta?._type !== 'gradio.FileData') throw fail('原回执的返回文件路径无效，未下载。');
  let appUrl = WAN_ORIGIN;
  if (receipt.app_url != null || receipt.observed_replica != null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(receipt.observed_replica || '')
      || receipt.app_url !== `${WAN_ORIGIN}/--replicas/${receipt.observed_replica}`
      || !Number.isFinite(Date.parse(receipt.route_verified_at || ''))) throw fail('原回执缺少已核实的固定 Wan 副本路由。');
    appUrl = receipt.app_url;
  }
  const canonical = `${WAN_ORIGIN}/gradio_api/file=${file.path}`, expected = `${appUrl}/gradio_api/file=${file.path}`;
  let url; try { url = new URL(file.url); } catch { throw fail('原回执没有有效文件 URL。'); }
  if (![canonical, expected].includes(url.href) || url.username || url.password || url.search || url.hash || receipt.download_url && receipt.download_url !== expected) throw fail('恢复只允许固定 Wan Space 的原始返回文件，拒绝其他来源、凭据或重定向。');
  const duration = receipt.parameters?.duration_seconds;
  if (!Number.isFinite(duration) || duration < 0.5 || duration > 5) throw fail('原回执没有有效的请求时长，不能核验恢复视频。');
  return { url: expected, path: file.path, duration };
}

// A stopped CLI may have submitted successfully but received no FileData. A
// separately persisted GET observation can recover that same original event;
// it never changes the original unknown receipt or authorizes another POST.
export function verifiedWanEventOutcome(original, evidence, source, originalReceiptSha256) {
  const replica = original?.observed_replica, session = original?.session_hash, event = original?.event_id;
  if (original?.space !== WAN_SPACE || original.anonymous !== true || original.paid_subscription_or_trial !== false
    || original.status !== 'unknown' || original.video_produced !== false || original.result != null || original.download_url != null
    || original.output_file != null || original.partial_file != null
    || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(replica || '') || original.app_url !== `${WAN_ORIGIN}/--replicas/${replica}`
    || !Number.isFinite(Date.parse(original.route_verified_at || ''))
    || !/^[A-Za-z0-9_-]{1,128}$/.test(session || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(event || '')) throw fail('原回执缺少可核对的固定副本与原事件，不能取代原结果。');
  const started = Date.parse(evidence?.startedAt || ''), completed = Date.parse(evidence?.completedAt || '');
  if (evidence?.version !== 1 || !['completed', 'failed'].includes(evidence.status) || evidence.method !== 'GET' || evidence.remoteResubmitted !== false
    || evidence.originalTaskId !== source.taskId || evidence.originalMediaId !== source.id
    || !/^[a-f0-9]{64}$/.test(originalReceiptSha256 || '') || evidence.originalReceiptSha256 !== originalReceiptSha256
    || evidence.space !== original.space || evidence.app_url !== original.app_url || evidence.observed_replica !== replica
    || evidence.session_hash !== session || evidence.event_id !== event
    || evidence.requestUrl !== `${original.app_url}/gradio_api/queue/data?session_hash=${encodeURIComponent(session)}`
    || evidence.httpStatus !== 200 || evidence.observedReplica !== replica
    || !Number.isFinite(started) || !Number.isFinite(completed) || completed < started
    || evidence.completion?.msg !== 'process_completed' || evidence.completion.event_id !== event) throw fail('原事件 GET 证据不完整或与原任务不匹配，未下载或重新生成。');
  if (evidence.status === 'failed') {
    const output = evidence.completion.output;
    if (evidence.completion.success !== false || !output || typeof output.error !== 'string' || !output.error.trim()
      || output.error.length > 8000 || output.data != null) throw fail('原事件没有明确失败且无返回文件的终态，仍需核实。');
    const title = String(output.title || evidence.completion.title || '').slice(0, 200);
    const quota = /^You have exceeded your ZeroGPU quota \((\d{1,5})s requested vs\. (\d{1,5})s left\)\. Try again in (\d{1,2}):([0-5]\d):([0-5]\d)\.(?: Authenticate with a Hugging Face token for more quota - https:\/\/huggingface\.co\/settings\/tokens)?$/.exec(output.error);
    const delaySeconds = quota ? Number(quota[3]) * 3600 + Number(quota[4]) * 60 + Number(quota[5]) : 0;
    const quotaExceeded = title === 'ZeroGPU quota exceeded' && !!quota && Number(quota[1]) > Number(quota[2])
      && delaySeconds > 0 && delaySeconds <= 48 * 3600;
    return { status: 'failed', terminalFailure: true, remoteFailure: { title,
      message: output.error.slice(0, 2000), quotaExceeded, observedAt: evidence.completedAt,
      ...(quotaExceeded ? { requestedSeconds: Number(quota[1]), remainingSeconds: Number(quota[2]), retryAfterSeconds: delaySeconds,
        retrySafetySeconds: 300, retryNotBefore: new Date(started + (delaySeconds + 300) * 1000).toISOString() } : {}) } };
  }
  if (evidence.completion.success !== true || !Array.isArray(evidence.completion.output?.data) || !evidence.completion.output.data.length) throw fail('原事件没有成功返回文件，未下载或重新生成。');
  const returned = { ...original, result: evidence.completion.output.data };
  returnedWanFile(returned);
  return { status: 'completed', terminalFailure: false, returned };
}

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
  constructor(runtimeDir, { workspace, projectRoot = root, python = productVideoPython(), ffprobe = process.env.DOUFENG_FFPROBE || 'ffprobe', ffmpeg = process.env.DOUFENG_FFMPEG || '', depsDir = process.env.DOUFENG_WAN_DEPS || '', processRun = runMediaProcess, newsCollect = collectNews, downloadFetch = wanDownloadFetch, recoveryTimeoutMs = 60000, recoveryMaxBytes = RECOVERY_MAX_BYTES } = {}) {
    this.directory = join(resolve(runtimeDir), 'media-automation');
    this.store = new JsonStore(join(this.directory, 'state.json'), { version: 1, jobs: [] });
    Object.assign(this, { workspace, projectRoot, python, ffprobe, ffmpeg, depsDir, processRun, newsCollect, downloadFetch, recoveryTimeoutMs, recoveryMaxBytes });
  }
  validate(kind, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('制作输入必须为对象。');
    if (kind === 'wanRecover') {
      if (Object.keys(input).some(key => key !== 'taskId')) throw fail('恢复输入仅允许原 Wan 任务编号，不接受下载地址或新生成参数。');
      return { taskId: text(input.taskId, 200, '原 Wan 任务编号') };
    }
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
      if (!p || !Array.isArray(p.images) || p.images.length < 1 || p.images.length > 20) throw fail('商品需要 1–20 张本地图片，视频使用前 6 张。');
      const originalTitle = text(p.title, 160, '商品标题');
      return { product: { id: String(p.id || '').slice(0, 100), originalTitle, title: [...originalTitle].slice(0, 30).join(''), caption: text(p.captionZh || p.caption || p.hook || `${originalTitle}。商品图片展示，具体规格请查看商品资料。`, 450, '商品文案'), images: p.images.slice(0, 6).map(i => ({ path: text(i?.path, 2000, '本地图片路径') })) }, platform };
    }
    const duration = input.duration ?? 3.5, seed = input.seed ?? 42;
    if (!Number.isFinite(duration) || duration < 0.5 || duration > 5 || !Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw fail('免费 Wan 时长须为 0.5–5 秒，seed 须为 0–2147483647 整数。');
    if (input.image && input.imagePath && input.image !== input.imagePath) throw fail('首帧路径不一致。');
    return { image: text(input.imagePath || input.image, 2000, '首帧路径'), prompt: text(input.prompt, 6000, '动作提示词'), title: text(input.title || '免费 Wan 首帧视频', 120, '标题'), duration, seed, platform };
  }
  handlers() {
    return Object.fromEntries(['wan', 'news', 'product', 'edit', 'wanRecover'].map(kind => [`media.${kind}`, {
      readOnly: kind !== 'wan', validate: input => { this.validate(kind, input); return input; },
      execute: (input, context) => kind === 'wanRecover' ? this.recoverWan(input, context) : this.execute(kind, input, context),
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
    try {
      await this.probeTools(context);
      const renderer = await this.command([join(this.projectRoot, 'tools/product_video/render.py'), '--check'], context);
      if (JSON.parse(renderer.stdout).ok !== true) throw fail('图片渲染器没有通过字体、Pillow 和 FFmpeg 检查。');
      result.local = true; result.ffprobe = this.ffprobeAvailable; result.metadataInspector = this.ffprobeAvailable ? 'ffprobe' : 'ffmpeg-stream-report-and-decode';
    }
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
    if (typeof requested !== 'string' || !isAbsolute(requested)) return null;
    let actual; try { actual = await realpath(requested); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const records = (await this.store.read()).value.jobs;
    for (const record of records.filter(j => j.status === 'completed' && j.asset)) {
      let saved; try { saved = await realpath(record.asset); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (actual === saved) {
        if (await hashFile(actual) !== record.media.sha256) throw fail('已归档成片校验不一致，停止预览。');
        return { directory: await realpath(record.directory), path: actual };
      }
    }
    return null;
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
    const videoId = `media-${record.id}`, draftId = `media-draft-${record.id}`, at = timestamp(), wan = ['wan', 'wanRecover'].includes(record.kind);
    await this.workspace.update(state => {
      if (!state.videos.some(v => v.id === videoId)) state.videos.push({ ...newVideo(), id: videoId, title: record.title, subject: record.title, asset: record.asset, status: 'completed', ratio: record.ratio || '9:16', provider: wan ? '免费 Wan2.2 公共 Space' : record.kind === 'edit' ? '本地镜头拼接与规格统一' : '本地静音图卡字幕', budget: 'free', cost: '0', notes: '已通过媒体轨道与完整解码检查；画面质量、版权和发布内容仍待检查。', ...(record.originalTaskId ? { originalTaskId: record.originalTaskId, originalMediaId: record.originalMediaId, downloadRecovery: true } : {}), createdAt: at, updatedAt: at, shots: [newShot({ seconds: Math.max(1, Math.round(record.media.seconds)), action: record.caption || record.title, asset: record.asset, reviewStatus: 'pending' })] });
      if (!state.drafts.some(d => d.id === draftId)) state.drafts.push({ id: draftId, sourceVideoId: videoId, sourceMediaTaskId: record.taskId, ...(record.originalTaskId ? { originalWanTaskId: record.originalTaskId, originalMediaId: record.originalMediaId, downloadRecovery: true } : {}), platform: record.platform, pubTitle: record.title, title: record.title, caption: record.caption, asset: record.asset, format: '视频', status: '待检查', aiGenerated: wan, createdAt: at, updatedAt: at });
    });
    return { summary: record.kind === 'wanRecover' ? '已恢复原 Wan 返回文件，完成实际媒体检查和草稿归档；未重新生成或发布。' : '视频制作、实际媒体检查和草稿归档完成；未发布。', videoId, draftId, asset: record.asset, media: record.media, receipt: record.recoveryReceipt || (record.kind === 'wan' ? join(record.directory, 'request.json') : this.store.path), ...(record.originalTaskId ? { originalTaskId: record.originalTaskId, originalMediaId: record.originalMediaId, originalReceipt: record.originalReceipt, downloadRecovery: true, remoteResubmitted: false } : {}), publicationSubmitted: false };
  }
  async downloadReturnedWanFile(file, target, context, attempt) {
    cancelled(context.signal);
    const timer = AbortSignal.timeout(Math.min(60000, Math.max(1, this.recoveryTimeoutMs)));
    const signal = context.signal ? AbortSignal.any([timer, context.signal]) : timer;
    let fileHandle, reader, abortListener;
    const interrupted = new Promise((_, reject) => {
      abortListener = () => reject(context.signal?.aborted ? fail('恢复下载已取消。', 'cancelled') : Object.assign(fail('恢复下载超时。'), { downloadRetryable: true }));
      signal.addEventListener('abort', abortListener, { once: true }); if (signal.aborted) abortListener();
    });
    interrupted.catch(() => {});
    try {
      let response;
      try { response = await Promise.race([this.downloadFetch(file.url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal }), interrupted]); }
      catch (error) { if (context.signal?.aborted) throw fail('恢复下载已取消。', 'cancelled'); throw Object.assign(fail(`恢复下载连接失败：${String(error.message).slice(0, 250)}`), { downloadRetryable: true }); }
      attempt.httpStatus = response.status;
      if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== file.url) throw fail('原文件下载发生重定向，已停止；未访问新地址。');
      if (!response.ok) throw Object.assign(fail(`原文件下载返回 HTTP ${response.status}，未重新生成。`), { downloadRetryable: response.status >= 500 && response.status < 600 });
      const maximum = Math.min(RECOVERY_MAX_BYTES, Math.max(32, this.recoveryMaxBytes));
      const announced = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(announced) && announced > maximum) throw fail('返回文件超过恢复下载的体积上限。');
      const type = String(response.headers?.get?.('content-type') || '');
      if (/text\/|application\/(?:json|xml)/i.test(type)) throw fail('远端返回文字页面而非视频，可能需要登录或文件已失效。');
      if (!response.body?.getReader) throw fail('下载响应没有可读取的文件流。');
      fileHandle = await open(target, 'wx'); reader = response.body.getReader();
      let bytes = 0, header = Buffer.alloc(0);
      const sum = createHash('sha256');
      for (;;) {
        cancelled(context.signal);
        let next; try { next = await Promise.race([reader.read(), interrupted]); }
        catch (error) { if (context.signal?.aborted) throw fail('恢复下载已取消。', 'cancelled'); throw Object.assign(fail(`下载文件流中断：${String(error.message).slice(0, 250)}`), { downloadRetryable: true }); }
        if (next.done) break;
        const chunk = Buffer.from(next.value); bytes += chunk.length; attempt.bytes = bytes;
        if (bytes > maximum) throw fail('返回文件超过恢复下载的体积上限。');
        if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
        sum.update(chunk); await fileHandle.write(chunk);
      }
      await fileHandle.sync();
      if (bytes < 32 || header.length < 12 || header.subarray(4, 8).toString() !== 'ftyp') throw fail('返回文件没有有效 MP4 文件头，未归档。');
      attempt.sha256 = sum.digest('hex'); attempt.bytes = bytes;
      return { bytes, sha256: attempt.sha256 };
    } finally {
      signal.removeEventListener('abort', abortListener);
      if (reader) { reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
      if (fileHandle) await fileHandle.close();
    }
  }
  async readWanOutcome(raw, context = {}) {
    const input = this.validate('wanRecover', raw);
    cancelled(context.signal);
    const source = (await this.store.read()).value.jobs.find(job => job.kind === 'wan' && job.taskId === input.taskId);
    if (!source || !/^[a-f0-9]{32}$/.test(source.id) || !['uncertain', 'requires_action', 'completed'].includes(source.status)) throw fail('未找到已结束且有返回文件的原 Wan 制作记录。');
    const expectedDirectory = join(this.directory, 'jobs', source.id, 'wan'), canonicalRoot = await realpath(this.directory), canonicalSource = await realpath(source.directory);
    if (resolve(source.directory) !== expectedDirectory || !isInside(canonicalRoot, canonicalSource) || canonicalSource !== join(canonicalRoot, 'jobs', source.id, 'wan')) throw fail('原 Wan 目录与任务记录不一致。');
    const originalReceipt = join(source.directory, 'request.json'), receiptInfo = await stat(originalReceipt);
    if (await realpath(originalReceipt) !== join(canonicalSource, 'request.json')) throw fail('原 Wan 回执路径发生变化。');
    if (!receiptInfo.isFile() || receiptInfo.size > 1024 * 1024) throw fail('原 Wan 回执无效或过大。');
    const originalRaw = await readFile(originalReceipt, 'utf8'), originalHash = digest(originalRaw);
    let returned; try { returned = JSON.parse(originalRaw); } catch { throw fail('原 Wan 回执无法解析，未下载。'); }
    let eventEvidence, outcome = { status: 'completed', terminalFailure: false };
    if (returned.result == null) {
      if (source.status === 'completed' || source.asset || source.media) throw fail('原制作记录已有成片痕迹，不能按缺失结果处置。');
      const path = join(source.directory, 'result-recovery.json');
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024 || await realpath(path) !== join(canonicalSource, 'result-recovery.json')) throw fail('原事件 GET 证据路径无效或过大。');
        const raw = await readFile(path, 'utf8');
        if (Buffer.byteLength(raw) > 1024 * 1024) throw fail('原事件 GET 证据读取期间发生变化。');
        const originalReceiptSha256 = createHash('sha256').update(originalRaw).digest('hex');
        const evidence = JSON.parse(raw);
        outcome = verifiedWanEventOutcome(returned, evidence, source, originalReceiptSha256);
        if (outcome.returned) returned = outcome.returned;
        eventEvidence = { path, sha256: createHash('sha256').update(raw).digest('hex'), originalReceiptSha256,
          method: 'GET', originalTaskId: source.taskId, originalMediaId: source.id, eventId: returned.event_id,
          sessionHash: returned.session_hash, appUrl: returned.app_url, observedReplica: returned.observed_replica,
          observedAt: evidence.completedAt, remoteResubmitted: false };
      } catch (error) {
        throw fail(error.code === 'ENOENT' ? '原 Wan 回执没有返回文件，尚无匹配的原事件 GET 完成证据；不会重新生成。' : `原事件 GET 证据未通过核对：${error.message}`);
      }
    }
    const file = outcome.status === 'completed' ? returnedWanFile(returned) : null;
    return { ...outcome, source, canonicalRoot, canonicalSource, originalReceipt, originalRaw, originalHash, returned, file, eventEvidence };
  }
  async inspectWanOutcome(raw, context = {}) {
    const observed = await this.readWanOutcome(raw, context);
    return { status: observed.status, terminalFailure: observed.terminalFailure, originalTaskId: observed.source.taskId, originalMediaId: observed.source.id,
      originalReceipt: observed.originalReceipt, originalReceiptPreserved: true, remoteResubmitted: false,
      ...(observed.eventEvidence ? { eventEvidence: observed.eventEvidence } : {}),
      ...(observed.remoteFailure ? { remoteFailure: observed.remoteFailure } : {}) };
  }
  async recoverWan(raw, context = {}, { automatic = false, ffmpeg: preparedFfmpeg } = {}) {
    const taskId = text(context.task?.id, 200, '恢复任务编号'), runId = text(context.runId, 200, '恢复运行编号');
    const observed = await this.readWanOutcome(raw, context);
    if (observed.status === 'failed') throw Object.assign(fail(`原事件已明确返回失败：${observed.remoteFailure.message}`, 'remote_failed'),
      { terminalFailure: true, eventEvidence: observed.eventEvidence, remoteFailure: observed.remoteFailure });
    const { source, canonicalRoot, originalReceipt, originalHash, returned, file, eventEvidence } = observed;
    const id = digest(['wan-recovery', source.id, taskId]).slice(0, 32);
    const directory = join(this.directory, 'jobs', id, 'wan-recovery'), recoveryReceipt = join(directory, 'download-recovery.json'), asset = join(directory, 'video.mp4');
    const existing = (await this.store.read()).value.jobs.find(job => job.id === id);
    if (existing) {
      if (existing.status === 'completed' && existing.originalReceiptHash === originalHash
        && existing.eventEvidence?.sha256 === eventEvidence?.sha256 && await hashFile(existing.asset) === existing.media.sha256) return { status: 'completed', output: await this.archive(existing) };
      throw fail('此恢复任务已有未完成或不一致的记录，请检查回执；不会覆盖原素材或自动重放。');
    }
    const ffmpeg = preparedFfmpeg || await this.probeTools(context);
    const record = { id, kind: 'wanRecover', taskId, runId, directory, recoveryReceipt, originalTaskId: source.taskId, originalMediaId: source.id, originalReceipt, originalReceiptHash: originalHash, ...(eventEvidence ? { eventEvidence } : {}),
      status: 'recovering', createdAt: timestamp(), platform: source.platform, automatic, remoteResubmitted: false, title: source.title || '免费 Wan 视频（恢复下载）', caption: source.caption || String(returned.parameters?.prompt || '').slice(0, 6000) };
    await this.store.update(state => { if (state.jobs.some(job => job.id === id)) throw fail('同一恢复任务已被认领。'); state.jobs.push(record); });
    const update = async fields => { const saved = await this.store.update(state => Object.assign(state.jobs.find(job => job.id === id), fields)); return saved.value.jobs.find(job => job.id === id); };
    const receipt = { version: 1, recoveryId: id, taskId, runId, originalTaskId: source.taskId, originalMediaId: source.id, originalReceipt, originalReceiptHash: originalHash, ...(eventEvidence ? { eventEvidence } : {}),
      url: file.url, returnedPath: file.path, requestedDuration: file.duration, method: 'GET', remoteResubmitted: false, originalReceiptPreserved: true, automatic, startedAt: timestamp(), status: 'recovering', attempts: [], asset };
    await mkdir(directory, { recursive: true });
    if (await realpath(directory) !== join(canonicalRoot, 'jobs', id, 'wan-recovery')) throw fail('恢复输出目录发生变化。');
    const receiptStore = new JsonStore(recoveryReceipt, receipt);
    await receiptStore.replace(receipt, 'missing');
    try {
      let downloaded;
      for (let index = 1; index <= 2; index++) {
        cancelled(context.signal);
        const attempt = { index, startedAt: timestamp(), status: 'downloading', path: join(directory, `attempt-${index}-${randomUUID()}.mp4.part`) };
        receipt.attempts.push(attempt); await receiptStore.replace(receipt);
        await context.reportProgress?.({ phase: 'recovering_download', message: `只下载原 Wan 已返回文件，第 ${index}/2 次 GET；不会重新生成。` });
        try {
          downloaded = await this.downloadReturnedWanFile(file, attempt.path, context, attempt); attempt.status = 'downloaded'; attempt.finishedAt = timestamp(); await receiptStore.replace(receipt);
          const media = await this.verifyMedia(attempt.path, ffmpeg, context);
          if (Math.abs(media.seconds - file.duration) > 0.6) throw fail('恢复文件实际时长与原请求不符，保留副本但不归档。');
          if (media.sha256 !== downloaded.sha256) throw fail('恢复文件在下载后校验时发生变化。');
          if (digest(await readFile(originalReceipt, 'utf8')) !== originalHash) throw fail('原生成回执在恢复期间发生变化，未归档。');
          if (eventEvidence && await hashFile(eventEvidence.path) !== eventEvidence.sha256) throw fail('原事件 GET 证据在恢复期间发生变化，未归档。');
          cancelled(context.signal);
          await copyFile(attempt.path, asset, constants.COPYFILE_EXCL);
          if (await hashFile(asset) !== media.sha256) throw fail('归档副本哈希校验失败。');
          receipt.status = 'completed'; receipt.finishedAt = timestamp(); receipt.media = media; receipt.sourceReceiptUnchanged = true; await receiptStore.replace(receipt);
          const complete = await update({ status: 'completed', asset, media, ratio: media.width === media.height ? '1:1' : media.width > media.height ? '16:9' : '9:16', finishedAt: timestamp() });
          return { status: 'completed', output: await this.archive(complete) };
        } catch (error) {
          attempt.status = error.code === 'cancelled' ? 'cancelled' : 'failed'; attempt.error = String(error.message).slice(0, 1000); attempt.finishedAt = timestamp(); await receiptStore.replace(receipt);
          if (!error.downloadRetryable || index === 2 || context.signal?.aborted) throw error;
        }
      }
      throw fail('恢复下载未完成。');
    } catch (error) {
      const current = (await this.store.read()).value.jobs.find(job => job.id === id);
      receipt.status = current.status === 'completed' ? 'completed' : error.code === 'cancelled' ? 'cancelled' : 'requires_action'; receipt.error = String(error.message).slice(0, 1000); receipt.finishedAt = timestamp(); await receiptStore.replace(receipt);
      if (current.status !== 'completed') await update({ status: receipt.status, error: receipt.error, finishedAt: timestamp() });
      throw fail(`原生成已保留，下载恢复未完成：${error.message}`, error.code === 'cancelled' ? 'cancelled' : 'requires_action');
    }
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
      state.jobs.push({ id, kind, taskId, runId, inputHash, directory: outputDir, status: 'preparing', createdAt: timestamp(), platform: input.platform, ratio: input.ratio || '9:16', ...(kind === 'wan' ? { title: input.title, caption: input.prompt, requestedDuration: input.duration } : {}) });
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
          await writeFile(join(directory, 'sources.json'), JSON.stringify({ productId: input.product.id, originalTitle: input.product.originalTitle, inputImages: input.product.images }, null, 2), { flag: 'wx' });
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
      // Recovery is GET-only and requires an already-returned FileData. Never
      // call the generator again, even if recovery fails or the process exits.
      const downloadFailure = remoteUnknown && !context.signal?.aborted && receipt?.status === 'unknown' && receipt?.video_produced === false
        && receipt.download_url && ['URLError', 'HTTPError', 'TimeoutError', 'ConnectionResetError', 'ConnectionError', 'SSLError'].includes(receipt.error_type);
      if (downloadFailure) {
        try {
          returnedWanFile(receipt);
          return await this.recoverWan({ taskId }, context, { automatic: true, ffmpeg });
        } catch (recoveryError) {
          if (recoveryError.code === 'cancelled') throw recoveryError;
          throw fail(`原生成结果已保留，仅下载恢复未完成；未重新提交：${recoveryError.message}`, 'uncertain');
        }
      }
      throw fail(remoteUnknown ? `生成结果需核实，未重试：${error.message}` : error.message, status);
    }
  }
}
