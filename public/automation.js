import { esc, dialog, download } from './workspace-ui.js';
import { automationStatuses, editableStatuses } from '../shared/automation-model.mjs';

const when = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未排期';
const size = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function createAutomationWorkspace({ notify }) {
  let snapshot = null, browsers = [], loading = false, operation = false, problem = '', filter = 'active', page = 1, settingsDirty = false;
  const settingsKey = 'doufeng.automation-settings.v1';
  let settingsCache = null;
  try { settingsCache = JSON.parse(sessionStorage.getItem(settingsKey) || 'null'); settingsDirty = !!settingsCache; } catch {}
  async function api(path = '', body, revision = snapshot?.revision) {
    const response = await fetch('/api/automation' + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'If-Match': revision || 'missing' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === '/connect' ? 150000 : path.includes('/approve') ? 15 * 60000 : 60000) });
    const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.message || '操作未完成'), { status: response.status }); return result;
  }
  const view = () => `<div class="page-head"><div><p class="eyebrow">DAILY PUBLISH</p><h1>每日自动发布</h1><p>本地视频提前审好，到点发布到指定抖音账号。</p></div><button class="button button-light" data-auto="refresh">刷新状态</button></div><div class="automation-steps"><span>① 设置视频文件夹</span><span>→</span><span>② 识别抖音账号</span><span>→</span><span>③ 预览并批准内容</span><span>→</span><span>④ 开启每日发布</span></div><div id="automation-root">${markup()}</div>`;
  function markup() {
    if (!snapshot) return `<div class="card empty" role="status">${esc(problem || '正在读取自动发布设置…')}</div>`;
    const c = snapshot.config, settings = settingsCache || c;
    const counts = status => snapshot.items.filter(i => status.includes(i.status)).length;
    const choices = browsers.some(b => b.id === settings.browserId) || !settings.browserId ? browsers : [{ id: settings.browserId, name: '已保存的浏览器 · ' + settings.browserId }, ...browsers];
    return `${problem ? `<div class="notice orange automation-status" role="alert">${esc(problem)}</div>` : ''}${snapshot.scheduler.error ? `<div class="notice orange automation-status">${esc(snapshot.scheduler.error)}</div>` : ''}
      <div class="card automation-intro"><div><span class="pill ${c.enabled ? 'green' : 'orange'}">${c.enabled ? '每日自动发布已开启' : '自动发布已暂停'}</span><p>每天 <b>${esc(c.dailyTime)}</b> · 北京时间 · 最多 1 条 · 已批准 ${counts(['approved'])} 条 / 待审批 ${counts(['pending','failed','missed'])} 条</p><p class="form-hint">请保持电脑、豆蜂服务和已登录的浏览器运行。错过 10 分钟不补发；结果不明确时暂停并等待核实。</p></div><button class="button ${c.enabled ? 'button-light automation-pause' : 'button-green'}" data-auto="toggle" ${!c.enabled && !counts(['approved']) ? 'disabled' : ''}>${c.enabled ? '暂停自动发布' : '开启自动发布'}</button></div>
      <div class="automation-layout"><section class="card automation-settings"><div class="card-title"><h3>日常设置</h3><span class="pill">本机保存</span></div><form id="automation-settings"><div class="field"><label for="auto-folder">视频文件夹完整路径</label><input id="auto-folder" name="folder" value="${esc(settings.folder)}" placeholder="例如 D:\\视频待发布" maxlength="2000"><small>只扫描这一层的 MP4 / MOV / WebM，不移动原文件。</small></div><div class="field"><label for="auto-time">每天发布时间（北京时间）</label><input id="auto-time" name="dailyTime" type="time" value="${esc(settings.dailyTime)}" required></div><div class="field"><label for="auto-browser">用于发布的浏览器</label><select id="auto-browser" name="browserId"><option value="">请连接并选择浏览器</option>${choices.map(b => `<option value="${esc(b.id)}" ${settings.browserId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div><div class="row-actions"><button type="button" class="button button-light" data-auto="browsers">刷新浏览器列表</button><button type="submit" class="button button-green">保存设置</button></div><p class="form-hint">${settingsDirty ? '设置已暂存，尚未保存。' : '更改文件夹、时间或浏览器后，已批准的条目需要重新审批。'}</p></form><div class="automation-account"><b>${c.accountId ? `目标抖音号：${esc(c.accountId)}` : '尚未识别抖音账号'}</b><small>${c.verifiedAt ? `上次检查：${when(c.verifiedAt)}` : '先在 Chrome / Edge 登录抖音创作者中心并连接 BrowserSkill。'}</small></div><button class="button button-light" data-auto="connect" ${!c.browserId || settingsDirty ? 'disabled' : ''}>检查浏览器与账号</button><p class="form-hint">只读取账号并检查上传入口。登录、扫码和验证码由你在浏览器中完成。</p></section>
      <section class="card"><div class="card-title"><h3>视频发布队列</h3><span class="pill">${snapshot.items.length} 条</span></div><div class="automation-toolbar"><button class="button button-green" data-auto="scan" ${!c.folder || settingsDirty ? 'disabled' : ''}>扫描视频文件夹</button><button class="button button-light" data-auto="export">导出发布记录</button><select id="auto-filter" aria-label="筛选发布队列"><option value="active" ${filter === 'active' ? 'selected' : ''}>待处理</option><option value="approved" ${filter === 'approved' ? 'selected' : ''}>已批准</option><option value="history" ${filter === 'history' ? 'selected' : ''}>提交与发布记录</option><option value="all" ${filter === 'all' ? 'selected' : ''}>全部</option></select></div><div id="automation-items">${itemsMarkup()}</div></section></div>
      <section class="card automation-log"><div class="card-title"><h3>最近执行记录</h3><small>每 15 秒检查到期任务</small></div>${snapshot.events.slice(-10).reverse().map(e => `<article><small>${when(e.at)}</small><p>${esc(e.message)}</p></article>`).join('') || '<p class="muted">设置、审批和执行结果会记录在这里。</p>'}<p class="form-hint">审批时会保存视频副本。迁移时请复制整个 runtime 目录；“数据管理”的工作区 JSON 不包含此队列和视频文件。</p></section>`;
  }
  function itemsMarkup() {
    const items = snapshot.items.filter(i => filter === 'all' || filter === 'approved' && i.status === 'approved' || filter === 'history' && ['submitted','published'].includes(i.status) || filter === 'active' && !['submitted','published','cancelled'].includes(i.status));
    const pages = Math.max(1, Math.ceil(items.length / 10)); page = Math.min(page, pages);
    if (!items.length) return '<div class="automation-empty"><b>从一条视频开始</b><p>保存文件夹后点击扫描，再预览视频、填写文案并批准排期。</p><p>扫描到的内容不会直接发布。</p></div>';
    return items.slice((page - 1) * 10, page * 10).map(item => `<article class="automation-item"><div class="chip-list"><span class="pill ${['approved','published','submitted'].includes(item.status) ? 'green' : ['failed','uncertain','missed'].includes(item.status) ? 'orange' : ''}">${automationStatuses[item.status]}</span><span class="pill">${size(item.sourceSize)}</span></div><h3>${esc(item.title)}</h3><small>${esc(item.fileName)}</small><p>计划：${when(item.scheduledAt)}${item.approval ? ` · 抖音号 ${esc(item.approval.accountId)}` : ''}</p>${item.message ? `<p>${esc(item.message)}</p>` : ''}<div class="row-actions"><button class="button button-light" data-auto="review" data-id="${item.id}">${editableStatuses.includes(item.status) ? '预览 / 编辑 / 审批' : '查看内容'}</button>${item.status === 'approved' ? `<button class="text-link" data-auto="cancel" data-id="${item.id}">撤销批准</button>` : ''}${['uncertain','submitted'].includes(item.status) ? `<button class="button button-light" data-auto="reconcile" data-id="${item.id}">核实发布结果</button>` : ''}${item.status === 'published' && /^https:\/\/(?:www\.|v\.)?douyin\.com\//.test(item.publishedUrl || '') ? `<a class="text-link" href="${esc(item.publishedUrl)}" target="_blank" rel="noopener noreferrer">查看作品 ↗</a>` : ''}</div></article>`).join('') + `<div class="pagination"><button class="button button-light" data-auto="previous" ${page <= 1 ? 'disabled' : ''}>上一页</button><span>${page} / ${pages}</span><button class="button button-light" data-auto="next" ${page >= pages ? 'disabled' : ''}>下一页</button></div>`;
  }
  function update() { const root = document.querySelector('#automation-root'); if (root) root.innerHTML = markup(); }
  async function load() {
    if (loading || operation) return;
    loading = true;
    try { snapshot = await api(); problem = ''; } catch (error) { problem = error.message; }
    finally { loading = false; update(); }
  }
  function captureSettings(form) {
    settingsCache = Object.fromEntries(new FormData(form)); settingsDirty = true;
    try { sessionStorage.setItem(settingsKey, JSON.stringify(settingsCache)); } catch {}
  }
  function review(item) {
    const editable = editableStatuses.includes(item.status), revision = snapshot.revision, scheduledAt = editable ? snapshot.suggestedAt : item.scheduledAt, accountId = editable ? snapshot.config.accountId : item.approval?.accountId;
    const el = dialog(editable ? '预览并审批这条视频' : '查看已审批内容', `<video class="automation-review-video" controls preload="metadata" src="/api/automation/media?id=${item.id}"></video><p class="form-hint">${esc(item.fileName)} · ${size(item.sourceSize)}。如浏览器无法播放，请先在本机查看完整视频，或转换为兼容的 MP4。</p><form id="automation-review"><div class="field"><label for="auto-title">作品标题（最多 30 字）</label><input id="auto-title" name="title" value="${esc(item.title)}" maxlength="30" required ${editable ? '' : 'readonly'}></div><div class="field"><label for="auto-caption">发布文案与话题（最多 1000 字）</label><textarea id="auto-caption" name="caption" maxlength="1000" rows="5" ${editable ? '' : 'readonly'}>${esc(item.caption)}</textarea></div><div class="automation-review-details"><p><b>目标：抖音号 ${esc(accountId || '尚未识别')}</b></p><p>排期：${when(scheduledAt)}（北京时间）</p><p>内容可见范围：公开发布。平台仍会审核。</p></div>${editable ? `<label class="check-row"><input type="checkbox" name="reviewed">我已看过视频，确认素材权利、文案、目标账号和上述时间，允许到点自动发布此条内容。</label>` : ''}<p class="form-error" role="alert"></p><div class="form-actions">${editable ? `<button type="submit" value="save" class="button button-light">仅保存文案</button><button type="submit" value="approve" class="button button-green" ${!accountId ? 'disabled' : ''}>批准此视频和排期</button>` : ''}</div></form>`, { wide: true, guard: editable });
    let busy = false; el.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    el.querySelector('video').addEventListener('error', () => { el.querySelector('.form-error').textContent = '视频暂时无法预览，请检查文件是否移动或编码是否受支持。'; });
    el.querySelector('form').onsubmit = async event => {
      event.preventDefault(); event.stopPropagation(); if (busy) return;
      const data = Object.fromEntries(new FormData(event.target)), approve = event.submitter?.value === 'approve';
      if (approve && !data.reviewed) { el.querySelector('.form-error').textContent = '请先勾选内容与定时发布确认。'; return; }
      busy = true; el.querySelectorAll('button').forEach(b => { b.disabled = true; }); el.querySelector('.form-error').textContent = approve ? '正在保存批准的视频副本，请稍候…' : '正在保存…';
      try {
        snapshot = await api(`/items/${item.id}/${approve ? 'approve' : 'edit'}`, { title: data.title, caption: data.caption, reviewed: !!data.reviewed, scheduledAt, accountId }, revision);
        problem = ''; el.close(); update(); notify(approve ? '已批准。开启自动发布后，会在指定时间执行。' : '文案已保存，尚未批准发布');
      } catch (error) { el.querySelector('.form-error').textContent = error.message + (error.status === 409 ? ' 请关闭弹窗、刷新队列后再审批。' : ''); }
      finally { busy = false; if (el.isConnected) { el.querySelectorAll('button').forEach(b => { b.disabled = false; }); if (!accountId) el.querySelector('[value=approve]').disabled = true; } }
    };
  }
  function reconcile(item) {
    const revision = snapshot.revision;
    const el = dialog('核实实际发布结果', `<p>请先在抖音创作者中心核对“${esc(item.title)}”。结果待核实时，系统不会自动重发。</p><form id="automation-reconcile"><div class="field"><label for="auto-result">实际结果</label><select id="auto-result" name="result"><option value="published">已找到发布作品</option><option value="not-published">已确认完全未发布，重新准备审批</option></select></div><div class="field"><label for="auto-url">抖音作品链接（已发布时必填）</label><input type="url" id="auto-url" name="url" placeholder="https://www.douyin.com/video/…"></div><label class="check-row"><input type="checkbox" name="confirmed" required>我已在抖音核实以上结果</label><p class="form-error" role="alert"></p><button class="button button-green" type="submit">记录核实结果</button></form>`);
    el.querySelector('form').onsubmit = async event => {
      event.preventDefault(); event.stopPropagation(); const data = Object.fromEntries(new FormData(event.target)); event.submitter.disabled = true;
      try { snapshot = await api(`/items/${item.id}/reconcile`, { ...data, confirmed: !!data.confirmed }, revision); el.close(); update(); notify('结果已记录'); }
      catch (error) { el.querySelector('.form-error').textContent = error.message; }
      finally { if (el.isConnected) event.submitter.disabled = false; }
    };
  }
  document.addEventListener('input', event => { if (event.target.closest('#automation-settings')) captureSettings(event.target.closest('form')); });
  document.addEventListener('change', event => {
    if (event.target.closest('#automation-settings')) captureSettings(event.target.closest('form'));
    if (event.target.id === 'auto-filter') { filter = event.target.value; page = 1; document.querySelector('#automation-items').innerHTML = itemsMarkup(); }
  });
  document.addEventListener('submit', async event => {
    if (event.target.id !== 'automation-settings') return;
    event.preventDefault(); event.stopImmediatePropagation(); const button = event.submitter; if (button.disabled || operation) return; operation = true; button.disabled = true; captureSettings(event.target);
    try { snapshot = await api('/settings', settingsCache); settingsCache = null; settingsDirty = false; try { sessionStorage.removeItem(settingsKey); } catch {} problem = ''; update(); notify('设置已保存'); }
    catch (error) { problem = error.message; update(); }
    finally { operation = false; button.disabled = false; }
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-auto]'); if (!button || button.disabled || operation) return;
    const action = button.dataset.auto, item = snapshot?.items.find(i => i.id === button.dataset.id);
    if (action === 'review' && item) { review(item); return; }
    if (action === 'reconcile' && item) { reconcile(item); return; }
    if (['previous','next'].includes(action)) { page += action === 'next' ? 1 : -1; document.querySelector('#automation-items').innerHTML = itemsMarkup(); return; }
    if (action === 'refresh') { await load(); return; }
    operation = true; button.disabled = true;
    try {
      if (action === 'browsers') { const data = await api('/browsers'); browsers = data.browsers; if (!browsers.length) throw new Error('没有已连接的浏览器，请在 Chrome / Edge 的 BrowserSkill 扩展中启用连接。'); }
      if (action === 'connect') { if (settingsDirty) throw new Error('请先保存设置。'); button.textContent = '正在识别账号…'; snapshot = await api('/connect', {}); notify('已识别抖音号，审批时请核对'); }
      if (action === 'scan') { if (settingsDirty) throw new Error('请先保存设置。'); snapshot = await api('/scan', {}); notify(`已新增 ${snapshot.result.added} 条待审批视频`); }
      if (action === 'cancel' && item) { snapshot = await api(`/items/${item.id}/cancel`, {}); notify('已撤销批准'); }
      if (action === 'toggle') { snapshot = await api('/toggle', { enabled: !snapshot.config.enabled }); notify(snapshot.config.enabled ? '每日自动发布已开启' : '自动发布已暂停'); }
      if (action === 'export') download({ version: 1, exportedAt: new Date().toISOString(), config: snapshot.config, items: snapshot.items, events: snapshot.events }, 'doufeng-auto-publish-records.json');
      problem = ''; update();
    } catch (error) { problem = error.message; update(); }
    finally { operation = false; button.disabled = false; }
  });
  // Refresh status without discarding text being edited.
  setInterval(() => { if (document.querySelector('#automation-root') && !document.querySelector('dialog[open]') && !settingsDirty && !loading && !operation) void load(); }, 15000);
  return { render: view, mount: load };
}
