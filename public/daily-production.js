import { esc, dialog, download } from './workspace-ui.js';

const labels = { selecting: '选品中', rendering: '制作中', publishing: '发布中', preview: '预览成片', submitted: '已提交待审核', published: '已确认发布', failed: '已停止', uncertain: '结果待核实', skipped: '今日已跳过' };
const scheduleLabels = { paused: '计划已暂停', running: '正在执行', waiting: '等待开始', due: '已到执行时间', done: '今日任务已结束', missed: '已错过今日时段' };
const checkLabels = { ok: '已就绪', warning: '需留意', blocked: '待处理', unknown: '待检查' };
const filters = { all: '全部', problems: '异常', submitted: '已提交', preview: '预览' };
const when = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const platformLabels = { published: '已发布', pending: '审核中', rejected: '未通过', unknown: '状态待确认' };
const platformState = run => Object.hasOwn(platformLabels, run.platformReview?.state) && Number.isFinite(Date.parse(run.platformObservedAt || run.platformReview?.observedAt)) ? run.platformReview.state : '';
const needsReconcile = run => run.status === 'uncertain' || run.status === 'submitted' && !['published', 'rejected'].includes(platformState(run));
const workLink = value => typeof value === 'string' && /^https:\/\/www\.douyin\.com\/video\/\d{1,32}$/.test(value) ? value : '';
const defaultNewsFeed = 'https://www.ithome.com/rss/';
const runTitle = run => run.title || (run.sourceMode === 'news' ? '每日资讯速览' : '每日商品介绍');
const runLabel = run => run.status === 'selecting' && run.sourceMode === 'news' ? '整理资讯中' : run.status === 'submitted' && platformState(run) ? '已提交' : labels[run.status] || run.status;
function sourceLink(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}

