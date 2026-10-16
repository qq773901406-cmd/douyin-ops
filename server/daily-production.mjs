import { realpath, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, relative, isAbsolute, sep, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { renderProductVideo } from './product-video.mjs';
import { shanghaiDay } from '../shared/automation-model.mjs';
import { syncProductReports } from './product-source.mjs';
import { newVideo } from '../workbuddy/connector/lib/video-projects.mjs';

const timestamp = () => new Date().toISOString();
const fail = message => Object.assign(new Error(message), { status: 409 });
const active = ['selecting', 'rendering', 'publishing'];
const hash = async path => { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); };
const defaults = () => ({ version: 1, config: { enabled: false, startTime: '06:00', accountId: '', browserId: '', authorizedAt: '', firstDay: '', sourceFolder: '' }, runs: [], lastSync: null });
function validate(state) {
  if (state?.version !== 1 || typeof state.config?.enabled !== 'boolean' || state.config.startTime !== '06:00' || !Array.isArray(state.runs)) throw new Error('每日生产记录格式不正确，请保留原文件。');
  if (state.config.enabled && (!state.config.authorizedAt || !state.config.accountId || !state.config.browserId || !/^\d{4}-\d{2}-\d{2}$/.test(state.config.firstDay))) throw new Error('每日生产缺少账号或启用记录。');
  const ids = new Set();
  if (state.config.sourceFolder !== undefined && typeof state.config.sourceFolder !== 'string') throw new Error('日报来源目录格式无效。');
  for (const run of state.runs) {
    if (!run?.id || ids.has(run.id) || !['selecting', 'rendering', 'publishing', 'preview', 'submitted', 'published', 'failed', 'uncertain', 'skipped'].includes(run.status)) throw new Error('每日生产运行记录无效。');
    ids.add(run.id);
  }
  return state;
}
const keyFor = product => String(product.title || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

// This service selects from real saved products. A connected source must populate
// the workspace; the scheduler never invents inventory or market statistics.
export class DailyProduction {
  constructor(runtimeDir, workspace, automation) {
    this.directory = join(runtimeDir, 'daily-production');
    this.store = new JsonStore(join(this.directory, 'state.json'), defaults(), validate);
    this.workspace = workspace; this.automation = automation;
    this.inbox = join(runtimeDir, 'product-inbox'); this.uploads = join(runtimeDir, 'uploads');
    this.busy = false; this.stopping = false; this.timer = null; this.error = '';
  }
  async candidates(state) {
    const { value } = await this.workspace.read();
    const used = new Set(state.runs.filter(r => ['submitted', 'published', 'uncertain', 'publishing'].includes(r.status)).map(r => r.productKey));
    return value.products.filter(p => p.status !== 'archived' && p.images?.some(image => isAbsolute(image.path) && /\.(png|jpe?g|webp)$/i.test(image.path)) && !used.has(keyFor(p)))
      .sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready') || String(b.sourceDate || '').localeCompare(String(a.sourceDate || '')) || String(a.id).localeCompare(String(b.id)));
  }
  async snapshot() {
    const { value, revision } = await this.store.read();
    const config = { ...value.config, sourceFolder: value.config.sourceFolder || this.inbox };
    const eligible = (await this.candidates(value)).length;
    const today = shanghaiDay(Date.now());
    const nextDay = config.firstDay > today ? config.firstDay : Date.now() < Date.parse(`${today}T06:00:00+08:00`) ? today : shanghaiDay(Date.now() + 86400000);
    return { ...value, config, revision, eligible, busy: this.busy, error: this.error, nextRunAt: config.enabled ? `${nextDay}T06:00:00+08:00` : '',
      source: '本地选品日报＋商品库', sourceConnected: !!value.lastSync, sourceMessage: `每天开工前自动同步日报目录：${config.sourceFolder}。1688 联网采集尚未接入。`,
      metricsMessage: '播放量和互动数据尚未自动回采；提交成功不代表平台审核通过。' };
  }
  async source(input, revision) {
    if (!revision) throw fail('请刷新后重试。');
    const folder = String(input.folder || '').trim() || this.inbox;
    if (!isAbsolute(folder) || /^\\\\/.test(folder)) throw fail('请选择本机日报目录的完整路径。');
    if (resolve(folder) === resolve(this.inbox)) await mkdir(this.inbox, { recursive: true });
    const resolved = await realpath(folder).catch(() => { throw fail('日报目录不存在。'); });
    if (!(await stat(resolved)).isDirectory()) throw fail('来源必须是文件夹。');
    if (this.busy) throw fail('请等当前任务完成后再更换来源。');
    this.busy = true; let release;
    try {
      release = await this.automation.lease();
      await this.store.update(state => {
        if (state.runs.some(r => active.includes(r.status))) throw fail('请等当前任务完成后再更换来源。');
        if (resolve(state.config.sourceFolder || this.inbox) !== resolved) { state.config.enabled = false; state.config.authorizedAt = ''; state.lastSync = null; }
        state.config.sourceFolder = resolved;
      }, revision);
    } finally { try { if (release) await release(); } finally { this.busy = false; } }
  }
  async syncSource() {
    const current = (await this.store.read()).value;
    const folder = current.config.sourceFolder || this.inbox;
    if (resolve(folder) === resolve(this.inbox)) await mkdir(this.inbox, { recursive: true });
    const result = await syncProductReports(folder, this.uploads, this.workspace);
    await this.store.update(state => { state.lastSync = { ...result, folder }; });
    return result;
  }
  async sync(revision) {
    if (revision !== (await this.store.read()).revision) throw fail('记录已有更新，请刷新。');
    if (this.busy) throw fail('任务正在运行，请稍后同步。');
    this.busy = true; let release;
    try { release = await this.automation.lease(); await this.syncSource(); this.error = ''; }
    finally { try { if (release) await release(); } finally { this.busy = false; } }
  }
  async connect(input, revision) {
    if (revision !== (await this.store.read()).revision) throw fail('记录已有更新，请刷新。');
    if (this.busy) throw fail('任务正在运行，请稍后绑定账号。');
    this.busy = true; let release;
    try {
      release = await this.automation.lease();
      let queue = await this.automation.store.read();
      if (queue.value.config.enabled || queue.value.items.some(i => ['running', 'approved', 'uncertain'].includes(i.status))) throw fail('请先处理原每日发布队列中的已批准或待核实任务。');
      const browsers = await this.automation.browsers();
      const requested = String(input.browserId || queue.value.config.browserId || '');
      const selected = requested ? browsers.find(b => b.id === requested) : browsers.length === 1 ? browsers[0] : null;
      if (!selected) throw fail('请在下拉列表选择已连接的浏览器；只有一个连接时会自动选择。');
      await this.automation.settings({ ...queue.value.config, browserId: selected.id }, queue.revision);
      queue = await this.automation.store.read();
      const account = await this.automation.connect(queue.revision);
      await this.store.update(state => {
        if (state.runs.some(r => active.includes(r.status))) throw fail('已有生产任务运行，请稍后绑定。');
        if (state.config.accountId !== account.accountId || state.config.browserId !== selected.id) state.config.enabled = false;
        Object.assign(state.config, { accountId: account.accountId, browserId: selected.id });
      }, revision);
    } finally { try { if (release) await release(); } finally { this.busy = false; } }
  }
  async reconcile(input, revision) {
    if (!revision || input.confirmed !== true || !['published', 'not-published'].includes(input.result)) throw fail('请确认已在抖音核实实际结果。');
    let url;
    if (input.result === 'published') {
      try { url = new URL(String(input.url || '')); } catch {}
      if (!url || url.protocol !== 'https:' || url.username || url.password || !['www.douyin.com', 'douyin.com', 'v.douyin.com'].includes(url.hostname)) throw fail('请填写核实后的抖音作品链接。');
    }
    await this.store.update(state => {
      const run = state.runs.find(r => r.id === input.id);
      if (!run || !['uncertain', 'submitted'].includes(run.status) || this.busy) throw fail('此任务当前不能核实，请刷新。');
      run.status = input.result === 'published' ? 'published' : 'failed';
      run.reconciledAt = timestamp(); run.reconciledResult = input.result;
      run.publishedUrl = url?.href || '';
      run.message = input.result === 'published' ? '用户已核实作品发布成功。' : '用户确认完全未发布；不会立即重发，重新开启计划后等待下一天。';
      if (input.result === 'not-published') state.config.enabled = false;
    }, revision);
    await this.mirrorRun(input.id);
  }
  async mirrorRun(id) {
    const run = (await this.store.read()).value.runs.find(r => r.id === id);
    if (!run?.draftId) return;
    try {
      await this.workspace.update(state => {
        const draft = state.drafts.find(d => d.id === run.draftId && d.sourceProductionId === id);
        if (!draft) return;
        draft.productionStatus = run.status; draft.productionMessage = run.message; draft.updatedAt = timestamp();
        draft.status = run.status === 'published' ? '已发布' : '待检查';
        if (run.status === 'published') { draft.publishedAt = run.reconciledAt; draft.publishedUrl = run.publishedUrl; }
      });
    } catch { this.error = '执行回执已保存，但发布计划同步失败；请以每日生产页面为准。'; }
  }
  async toggle(input, revision) {
    if (!revision) throw fail('请刷新后重试。');
    if (typeof input.enabled !== 'boolean') throw fail('开关值无效。');
    let binding;
    if (input.enabled) {
      if (!this.timer || this.stopping) throw fail('每日生产调度尚未就绪，请先处理服务启动错误。');
      if (input.authorized !== true) throw fail('请确认每天自动制作并公开发布 1 条商品介绍视频。');
      const queue = (await this.automation.store.read()).value;
      if (queue.config.enabled || queue.items.some(i => ['running', 'uncertain', 'approved'].includes(i.status))) throw fail('请先暂停每日视频队列并处理已批准或待核实任务，避免两个计划重复发布。');
      binding = queue.config;
      if (!binding.accountId || !binding.browserId || !binding.verifiedAt) throw fail('请先点击“自动识别抖音账号”。');
      const current = (await this.store.read()).value;
      if (current.config.accountId !== binding.accountId || current.config.browserId !== binding.browserId) throw fail('发布账号设置已变化，请重新识别并核对账号后再开启。');
      if (!(await this.candidates(current)).length) throw fail('没有可用商品：请先接入选品来源，或导入带商品图的日报。');
    }
    await this.store.update(state => {
      if (input.enabled && state.runs.some(r => active.includes(r.status) || r.status === 'uncertain')) throw fail('请先处理正在运行或结果待核实的任务。');
      if (input.enabled) {
        if (state.config.enabled) return;
        const day = shanghaiDay(Date.now());
        const firstDay = Date.now() < Date.parse(`${day}T06:00:00+08:00`) ? day : shanghaiDay(Date.now() + 86400000);
        Object.assign(state.config, { accountId: binding.accountId, browserId: binding.browserId, firstDay, authorizedAt: timestamp() });
      }
      state.config.enabled = input.enabled;
    }, revision);
  }
  async start() {
    if (this.timer) return;
    this.stopping = false;
    const current = (await this.store.read()).value;
    if (current.runs.some(r => active.includes(r.status))) {
      const release = await this.automation.lease();
      try {
        await this.store.update(state => {
          for (const run of state.runs.filter(r => active.includes(r.status))) {
            run.status = run.submitStartedAt ? 'uncertain' : 'failed';
            run.message = '上次运行中断，已暂停；提交结果待核实时不能自动重试。'; run.finishedAt = timestamp();
            state.config.enabled = false;
          }
        });
      } finally { await release(); }
    }
    this.timer = setInterval(() => { void this.run(false).catch(error => { this.error = error.message; }); }, 30000);
    this.timer.unref();
  }
  stop() { this.stopping = true; clearInterval(this.timer); this.timer = null; }
  async preview(revision) {
    const state = await this.store.read();
    if (revision !== state.revision) throw fail('记录已有更新，请刷新后重试。');
    if (this.busy) throw fail('已有任务正在运行。');
    // This entry point only renders. It never enables publishing.
    void this.run(true).catch(error => { this.error = error.message; });
  }
  async media(id) {
    const run = (await this.store.read()).value.runs.find(r => r.id === id);
    if (!run?.asset) throw fail('此任务还没有成片。');
    const path = await realpath(run.asset), root = await realpath(this.directory), rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw fail('视频路径无效。');
    return { directory: root, path };
  }
  async mediaByPath(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) return null;
    const rel = relative(this.directory, path);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
    const run = (await this.store.read()).value.runs.find(r => r.asset && resolve(r.asset) === resolve(path));
    return run ? this.media(run.id) : null;
  }
  async run(previewOnly = false) {
    if (this.busy || this.stopping) return;
    this.busy = true;
    let release, target;
    try {
      const saved = (await this.store.read()).value;
      const day = shanghaiDay(Date.now()), due = Date.parse(`${day}T06:00:00+08:00`);
      if (!previewOnly && (!saved.config.enabled || day < saved.config.firstDay || Date.now() < due || saved.runs.some(r => !r.previewOnly && r.day === day))) return;
      // Share the publisher lease with the manually approved queue across processes.
      release = await this.automation.lease();
      await this.store.update(state => {
        if (state.runs.some(r => active.includes(r.status) || r.status === 'uncertain')) throw fail('有运行中或结果待核实的任务，已停止。');
        if (!previewOnly && (!state.config.enabled || state.runs.some(r => !r.previewOnly && r.day === day))) return;
        target = { id: randomUUID(), day, previewOnly, status: 'selecting', startedAt: timestamp(), message: '正在从商品库选择未发布商品。', binding: structuredClone(state.config) };
        state.runs.push(target); target = structuredClone(target);
      });
      if (!target) return;
      const update = async patch => { await this.store.update(state => { Object.assign(state.runs.find(r => r.id === target.id), patch); }); Object.assign(target, patch); };
      if (!previewOnly && Date.now() - due > 6 * 3600000) { await update({ status: 'skipped', message: '超过当天上午的运行窗口，今天不补发。', finishedAt: timestamp() }); return; }
      const guard = async () => {
        const state = (await this.store.read()).value;
        if (this.stopping || (!previewOnly && (!state.config.enabled || state.config.authorizedAt !== target.binding.authorizedAt))) throw fail('每日生产已暂停或配置发生变化。');
        if (!previewOnly && shanghaiDay(Date.now()) !== day) throw fail('已跨日，停止本次发布。');
        if (!previewOnly) {
          const queue = (await this.automation.store.read()).value;
          if (queue.config.enabled || queue.config.accountId !== target.binding.accountId || queue.config.browserId !== target.binding.browserId) throw fail('另一个发布计划已开启或账号设置变化，已停止。');
        }
      };
      await guard();
      await update({ message: '正在同步选品日报和商品图片。' });
      const sourceResult = await this.syncSource();
      await update({ sourceResult });
      const candidates = await this.candidates((await this.store.read()).value);
      const product = candidates[0];
      if (!product) throw fail('没有尚未发布且带本地图片的商品。请把新日报放入来源目录，或在电商选品中导入商品。');
      await guard();
      await update({ status: 'rendering', productId: product.id, productKey: keyFor(product), title: product.title, message: '正在用本地图片合成竖屏字幕视频。' });
      const rendered = await renderProductVideo(product, join(this.directory, 'videos'));
      await update({ ...rendered, sha256: await hash(rendered.asset) });
      const videoId = randomUUID(), draftId = randomUUID();
      await this.workspace.update(state => {
        state.videos.push({ ...newVideo(), id: videoId, title: rendered.title, subject: product.title, asset: rendered.asset, status: 'completed', provider: '本地图片字幕合成', cost: '0', sourceProductId: product.id, createdAt: timestamp(), updatedAt: timestamp(), shots: [{ seconds: rendered.seconds, action: '按商品图片依次展示商品资料，字幕来自保存的中文文案。', camera: '竖屏商品展示' }] });
        state.drafts.push({ id: draftId, title: rendered.title, pubTitle: rendered.title, caption: rendered.caption, asset: rendered.asset, platform: 'douyin', format: '视频', status: '待检查', sourceProductId: product.id, sourceVideoId: videoId, sourceProductionId: target.id, createdAt: timestamp(), updatedAt: timestamp() });
      });
      await update({ videoId, draftId });
      await guard();
      if (previewOnly) { await update({ status: 'preview', message: '成片已生成，仅预览，没有发布。', finishedAt: timestamp() }); return; }
      const queue = (await this.automation.store.read()).value;
      if (queue.config.enabled || queue.config.accountId !== target.binding.accountId || queue.config.browserId !== target.binding.browserId || queue.items.some(i => ['running', 'uncertain'].includes(i.status) || ['submitted', 'published'].includes(i.status) && i.approval?.accountId === target.binding.accountId && shanghaiDay(Date.parse(i.startedAt || i.scheduledAt)) === day)) throw fail('账号设置变化、旧队列启用，或今天已有发布记录，已停止。');
      await update({ status: 'publishing', message: '正在上传并公开发布商品介绍视频。' });
      const approval = { ...rendered, accountId: target.binding.accountId, browserId: target.binding.browserId };
      const beforeSubmit = async () => { await guard(); if (await hash(rendered.asset) !== target.sha256) throw fail('视频文件发生变化，已停止。'); await update({ submitStartedAt: timestamp(), message: '正在单次提交；结果不明时禁止自动重发。' }); };
      const result = await this.automation.publisher.publish({ approval }, { guard, beforeSubmit });
      await update({ status: 'submitted', message: result.message, evidence: result.evidence, finishedAt: timestamp() });
      this.error = '';
    } catch (error) {
      this.error = error.message;
      if (target) await this.store.update(state => {
        const run = state.runs.find(r => r.id === target.id);
        run.status = run.submitStartedAt ? 'uncertain' : 'failed'; run.message = error.message; run.finishedAt = timestamp();
        if (!previewOnly) state.config.enabled = false;
      });
      else throw error;
    } finally { try { if (target) await this.mirrorRun(target.id); } finally { try { if (release) await release(); } finally { this.busy = false; } } }
  }
}
