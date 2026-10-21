import { cachedState, createStateSync } from './state-sync.js';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';
import { moveToTrash, validateMetric } from '../workbuddy/connector/lib/workspace-actions.mjs';
import { createVideoStudio } from './video-studio.js';
import { createPublishPlanner } from './publish-planner.js';
import { createContentLibrary } from './content-library.js';
import { createDataCenter } from './data-center.js';
import { createShopWorkspace } from './shop-workspace.js';
import { createAutomationWorkspace } from './automation.js';
import { createDailyProduction } from './daily-production.js';
import { createDouyinTracking } from './douyin-tracking.js';
import { dashboard } from './dashboard.js';
import { renderLegacyPage } from './legacy-pages.js';
import { esc, request, download, localDay, createFormMemory } from './workspace-ui.js';

const defaults = normalizeState({ account: '我的账号', persona: '表达直接、自然，用具体信息帮助观众。视频前三秒有钩子，结尾留一个自然问题。' });
let state = cachedState(defaults), page = 'home', toastTimer, refreshing = false, connectorBusy = false;
const runtime = { online: false, workbuddy: { packageReady: false }, browserSkill: { installed: false, connected: false, message: '打开应用接入后检查' }, jobs: [], activity: [] };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const makeId = () => crypto.randomUUID();
const today = () => new Date().toLocaleDateString('zh-CN');
const memory = createFormMemory();
const save = () => sync.save();