export function createDailyProduction({ notify, refreshWorkspace }) {
  let snapshot, problem = '', loading = false, busy = false, authorized = false;
  let sourceDraft = null, contentDraft = null, scheduleDraft = null, browsers = [], browserId = '', recordFilter = 'all', loadVersion = 0;
  const isBusy = () => busy || snapshot?.busy;
  const isNews = () => snapshot?.config.sourceMode === 'news';
  const sourceConfig = () => ({ mode: snapshot.config.sourceMode || 'products', feedUrl: snapshot.config.newsFeedUrl || defaultNewsFeed, keywords: snapshot.config.newsKeywords || '' });
  const scheduleConfig = () => ({ startTime: snapshot.config.startTime, executionMode: snapshot.config.executionMode || 'daily', executionDate: snapshot.config.executionDate || '' });
  const isOnce = () => snapshot?.config.executionMode === 'once';
  const scheduleText = () => isOnce() ? `仅 ${snapshot.config.executionDate} ${snapshot.config.startTime} 执行一次` : `每天 ${snapshot.config.startTime}`;
  const hasUnsavedSettings = () => contentDraft !== null || !isNews() && sourceDraft !== null || scheduleDraft !== null;
  async function request(route = '', body) {
    const mutation = body !== undefined;
    const timeout = ['/connect', '/sync'].includes(route) ? 180000 : ['/check', '/toggle'].includes(route) ? 60000 : 20000;
    const response = await fetch('/api/daily-production' + route, {
      method: mutation ? 'POST' : 'GET',
      headers: mutation ? { 'Content-Type': 'application/json', 'If-Match': snapshot?.revision || 'missing' } : {},
      body: mutation ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '操作未完成');
    return data;
  }
  function acceptSnapshot(value) {
    if (snapshot && ['accountId', 'browserId', 'startTime', 'executionMode', 'executionDate', 'enabled', 'sourceFolder', 'sourceMode', 'newsFeedUrl', 'newsKeywords'].some(key => snapshot.config[key] !== value.config[key])) authorized = false;
    snapshot = value;
  }
  function warningMarkup(warnings, title = '处理提示', key = 'sync-warnings') {
    return warnings?.length ? `<details class="daily-warnings" data-daily-detail="${esc(key)}"><summary>${esc(title)}（${warnings.length}）</summary>${warnings.map(w => `<p class="form-hint">${esc(typeof w === 'string' ? w : w?.message || JSON.stringify(w))}</p>`).join('')}</details>` : '';
  }
  function summaryMarkup() {
    const today = snapshot.todayRun;
    const unresolved = snapshot.runs.filter(needsReconcile).length;
    return `<section class="daily-summary" aria-label="每日生产概况">
      <div class="card"><span class="daily-summary-label">今日状态</span><strong>${esc(scheduleLabels[snapshot.scheduleState] || (snapshot.config.enabled ? '等待开始' : '计划已暂停'))}</strong><small>${today ? `${esc(runLabel(today))}${platformState(today) ? ` · 平台${platformLabels[platformState(today)]}` : ''} · ${esc(runTitle(today))}` : '今天还没有正式执行记录'}</small></div>
      <div class="card"><span class="daily-summary-label">待核实 / 待审核</span><strong>${unresolved} 条</strong><small>${unresolved ? '在下方记录中核对作品实际状态' : '暂无需要核实的发布记录'}</small></div>
      <div class="card"><span class="daily-summary-label">下次执行 · 北京时间</span><strong class="daily-next-run">${when(snapshot.nextRunAt)}</strong><small>${esc(scheduleText())} · 电脑和本地服务需持续运行</small></div>
    </section>`;
  }
  function articleMarkup(item) {
    const link = sourceLink(item.url);
    return `<li><b>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(item.title || '查看原文')}</a>` : esc(item.title || '资讯原文')}</b><small>${esc(item.sourceName || '公开资讯源')}${item.publishedAt ? ` · ${when(item.publishedAt)}` : ''}</small></li>`;
  }
  function contentSourceMarkup() {
    const config = contentDraft || sourceConfig();
    const news = config.mode === 'news';
    const items = [...(snapshot.newsItems || [])].sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0)).slice(0, 5);
    return `<section class="card daily-section daily-content-source"><div class="card-title"><h3>制作什么内容</h3><span class="pill">已保存：${isNews() ? '资讯视频' : '商品介绍'}</span></div>
      <p>现阶段选择资讯视频即可：自动采集公开资讯，制作原创排版的静音图卡字幕视频，再按计划发布。</p>
      <div class="daily-source-modes" role="group" aria-label="内容来源模式">
        <label class="check-row"><input type="radio" name="daily-source-mode" value="news" ${news ? 'checked' : ''} ${isBusy() ? 'disabled' : ''}>资讯视频（推荐）</label>
        <label class="check-row"><input type="radio" name="daily-source-mode" value="products" ${!news ? 'checked' : ''} ${isBusy() ? 'disabled' : ''}>商品介绍</label>
      </div>
      ${news ? `<div class="field"><label for="daily-news-feed">公开 RSS 资讯源（HTTPS）</label><input id="daily-news-feed" type="url" value="${esc(config.feedUrl)}" ${isBusy() ? 'disabled' : ''}><small>默认 IT 之家科技资讯。支持填写其他使用 HTTPS 的公开 RSS 地址。</small></div><div class="field"><label for="daily-news-keywords">关注关键词（选填）</label><input id="daily-news-keywords" value="${esc(config.keywords)}" placeholder="例如：人工智能,手机,机器人" ${isBusy() ? 'disabled' : ''}><small>多个词用逗号隔开，留空采集该来源的全部资讯。</small></div><p class="form-hint">每条视频选取最近 48 小时内尚未发布的最多 3 条资讯，按时间选择，无热度排名数据。使用原创文字排版，不下载他人的视频或配图；成片为静音图卡字幕视频，无旁白，不是 AI 动态视频。</p>` : '<p class="form-hint">沿用已有的本地商品日报、商品图片和商品库。保存模式后可在下方设置商品目录。</p>'}
      <div class="form-actions"><button class="button button-green" data-daily="content-source" ${isBusy() || contentDraft === null ? 'disabled' : ''}>保存内容来源</button><button class="button button-light" data-daily="default-news" ${isBusy() ? 'disabled' : ''}>一键使用科技资讯</button>${isNews() ? `<button class="button button-light" data-daily="sync" ${isBusy() || hasUnsavedSettings() ? 'disabled' : ''}>立即采集资讯</button>` : ''}</div>
      <p class="form-hint">更改内容来源会暂停计划，需核对账号后重新开启。“一键使用科技资讯”只保存来源，不会开启发布。${contentDraft !== null ? '<b>内容来源尚未保存。</b>' : ''}</p>
      ${isNews() ? `<div class="daily-news-preview"><h4>最近采集的资讯</h4>${items.length ? `<ul class="daily-news-articles">${items.map(articleMarkup).join('')}</ul>` : '<p class="muted">保存来源后点击“立即采集资讯”，原文链接会显示在这里。</p>'}<p class="form-hint">可用于下一条视频：${snapshot.eligible} 条。同一篇已提交、已发布或结果待核实的资讯不会重复选入；仅生成预览不消耗资讯。</p></div>` : ''}
    </section>`;
  }
  function readinessMarkup() {
    const readiness = snapshot.readiness;
    const actionText = { sync: isNews() ? '采集资讯' : '同步商品', connect: '识别账号', check: '检查环境', shop: isNews() ? '采集资讯' : '查看商品', automation: '查看发布队列', reconcile: '核实记录' };
    const checks = readiness?.checks || [];
    return `<section class="card daily-section"><div class="card-title"><h3>运行准备</h3><button class="button button-light" data-daily="check" ${isBusy() || hasUnsavedSettings() ? 'disabled' : ''}>检查运行条件</button></div>
      <p class="form-hint">${readiness?.checkedAt ? `检查时间：${when(readiness.checkedAt)}。` : `先检查来源、${isNews() ? '资讯' : '商品'}、制作环境和发布账号。`}检查不会生成视频或发布作品。</p>
      ${checks.length ? `<ul class="daily-readiness">${checks.map(check => {
        const state = Object.hasOwn(checkLabels, check.state) ? check.state : 'unknown';
        const action = Object.hasOwn(actionText, check.action) ? isNews() && check.action === 'shop' ? 'sync' : check.action : '';
        const navigation = ['shop', 'automation'].includes(action);
        return `<li class="daily-check daily-check-${state}"><span class="daily-check-state">${checkLabels[state]}</span><div><b>${esc(check.label)}</b><p>${esc(check.message)}</p></div>${action ? `<button class="text-link" ${navigation ? `data-go="${action}"` : `data-daily="${action}"`} ${!navigation && (isBusy() || hasUnsavedSettings()) ? 'disabled' : ''}>${actionText[action]}</button>` : ''}</li>`;
      }).join('')}</ul>` : '<p class="muted">尚无准备检查结果，点击上方按钮获取。</p>'}
      ${snapshot.environment?.message ? `<p class="form-hint">制作环境：${esc(snapshot.environment.message)}${snapshot.environment.checkedAt ? `（${when(snapshot.environment.checkedAt)}）` : ''}</p>` : ''}
    </section>`;
  }
  function setupMarkup() {
    return `<section class="card daily-section"><div class="card-title"><h3>首次连接，以后沿用</h3><span class="pill">本机保存</span></div>
      ${!isNews() ? `<details data-daily-detail="source" ${!snapshot.lastSync || sourceDraft !== null ? 'open' : ''}><summary>商品日报来源</summary>
        <div class="field"><label for="daily-source-folder">原选品项目的 output 目录</label><input id="daily-source-folder" value="${esc(sourceDraft ?? snapshot.config.sourceFolder)}" ${isBusy() ? 'disabled' : ''}><small>可直接使用默认收件目录，也可只改一次为原项目的 output、日期或单品目录。</small></div>
        <p class="form-hint">自动识别 01_全链路分析.md、05_发布文案.md 和 06_素材/images/；只导入有图片的新商品，保留已有编辑。更换来源会暂停计划。</p>
        <div class="form-actions"><button class="button button-light" data-daily="source" ${isBusy() ? 'disabled' : ''}>保存来源</button><button class="button button-light" data-daily="sync" ${isBusy() || hasUnsavedSettings() ? 'disabled' : ''}>立即同步商品</button></div>
      </details>` : ''}
      ${snapshot.lastSync ? `<p class="form-hint">上次${isNews() ? '采集' : '同步'} ${when(snapshot.lastSync.at)}：新增 ${snapshot.lastSync.added} ${isNews() ? '条' : '款'}，已有 ${snapshot.lastSync.existing} ${isNews() ? '条' : '款'}。</p>${warningMarkup(snapshot.lastSync.warnings, isNews() ? '采集提示' : '导入提示')}` : ''}
      <div class="form-actions"><button class="button button-light" data-daily="connect" ${isBusy() ? 'disabled' : ''}>自动识别抖音账号</button><button class="text-link" data-daily="browsers" ${isBusy() ? 'disabled' : ''}>选择浏览器</button>
        ${browsers.length ? `<select id="daily-browser" aria-label="发布浏览器" ${isBusy() ? 'disabled' : ''}><option value="">自动选择唯一连接</option>${browsers.map(b => `<option value="${esc(b.id)}" ${b.id === browserId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>` : ''}
      </div><p class="form-hint">登录状态沿用本机浏览器。只有一个连接时自动选择；不需要填写账号编号。</p>
    </section>`;
  }
  function scheduleMarkup() {
    const settings = scheduleDraft || scheduleConfig();
    const once = settings.executionMode === 'once';
    return `<section class="card daily-section"><div class="card-title"><h3>${esc(scheduleText())} · 免费本地合成 · 抖音 1 条</h3><span class="pill">${snapshot.config.enabled ? '已开启' : '已暂停'}</span></div>
      <p>${isNews() ? '自动采集公开资讯 → 选择近 48 小时的最新内容 → 制作原创静音图卡字幕视频 → 制作完成后公开发布。' : '从商品库选择尚未发布的商品 → 商品图片配字幕 → 生成竖屏视频 → 制作完成后公开发布。'}</p>
      <p class="form-hint">${isNews() ? '免费生成资讯速览，成片保留原文出处。' : '普通商品介绍，不挂商品链接。'}同一账号每天最多 1 条。单次计划完成、跳过或失败后暂停，过期不顺延；每日计划若已过开工时间或今天已有执行记录，从明天开始。</p>
      <div class="daily-schedule"><div class="field"><label for="daily-execution-mode">执行方式</label><select id="daily-execution-mode" ${isBusy() ? 'disabled' : ''}><option value="once" ${once ? 'selected' : ''}>只执行一次，随后暂停</option><option value="daily" ${!once ? 'selected' : ''}>每天执行，直到手动暂停</option></select></div>${once ? `<div class="field"><label for="daily-execution-date">单次日期（北京时间）</label><input id="daily-execution-date" type="date" required value="${esc(settings.executionDate)}" ${isBusy() ? 'disabled' : ''}></div>` : ''}<div class="field"><label for="daily-start-time">开始时间（北京时间）</label><input id="daily-start-time" type="time" required step="60" value="${esc(settings.startTime)}" ${isBusy() ? 'disabled' : ''}></div><button class="button button-light" data-daily="schedule" ${isBusy() || scheduleDraft === null ? 'disabled' : ''}>保存执行计划</button></div>
      <p class="form-hint">更改执行方式、日期或时间后计划暂停，核对后重新开启。允许在计划时间后 6 小时内开工；单次计划不会改到其他日期。${hasUnsavedSettings() ? '<b>有尚未保存的设置，请先保存后再检查或启动。</b>' : ''}</p>
      <p>目标抖音号：<b>${esc(snapshot.config.accountId || '尚未绑定')}</b> · ${isNews() ? '可选资讯' : '可选商品'}：<b>${snapshot.eligible}</b> ${isNews() ? '条' : '款'}</p>
      ${!snapshot.config.enabled ? `<label class="check-row"><input type="checkbox" data-daily-consent ${authorized ? 'checked' : ''} ${busy || hasUnsavedSettings() ? 'disabled' : ''}>允许${esc(scheduleText())}，${isNews() ? '从已保存的公开 RSS 来源选择最近 48 小时内最多 3 条资讯，制作 1 条原创排版的静音图卡字幕视频' : '从我的商品库选 1 款，使用已有图片和文案制作 1 条商品介绍视频'}，并公开发布到抖音号 ${esc(snapshot.config.accountId || '尚未绑定')}，无需逐条批准。${isOnce() ? '本次结束即暂停，不授权后续日期的发布。' : '此授权持续每天执行，直到我暂停或修改计划。'}</label>` : ''}
      ${snapshot.busy ? '<p class="form-hint">当前任务正在处理，可随时暂停后续发布。</p>' : ''}
      <div class="form-actions"><button class="button button-green" data-daily="toggle" ${busy || !snapshot.config.enabled && (!authorized || hasUnsavedSettings()) ? 'disabled' : ''}>${snapshot.config.enabled ? '暂停生产计划' : isOnce() ? '开启单次生产' : '开启每日生产'}</button><button class="button button-light" data-daily="preview" ${isBusy() || hasUnsavedSettings() ? 'disabled' : ''}>仅生成一条预览</button><button class="button button-light" data-daily="export">导出运行记录</button></div>
    </section>`;
  }
  function runMarkup(run) {
    const reviewState = platformState(run);
    const platformLink = workLink(run.platformUrl);
    const link = platformLink || (run.status === 'published' ? workLink(run.publishedUrl) : '');
    return `<article class="automation-item"><span class="pill">${esc(runLabel(run))}</span><h3>${esc(runTitle(run))}</h3>
      <small>${when(run.startedAt)}${run.previewOnly ? ' · 仅预览' : run.trigger === 'scheduler' ? ' · 定时触发' : ''}${run.binding?.executionMode === 'once' && !run.previewOnly ? ' · 单次计划' : ''}${run.seconds ? ` · ${esc(run.seconds)} 秒` : ''}</small><p>${reviewState ? '提交时回执：' : ''}${esc(run.message || '')}</p>
      ${reviewState ? `<p><b>平台审核：${platformLabels[reviewState]}</b></p><p class="form-hint">最近回采：${when(run.platformObservedAt || run.platformReview.observedAt)}。提交记录保留，用于防止重复发布。</p>` : ''}
      ${warningMarkup(run.warnings, '处理提示', `run-${run.id}`)}
      ${run.sourceMode === 'news' || run.sourceArticles?.length ? `<details class="daily-warnings" data-daily-detail="articles-${esc(run.id)}"><summary>资讯出处${run.sourceArticles?.length ? `（${run.sourceArticles.length}）` : ''}</summary>${run.sourceArticles?.length ? `<ul class="daily-news-articles">${run.sourceArticles.map(articleMarkup).join('')}</ul>` : '<p class="form-hint">此记录未保存原文链接。</p>'}</details>` : ''}
      ${run.asset ? `<video class="automation-review-video" controls preload="none" src="/api/daily-production/media?id=${encodeURIComponent(run.id)}"></video>` : ''}
      ${needsReconcile(run) ? `<button class="button button-light" data-daily="reconcile" data-id="${esc(run.id)}" ${busy ? 'disabled' : ''}>核实发布结果</button>` : ''}
      ${link ? `<a class="button button-light" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${platformLink ? '查看已绑定作品' : '查看作品'}</a>` : ''}
      ${run.status === 'uncertain' ? '<p class="form-hint">请先到抖音核实这次提交。此任务不会自动重发。</p>' : ''}
    </article>`;
  }
  function recordsMarkup() {
    const selected = snapshot.runs.filter(run => recordFilter === 'all' || recordFilter === 'problems' && (['failed', 'uncertain'].includes(run.status) || platformState(run) === 'rejected') || recordFilter === 'submitted' && ['submitted', 'published'].includes(run.status) || recordFilter === 'preview' && (run.previewOnly || run.status === 'preview'));
    return `<section class="card daily-section"><div class="card-title"><h3>每天的执行结果</h3><span class="pill">${selected.length} 条记录</span></div>
      <div class="daily-filters" role="group" aria-label="筛选运行记录">${Object.entries(filters).map(([id, title]) => `<button class="button button-light" data-daily-filter="${id}" aria-pressed="${id === recordFilter}" ${busy ? 'disabled' : ''}>${title}</button>`).join('')}</div>
      ${selected.slice(-30).reverse().map(runMarkup).join('') || '<p class="muted">暂无符合条件的记录。</p>'}
      ${selected.length > 30 ? '<p class="form-hint">显示最近 30 条符合条件的记录，导出可保存全部记录。</p>' : ''}
    </section>`;
  }
  function markup() {
    if (!snapshot) return `<div class="card empty">${esc(problem || '正在读取每日生产状态…')}</div>`;
    return `${problem ? `<div class="notice orange" role="alert">${esc(problem)}</div>` : ''}${busy ? '<p role="status">正在处理，请稍候…</p>' : ''}
      ${summaryMarkup()}${contentSourceMarkup()}${readinessMarkup()}${scheduleMarkup()}${setupMarkup()}
      <section class="card daily-section"><div class="card-title"><h3>当前接入情况</h3></div><p><b>${isNews() ? '资讯' : '商品'}来源：</b>${esc(snapshot.sourceMessage)}</p><p><b>视频制作：</b>${isNews() ? '本机生成 720×1280 原创静音图卡字幕视频，无旁白，不下载他人视频或配图，不调用付费模型。' : '本机生成 720×1280 静音字幕视频，无旁白，不调用付费模型。'}</p><p><b>效果数据：</b>${esc(snapshot.metricsMessage)}</p>${!isNews() ? '<div class="form-actions"><button class="button button-light" data-go="shop">查看 / 导入商品库</button></div>' : ''}${snapshot.error ? `<p class="form-error" role="alert">${esc(snapshot.error)}</p>` : ''}</section>
      ${recordsMarkup()}`;
  }
  function update() {
    const el = document.querySelector('#daily-production-root');
    if (el) {
      const details = new Map([...el.querySelectorAll('[data-daily-detail]')].map(item => [item.dataset.dailyDetail, item.open]));
      el.innerHTML = markup();
      for (const item of el.querySelectorAll('[data-daily-detail]')) {
        if (details.has(item.dataset.dailyDetail)) item.open = details.get(item.dataset.dailyDetail);
      }
    }
    document.querySelectorAll('[data-daily="refresh"]').forEach(button => { button.disabled = busy || loading; });
  }
  // A newer mutation invalidates any GET that started before it.
  async function load() {
    if (loading || busy) return;
    const version = ++loadVersion;
    loading = true;
    try {
      const data = await request();
      if (version !== loadVersion || busy) return;
      acceptSnapshot(data); problem = '';
      try { await refreshWorkspace(); }
      catch (error) {
        if (version === loadVersion && !busy) problem = `生产状态已更新，但工作区列表刷新失败：${error.message}。可稍后刷新页面。`;
      }
    } catch (error) {
      if (version === loadVersion && !busy) problem = `状态刷新失败：${error.message}`;
    } finally {
      loading = false;
      const root = document.querySelector('#daily-production-root');
      if (version === loadVersion && (!root || !pauseRefresh(root))) update();
      document.querySelectorAll('[data-daily="refresh"]').forEach(button => { button.disabled = busy; });
    }
  }
  async function refreshWorkspaceSafely() {
    try { await refreshWorkspace(); }
    catch (error) { problem = `操作已保存，但工作区列表刷新失败：${error.message}。可稍后刷新页面。`; }
  }
  async function recoverSnapshot(error) {
    problem = error.message;
    try { acceptSnapshot(await request()); }
    catch { problem += '；暂时无法更新状态，请刷新后再操作。'; }
  }
  function beginMutation() { busy = true; ++loadVersion; update(); }
  function updateSettingButtons() {
    const unsaved = hasUnsavedSettings();
    for (const action of ['sync', 'preview', 'check']) {
      document.querySelectorAll(`[data-daily="${action}"]`).forEach(button => { button.disabled = isBusy() || unsaved; });
    }
    const toggle = document.querySelector('[data-daily="toggle"]');
    if (toggle) toggle.disabled = busy || !snapshot.config.enabled && (!authorized || unsaved);
    const saveTime = document.querySelector('[data-daily="schedule"]');
    if (saveTime) saveTime.disabled = isBusy() || scheduleDraft === null;
    const saveContent = document.querySelector('[data-daily="content-source"]');
    if (saveContent) saveContent.disabled = isBusy() || contentDraft === null;
    const consent = document.querySelector('[data-daily-consent]');
    if (consent) consent.disabled = busy || unsaved;
  }
  function editContent(key, value) {
    contentDraft = { ...(contentDraft || sourceConfig()), [key]: value };
    const saved = sourceConfig();
    if (Object.keys(saved).every(field => saved[field] === contentDraft[field])) contentDraft = null;
    authorized = false;
    const consent = document.querySelector('[data-daily-consent]');
    if (consent) consent.checked = false;
  }
  function editSchedule(key, value) {
    scheduleDraft = { ...(scheduleDraft || scheduleConfig()), [key]: value };
    if (key === 'executionMode') scheduleDraft.executionDate = value === 'once' ? scheduleDraft.executionDate || new Date(Date.now() + 32 * 3600000).toISOString().slice(0, 10) : '';
    const saved = scheduleConfig();
    if (Object.keys(saved).every(field => saved[field] === scheduleDraft[field])) scheduleDraft = null;
    authorized = false;
    const consent = document.querySelector('[data-daily-consent]');
    if (consent) consent.checked = false;
  }
  document.addEventListener('input', event => {
    if (!snapshot) return;
    if (event.target.id === 'daily-source-folder') sourceDraft = event.target.value === snapshot.config.sourceFolder ? null : event.target.value;
    else if (event.target.id === 'daily-start-time') editSchedule('startTime', event.target.value);
    else if (event.target.id === 'daily-execution-date') editSchedule('executionDate', event.target.value);
    else if (event.target.id === 'daily-news-feed') editContent('feedUrl', event.target.value);
    else if (event.target.id === 'daily-news-keywords') editContent('keywords', event.target.value);
    else return;
    updateSettingButtons();
  });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-daily-consent]')) { authorized = event.target.checked; updateSettingButtons(); }
    if (event.target.id === 'daily-browser') browserId = event.target.value;
    if (event.target.id === 'daily-execution-mode') { editSchedule('executionMode', event.target.value); update(); }
    if (event.target.name === 'daily-source-mode') { editContent('mode', event.target.value); update(); }
  });
  function reconcile(run) {
    if (!run) { notify('暂无待核实记录，请刷新后查看最新状态。'); return; }
    const el = dialog('核实发布结果', `<p>${esc(runTitle(run))}。请到抖音确认后选择实际结果。</p><form><div class="field"><label for="daily-result">结果</label><select id="daily-result" name="result"><option value="published">作品已经发布</option><option value="not-published">确认完全未发布</option></select></div><div class="field"><label for="daily-url">已发布作品链接</label><input id="daily-url" type="url" name="url" required></div><label class="check-row"><input name="confirmed" type="checkbox" required>我已在抖音核实此条视频</label><p class="form-error" role="alert"></p><button class="button button-green">保存核实结果</button></form>`);
    let pending = false;
    const form = el.querySelector('form');
    const result = form.elements.result;
    const url = form.elements.url;
    result.onchange = () => { url.required = result.value === 'published'; url.disabled = result.value !== 'published'; };
    const close = el.querySelector('[data-dialog-close]');
    close.onclick = () => { if (!pending) el.close(); };
    el.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
    form.onsubmit = async event => {
      event.preventDefault(); event.stopPropagation();
      if (pending || busy) return;
      const body = { ...Object.fromEntries(new FormData(form)), id: run.id, confirmed: true };
      const controls = [...el.querySelectorAll('button,input,select')].map(input => [input, input.disabled]);
      pending = true; beginMutation();
      controls.forEach(([input]) => { input.disabled = true; });
      el.querySelector('.form-error').textContent = '';
      try {
        acceptSnapshot(await request('/reconcile', body)); problem = '';
        el.close(); notify('核实结果已保存');
        await refreshWorkspaceSafely();
      } catch (error) {
        await recoverSnapshot(error);
        el.querySelector('.form-error').textContent = problem;
      } finally {
        pending = busy = false;
        controls.forEach(([input, disabled]) => { input.disabled = disabled; });
        update();
      }
    };
  }
  document.addEventListener('click', async event => {
    const filter = event.target.closest('[data-daily-filter]');
    if (filter && !busy) { recordFilter = filter.dataset.dailyFilter; update(); return; }
    const button = event.target.closest('[data-daily]');
    if (!button || button.disabled || busy) return;
    const action = button.dataset.daily;
    if (action === 'refresh') { await load(); return; }
    if (!snapshot) return;
    if (action === 'reconcile') { reconcile(button.dataset.id ? snapshot.runs.find(r => r.id === button.dataset.id) : snapshot.runs.find(r => r.status === 'uncertain') || snapshot.runs.find(needsReconcile)); return; }
    if (action === 'export') { download({ exportedAt: new Date().toISOString(), ...snapshot }, 'doufeng-daily-production.json'); return; }
    if (!['browsers', 'toggle', 'source', 'content-source', 'default-news', 'schedule', 'sync', 'connect', 'preview', 'check'].includes(action)) return;
    if (action === 'schedule' && (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleDraft?.startTime || '') || scheduleDraft.executionMode === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(scheduleDraft.executionDate))) { notify('请选择有效的开始时间和单次日期。'); return; }
    if (action === 'content-source' && (contentDraft || sourceConfig()).mode === 'news') {
      const feed = sourceLink((contentDraft || sourceConfig()).feedUrl);
      if (!feed || new URL(feed).protocol !== 'https:') { notify('请填写有效的公开 HTTPS RSS 地址。'); return; }
    }
    beginMutation();
    try {
      if (action === 'browsers') {
        browsers = (await request('/browsers')).browsers;
        if (!browsers.length) throw new Error('没有可用浏览器，请连接扩展后重试。');
        problem = '';
      } else {
        if (action === 'toggle' && !snapshot.config.enabled && !snapshot.eligible) acceptSnapshot(await request('/sync', {}));
        const body = action === 'toggle' ? { enabled: !snapshot.config.enabled, authorized }
          : action === 'source' ? { folder: sourceDraft ?? snapshot.config.sourceFolder }
          : action === 'content-source' ? { ...(contentDraft || sourceConfig()) }
          : action === 'default-news' ? { mode: 'news', feedUrl: defaultNewsFeed, keywords: '' }
          : action === 'schedule' ? { ...scheduleDraft }
          : action === 'connect' ? { browserId } : {};
        acceptSnapshot(await request('/' + (action === 'default-news' ? 'content-source' : action), body));
        if (action === 'source') { sourceDraft = null; authorized = false; }
        if (['content-source', 'default-news'].includes(action)) { contentDraft = null; authorized = false; }
        if (action === 'schedule') { scheduleDraft = null; authorized = false; }
        problem = '';
        notify({
          preview: '已开始生成预览，不会发布', source: '来源已保存，以后开工前自动同步',
          'content-source': '内容来源已保存，请核对后重新开启计划',
          'default-news': '已保存科技资讯来源，可先采集资讯和生成预览',
          schedule: `已保存：${scheduleText()}，请核对并重新开启计划`,
          sync: isNews() ? '资讯采集完成' : '商品同步完成', connect: '账号已识别，请核对目标抖音号',
          check: '运行条件检查完成，请查看准备清单',
          toggle: snapshot.config.enabled ? `已开启：${scheduleText()}` : '已暂停生产计划'
        }[action]);
        if (['preview', 'sync', 'toggle'].includes(action)) await refreshWorkspaceSafely();
      }
    } catch (error) { await recoverSnapshot(error); }
    finally { busy = false; update(); }
  });
  function editing(root) {
    const active = document.activeElement;
    return root.contains(active) && (active.isContentEditable || active.matches('textarea,select,input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"])'));
  }
  function pauseRefresh(root) {
    return document.querySelector('dialog[open]') || editing(root) || [...root.querySelectorAll('video')].some(video => !video.paused);
  }
  setInterval(() => {
    const root = document.querySelector('#daily-production-root');
    if (root && !pauseRefresh(root)) void load();
  }, 5000);
  return { mount: load, render: () => `<div class="page-head"><div><p class="eyebrow">DAILY PRODUCTION</p><h1>每日自动生产</h1><p>一次设置，查看每天的内容采集、成片和发布结果。</p></div><button class="button button-light" data-daily="refresh" ${busy || loading ? 'disabled' : ''}>刷新</button></div><div id="daily-production-root">${markup()}</div>` };
}
