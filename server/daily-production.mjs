import { realpath, mkdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute, sep, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { renderProductVideo, inspectProductVideoEnvironment, usableProductImages } from './product-video.mjs';
import { shanghaiDay } from '../shared/automation-model.mjs';
import { syncProductReports } from './product-source.mjs';
import { newVideo } from '../workbuddy/connector/lib/video-projects.mjs';
import { hashFile } from '../lib/fs-utils.mjs';
import { collectNews, defaultNewsFeed, validateNewsSettings } from './news-source.mjs';
import { renderNewsVideo, selectNewsForVideo } from './news-video.mjs';

const timestamp = () => new Date().toISOString();
const fail = message => Object.assign(new Error(message), { status: 409 });
const active = ['selecting', 'rendering', 'publishing'];
const DAILY_TICK_INTERVAL_MS = 30000;
// Persist and calculate daily boundaries in Shanghai time.
const dayStartISO = (day, startTime = '06:00') => `${day}T${startTime}:00+08:00`;
const defaults = () => ({ version: 1, config: { enabled: false, startTime: '06:00', accountId: '', browserId: '', authorizedAt: '', firstDay: '', sourceFolder: '', sourceMode: 'news', newsFeedUrl: defaultNewsFeed, newsKeywords: '' }, runs: [], lastSync: null, newsLastSync: null, newsItems: [] });
function validate(state) {
  if (state?.version !== 1 || typeof state.config?.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(state.config.startTime) || !Array.isArray(state.runs)) throw new Error('每日生产记录格式不正确，请保留原文件。');
  if (state.config.enabled && (!state.config.authorizedAt || !state.config.accountId || !state.config.browserId || !/^\d{4}-\d{2}-\d{2}$/.test(state.config.firstDay))) throw new Error('每日生产缺少账号或启用记录。');
  const ids = new Set();
  if (state.config.sourceFolder !== undefined && typeof state.config.sourceFolder !== 'string') throw new Error('日报来源目录格式无效。');
  // Existing product schedules retain their original authorization and source.
  state.config.sourceMode ??= 'products';
  state.config.newsFeedUrl ??= defaultNewsFeed;
  state.config.newsKeywords ??= '';
  state.newsItems ??= [];
  if (!['products', 'news'].includes(state.config.sourceMode) || !Array.isArray(state.newsItems) || state.newsItems.length > 120) throw new Error('每日内容来源格式无效。');
  validateNewsSettings({ feedUrl: state.config.newsFeedUrl, keywords: state.config.newsKeywords });
  if (state.newsItems.some(item => !item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.url !== 'string' || !Number.isFinite(Date.parse(item.publishedAt)))) throw new Error('已采集资讯格式无效，请保留原文件检查。');
  for (const run of state.runs) {
    if (!run?.id || ids.has(run.id) || !['selecting', 'rendering', 'publishing', 'preview', 'submitted', 'published', 'failed', 'uncertain', 'skipped'].includes(run.status)) throw new Error('每日生产运行记录无效。');
    ids.add(run.id);
  }
  return state;
}
const keyFor = product => String(product.title || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const articleKey = item => {
  try { const url = new URL(item.url); url.hash = ''; return url.href; }
  catch { return String(item.url || ''); }
};

// News and product modes share one daily limit, publisher lease and receipt ledger.
export class DailyProduction {
  constructor(runtimeDir, workspace, automation) {
    this.directory = join(runtimeDir, 'daily-production');
    this.store = new JsonStore(join(this.directory, 'state.json'), defaults(), validate);
    this.workspace = workspace; this.automation = automation;
    this.inbox = join(runtimeDir, 'product-inbox'); this.uploads = join(runtimeDir, 'uploads');
    this.busy = false; this.stopping = false; this.timer = null; this.error = ''; this.environment = null;
  }
  async candidates(state) {
    if (state.config.sourceMode === 'news') {
      const usedRuns = state.runs.filter(run => ['submitted', 'published', 'uncertain', 'publishing'].includes(run.status));
      const used = new Set(usedRuns.flatMap(run => run.newsItemIds || []));
      const usedUrls = new Set(usedRuns.flatMap(run => run.sourceArticles || []).map(articleKey));
      const seenUrls = new Set();
      const now = Date.now();
      return (state.newsItems || []).filter(item => item.sourceUrl === state.config.newsFeedUrl && !used.has(item.id) && !usedUrls.has(articleKey(item)) && Date.parse(item.publishedAt) >= now - 48 * 3600000 && Date.parse(item.publishedAt) <= now + 10 * 60000)
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .filter(item => { const key = articleKey(item); if (seenUrls.has(key)) return false; seenUrls.add(key); return true; });
    }
    const { value } = await this.workspace.read();
    const used = new Set(state.runs.filter(r => ['submitted', 'published', 'uncertain', 'publishing'].includes(r.status)).map(r => r.productKey));
    return value.products.filter(p => p.status !== 'archived' && p.images?.some(image => isAbsolute(image.path) && /\.(png|jpe?g|webp)$/i.test(image.path)) && !used.has(keyFor(p)))
      .sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready') || String(b.sourceDate || '').localeCompare(String(a.sourceDate || '')) || String(a.id).localeCompare(String(b.id)));
  }
  async snapshot() {
    const { value, revision } = await this.store.read();
    const config = { ...value.config, sourceFolder: value.config.sourceFolder || this.inbox };
    const eligible = (await this.candidates(value)).length;
    const now = Date.now(), today = shanghaiDay(now), due = Date.parse(dayStartISO(today, config.startTime));
    const todayRun = value.runs.findLast(run => !run.previewOnly && run.day === today) || null;
    const running = value.runs.some(run => active.includes(run.status));
    const windowOpen = now <= due + 6 * 3600000;
    const nextDay = config.firstDay > today ? config.firstDay : !todayRun && windowOpen ? today : shanghaiDay(now + 86400000);
    const scheduleState = running ? 'running' : !config.enabled ? 'paused' : todayRun ? 'done'
      : config.firstDay > today || now < due ? 'waiting' : windowOpen ? 'due' : 'missed';
    const newsMode = config.sourceMode === 'news';
    return { ...value, config, revision, eligible, todayRun, scheduleState, busy: this.busy || running, error: this.error, environment: this.environment,
      lastSync: newsMode ? value.newsLastSync : value.lastSync,
      readiness: await this.readiness(value, eligible), nextRunAt: config.enabled ? dayStartISO(nextDay, config.startTime) : '',
      source: newsMode ? '公开 RSS / Atom 资讯' : '本地选品日报＋商品库', sourceConnected: !!(newsMode ? value.newsLastSync : value.lastSync),
      sourceMessage: newsMode ? `每天采集 ${config.newsFeedUrl} 最近 48 小时的资讯标题与出处，去重后最多选 3 条制作一条视频；没有新资讯则跳过。当前不提供热度排名。` : `每天开工前自动同步日报目录：${config.sourceFolder}。1688 联网采集尚未接入。`,
      metricsMessage: '在效果追踪中核实并绑定作品后，每 15 分钟自动检查审核与可见指标；提交成功不代表平台审核通过。' };
  }
  async readiness(state, eligible) {
    const checks = [];
    const add = (id, label, condition, message, action) => checks.push({ id, label, state: condition, message, ...(action ? { action } : {}) });
    if (state.config.sourceMode === 'news') {
      add('source', '资讯来源', state.newsLastSync ? 'ok' : 'unknown', state.newsLastSync ? `上次成功采集：${state.newsLastSync.at}。实际开工时会重新采集。` : '已配置公开 RSS 来源，请先采集一次；打开本页不会自动访问网站。', 'sync');
      add('news', '待制作资讯', eligible ? 'ok' : 'warning', eligible ? `${eligible} 条尚未发布的近期资讯，将取最新最多 3 条。` : '暂无新的匹配资讯；开工时会再采集，仍为空则跳过当天。', 'sync');
    } else {
      const source = state.config.sourceFolder || this.inbox;
      let sourceExists = false;
      try { await access(source, constants.R_OK); sourceExists = (await stat(source)).isDirectory(); } catch {}
      add('source', '商品来源', sourceExists ? 'ok' : eligible ? 'warning' : 'blocked', sourceExists ? '来源目录可读取；开工前会同步新日报。' : eligible ? '来源目录暂不可用，可沿用商品库中的现有图片。' : '来源目录未准备好，先保存来源并同步商品。', 'sync');
      add('products', '待制作商品', eligible ? 'ok' : 'blocked', eligible ? `${eligible} 款待选商品；开工时再检查图片文件。` : '暂无带本地图片的未发布商品，请同步日报或导入商品。', 'shop');
    }
    add('renderer', '本地视频合成', this.environment ? this.environment.ok ? 'ok' : 'blocked' : 'unknown', this.environment?.message || '尚未检查 Python、字体和视频编码器；开启计划前会自动检查。', 'check');
    try {
      const queue = (await this.automation.store.read()).value;
      const bound = state.config.accountId && queue.config.verifiedAt && state.config.accountId === queue.config.accountId && state.config.browserId === queue.config.browserId;
      add('account', '抖音账号', bound ? 'ok' : 'blocked', bound ? '账号绑定一致；实际发布前仍会核对登录状态。' : '尚未识别账号，或浏览器及账号配置已变化。', 'connect');
      const conflict = queue.config.enabled || queue.items.some(item => ['running', 'approved', 'uncertain'].includes(item.status));
      add('queue', '发布队列', conflict ? 'blocked' : 'ok', conflict ? '原每日发布队列仍启用，或存在已批准、运行中、待核实任务。' : '原每日发布队列没有冲突任务。', 'automation');
    } catch {
      add('queue', '发布队列', 'blocked', '无法读取发布账号或队列记录，请检查每日自动发布页面。', 'automation');
    }
    const uncertain = state.runs.some(run => run.status === 'uncertain');
    add('receipts', '发布结果', uncertain ? 'blocked' : 'ok', uncertain ? '有提交结果不明的任务，请先核实，系统不会自动重发。' : '没有结果不明的提交。', 'reconcile');
    add('scheduler', '本地调度', this.timer && !this.stopping ? 'ok' : 'blocked', this.timer && !this.stopping ? '调度已启动；电脑与本地服务需要保持运行。' : '调度尚未启动，请查看服务日志并重启服务。');
    return { checkedAt: timestamp(), canEnable: !this.busy && !state.runs.some(run => active.includes(run.status)) && !checks.some(check => check.state === 'blocked'), checks };
  }
  async check(revision) {
    if (revision !== (await this.store.read()).revision) throw fail('记录已有更新，请刷新。');
    if (this.busy) throw fail('任务正在处理，请完成后再检查。');
    this.busy = true;
    try { this.environment = await inspectProductVideoEnvironment(); }
    finally { this.busy = false; }
  }
  async schedule(input, revision) {
    if (!revision || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime || '')) throw fail('请选择有效的每日开工时间。');
    if (this.busy) throw fail('请等当前任务完成后再调整时间。');
    this.busy = true; let release;
    try {
      release = await this.automation.lease();
      await this.store.update(state => {
        if (state.runs.some(run => active.includes(run.status))) throw fail('有任务正在运行，暂不能调整时间。');
        if (state.config.startTime === input.startTime) return;
        Object.assign(state.config, { startTime: input.startTime, enabled: false, authorizedAt: '', firstDay: '' });
      }, revision);
    } finally { try { if (release) await release(); } finally { this.busy = false; } }
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
  async contentSource(input, revision) {
    if (!revision || !['news', 'products'].includes(input.mode)) throw fail('请选择资讯视频或商品介绍模式。');
    const settings = input.mode === 'news' ? validateNewsSettings({ feedUrl: input.feedUrl, keywords: input.keywords }) : null;
    if (this.busy) throw fail('请等当前任务完成后再更换内容来源。');
    this.busy = true; let release;
    try {
      release = await this.automation.lease();
      await this.store.update(state => {
        if (state.runs.some(run => active.includes(run.status))) throw fail('已有生产任务正在运行。');
        const changed = state.config.sourceMode !== input.mode || settings && (state.config.newsFeedUrl !== settings.feedUrl || state.config.newsKeywords !== settings.keywords);
        if (!changed) return;
        Object.assign(state.config, { sourceMode: input.mode, enabled: false, authorizedAt: '', firstDay: '' });
        if (settings) Object.assign(state.config, { newsFeedUrl: settings.feedUrl, newsKeywords: settings.keywords });
        state.newsItems = []; state.newsLastSync = null;
      }, revision);
      this.error = '';
    } finally { try { if (release) await release(); } finally { this.busy = false; } }
  }
  async syncSource() {
    const current = (await this.store.read()).value;
    if (current.config.sourceMode === 'news') {
      const collected = await collectNews({ feedUrl: current.config.newsFeedUrl, keywords: current.config.newsKeywords }, join(this.directory, 'news-source'));
      const known = new Set((current.newsItems || []).map(articleKey));
      const result = { at: collected.at, scanned: collected.items.length, added: collected.items.filter(item => !known.has(articleKey(item))).length, existing: collected.items.filter(item => known.has(articleKey(item))).length, warnings: collected.warnings, feedTitle: collected.feedTitle, feedUrl: current.config.newsFeedUrl };
      await this.store.update(state => {
        if (state.config.sourceMode !== 'news' || state.config.newsFeedUrl !== current.config.newsFeedUrl || state.config.newsKeywords !== current.config.newsKeywords) throw fail('资讯来源已变化，请重新采集。');
        const merged = new Map((state.newsItems || []).map(item => [articleKey(item), item]));
        for (const item of collected.items) merged.set(articleKey(item), { ...item, sourceUrl: current.config.newsFeedUrl });
        state.newsItems = [...merged.values()].filter(item => Date.parse(item.publishedAt) >= Date.now() - 48 * 3600000).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 120);
        state.newsLastSync = result;
      });
      return result;
    }
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
      const requested = String(input.browserId || '');
      const selected = requested ? browsers.find(b => b.id === requested)
        : browsers.find(b => b.id === queue.value.config.browserId) || (browsers.length === 1 ? browsers[0] : null);
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
    } catch (error) { this.error = '执行回执已保存，但发布计划同步失败；请以每日生产页面为准。'; console.warn('发布计划同步失败：', error?.message || error); }
  }
  async toggle(input, revision) {
    if (!revision) throw fail('请刷新后重试。');
    if (typeof input.enabled !== 'boolean') throw fail('开关值无效。');
    let binding;
    if (input.enabled) {
      if (this.busy) throw fail('任务正在处理，请完成后再开启。');
      if (!this.timer || this.stopping) throw fail('每日生产调度尚未就绪，请先处理服务启动错误。');
      if (input.authorized !== true) throw fail('请确认每天按当前内容来源自动制作并公开发布 1 条视频。');
      const queue = (await this.automation.store.read()).value;
      if (queue.config.enabled || queue.items.some(i => ['running', 'uncertain', 'approved'].includes(i.status))) throw fail('请先暂停每日视频队列并处理已批准或待核实任务，避免两个计划重复发布。');
      binding = queue.config;
      if (!binding.accountId || !binding.browserId || !binding.verifiedAt) throw fail('请先点击“自动识别抖音账号”。');
      const current = (await this.store.read()).value;
      if (current.config.accountId !== binding.accountId || current.config.browserId !== binding.browserId) throw fail('发布账号设置已变化，请重新识别并核对账号后再开启。');
      if (current.config.sourceMode === 'news') {
        if (!current.newsLastSync) throw fail('请先采集一次资讯，确认来源可以读取。');
      } else if (!(await this.candidates(current)).length) throw fail('没有可用商品：请先接入选品来源，或导入带商品图的日报。');
      await this.check(revision);
      if (!this.environment.ok) throw fail(this.environment.message);
    }
    await this.store.update(state => {
      if (input.enabled && state.runs.some(r => active.includes(r.status) || r.status === 'uncertain')) throw fail('请先处理正在运行或结果待核实的任务。');
      if (input.enabled) {
        if (state.config.enabled) return;
        const day = shanghaiDay(Date.now());
        const firstDay = Date.now() < Date.parse(dayStartISO(day, state.config.startTime)) ? day : shanghaiDay(Date.now() + 86400000);
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
    this.timer = setInterval(() => { void this.run(false).catch(error => { this.error = error.message; }); }, DAILY_TICK_INTERVAL_MS);
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
      const day = shanghaiDay(Date.now()), due = Date.parse(dayStartISO(day, saved.config.startTime));
      if (!previewOnly && (!saved.config.enabled || day < saved.config.firstDay || Date.now() < due || saved.runs.some(r => !r.previewOnly && r.day === day))) return;
      // Share the publisher lease with the manually approved queue across processes.
      release = await this.automation.lease();
      await this.store.update(state => {
        if (state.runs.some(r => active.includes(r.status) || r.status === 'uncertain')) throw fail('有运行中或结果待核实的任务，已停止。');
        if (!previewOnly && (!state.config.enabled || day < state.config.firstDay || Date.now() < Date.parse(dayStartISO(day, state.config.startTime)) || state.config.authorizedAt !== saved.config.authorizedAt || state.runs.some(r => !r.previewOnly && r.day === day))) return;
        target = { id: randomUUID(), day, previewOnly, sourceMode: state.config.sourceMode, status: 'selecting', startedAt: timestamp(), message: '正在准备当天的内容来源。', binding: structuredClone(state.config) };
        state.runs.push(target); target = structuredClone(target);
      });
      if (!target) return;
      const update = async patch => { await this.store.update(state => { Object.assign(state.runs.find(r => r.id === target.id), patch); }); Object.assign(target, patch); };
      if (!previewOnly && Date.now() - due > 6 * 3600000) { await update({ status: 'skipped', message: '超过计划开工时间 6 小时，今天不补发。', finishedAt: timestamp() }); return; }
      const guard = async () => {
        const state = (await this.store.read()).value;
        if (['sourceMode', 'newsFeedUrl', 'newsKeywords', 'sourceFolder'].some(key => state.config[key] !== target.binding[key])) throw fail('内容来源已变化，停止本次任务。');
        if (this.stopping || (!previewOnly && (!state.config.enabled || state.config.authorizedAt !== target.binding.authorizedAt || state.config.startTime !== target.binding.startTime))) throw fail('每日生产已暂停或配置发生变化。');
        if (!previewOnly && shanghaiDay(Date.now()) !== day) throw fail('已跨日，停止本次发布。');
        if (!previewOnly) {
          const queue = (await this.automation.store.read()).value;
          if (queue.config.enabled || queue.config.accountId !== target.binding.accountId || queue.config.browserId !== target.binding.browserId) throw fail('另一个发布计划已开启或账号设置变化，已停止。');
        }
      };
      await guard();
      const newsMode = target.sourceMode === 'news';
      await update({ message: newsMode ? '正在采集近期资讯标题与出处。' : '正在同步选品日报和商品图片。' });
      let sourceResult;
      const warnings = [];
      try { sourceResult = await this.syncSource(); }
      catch (error) {
        if (!(await this.candidates((await this.store.read()).value)).length) {
          if (!newsMode) throw error;
          await update({ status: 'skipped', message: '资讯来源暂不可用，且没有近期缓存，本次不发布；计划开启时下个执行日再采集。', warnings: [error.message], finishedAt: timestamp() });
          this.error = ''; return;
        }
        warnings.push(`${newsMode ? '资讯采集未完成，沿用 48 小时内的缓存' : '日报同步未完成，沿用已有商品库'}：${error.message}`);
      }
      if (sourceResult) warnings.push(...sourceResult.warnings);
      await update({ ...(sourceResult ? { sourceResult } : {}), warnings: warnings.slice(0, 30) });
      const candidates = await this.candidates((await this.store.read()).value);
      let product, rendered, articles = [];
      if (newsMode) {
        const selection = selectNewsForVideo(candidates, { day });
        articles = selection.items;
        warnings.push(...selection.warnings);
        await update({ warnings: warnings.slice(0, 30) });
        if (!articles.length) {
          await update({ status: 'skipped', message: candidates.length ? '本次资讯的标题或出处无法完整排入视频及文案，已跳过；详情见处理提示。计划开启时下个执行日继续采集。' : '最近 48 小时没有尚未发布的匹配资讯，本次跳过，不重复发布；计划开启时下个执行日继续采集。', finishedAt: timestamp() });
          this.error = ''; return;
        }
        await guard();
        await update({ status: 'rendering', title: `${day} 资讯速览`, newsItemIds: articles.map(item => item.id), sourceArticles: articles, message: `已选择 ${articles.length} 条资讯，正在制作原创排版的信息卡与字幕。` });
        rendered = await renderNewsVideo(articles, join(this.directory, 'videos'), { day });
      } else {
        for (const candidate of candidates) {
          await guard();
          const usable = await usableProductImages(candidate);
          warnings.push(...usable.warnings.map(message => `${candidate.title}：${message}`));
          if (usable.images.length) { product = { ...candidate, images: usable.images }; break; }
        }
        await update({ warnings: warnings.slice(0, 30) });
        if (!product) throw fail('没有尚未发布且图片可读取的商品。请补充商品图片或同步新日报。');
        await guard();
        await update({ status: 'rendering', productId: product.id, productKey: keyFor(product), title: product.title, message: '正在用本地图片合成竖屏字幕视频。' });
        rendered = await renderProductVideo(product, join(this.directory, 'videos'));
      }
      await update({ ...rendered, sha256: await hashFile(rendered.asset) });
      const videoId = randomUUID(), draftId = randomUUID();
      const productLink = product ? { sourceProductId: product.id } : {};
      const notes = newsMode ? '公开资讯标题编排为原创信息卡画面，非现场画面，不含热度排名。\n' + articles.map(item => `${item.sourceName}：${item.title}\n${item.url}`).join('\n') : '';
      await this.workspace.update(state => {
        state.videos.push({ ...newVideo(), id: videoId, title: rendered.title, subject: product?.title || '每日资讯标题速览', notes, asset: rendered.asset, status: 'completed', provider: newsMode ? '本地资讯图卡字幕合成' : '本地图片字幕合成', cost: '0', ...productLink, createdAt: timestamp(), updatedAt: timestamp(), shots: [{ seconds: rendered.seconds, action: newsMode ? '按资讯逐条展示信息卡、标题、发布日期和来源，附字幕说明。' : '按商品图片依次展示商品资料，字幕来自保存的中文文案。', camera: newsMode ? '竖屏资讯图卡' : '竖屏商品展示' }] });
        state.drafts.push({ id: draftId, title: rendered.title, pubTitle: rendered.title, caption: rendered.caption, asset: rendered.asset, platform: 'douyin', format: '视频', status: '待检查', ...productLink, sourceVideoId: videoId, sourceProductionId: target.id, sourceMode: target.sourceMode, sourceArticles: articles, createdAt: timestamp(), updatedAt: timestamp() });
      });
      await update({ videoId, draftId });
      await guard();
      if (previewOnly) { await update({ status: 'preview', message: '成片已生成，仅预览，没有发布。', finishedAt: timestamp() }); this.error = ''; return; }
      const queue = (await this.automation.store.read()).value;
      if (queue.config.enabled || queue.config.accountId !== target.binding.accountId || queue.config.browserId !== target.binding.browserId || queue.items.some(i => ['running', 'uncertain'].includes(i.status) || ['submitted', 'published'].includes(i.status) && i.approval?.accountId === target.binding.accountId && shanghaiDay(Date.parse(i.startedAt || i.scheduledAt)) === day)) throw fail('账号设置变化、旧队列启用，或今天已有发布记录，已停止。');
      await update({ status: 'publishing', message: newsMode ? '正在上传并公开发布资讯卡片视频。' : '正在上传并公开发布商品介绍视频。' });
      const approval = { ...rendered, accountId: target.binding.accountId, browserId: target.binding.browserId };
      const beforeSubmit = async () => { await guard(); if (await hashFile(rendered.asset) !== target.sha256) throw fail('视频文件发生变化，已停止。'); await update({ submitStartedAt: timestamp(), message: '正在单次提交；结果不明时禁止自动重发。' }); };
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