function notify(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}
function remove(collection, id) {
  if (!confirm('将这条内容移入回收站？之后可以在数据管理中恢复。')) return false;
  try { moveToTrash(state, collection, id); save(); render(); notify('已移入回收站'); return true; }
  catch (error) { notify(error.message); return false; }
}
function go(next, fromHistory = false) {
  page = Object.hasOwn(pages, next) ? next : 'home';
  if (!fromHistory && location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
  render(); $('#view').focus({ preventScroll: true }); $('#sidebar').classList.remove('open');
  if (page === 'live') void refreshRuntime(true);
}
function track(id) {
  const draft = state.drafts.find(item => item.id === id); if (!draft) return;
  go('tracking'); $('#mTitle').value = draft.pubTitle || draft.title || ''; $('#metric-draft').value = id;
  if (draft.publishedAt || draft.scheduledAt) $('#mPublished').value = localDay(new Date(draft.publishedAt || draft.scheduledAt));
  $('#mTitle').dispatchEvent(new Event('input', { bubbles: true }));
}

const studio = createVideoStudio({ getState: () => state, save, go, openDraft: id => planner.open(id), notify, esc });
const planner = createPublishPlanner({ getState: () => state, save, render, notify, go, remove, track });
const shop = createShopWorkspace({ getState: () => state, save, render, notify, go, openDraft: id => planner.open(id), openVideo: id => studio.open(id), remove });
const library = createContentLibrary({ getState: () => state, save, render, notify, openVideo: id => studio.open(id), openDraft: id => planner.open(id), openProduct: id => shop.edit(id), remove });
const dataCenter = createDataCenter({ getState: () => state, getSync: () => sync, save, render, notify });
const automation = createAutomationWorkspace({ notify });
const dailyProduction = createDailyProduction({ notify, refreshWorkspace: () => sync.refreshSaved() });
const douyinTracking = createDouyinTracking({ notify, refreshWorkspace: () => sync.refreshSaved() });
const sync = createStateSync({ getState: () => state, setState(value, { initial = false } = {}) {
  state = value; studio.reset({ preserveEditor: initial }); planner.reset({ preserveEditor: initial }); shop.reset({ preserveEditor: initial });
  if (!initial) memory.reset();
}, render, notify });

const head = (eyebrow, title, desc, actions = '') => `<div class="page-head"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p>${desc}</p></div><div class="page-actions">${actions}</div></div>`;
const card = (title, body, extra = '') => `<section class="card ${extra}"><div class="card-title"><h3>${title}</h3></div>${body}</section>`;
const btn = (label, action, kind = 'button-light', extra = '') => `<button type="button" class="button ${kind}" data-action="${esc(action)}" ${extra}>${label}</button>`;
const empty = (icon, title, desc) => `<div class="empty"><div class="empty-icon">${icon}</div><b>${title}</b><div>${desc}</div></div>`;
const metric = (name, value, note, icon) => `<div class="card metric-card"><div class="metric-top">${name}<span class="metric-icon">${icon}</span></div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`;
function field(label, name, placeholder = '', type = 'text', value = '', cls = '') {
  const required = ['title', 'mTitle', 'recordTitle', 'commentText', 'accountName', 'pain', 'jobLabel', 'jobUrl', 'nextRunAt'].includes(name) ? 'required' : '';
  const bounds = type === 'number' ? ['completion', 'retention', 'conversion'].includes(name) ? 'min="0" max="100" step="0.01"' : 'min="0" step="1"' : '';
  return `<div class="field ${cls}"><label for="${name}">${label}</label>${type === 'textarea' ? `<textarea id="${name}" name="${name}" placeholder="${esc(placeholder)}" maxlength="20000" ${required}>${esc(value)}</textarea>` : `<input id="${name}" name="${name}" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" maxlength="2000" ${required} ${bounds}>`}</div>`;
}
const navNames = { home: '总览', account: '账号诊断', research: '推荐流研究', ideas: '选题与脚本', video: '视频制作台', remix: '爆款拆解', publish: '发布计划', comments: '评论回复', tracking: '效果追踪', knowledge: '内容库', data: '数据管理', live: '应用接入', settings: '账号与设置' };
navNames.shop = '电商选品';
navNames.automation = '每日自动发布';
navNames.production = '每日自动生产';
const pages = { home: () => dashboard(state), video: studio.render, publish: planner.render, knowledge: library.render, data: dataCenter.render, shop: shop.render };
pages.automation = automation.render;
pages.production = dailyProduction.render;
for (const name of ['account', 'research', 'ideas', 'remix', 'comments', 'tracking', 'live', 'settings']) pages[name] = () => renderLegacyPage(name, { state, runtime, head, card, btn, field, metric, empty });

function connectionStatus() {
  $('#connection-status').innerHTML = `<span class="status-dot ${runtime.online ? 'connected' : ''}"></span>${runtime.online ? '本地服务已连接' : '本地服务未连接'}`;
}
function render() {
  $('#side-account').textContent = state.account; $('#page-title').textContent = navNames[page];
  document.title = `${navNames[page]} · 豆蜂`;
  try { $('#view').innerHTML = pages[page](); memory.restore(); }
  catch (error) {
    console.error(error);
    $('#view').innerHTML = `${head('WORKSPACE', '暂时无法显示页面', '可以导出当前数据，或打开数据管理恢复备份。')}<div class="notice orange">${esc(error.message)}</div><div class="form-actions">${btn('导出当前数据', 'export-data')}<button class="button button-green" data-go="data">数据管理</button></div>`;
  }
  for (const el of $$('.nav-item')) { el.classList.toggle('active', el.dataset.page === page); if (el.dataset.page === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); }
  connectionStatus(); if (page === 'data') void dataCenter.mount();
  if (page === 'automation') void automation.mount();
  if (page === 'production') void dailyProduction.mount();
  if (page === 'tracking') void douyinTracking.mount();
}
async function refreshRuntime(checkBrowser = false) {
  if (refreshing) return; refreshing = true;
  try {
    const [health, jobs, activity] = await Promise.all([request('/api/health'), request('/api/jobs'), request('/api/activity')]);
    runtime.online = true; runtime.workbuddy = health.workbuddy || runtime.workbuddy;
    runtime.jobs = jobs.jobs || []; runtime.activity = activity.activity || [];
    if (checkBrowser) {
      try { runtime.browserSkill = await request('/api/browser-skill/status', { signal: AbortSignal.timeout(25000) }); }
      catch (error) { runtime.browserSkill = { installed: false, connected: false, message: error.message }; }
    }
  } catch (error) { runtime.online = false; if (page === 'live') notify(error.message); }
  finally { refreshing = false; connectionStatus(); if (page === 'live' && !document.activeElement?.closest('form')) render(); }
}
async function runConnector(input, label) {
  if (connectorBusy) { notify('上一个浏览器操作仍在执行'); return; }
  connectorBusy = true; runtime.output = `${label}执行中…`; if ($('#connector-output')) $('#connector-output').textContent = runtime.output;
  try {
    const result = await request('/api/browser-skill/execute', { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(45000) });
    if (result.ok === false) throw new Error(result.message || result.stderr || '执行失败');
    runtime.output = JSON.stringify(result.data ?? result.stdout ?? result, null, 2); notify(`${label}完成`);
  } catch (error) { runtime.output = `${label}失败：${error.message}`; notify(runtime.output); }
  finally { connectorBusy = false; if ($('#connector-output')) $('#connector-output').textContent = runtime.output; await refreshRuntime(true); }
}
function addRecord(type, category, title, summary, extra = {}) {
  state.records.push({ id: makeId(), type, category, title, summary, date: today(), createdAt: new Date().toISOString(), ...extra });
}

document.addEventListener('click', async event => {
  try {
    if (await studio.handleClick(event)) return;
    const target = event.target;
    const nav = target.closest('[data-page]'); if (nav) { go(nav.dataset.page); return; }
    const link = target.closest('[data-go]'); if (link) { go(link.dataset.go); return; }
    const video = target.closest('[data-open-video]'); if (video) { studio.open(video.dataset.openVideo); return; }
    const del = target.closest('[data-delete]'); if (del) { const [collection, id] = del.dataset.delete.split(':'); remove(collection, id); return; }
    const copy = target.closest('[data-copy]'); if (copy) { await navigator.clipboard.writeText(copy.dataset.copy); notify('已复制'); return; }
    const job = target.closest('[data-job-delete]');
    if (job) { if (confirm('删除这个回采计划？')) { await request(`/api/jobs/${encodeURIComponent(job.dataset.jobDelete)}`, { method: 'DELETE' }); await refreshRuntime(); render(); notify('计划已删除'); } return; }
    const action = target.closest('[data-action]')?.dataset.action; if (!action) return;
    if (action.startsWith('go-')) go(action.slice(3));
    else if (action === 'connector-page') go('live');
    else if (action === 'connector-refresh') await refreshRuntime(true);
    else if (action === 'connector-start') await runConnector({ action: 'start' }, '启动会话');
    else if (action === 'connector-stop') await runConnector({ action: 'stop' }, '结束会话');
    else if (action === 'connector-observe') await runConnector({ action: 'observe' }, '观察页面');
    else if (action === 'open-douyin') await runConnector({ action: 'navigate', url: 'https://www.douyin.com/' }, '打开抖音');
    else if (action === 'open-creator') await runConnector({ action: 'navigate', url: 'https://creator.douyin.com/' }, '打开创作者中心');
    else if (action.startsWith('idea-video:')) { const idea = state.ideas.find(item => item.id === action.slice(11)); if (idea) studio.fromIdea(idea); }
    else if (action.startsWith('save-idea:')) {
      const idea = state.ideas.find(item => item.id === action.slice(10)); if (!idea) return;
      if (state.records.some(item => item.sourceIdeaId === idea.id)) { notify('这个选题已在内容库中'); return; }
      addRecord('选题', '选题', idea.title, `钩子：${idea.hook || ''}\n脚本：${idea.script || ''}\n结尾：${idea.cta || ''}`, { sourceIdeaId: idea.id }); save(); notify('选题已加入内容库');
    } else if (action === 'export-data') { download(state, `doufeng-${localDay()}.json`); notify('已导出当前数据，不包含素材文件'); }
    else if (action === 'sidebar-toggle') $('#sidebar').classList.toggle('open');
  } catch (error) { notify(error.message); }
});

const formHandlers = {
  'settings-form'(x) { if (!x.accountName.trim()) throw new Error('请输入账号名称'); Object.assign(state, { account: x.accountName.trim(), audience: x.settingsAudience, pillars: x.settingsPillars, persona: x.settingsPersona }); },
  'diagnosis-form'(x) {
    const scores = [0, 1, 2, 3, 4].map(i => Number(x[`score${i}`]));
    if (scores.some(n => !Number.isInteger(n) || n < 1 || n > 5)) throw new Error('评分必须在 1–5 之间');
    state.audience = x.audience; state.pillars = x.pillars; state.diagnosis = { scores, strength: x.strength || '待补充', weakness: x.weakness || '待补充', next: x.next || '待补充', sample: x.sample, date: today() };
    addRecord('诊断', '账号', '账号五维诊断', `优势：${state.diagnosis.strength}\n短板：${state.diagnosis.weakness}\n下一步：${state.diagnosis.next}`);
  },
  'research-form'(x) {
    if (!x.title.trim()) throw new Error('请填写主题与标题'); state.research.push({ ...x, id: makeId(), date: today() });
    addRecord('观察', '模式', x.title, `钩子：${x.hook || '—'}\n可借鉴：${x.takeaway || x.structure || '—'}`);
  },
  'ideas-form'(x) {
    const pain = x.pain.trim(); if (!pain) throw new Error('请填写本轮主题');
    const templates = [
      ['反差切入', `关于${pain}，你可能漏了这一步。`, '列出一个待核实的常见误区。\n补充自己的案例和可验证的做法。\n给观众一个今天就能尝试的小动作。', '你也遇到过这个问题吗？'],
      ['经验拆解', `${pain}，我会从这几个步骤开始。`, '补充自己的真实经历。\n对比尝试前后的变化，并解释原因。\n给出一条具体建议，避免编造体验。', '你还有什么更省事的方法？'],
      ['问题共鸣', `如果你也被${pain}卡住，可以先从这里开始。`, '描述观众熟悉的场景。\n拆出造成问题的两个原因。\n分享一个小步骤，说明适用边界。', '你现在最想解决哪一步？']
    ];
    for (const [angle, hook, script, cta] of templates) state.ideas.push({ id: makeId(), date: today(), title: `${x.direction || '内容'}：${pain} · ${angle}`, angle: x.angle || angle, target: x.target, tone: x.tone, hook, script: `目标观众：${x.target || '待补充'}\n表达立场：${x.angle || '待补充'}\n语气：${x.tone || '自然'}\n\n${script}`, cta, duration: x.duration, bgm: '按内容节奏选择已获授权的音乐' });
  },
  'remix-form'(x) { addRecord('拆解', '模式', x.sourceTopic || '爆款结构拆解', `参考链接：${x.sourceUrl || '—'}\n主题：${x.sourceTopic || '—'}\n开场：${x.sourceHook || '—'}\n结构：${x.sourceFlow || '—'}\n互动：${x.sourceCta || '—'}\n原创角度：${x.newAngle || '—'}\n原创脚本：${x.newScript || '—'}`); },
  'comment-form'(x) {
    if (!x.commentText.trim()) throw new Error('请填写原评论');
    const reply = `${x.replyStyle === '温和解释' ? '理解你的想法。' : x.replyStyle === '直球带梗' ? '我直接说：' : '谢谢你分享。'}${x.replyType === '被夸 / 闲聊' ? '收到这句鼓励，今天剪片都有劲了。' : '关于你提到的问题，[补充与你的视频和这条评论相关的具体回答]。'}`;
    state.comments.push({ id: makeId(), date: today(), comment: x.commentText, context: x.commentContext, replyType: x.replyType, reply });
  },
  'metrics-form'(x) {
    validateMetric(x); state.metrics.push({ ...x, id: makeId(), date: today(), createdAt: new Date().toISOString() });
    addRecord('复盘', '复盘', x.mTitle, `播放 ${x.plays || 0}；完播 ${x.completion || 0}%；互动 ${x.likes || 0} 赞 / ${x.mComments || 0} 评 / ${x.shares || 0} 分享。\n下一步：${x.reflection || '待补'}`, { draftId: x.draftId || '' });
  },
  'record-form'(x) { if (!x.recordTitle.trim()) throw new Error('请填写标题'); addRecord('手动记录', x.category, x.recordTitle, x.recordSummary || ''); }
};
document.addEventListener('submit', async event => {
  if (studio.handleSubmit(event) || planner.handleSubmit(event)) return;
  const form = event.target; if (!(form instanceof HTMLFormElement) || form.closest('dialog')) return;
  event.preventDefault(); if (form.dataset.busy) return;
  const values = Object.fromEntries(new FormData(form)); const button = event.submitter;
  form.dataset.busy = 'true'; if (button) button.disabled = true;
  try {
    if (form.id === 'job-form') {
      await request('/api/jobs', { method: 'POST', body: JSON.stringify({ label: values.jobLabel, url: values.jobUrl, extractor: values.extractor, repeat: values.repeat, nextRunAt: new Date(values.nextRunAt).toISOString() }) });
      form.reset(); await refreshRuntime(); render(); notify('回采计划已创建'); return;
    }
    if (form.id === 'upload-form') {
      const file = $('#media-file')?.files?.[0]; if (!file) throw new Error('请选择素材文件');
      const response = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || '素材准备失败'); runtime.lastUploadPath = result.path; render(); notify('素材已保存到本机'); return;
    }
    if (!formHandlers[form.id]) return;
    formHandlers[form.id](values); memory.clear(form); save(); render();
    notify(form.id === 'ideas-form' ? '已创建 3 个写作模板，可在内容库继续编辑' : form.id === 'comment-form' ? '回复模板已保存，请补充具体内容' : '已记录，正在保存到本机');
  } catch (error) { notify(error.message); }
  finally { delete form.dataset.busy; if (button) button.disabled = false; }
});
document.addEventListener('change', event => {
  if (event.target.id !== 'metric-draft') return;
  const draft = state.drafts.find(item => item.id === event.target.value);
  if (draft && $('#mTitle')) { $('#mTitle').value = draft.pubTitle || draft.title || ''; $('#mTitle').dispatchEvent(new Event('input', { bubbles: true })); }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('#sidebar').classList.remove('open'); });
window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'home', true));
window.addEventListener('unhandledrejection', event => { console.error(event.reason); notify('操作未完成，请重试。未提交的内容仍可继续编辑。'); });
if (Object.hasOwn(pages, location.hash.slice(1))) page = location.hash.slice(1);
render(); void sync.initialize(); void refreshRuntime(page === 'live');
