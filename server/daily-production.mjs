import { realpath, mkdir, stat, access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute, sep, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { renderProductVideo, inspectProductVideoEnvironment, usableProductImages } from './product-video.mjs';
import { shanghaiDay } from '../shared/automation-model.mjs';
import { syncProductReports } from './product-source.mjs';
import { newVideo } from '../workbuddy/connector/lib/video-projects.mjs';
import { hashFile } from '../lib/fs-utils.mjs';
import { collectNews, defaultNewsFeed, validateNewsSettings } from './news-source.mjs';
import { renderNewsVideo, selectNewsForVideo } from './news-video.mjs';
import { validatePetSettings } from './pet-video-pipeline.mjs';

const timestamp = () => new Date().toISOString();
const fail = message => Object.assign(new Error(message), { status: 409 });
const active = ['selecting', 'rendering', 'publishing'];
const DAILY_TICK_INTERVAL_MS = 30000;
const defaultPetSettings = () => ({ model: '', referenceUrls: [], firstFrames: [], visualBrief: '', duration: 20, audioMode: 'original-music' });
const productionMode = config => config.productionMode || 'cards';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const petSettingsDigest = config => digest(validatePetSettings(config.petSettings || defaultPetSettings()));
const productionChanged = (a, b) => productionMode(a) !== productionMode(b) || petSettingsDigest(a) !== petSettingsDigest(b);
const generationUncertain = run => run.generationState === 'uncertain';
const petSourceIdentity = source => {
  let url;
  try { url = new URL(source.url); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password) throw fail('萌宠参考缺少可核实的公开 HTTPS 来源。');
  url.hash = '';
  const content = [source.title, source.summary, ...(Array.isArray(source.paragraphs) ? source.paragraphs : [])]
    .filter(value => typeof value === 'string').map(value => value.normalize('NFKC').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!content.length || !Number.isFinite(Date.parse(source.observedAt))) throw fail('萌宠参考缺少实际采集文字或采集时间。');
  const contentHash = digest(content);
  return { url: url.href, contentHash, key: digest([url.href, contentHash]) };
};
// Persist and calculate daily boundaries in Shanghai time.
const dayStartISO = (day, startTime = '06:00') => `${day}T${startTime}:00+08:00`;
const defaults = () => ({ version: 1, config: { enabled: false, startTime: '06:00', executionMode: 'daily', executionDate: '', accountId: '', browserId: '', authorizedAt: '', firstDay: '', sourceFolder: '', sourceMode: 'news', newsFeedUrl: defaultNewsFeed, newsKeywords: '', productionMode: 'cards', petSettings: defaultPetSettings() }, runs: [], generationResolutions: [], lastSync: null, newsLastSync: null, newsItems: [], petSources: [], petLastSync: null });
const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
const submissionFields = ['submitStartedAt', 'evidence', 'publishedUrl', 'publishedAt', 'boundWorkId', 'boundUrl', 'platformWorkId', 'platformUrl', 'platformReview', 'platformObservedAt', 'platformPublishedAt', 'platformTrackingRef', 'reconciledAt', 'reconciledResult'];
const hasSubmissionEvidence = run => submissionFields.some(key => run[key] != null && run[key] !== '');
// Abandonment applies only to a finished, unpublished preview. Its unknown
// generation outcome and all original receipts remain unchanged.
const abandonableGeneration = run => run?.previewOnly === true && run.trigger === 'preview'
  && run.status === 'failed' && run.productionMode === 'ai-pet' && generationUncertain(run)
  && Number.isFinite(Date.parse(run.finishedAt)) && !hasSubmissionEvidence(run)
  && !run.asset && !run.draftId && !run.videoId;
const generationAbandoned = (state, run) => abandonableGeneration(run)
  && (state.generationResolutions || []).some(item => item.runId === run.id && item.action === 'abandon-preview' && item.originalRunSha256 === digest(run));
const generationBlocked = (state, run) => generationUncertain(run) && !generationAbandoned(state, run);
// An explicitly reauthorized one-time slot may exclude exactly one proven
// pre-submit failure. The old receipt stays immutable; every new run still
// consumes the day, including another failure, skip or uncertain submission.
const retrySourceRun = state => {
  if (state.config.executionMode !== 'once' || !state.config.retryOfRunId) return null;
  const run = state.runs.find(item => item.id === state.config.retryOfRunId);
  if (!run || run.previewOnly || run.status !== 'failed' || run.day !== state.config.executionDate
    || !Number.isFinite(Date.parse(run.finishedAt)) || submissionFields.some(key => run[key])
    || generationUncertain(run) || !run.binding || run.binding.accountId !== state.config.accountId || productionChanged(run.binding, state.config)
    || ['sourceMode', 'newsFeedUrl', 'newsKeywords', 'sourceFolder'].some(key => (run.binding[key] || '') !== (state.config[key] || ''))) return null;
  return run;
};
const dayRuns = (state, day) => {
  const excluded = retrySourceRun(state)?.id;
  return state.runs.filter(run => !run.previewOnly && run.day === day && run.id !== excluded);
};
const requireRetrySource = state => {
  if (state.config.retryOfRunId && !retrySourceRun(state)) throw fail('重新排期只允许同账号、同来源、同日期且确认尚未提交的失败记录；请保留回执并核实。');
};
const consumedOnce = state => state.config.executionMode === 'once' && dayRuns(state, state.config.executionDate).length > 0;
const completedOnce = state => state.config.executionMode === 'once' && dayRuns(state, state.config.executionDate).some(run => !active.includes(run.status));
const queueSubmittedOn = (queue, accountId, day) => queue.items.some(item => ['submitted', 'published', 'uncertain'].includes(item.status) && item.approval?.accountId === accountId && shanghaiDay(Date.parse(item.submitStartedAt || item.startedAt || item.scheduledAt)) === day);
function validate(state) {
  if (state?.version !== 1 || typeof state.config?.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(state.config.startTime) || !Array.isArray(state.runs)) throw new Error('每日生产记录格式不正确，请保留原文件。');
  state.config.executionMode ??= 'daily';
  state.config.executionDate ??= '';
  state.config.retryOfRunId ??= '';
  state.config.productionMode ??= 'cards';
  state.config.petSettings ??= defaultPetSettings();
  if (!['cards', 'ai-pet'].includes(state.config.productionMode)) throw new Error('成片方式无效。');
  state.config.petSettings = validatePetSettings(state.config.petSettings);
  state.petSources ??= [];
  state.generationResolutions ??= [];
  state.generationResumptions ??= [];
  if (!Array.isArray(state.generationResumptions) || state.generationResumptions.some(item => !item || typeof item.id !== 'string' || typeof item.runId !== 'string'
    || item.confirmed !== true || !Number.isFinite(Date.parse(item.at)) || !/^[a-f0-9]{64}$/.test(item.originalRunSha256 || '')
    || digest(item.originalRun) !== item.originalRunSha256 || item.originalRun?.id !== item.runId)) throw new Error('生成续作审计无效，请保留原文件。');
  if (!Array.isArray(state.generationResolutions)) throw new Error('生成处置审计格式无效，请保留原文件。');
  const resolutionIds = new Set(), resolvedRuns = new Set();
  for (const item of state.generationResolutions) {
    if (!item || typeof item.id !== 'string' || !item.id || resolutionIds.has(item.id)
      || typeof item.runId !== 'string' || !item.runId || resolvedRuns.has(item.runId)
      || item.action !== 'abandon-preview' || item.confirmed !== true || !Number.isFinite(Date.parse(item.at))
      || typeof item.note !== 'string' || item.note.trim().length < 10 || item.note.length > 1500
      || !/^[a-f0-9]{64}$/.test(item.originalRunSha256 || '') || !/^[a-f0-9]{64}$/.test(item.originalRevision || '')
      || item.originalGenerationState !== 'uncertain' || item.originalReceiptPreserved !== true || item.publicationSubmitted !== false
      || item.evidence && (typeof item.evidence.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.evidence.sha256 || '') || !Number.isSafeInteger(item.evidence.bytes) || item.evidence.bytes < 1)) throw new Error('生成处置审计不完整，请保留原文件。');
    resolutionIds.add(item.id); resolvedRuns.add(item.runId);
  }
  if (!Array.isArray(state.petSources) || state.petSources.length > 100) throw new Error('萌宠来源记录无效。');
  for (const source of state.petSources) petSourceIdentity(source);
  if (typeof state.config.retryOfRunId !== 'string' || state.config.retryOfRunId.length > 100) throw new Error('重新排期的原执行记录标识无效。');
  if (!['daily', 'once'].includes(state.config.executionMode) || typeof state.config.executionDate !== 'string' || state.config.executionMode === 'once' && !validDay(state.config.executionDate)) throw new Error('生产计划的执行模式或单次日期无效。');
  if (state.config.enabled && (!state.config.authorizedAt || !state.config.accountId || !state.config.browserId || !/^\d{4}-\d{2}-\d{2}$/.test(state.config.firstDay))) throw new Error('每日生产缺少账号或启用记录。');
  if (state.config.enabled && state.config.executionMode === 'once' && state.config.firstDay !== state.config.executionDate) throw new Error('单次生产的授权日期与计划不一致。');
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
  constructor(runtimeDir, workspace, automation, { now = () => Date.now(), intervalMs = DAILY_TICK_INTERVAL_MS, renderNews = renderNewsVideo, petPipeline } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || typeof renderNews !== 'function') throw new Error('生产调度器配置无效。');
    this.directory = join(runtimeDir, 'daily-production');
    this.runtimeDir = resolve(runtimeDir);
    this.store = new JsonStore(join(this.directory, 'state.json'), defaults(), validate);
    this.workspace = workspace; this.automation = automation;
    this.inbox = join(runtimeDir, 'product-inbox'); this.uploads = join(runtimeDir, 'uploads');
    this.busy = false; this.stopping = false; this.timer = null; this.error = ''; this.environment = null;
    this.now = now; this.intervalMs = intervalMs; this.renderNews = renderNews; this.petPipeline = petPipeline;
  }
  async candidates(state) {
    if (productionMode(state.config) === 'ai-pet') {
      const configured = new Set(state.config.petSettings.referenceUrls.map(value => { const url = new URL(value); url.hash = ''; return url.href; }));
      const seen = new Set();
      return (state.petSources || []).filter(source => {
        const identity = petSourceIdentity(source);
        if (!configured.has(identity.url) || seen.has(identity.contentHash)) return false;
        seen.add(identity.contentHash); return true;
      });
    }
    if (state.config.sourceMode === 'news') {
      const usedRuns = state.runs.filter(run => ['submitted', 'published', 'uncertain', 'publishing'].includes(run.status));
      const used = new Set(usedRuns.flatMap(run => run.newsItemIds || []));
      const usedUrls = new Set(usedRuns.flatMap(run => run.sourceArticles || []).map(articleKey));
      const seenUrls = new Set();
      const now = this.now();
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
    const now = this.now(), today = shanghaiDay(now), once = config.executionMode === 'once';
    const due = Date.parse(dayStartISO(once ? config.executionDate : today, config.startTime));
    const todayRun = value.runs.findLast(run => !run.previewOnly && run.day === today) || null;
    const scheduledRun = once ? dayRuns(value, config.executionDate).at(-1) : todayRun;
    const running = value.runs.some(run => active.includes(run.status));
    const windowOpen = now <= due + 6 * 3600000;
    const nextDay = once ? config.executionDate : config.firstDay > today ? config.firstDay : !todayRun && windowOpen ? today : shanghaiDay(now + 86400000);
    const scheduleState = running ? 'running' : !config.enabled ? 'paused'
      : config.firstDay > today || now < due ? 'waiting' : scheduledRun ? 'done' : windowOpen ? 'due' : 'missed';
    const petMode = productionMode(config) === 'ai-pet', newsMode = config.sourceMode === 'news';
    return { ...value, config, revision, eligible, todayRun, scheduleState, busy: this.busy || running, error: this.error, environment: this.environment,
      generationResolutionStatus: value.runs.filter(generationUncertain).map(run => ({ runId: run.id, abandoned: generationAbandoned(value, run),
        canAbandon: !config.enabled && !this.busy && !running && abandonableGeneration(run) && !value.generationResolutions.some(item => item.runId === run.id) })),
      productionMode: productionMode(config), petReadiness: petMode ? this.environment : null,
      lastSync: petMode ? value.petLastSync : newsMode ? value.newsLastSync : value.lastSync,
      readiness: await this.readiness(value, eligible), nextRunAt: config.enabled && (!once || !consumedOnce(value) && windowOpen) ? dayStartISO(nextDay, config.startTime) : '',
      source: petMode ? '已配置的萌宠参考内容' : newsMode ? '公开 RSS / Atom 资讯' : '本地选品日报＋商品库', sourceConnected: !!(petMode ? value.petLastSync : newsMode ? value.newsLastSync : value.lastSync),
      sourceMessage: petMode ? '采集已保存的萌宠参考链接，转化为新的原创剧情，再进行 AI 动态生成和原创音乐合成；参考可复用，已提交的剧情和成片不能重复发布。' : newsMode ? `每次开工采集 ${config.newsFeedUrl} 最近 48 小时的资讯标题与出处，去重后最多选 3 条制作一条视频；没有新资讯则跳过。当前不提供热度排名。` : `每次开工前自动同步日报目录：${config.sourceFolder}。1688 联网采集尚未接入。`,
      metricsMessage: '审核与可见指标按效果追踪中的每日时间集中回采，每轮复用一个临时窗口，完成后关闭；提交成功不代表平台审核通过。' };
  }
  async readiness(state, eligible) {
    const checks = [];
    const add = (id, label, condition, message, action) => checks.push({ id, label, state: condition, message, ...(action ? { action } : {}) });
    const petMode = productionMode(state.config) === 'ai-pet';
    if (petMode) {
      add('source', '萌宠参考来源', state.config.petSettings.referenceUrls.length ? 'ok' : 'blocked', state.config.petSettings.referenceUrls.length ? `已保存 ${state.config.petSettings.referenceUrls.length} 个参考链接；开工时读取实际内容。` : '请保存需要转化的萌宠参考链接。', 'production-settings');
      add('pet-content', '真实参考内容', eligible ? 'ok' : 'warning', eligible ? `${eligible} 条可用于创作新剧情的真实来源记录。` : '尚未采集到真实参考内容；不会改用科技资讯。', 'sync');
      if (Array.isArray(this.environment?.checks)) for (const check of this.environment.checks) checks.push({ ...check, id: `pet-${check.id}`, action: check.action || 'check' });
    } else if (state.config.sourceMode === 'news') {
      add('source', '资讯来源', state.newsLastSync ? 'ok' : 'unknown', state.newsLastSync ? `上次成功采集：${state.newsLastSync.at}。实际开工时会重新采集。` : '已配置公开 RSS 来源，请先采集一次；打开本页不会自动访问网站。', 'sync');
      add('news', '待制作资讯', eligible ? 'ok' : 'warning', eligible ? `${eligible} 条尚未发布的近期资讯，将取最新最多 3 条。` : '暂无新的匹配资讯；开工时会再采集，仍为空则跳过当天。', 'sync');
    } else {
      const source = state.config.sourceFolder || this.inbox;
      let sourceExists = false;
      try { await access(source, constants.R_OK); sourceExists = (await stat(source)).isDirectory(); } catch {}
      add('source', '商品来源', sourceExists ? 'ok' : eligible ? 'warning' : 'blocked', sourceExists ? '来源目录可读取；开工前会同步新日报。' : eligible ? '来源目录暂不可用，可沿用商品库中的现有图片。' : '来源目录未准备好，先保存来源并同步商品。', 'sync');
      add('products', '待制作商品', eligible ? 'ok' : 'blocked', eligible ? `${eligible} 款待选商品；开工时再检查图片文件。` : '暂无带本地图片的未发布商品，请同步日报或导入商品。', 'shop');
    }
    add('renderer', petMode ? 'AI 萌宠有声视频' : '本地视频合成', this.environment ? this.environment.ok ? 'ok' : 'blocked' : petMode ? 'blocked' : 'unknown', this.environment?.message || (petMode ? '尚未确认 AI 模型、首帧、动态生成及真实声音能力；完成检查后才能开启。' : '尚未检查 Python、字体和视频编码器；开启计划前会自动检查。'), 'check');
    try {
      const queue = (await this.automation.store.read()).value;
      const bound = state.config.accountId && queue.config.verifiedAt && state.config.accountId === queue.config.accountId && state.config.browserId === queue.config.browserId;
      add('account', '抖音账号', bound ? 'ok' : 'blocked', bound ? '账号绑定一致；实际发布前仍会核对登录状态。' : '尚未识别账号，或浏览器及账号配置已变化。', 'connect');
      const conflict = queue.config.enabled || queue.items.some(item => ['running', 'approved', 'uncertain'].includes(item.status));
      add('queue', '发布队列', conflict ? 'blocked' : 'ok', conflict ? '原每日发布队列仍启用，或存在已批准、运行中、待核实任务。' : '原每日发布队列没有冲突任务。', 'automation');
    } catch {
      add('queue', '发布队列', 'blocked', '无法读取发布账号或队列记录，请检查每日自动发布页面。', 'automation');
    }
    const uncertain = state.runs.some(run => run.status === 'uncertain' || generationBlocked(state, run));
    const abandoned = state.runs.filter(run => generationAbandoned(state, run)).length;
    add('receipts', '生成与发布结果', uncertain ? 'blocked' : 'ok', uncertain ? '有生成或提交结果不明的任务，请先核实原回执，系统不会自动重试。' : abandoned ? `已保留 ${abandoned} 条放弃取回的预览生成回执；原结果仍不明，仅解除新任务阻塞。` : '没有结果不明的生成或提交。', 'reconcile');
    add('scheduler', '本地调度', this.timer && !this.stopping ? 'ok' : 'blocked', this.timer && !this.stopping ? '调度已启动；电脑与本地服务需要保持运行。' : '调度尚未启动，请查看服务日志并重启服务。');
    return { checkedAt: timestamp(), canEnable: !this.busy && !state.runs.some(run => active.includes(run.status)) && !checks.some(check => check.state === 'blocked'), checks };
  }
  async check(revision) {
    const current = await this.store.read();
    if (revision !== current.revision) throw fail('记录已有更新，请刷新。');
    if (this.busy) throw fail('任务正在处理，请完成后再检查。');
    this.busy = true;
    try {
      this.environment = productionMode(current.value.config) === 'ai-pet'
        ? typeof this.petPipeline?.check === 'function' ? await this.petPipeline.check(current.value.config.petSettings) : { ok: false, message: 'AI 萌宠生产链尚未接入，未启用发布。', checks: [] }
        : await inspectProductVideoEnvironment();
    }
    finally { this.busy = false; }
  }
  async productionSettings(input, revision) {
    if (!revision || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['productionMode', 'petSettings'].includes(key)) || !['cards', 'ai-pet'].includes(input.productionMode)) throw fail('请选择有效成片方式和萌宠设置。');
    const settings = validatePetSettings(input.petSettings || defaultPetSettings());
    if (this.busy) throw fail('请等当前生产任务完成后再调整成片方式。');
    this.busy = true; let release;
    try {
      release = await this.automation.lease();
      await this.store.update(state => {
        if (state.runs.some(run => active.includes(run.status))) throw fail('已有生产任务正在运行。');
        if (!productionChanged(state.config, { productionMode: input.productionMode, petSettings: settings })) return;
        Object.assign(state.config, { productionMode: input.productionMode, petSettings: settings, enabled: false, authorizedAt: '', firstDay: '', retryOfRunId: '' });
        state.petSources = []; state.petLastSync = null;
      }, revision);
      this.environment = null; this.error = '';
    } finally { try { if (release) await release(); } finally { this.busy = false; } }
  }
  async schedule(input, revision) {
    if (!revision || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime || '')) throw fail('请选择有效的每日开工时间。');
    if (this.busy) throw fail('请等当前任务完成后再调整时间。');
    this.busy = true; let release;
    try {
      release = await this.automation.lease();
      await this.store.update(state => {
        if (state.runs.some(run => active.includes(run.status))) throw fail('有任务正在运行，暂不能调整时间。');
        const executionMode = input.executionMode ?? state.config.executionMode;
        const executionDate = executionMode === 'once' ? input.executionDate ?? state.config.executionDate : '';
        if (!['daily', 'once'].includes(executionMode) || executionMode === 'once' && !validDay(executionDate)) throw fail('请选择有效的执行模式和单次执行日期。');
        const retryOfRunId = input.retryOfRunId ?? '';
        if (typeof retryOfRunId !== 'string' || retryOfRunId.length > 100) throw fail('请选择有效的原失败记录。');
        if (retryOfRunId) {
          if (input.authorizedRetry !== true || executionMode !== 'once') throw fail('请明确授权对尚未提交的失败记录重新安排一次单次验收。');
          const proposed = { ...state, config: { ...state.config, executionMode, executionDate, retryOfRunId } };
          requireRetrySource(proposed);
          if (dayRuns(proposed, executionDate).length) throw fail('该日期已有其他生产或发布记录，不能重复重新排期。');
        }
        if (state.config.startTime === input.startTime && state.config.executionMode === executionMode && state.config.executionDate === executionDate && state.config.retryOfRunId === retryOfRunId) return;
        Object.assign(state.config, { startTime: input.startTime, executionMode, executionDate, retryOfRunId, enabled: false, authorizedAt: '', firstDay: '' });
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
        if (resolve(state.config.sourceFolder || this.inbox) !== resolved) {
          Object.assign(state.config, { sourceFolder: resolved, enabled: false, authorizedAt: '', firstDay: '', retryOfRunId: '' });
          state.lastSync = null;
        }
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
        Object.assign(state.config, { sourceMode: input.mode, enabled: false, authorizedAt: '', firstDay: '', retryOfRunId: '' });
        if (settings) Object.assign(state.config, { newsFeedUrl: settings.feedUrl, newsKeywords: settings.keywords });
        state.newsItems = []; state.newsLastSync = null;
      }, revision);
      this.error = '';
    } finally { try { if (release) await release(); } finally { this.busy = false; } }
  }
  async syncSource({ guard = async () => {} } = {}) {
    const current = (await this.store.read()).value;
    if (productionMode(current.config) === 'ai-pet') {
      if (typeof this.petPipeline?.collect !== 'function') throw fail('AI 萌宠参考采集器尚未接入。');
      await guard();
      const collected = await this.petPipeline.collect(current.config.petSettings, { binding: structuredClone(current.config), guard });
      if (!Array.isArray(collected?.sources) || collected.sources.length > 100) throw fail('萌宠采集结果格式无效，未保存来源。');
      const configured = new Set(current.config.petSettings.referenceUrls.map(value => { const url = new URL(value); url.hash = ''; return url.href; }));
      const unique = new Map();
      for (const source of collected.sources) {
        const identity = petSourceIdentity(source);
        if (!configured.has(identity.url)) throw fail('采集结果包含未配置的萌宠来源，已停止。');
        unique.set(identity.key, { ...source, url: identity.url, sourceKey: identity.key, contentHash: identity.contentHash });
      }
      const sources = [...unique.values()], known = new Set((current.petSources || []).map(source => petSourceIdentity(source).key));
      const result = { at: collected.at || timestamp(), scanned: sources.length, added: sources.filter(source => !known.has(source.sourceKey)).length, existing: sources.filter(source => known.has(source.sourceKey)).length, warnings: Array.isArray(collected.warnings) ? collected.warnings : [], source: 'pet-references' };
      await guard();
      await this.store.update(state => {
        if (productionChanged(state.config, current.config)) throw fail('萌宠生产设置已变化，请重新采集。');
        state.petSources = sources; state.petLastSync = result;
      });
      return result;
    }
    if (current.config.sourceMode === 'news') {
      const collected = await collectNews({ feedUrl: current.config.newsFeedUrl, keywords: current.config.newsKeywords }, join(this.directory, 'news-source'));
      const known = new Set((current.newsItems || []).map(articleKey));
      const result = { at: collected.at, scanned: collected.items.length, added: collected.items.filter(item => !known.has(articleKey(item))).length, existing: collected.items.filter(item => known.has(articleKey(item))).length, warnings: collected.warnings, feedTitle: collected.feedTitle, feedUrl: current.config.newsFeedUrl };
      await this.store.update(state => {
        if (state.config.sourceMode !== 'news' || state.config.newsFeedUrl !== current.config.newsFeedUrl || state.config.newsKeywords !== current.config.newsKeywords) throw fail('资讯来源已变化，请重新采集。');
        const merged = new Map((state.newsItems || []).map(item => [articleKey(item), item]));
        for (const item of collected.items) merged.set(articleKey(item), { ...item, sourceUrl: current.config.newsFeedUrl });
        state.newsItems = [...merged.values()].filter(item => Date.parse(item.publishedAt) >= this.now() - 48 * 3600000).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 120);
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
        if (state.config.accountId !== account.accountId || state.config.browserId !== selected.id) Object.assign(state.config, { enabled: false, authorizedAt: '', firstDay: '', retryOfRunId: '' });
        Object.assign(state.config, { accountId: account.accountId, browserId: selected.id });
      }, revision);
    } finally { try { if (release) await release(); } finally { this.busy = false; } }
  }
  async resolveGeneration(input, revision) {
    if (!revision || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['id', 'action', 'confirmed', 'note', 'evidencePath'].includes(key))
      || input.action !== 'abandon-preview' || input.confirmed !== true || typeof input.id !== 'string'
      || typeof input.note !== 'string' || input.note.trim().length < 10 || input.note.length > 1500
      || input.evidencePath != null && (typeof input.evidencePath !== 'string' || input.evidencePath.length > 4096)) throw fail('请明确确认放弃取回这次未发布的预览，并填写至少 10 字的核实说明。');
    if (this.busy || this.stopping) throw fail('任务正在处理或服务停止中，不能处置生成记录。');
    this.busy = true;
    let release;
    try {
      release = await this.automation.lease();
      const current = await this.store.read();
      if (revision !== current.revision) throw fail('记录已有更新，请刷新后核实。');
      const original = current.value.runs.find(run => run.id === input.id);
      if (current.value.config.enabled || current.value.runs.some(run => active.includes(run.status))) throw fail('请先暂停计划并等待所有任务结束。');
      if (!abandonableGeneration(original) || current.value.generationResolutions.some(item => item.runId === input.id)) throw fail('仅可处置尚未发布、没有成片或草稿且已结束的未知预览；原任务不会重跑。');
      const [queue, workspace] = await Promise.all([this.automation.store.read(), this.workspace.read()]);
      const drafts = workspace.value.drafts.filter(draft => draft.sourceProductionId === original.id || original.draftId && draft.id === original.draftId);
      if (queue.value.config.enabled || queue.value.items.some(item => ['approved', 'running', 'uncertain'].includes(item.status))
        || drafts.length || queue.value.items.some(item => item.sourceProductionId === original.id || original.draftId && item.sourceDraftId === original.draftId)) throw fail('发布队列或关联草稿存在记录，请先人工核实，不能按未发布预览处置。');
      let evidence;
      if (input.evidencePath) {
        if (!isAbsolute(input.evidencePath)) throw fail('核实证据必须是本项目 runtime 内的绝对文件路径。');
        const root = await realpath(this.runtimeDir), path = await realpath(input.evidencePath), rel = relative(root, path);
        if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw fail('核实证据必须位于本项目 runtime 内。');
        const info = await stat(path);
        if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024) throw fail('核实证据必须是 1 MiB 以内的非空文件。');
        const raw = await readFile(path);
        if (!raw.length || raw.length > 1024 * 1024) throw fail('核实证据文件在读取期间发生变化。');
        evidence = { path, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') };
      }
      await this.store.update(state => {
        const run = state.runs.find(item => item.id === input.id);
        if (state.config.enabled || state.runs.some(item => active.includes(item.status)) || !abandonableGeneration(run)
          || state.generationResolutions.some(item => item.runId === input.id)) throw fail('生成记录或计划状态已经变化，请重新核实。');
        state.generationResolutions.push({ id: randomUUID(), runId: run.id, action: 'abandon-preview', confirmed: true,
          at: timestamp(), note: input.note.trim(), originalRevision: revision, originalRunSha256: digest(run),
          originalGenerationState: run.generationState, originalReceiptPreserved: true, publicationSubmitted: false, ...(evidence ? { evidence } : {}) });
      }, revision);
    } finally { try { if (release) await release(); } finally { this.busy = false; } }
  }
  async resumeGeneration(input, revision) {
    if (!revision || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'confirmed'].includes(key))
      || typeof input.id !== 'string' || input.confirmed !== true) throw fail('请明确确认仅续作原来未发布的 AI 预览。');
    if (this.busy || this.stopping) throw fail('已有任务正在运行或服务停止中。');
    this.busy = true;
    let release, launched = false;
    try {
      release = await this.automation.lease();
      const current = await this.store.read(), original = current.value.runs.find(run => run.id === input.id);
      if (current.revision !== revision) throw fail('记录已有更新，请刷新后续作。');
      if (current.value.config.enabled || !abandonableGeneration(original) || current.value.generationResolutions.some(item => item.runId === input.id)
        || current.value.runs.some(run => run.id !== input.id && (active.includes(run.status) || run.status === 'uncertain' || generationBlocked(current.value, run)))) throw fail('仅可续作已暂停、未弃置且没有发布或成片痕迹的失败预览。');
      if (productionChanged(current.value.config, original.binding) || ['accountId', 'browserId', 'sourceMode', 'newsFeedUrl', 'newsKeywords', 'sourceFolder'].some(key => current.value.config[key] !== original.binding[key])) throw fail('原预览设置已变化，不能续作。');
      if (typeof this.petPipeline?.resume !== 'function' || !original.sourceReferences?.length) throw fail('原生成续作能力或来源凭据不完整。');
      const [queue, workspace] = await Promise.all([this.automation.store.read(), this.workspace.read()]);
      if (queue.value.config.enabled || queue.value.items.some(item => ['approved', 'running', 'uncertain'].includes(item.status) || item.sourceProductionId === original.id)
        || workspace.value.drafts.some(draft => draft.sourceProductionId === original.id)) throw fail('发布队列或关联草稿存在记录，不能续作此预览。');
      const auditId = randomUUID();
      await this.store.update(state => {
        const run = state.runs.find(row => row.id === input.id);
        if (digest(run) !== digest(original) || state.config.enabled) throw fail('原任务已有更新，不能重复续作。');
        state.generationResumptions.push({ id: auditId, runId: run.id, confirmed: true, at: timestamp(), originalRevision: revision,
          originalRunSha256: digest(original), originalRun: structuredClone(original), publicationSubmitted: false, status: 'running' });
        Object.assign(run, { status: 'rendering', generationState: 'running', message: '正在核实原镜头终态；只恢复已返回文件或在已确认的免费额度恢复后续作。', generationResumeId: auditId });
      }, revision);
      launched = true;
      void this.finishResumedPreview(structuredClone(original), auditId, release).catch(error => { this.error = error.message; });
    } finally { if (!launched) { try { if (release) await release(); } finally { this.busy = false; } } }
  }
  async inspectGenerationResume(id) {
    const state = await this.store.read(), original = state.value.runs.find(run => run.id === id);
    if (typeof id !== 'string' || this.busy || this.stopping || state.value.config.enabled || !abandonableGeneration(original)
      || state.value.generationResolutions.some(row => row.runId === id)
      || productionChanged(state.value.config, original.binding)
      || ['accountId', 'browserId', 'sourceMode', 'newsFeedUrl', 'newsKeywords', 'sourceFolder'].some(key => state.value.config[key] !== original.binding[key])) return { id, revision: state.revision, status: 'blocked', canResume: false, message: '当前记录或计划不符合未发布预览续作条件。' };
    const [queue, workspace] = await Promise.all([this.automation.store.read(), this.workspace.read()]);
    if (queue.value.config.enabled || queue.value.items.some(item => ['approved', 'running', 'uncertain'].includes(item.status) || item.sourceProductionId === id)
      || workspace.value.drafts.some(draft => draft.sourceProductionId === id)) return { id, revision: state.revision, status: 'blocked', canResume: false, message: '存在发布队列或草稿记录，不能续作。' };
    if (typeof this.petPipeline?.inspectResume !== 'function') return { id, revision: state.revision, status: 'blocked', canResume: false, message: '原预览续作检查未接入。' };
    return { id, revision: state.revision, ...(await this.petPipeline.inspectResume(original.sourceReferences, join(this.directory, 'videos'), { runId: id, settings: original.binding.petSettings })) };
  }
  async finishResumedPreview(target, auditId, release) {
    const update = async patch => { await this.store.update(state => Object.assign(state.runs.find(run => run.id === target.id), patch)); Object.assign(target, patch); };
    const guard = async () => {
      const state = (await this.store.read()).value, current = state.runs.find(run => run.id === target.id);
      if (this.stopping || state.config.enabled || current?.generationResumeId !== auditId || current.status !== 'rendering' || hasSubmissionEvidence(current)
        || productionChanged(state.config, target.binding) || ['accountId', 'browserId', 'sourceMode', 'newsFeedUrl', 'newsKeywords', 'sourceFolder'].some(key => state.config[key] !== target.binding[key])) throw fail('续作期间设置或任务状态变化，已停止。');
      const queue = (await this.automation.store.read()).value;
      if (queue.config.enabled || queue.items.some(item => ['approved', 'running', 'uncertain'].includes(item.status) || item.sourceProductionId === target.id)) throw fail('发布队列状态变化，已停止续作。');
    };
    try {
      await guard();
      const rendered = await this.petPipeline.resume(target.sourceReferences, join(this.directory, 'videos'), { runId: target.id, settings: target.binding.petSettings, guard,
        onProgress: async info => { await guard(); await update({ message: String(info?.message || '正在续作原 AI 萌宠预览。').slice(0, 1500) }); } });
      await guard();
      const sha256 = await this.verifyPetRendered(rendered, target);
      const videoId = randomUUID(), draftId = randomUUID(), references = target.sourceReferences;
      await this.workspace.update(state => {
        if (state.drafts.some(draft => draft.sourceProductionId === target.id)) throw fail('此预览已经归档，未重复创建草稿。');
        state.videos.push({ ...newVideo(), id: videoId, title: rendered.title, subject: 'AI 萌宠有声故事', notes: '从本次中断处续作；保留原镜头与原失败证据。\n' + references.map(item => `${item.title}\n${item.url}`).join('\n'), asset: rendered.asset, status: 'completed', provider: 'AI 萌宠动态生成与原创音乐合成', cost: '0', aiGenerated: true,
          generationReceipt: rendered.generationReceipt, audioVerification: rendered.audioVerification, motionVerification: rendered.motionVerification, createdAt: timestamp(), updatedAt: timestamp(),
          shots: [{ seconds: Math.round(rendered.seconds), action: 'AI 生成萌宠动态镜头并配原创音乐。', camera: '竖屏 AI 萌宠动态镜头' }] });
        state.drafts.push({ id: draftId, title: rendered.title, pubTitle: rendered.title, caption: rendered.caption, asset: rendered.asset, platform: 'douyin', format: '视频', status: '待检查', sourceVideoId: videoId, sourceProductionId: target.id,
          sourceMode: target.sourceMode, productionMode: 'ai-pet', aiGenerated: true, contentDeclaration: 'ai-generated', sourceReferences: references, generationReceipt: rendered.generationReceipt,
          audioVerification: rendered.audioVerification, motionVerification: rendered.motionVerification, createdAt: timestamp(), updatedAt: timestamp() });
      });
      await update({ ...rendered, sha256, videoId, draftId, generationState: 'completed', status: 'preview', message: '原预览续作完成，有声成片已验证；没有启用计划或发布。', finishedAt: timestamp(), generationWait: null });
      await this.store.update(state => Object.assign(state.generationResumptions.find(row => row.id === auditId), { status: 'completed', finishedAt: timestamp(), assetSha256: sha256 }));
      this.error = '';
    } catch (error) {
      this.error = error.message;
      await update({ status: 'failed', generationState: 'uncertain', message: error.message, finishedAt: timestamp(),
        ...(error.code === 'quota_wait' && error.retryNotBefore ? { generationWait: { reason: 'quota', retryNotBefore: error.retryNotBefore } } : {}) });
      await this.store.update(state => Object.assign(state.generationResumptions.find(row => row.id === auditId), { status: error.code === 'quota_wait' ? 'quota_wait' : 'failed', finishedAt: timestamp(), message: error.message }));
    } finally { try { await this.mirrorRun(target.id); } finally { try { if (release) await release(); } finally { this.busy = false; } } }
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
    let binding, queue;
    if (input.enabled) {
      if (this.busy) throw fail('任务正在处理，请完成后再开启。');
      if (!this.timer || this.stopping) throw fail('每日生产调度尚未就绪，请先处理服务启动错误。');
      if (input.authorized !== true) throw fail('请确认按已保存的执行模式、日期、内容来源和账号自动制作并公开发布。');
      queue = (await this.automation.store.read()).value;
      if (queue.config.enabled || queue.items.some(i => ['running', 'uncertain', 'approved'].includes(i.status))) throw fail('请先暂停每日视频队列并处理已批准或待核实任务，避免两个计划重复发布。');
      binding = queue.config;
      if (!binding.accountId || !binding.browserId || !binding.verifiedAt) throw fail('请先点击“自动识别抖音账号”。');
      const current = (await this.store.read()).value;
      requireRetrySource(current);
      if (current.config.accountId !== binding.accountId || current.config.browserId !== binding.browserId) throw fail('发布账号设置已变化，请重新识别并核对账号后再开启。');
      if (current.config.executionMode === 'once') {
        if (Date.parse(dayStartISO(current.config.executionDate, current.config.startTime)) <= this.now()) throw fail('单次执行时间已过，请重新保存一个未来时间；不会自动顺延或补发。');
        if (consumedOnce(current) || queueSubmittedOn(queue, binding.accountId, current.config.executionDate)) throw fail('该日期已有生产或发布记录，请另选日期；不会重复执行。');
      }
      if (current.runs.some(run => generationBlocked(current, run))) throw fail('有 AI 生成结果不明的任务，请先核实原回执；不会新建生成重试。');
      if (productionMode(current.config) === 'ai-pet') {
        if (typeof this.petPipeline?.render !== 'function' || typeof this.petPipeline?.collect !== 'function') throw fail('AI 萌宠有声生产链未完整接入。');
      } else if (current.config.sourceMode === 'news') {
        if (!current.newsLastSync) throw fail('请先采集一次资讯，确认来源可以读取。');
      } else if (!(await this.candidates(current)).length) throw fail('没有可用商品：请先接入选品来源，或导入带商品图的日报。');
      await this.check(revision);
      if (!this.environment.ok) throw fail(this.environment.message);
    }
    await this.store.update(state => {
      if (input.enabled) requireRetrySource(state);
      if (input.enabled && state.runs.some(r => active.includes(r.status) || r.status === 'uncertain' || generationBlocked(state, r))) throw fail('请先处理正在运行或生成、提交结果待核实的任务。');
      if (input.enabled) {
        if (state.config.enabled) return;
        const now = this.now(), day = shanghaiDay(now);
        const usedToday = state.runs.some(run => !run.previewOnly && run.day === day) || queueSubmittedOn(queue, binding.accountId, day);
        const firstDay = state.config.executionMode === 'once' ? state.config.executionDate : now < Date.parse(dayStartISO(day, state.config.startTime)) && !usedToday ? day : shanghaiDay(now + 86400000);
        // Environment checks may take time. Do not enable a one-time slot that
        // became due while the user was still waiting for that check.
        if (state.config.executionMode === 'once' && Date.parse(dayStartISO(firstDay, state.config.startTime)) <= this.now()) throw fail('单次执行时间已过，请保存新的未来时间。');
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
            if (productionMode(run.binding || {}) === 'ai-pet' && run.status === 'rendering' && run.generationState !== 'completed') run.generationState = 'uncertain';
            run.status = run.submitStartedAt ? 'uncertain' : 'failed';
            run.message = '上次运行中断，已暂停；提交结果待核实时不能自动重试。'; run.finishedAt = timestamp();
            state.config.enabled = false;
          }
        });
      } finally { await release(); }
    }
    // The durable run consumes a one-time plan even if the prior process died
    // after saving its result but before returning to the scheduler.
    if (current.config.enabled && completedOnce(current)) await this.store.update(state => {
      if (state.config.enabled && completedOnce(state)) state.config.enabled = false;
    });
    this.timer = setInterval(() => { void this.run(false, 'scheduler').catch(error => { this.error = error.message; }); }, this.intervalMs);
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
  async verifyPetRendered(rendered, target) {
    const receipt = rendered?.generationReceipt, audio = rendered?.audioVerification, motion = rendered?.motionVerification;
    if (!rendered?.asset || rendered.aiGenerated !== true || rendered.contentDeclaration !== 'ai-generated'
      || !Number.isFinite(rendered.seconds) || Math.abs(rendered.seconds - target.binding.petSettings.duration) > 0.1 || audio?.decoded !== true || audio.nonSilent !== true
      || !Number.isFinite(audio.rmsDb) || audio.rmsDb <= -45 || motion?.checked !== true || motion.passed !== true
      || receipt?.status !== 'completed' || receipt.runId !== target.id || receipt.model !== target.binding.petSettings.model
      || !/^[a-f0-9]{64}$/.test(receipt.inputHash || '') || !/^[a-f0-9]{64}$/.test(receipt.sourceHash || '') || !/^[a-f0-9]{64}$/.test(receipt.storyHash || '')
      || !Array.isArray(receipt.shots) || receipt.shots.length !== 4 || receipt.shots.some(shot => !/^[a-f0-9]{64}$/.test(shot.sha256 || ''))
      || new Set(receipt.shots.map(shot => shot.sha256)).size !== 4 || typeof receipt.path !== 'string') {
      throw fail('AI 萌宠成片缺少真实生成、有声或动作验证凭据，禁止用静音图卡替代发布。');
    }
    const directory = await realpath(join(this.directory, 'videos'));
    for (const file of [rendered.asset, receipt.path]) {
      const path = await realpath(file), rel = relative(directory, path);
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw fail('AI 萌宠成片或回执不在本次生产目录中。');
    }
    const sha256 = await hashFile(rendered.asset), persisted = JSON.parse(await readFile(receipt.path, 'utf8'));
    if (receipt.assetSha256 !== sha256 || persisted.status !== 'completed' || persisted.runId !== target.id || persisted.assetSha256 !== sha256 || persisted.storyHash !== receipt.storyHash) throw fail('AI 萌宠成片与持久生成回执不一致，已停止。');
    const previous = (await this.store.read()).value.runs.filter(run => run.id !== target.id && ['submitted', 'published', 'uncertain', 'publishing'].includes(run.status));
    if (previous.some(run => run.sha256 === sha256 || run.generationReceipt?.storyHash === receipt.storyHash)) throw fail('AI 剧情或成片与此前已提交作品重复，本次不发布。');
    return sha256;
  }
  async run(previewOnly = false, trigger = previewOnly ? 'preview' : 'direct') {
    if (this.busy || this.stopping) return;
    // Polling a paused or future plan is read-only. It must not briefly mark the
    // service busy and reject a user's settings or authorization request.
    const saved = (await this.store.read()).value;
    if (this.busy || this.stopping) return;
    const day = shanghaiDay(this.now());
    const runDay = !previewOnly && saved.config.executionMode === 'once' ? saved.config.executionDate : day;
    const due = Date.parse(dayStartISO(runDay, saved.config.startTime));
    const completed = !previewOnly && saved.config.enabled && completedOnce(saved);
    if (!previewOnly && !completed && (!saved.config.enabled || day < saved.config.firstDay || this.now() < due || dayRuns(saved, runDay).length)) return;
    this.busy = true;
    let release, target;
    try {
      if (completed) {
        await this.store.update(state => { if (completedOnce(state)) state.config.enabled = false; });
        return;
      }
      // Share the publisher lease with the manually approved queue across processes.
      release = await this.automation.lease();
      await this.store.update(state => {
        if (state.runs.some(r => active.includes(r.status) || r.status === 'uncertain' || generationBlocked(state, r))) throw fail('有运行中或生成、提交结果待核实的任务，已停止。');
        if (!previewOnly) requireRetrySource(state);
        if (!previewOnly && (!state.config.enabled || day < state.config.firstDay || this.now() < Date.parse(dayStartISO(runDay, state.config.startTime)) || state.config.authorizedAt !== saved.config.authorizedAt || dayRuns(state, runDay).length)) return;
        target = { id: randomUUID(), day: runDay, previewOnly, trigger, sourceMode: state.config.sourceMode, productionMode: productionMode(state.config), status: 'selecting', startedAt: timestamp(), message: '正在准备当天的内容来源。', binding: structuredClone(state.config) };
        state.runs.push(target); target = structuredClone(target);
      });
      if (!target) return;
      const update = async patch => { await this.store.update(state => {
        Object.assign(state.runs.find(r => r.id === target.id), patch);
        // Save the receipt and consume the one-time authorization atomically.
        if (!previewOnly && target.binding.executionMode === 'once' && patch.status && !active.includes(patch.status)) state.config.enabled = false;
      }); Object.assign(target, patch); };
      if (!previewOnly && (day !== runDay || this.now() - due > 6 * 3600000)) { await update({ status: 'skipped', message: saved.config.executionMode === 'once' ? '单次执行时段已过，计划已暂停，不顺延或补发。' : '超过计划开工时间 6 小时，今天不补发。', finishedAt: timestamp() }); return; }
      const guard = async () => {
        const state = (await this.store.read()).value;
        if (!previewOnly) requireRetrySource(state);
        if (productionChanged(state.config, target.binding)) throw fail('成片方式或萌宠生成设置已变化，停止本次任务。');
        if (['sourceMode', 'newsFeedUrl', 'newsKeywords', 'sourceFolder'].some(key => state.config[key] !== target.binding[key])) throw fail('内容来源已变化，停止本次任务。');
        if (this.stopping || (!previewOnly && (!state.config.enabled || ['authorizedAt', 'startTime', 'executionMode', 'executionDate', 'retryOfRunId'].some(key => state.config[key] !== target.binding[key])))) throw fail('每日生产已暂停或配置发生变化。');
        if (!previewOnly && shanghaiDay(this.now()) !== day) throw fail('已跨日，停止本次发布。');
        if (!previewOnly) {
          const queue = (await this.automation.store.read()).value;
          if (queue.config.enabled || queue.config.accountId !== target.binding.accountId || queue.config.browserId !== target.binding.browserId) throw fail('另一个发布计划已开启或账号设置变化，已停止。');
        }
      };
      await guard();
      const petMode = target.productionMode === 'ai-pet', newsMode = !petMode && target.sourceMode === 'news';
      if (petMode) {
        if (typeof this.petPipeline?.check !== 'function' || typeof this.petPipeline?.render !== 'function') throw fail('AI 萌宠有声生产链尚未接入。');
        this.environment = await this.petPipeline.check(target.binding.petSettings);
        if (!this.environment?.ok) throw fail(this.environment?.message || 'AI 萌宠生成环境未就绪。');
        await guard();
      }
      await update({ message: petMode ? '正在采集已保存的萌宠参考内容。' : newsMode ? '正在采集近期资讯标题与出处。' : '正在同步选品日报和商品图片。' });
      let sourceResult;
      const warnings = [];
      try { sourceResult = await this.syncSource({ guard }); }
      catch (error) {
        if (petMode) throw error;
        if (!(await this.candidates((await this.store.read()).value)).length) {
          if (!newsMode) throw error;
          await update({ status: 'skipped', message: '资讯来源暂不可用，且没有近期缓存，本次不发布。' + (target.binding.executionMode === 'once' && !previewOnly ? '单次计划已暂停，不顺延。' : '计划开启时下个执行日再采集。'), warnings: [error.message], finishedAt: timestamp() });
          this.error = ''; return;
        }
        warnings.push(`${newsMode ? '资讯采集未完成，沿用 48 小时内的缓存' : '日报同步未完成，沿用已有商品库'}：${error.message}`);
      }
      if (sourceResult) warnings.push(...sourceResult.warnings);
      await update({ ...(sourceResult ? { sourceResult } : {}), warnings: warnings.slice(0, 30) });
      const candidates = await this.candidates((await this.store.read()).value);
      let product, rendered, verifiedPetSha256, articles = [], references = [];
      if (petMode) {
        references = candidates.slice(0, 3);
        if (!references.length) {
          await update({ status: 'skipped', message: '本次没有可读取的真实萌宠参考内容，跳过发布；不会改用静音图卡。', finishedAt: timestamp() });
          this.error = ''; return;
        }
        await guard();
        const identities = references.map(petSourceIdentity);
        await update({ status: 'rendering', generationState: 'running', sourceReferences: references,
          petSourceKeys: identities.map(item => item.key), petSourceHashes: identities.map(item => item.contentHash),
          message: '正在将萌宠参考转化为 AI 分镜、生成动态镜头并合成原创音乐。' });
        rendered = await this.petPipeline.render(references, join(this.directory, 'videos'), {
          runId: target.id, settings: target.binding.petSettings, guard,
          previousStoryHashes: (await this.store.read()).value.runs.filter(run => ['submitted', 'published', 'uncertain', 'publishing'].includes(run.status)).map(run => run.generationReceipt?.storyHash).filter(Boolean),
          onProgress: async progress => { await guard(); await update({ message: String(progress?.message || progress || '正在制作 AI 萌宠有声视频。').slice(0, 1500) }); }
        });
        verifiedPetSha256 = await this.verifyPetRendered(rendered, target);
        await update({ generationState: 'completed', sha256: verifiedPetSha256 });
      } else if (newsMode) {
        const selection = selectNewsForVideo(candidates, { day });
        articles = selection.items;
        warnings.push(...selection.warnings);
        await update({ warnings: warnings.slice(0, 30) });
        if (!articles.length) {
          const next = target.binding.executionMode === 'once' && !previewOnly ? '单次计划已暂停，不顺延。' : '计划开启时下个执行日继续采集。';
          await update({ status: 'skipped', message: (candidates.length ? '本次资讯的标题或出处无法完整排入视频及文案，已跳过；详情见处理提示。' : '最近 48 小时没有尚未发布的匹配资讯，本次跳过，不重复发布。') + next, finishedAt: timestamp() });
          this.error = ''; return;
        }
        await guard();
        await update({ status: 'rendering', title: `${day} 资讯速览`, newsItemIds: articles.map(item => item.id), sourceArticles: articles, message: `已选择 ${articles.length} 条资讯，正在制作原创排版的信息卡与字幕。` });
        rendered = await this.renderNews(articles, join(this.directory, 'videos'), { day });
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
      // Keep the hash accepted with the audio/motion/generation evidence. A
      // later file replacement must fail beforeSubmit, not become the new baseline.
      await update({ ...rendered, sha256: petMode ? verifiedPetSha256 : await hashFile(rendered.asset) });
      const videoId = randomUUID(), draftId = randomUUID();
      const productLink = product ? { sourceProductId: product.id } : {};
      const notes = petMode ? '依据实际采集的参考内容转化为 AI 萌宠动态视频，搭配原创音乐；不是现场实拍。\n' + references.map(item => `${item.title || '参考来源'}\n${item.url}`).join('\n') : newsMode ? '公开资讯标题编排为原创信息卡画面，非现场画面，不含热度排名。\n' + articles.map(item => `${item.sourceName}：${item.title}\n${item.url}`).join('\n') : '';
      await this.workspace.update(state => {
        state.videos.push({ ...newVideo(), id: videoId, title: rendered.title, subject: product?.title || (petMode ? 'AI 萌宠有声故事' : '每日资讯标题速览'), notes, asset: rendered.asset, status: 'completed', provider: petMode ? 'AI 萌宠动态生成与原创音乐合成' : newsMode ? '本地资讯图卡字幕合成' : '本地图片字幕合成', cost: '0', ...productLink, ...(petMode ? { aiGenerated: true, generationReceipt: rendered.generationReceipt, audioVerification: rendered.audioVerification, motionVerification: rendered.motionVerification } : {}), createdAt: timestamp(), updatedAt: timestamp(), shots: [{ seconds: Math.round(rendered.seconds), action: petMode ? 'AI 生成萌宠动态镜头并配原创音乐。' : newsMode ? '按资讯逐条展示信息卡、标题、发布日期和来源，附字幕说明。' : '按商品图片依次展示商品资料，字幕来自保存的中文文案。', camera: petMode ? '竖屏 AI 萌宠动态镜头' : newsMode ? '竖屏资讯图卡' : '竖屏商品展示' }] });
        state.drafts.push({ id: draftId, title: rendered.title, pubTitle: rendered.title, caption: rendered.caption, asset: rendered.asset, platform: 'douyin', format: '视频', status: '待检查', ...productLink, sourceVideoId: videoId, sourceProductionId: target.id, sourceMode: target.sourceMode, productionMode: target.productionMode, sourceArticles: articles, ...(petMode ? { aiGenerated: true, contentDeclaration: 'ai-generated', sourceReferences: references, generationReceipt: rendered.generationReceipt, audioVerification: rendered.audioVerification, motionVerification: rendered.motionVerification } : {}), createdAt: timestamp(), updatedAt: timestamp() });
      });
      await update({ videoId, draftId });
      await guard();
      if (previewOnly) { await update({ status: 'preview', message: '成片已生成，仅预览，没有发布。', finishedAt: timestamp() }); this.error = ''; return; }
      const queue = (await this.automation.store.read()).value;
      if (queue.config.enabled || queue.config.accountId !== target.binding.accountId || queue.config.browserId !== target.binding.browserId || queue.items.some(i => ['running', 'uncertain'].includes(i.status)) || queueSubmittedOn(queue, target.binding.accountId, day)) throw fail('账号设置变化、旧队列启用，或今天已有发布记录，已停止。');
      await update({ status: 'publishing', message: petMode ? '正在上传并公开发布 AI 萌宠有声视频。' : newsMode ? '正在上传并公开发布资讯卡片视频。' : '正在上传并公开发布商品介绍视频。' });
      const approval = { ...rendered, accountId: target.binding.accountId, browserId: target.binding.browserId };
      const beforeSubmit = async () => { await guard(); if (await hashFile(rendered.asset) !== target.sha256) throw fail('视频文件发生变化，已停止。'); await update({ submitStartedAt: timestamp(), message: '正在单次提交；结果不明时禁止自动重发。' }); };
      const result = await this.automation.publisher.publish({ approval }, { guard, beforeSubmit });
      await update({ status: 'submitted', message: result.message, evidence: result.evidence, finishedAt: timestamp() });
      this.error = '';
    } catch (error) {
      this.error = error.message;
      if (target) await this.store.update(state => {
        const run = state.runs.find(r => r.id === target.id);
        if (target.productionMode === 'ai-pet' && (error.code === 'uncertain' || error.status === 'uncertain')) run.generationState = 'uncertain';
        else if (target.productionMode === 'ai-pet' && run.generationState === 'running') run.generationState = 'failed';
        run.status = run.submitStartedAt ? 'uncertain' : 'failed'; run.message = error.message; run.finishedAt = timestamp();
        if (!previewOnly) state.config.enabled = false;
      });
      else throw error;
    } finally { try { if (target) await this.mirrorRun(target.id); } finally { try { if (release) await release(); } finally { this.busy = false; } } }
  }
}
