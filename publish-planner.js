import { esc, localDay, localInput, dateTime, csv } from './workspace-ui.js';

const statuses = ['待人工准备', '待检查', '可发布', '已发布'];
const cacheKey = 'doufeng.publish-editor.v1';
const blank = () => ({ pubTitle: '', format: '视频', asset: '', cover: '', caption: '', hashtags: '', scheduledAt: '', publishedUrl: '', status: '待人工准备', ck1: false, ck2: false, ck3: false });

export function createPublishPlanner({ getState, save, render, notify, go, remove, track }) {
  let selected = null, values = blank(), baseline = null, dirty = false;
  let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1), mode = 'list', query = '', status = '', day = '';
  try { const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null'); if (cached?.values && typeof cached.values === 'object') { selected = cached.id; values = { ...blank(), ...cached.values }; baseline = cached.baseline; dirty = true; } } catch {}
  const persist = () => { try { sessionStorage.setItem(cacheKey, JSON.stringify({ id: selected, values, baseline })); } catch { notify('浏览器暂存失败，请保存草稿'); } };
  const clear = () => { try { sessionStorage.removeItem(cacheKey); } catch {} };
  const reset = () => { selected = null; values = blank(); baseline = null; dirty = false; clear(); };
  const stamp = draft => draft.status === '已发布' && draft.publishedAt ? draft.publishedAt : draft.scheduledAt;
  const isLate = draft => draft.status !== '已发布' && draft.scheduledAt && Date.parse(draft.scheduledAt) < Date.now();
  const filtered = () => [...getState().drafts].filter(d => (!status || d.status === status) && (!query || `${d.pubTitle || d.title} ${d.caption || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (!day || (stamp(d) && localDay(new Date(stamp(d))) === day))).sort((a, b) => (Date.parse(stamp(a)) || Infinity) - (Date.parse(stamp(b)) || Infinity));
  function open(id) {
    if (dirty && !confirm('放弃尚未保存的发布草稿编辑？')) return false;
    reset();
    if (id) {
      const draft = getState().drafts.find(d => d.id === id); if (!draft) { notify('草稿已不存在'); return false; }
      selected = id; baseline = JSON.stringify(draft); values = { ...blank(), ...draft, pubTitle: draft.pubTitle || draft.title || '', hashtags: draft.hashtags || draft.topics || '', scheduledAt: localInput(draft.scheduledAt), ck1: !!draft.ck1, ck2: !!draft.ck2, ck3: !!draft.ck3 };
      if (!statuses.includes(values.status)) values.status = '待人工准备';
    }
    go('publish'); return true;
  }
  function list() {
    return filtered().map(d => `<article class="publish-item"><div><div class="chip-list"><span class="pill ${d.status === '已发布' ? 'green' : isLate(d) ? 'orange' : ''}">${esc(d.status)}</span>${isLate(d) ? '<span class="pill orange">计划已逾期</span>' : ''}</div><h3>${esc(d.pubTitle || d.title)}</h3><p>${d.status === '已发布' ? '发布记录' : '计划时间'}：${esc(dateTime(stamp(d)))}</p><small>${esc(d.asset || '素材待补充')}</small></div><div class="row-actions"><button type="button" class="button button-light" data-plan="edit" data-id="${esc(d.id)}">编辑</button>${d.status === '已发布' ? `<button type="button" class="button button-light" data-plan="track" data-id="${esc(d.id)}">记录效果</button>` : ''}<button type="button" class="text-link" data-plan="delete" data-id="${esc(d.id)}">移入回收站</button></div></article>`).join('') || '<div class="empty"><b>暂无符合条件的草稿</b><p>新建草稿，或从视频制作台转入成片。</p></div>';
  }
  function calendar() {
    const first = new Date(month.getFullYear(), month.getMonth(), 1); first.setDate(first.getDate() - (first.getDay() + 6) % 7);
    const items = filtered();
    return `<div class="calendar-scroll"><div class="calendar-grid">${['一', '二', '三', '四', '五', '六', '日'].map(d => `<div class="calendar-weekday">周${d}</div>`).join('')}${Array.from({ length: 42 }, (_, index) => {
      const date = new Date(first); date.setDate(first.getDate() + index); const key = localDay(date);
      const drafts = items.filter(d => stamp(d) && localDay(new Date(stamp(d))) === key);
      return `<button type="button" class="calendar-day ${date.getMonth() !== month.getMonth() ? 'outside' : ''} ${key === localDay() ? 'today' : ''}" data-plan="day" data-day="${key}" aria-label="${key}，${drafts.length} 条内容"><b>${date.getDate()}</b>${drafts.slice(0, 3).map(d => `<span class="calendar-entry ${d.status === '已发布' ? 'done' : ''}">${esc(d.pubTitle || d.title)}</span>`).join('')}${drafts.length > 3 ? `<small>另有 ${drafts.length - 3} 条</small>` : ''}</button>`;
    }).join('')}</div></div><p class="form-hint">未排期的 ${items.filter(d => !stamp(d)).length} 条草稿可在列表查看。日历显示本机时区，仅作计划记录。</p>`;
  }
  function results() { return `<div class="list-meta"><span>${filtered().length} 条内容${day ? ` · ${day}` : ''}</span>${day ? '<button class="text-link" data-plan="clear-day">清除日期筛选</button>' : ''}</div>${mode === 'calendar' ? calendar() : list()}`; }
  function updateResults() { const el = document.querySelector('#plan-results'); if (el) el.innerHTML = results(); }
  const input = (label, name, type = 'text', full = false) => `<div class="field ${full ? 'full' : ''}"><label for="plan-${name}">${label}</label>${type === 'textarea' ? `<textarea name="${name}" id="plan-${name}" maxlength="5000">${esc(values[name])}</textarea>` : `<input name="${name}" id="plan-${name}" type="${type}" value="${esc(values[name])}" ${name === 'pubTitle' ? 'required maxlength="120"' : 'maxlength="5000"'}>`}</div>`;
  function view() {
    return `<div class="page-head"><div><p class="eyebrow">PUBLISH PLANNER</p><h1>发布计划</h1><p>准备素材、安排时间、完成检查，再记录真实发布结果。这里不会自动发布。</p></div><div class="page-actions"><button class="button button-light" data-plan="export">导出排期 CSV</button><button class="button button-green" data-plan="new">＋ 新建草稿</button></div></div>
      <div class="planner-layout"><section class="card"><div class="card-title"><h3>${selected ? '编辑发布草稿' : '新建发布草稿'}</h3><span class="pill" id="plan-dirty">${dirty ? '编辑已暂存' : '填写后保存'}</span></div><form id="planner-form"><div class="form-grid">${input('内容标题', 'pubTitle', 'text', true)}<div class="field"><label for="plan-format">内容形式</label><select id="plan-format" name="format">${['视频', '图文'].map(v => `<option ${values.format === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div><div class="field"><label for="plan-status">制作阶段</label><select name="status" id="plan-status">${statuses.map(v => `<option ${values.status === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>${input('计划发布时间', 'scheduledAt', 'datetime-local', true)}${input('素材路径或备注', 'asset', 'text', true)}${input('封面说明', 'cover', 'text', true)}${input('发布文案', 'caption', 'textarea', true)}${input('话题标签', 'hashtags', 'text', true)}${input('已发布作品链接（可选）', 'publishedUrl', 'url', true)}<div class="field full"><label>发布前检查</label>${[['ck1', '素材和音乐使用权限已确认'], ['ck2', '标题、字幕和事实已检查'], ['ck3', '账号与发布计划已确认']].map(([key, text]) => `<label class="check-row"><input type="checkbox" name="${key}" ${values[key] ? 'checked' : ''}>${text}</label>`).join('')}</div></div><p class="form-error" role="alert"></p><div class="form-actions"><button type="submit" class="button button-green">保存草稿</button><button type="button" class="button button-light" data-plan="save-new">另存新草稿</button></div><p class="form-hint">“可发布”和“已发布”需要填写素材并完成三项检查。已发布状态由你手动确认。</p></form></section>
      <section><div class="planner-toolbar"><div class="segmented"><button data-plan="list" class="${mode === 'list' ? 'active' : ''}">列表</button><button data-plan="calendar" class="${mode === 'calendar' ? 'active' : ''}">月历</button></div>${mode === 'calendar' ? `<div class="month-picker"><button class="icon-button" data-plan="previous" aria-label="上个月">←</button><b>${month.getFullYear()} 年 ${month.getMonth() + 1} 月</b><button class="icon-button" data-plan="next" aria-label="下个月">→</button><button class="text-link" data-plan="today">本月</button></div>` : ''}</div><div class="library-toolbar"><div class="field grow"><label for="plan-query">搜索草稿</label><input id="plan-query" type="search" value="${esc(query)}" placeholder="标题或文案"></div><div class="field"><label for="plan-filter">状态</label><select id="plan-filter"><option value="">全部状态</option>${statuses.map(s => `<option ${status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div><div id="plan-results">${results()}</div></section></div>`;
  }
  function capture(form) { const data = Object.fromEntries(new FormData(form)); values = { ...values, ...data, ck1: !!data.ck1, ck2: !!data.ck2, ck3: !!data.ck3 }; dirty = true; persist(); const badge = document.querySelector('#plan-dirty'); if (badge) badge.textContent = '编辑已暂存'; }
  function commit(asNew = false) {
    const current = selected ? getState().drafts.find(d => d.id === selected) : null;
    if (!asNew && selected && JSON.stringify(current) !== baseline) throw new Error('草稿已有更新或被删除，请重新打开或另存新草稿。');
    if (!values.pubTitle.trim()) throw new Error('请填写内容标题。');
    if (!statuses.includes(values.status)) throw new Error('发布状态无效。');
    if (!asNew && ['可发布', '已发布'].includes(values.status) && (!values.asset.trim() || !values.ck1 || !values.ck2 || !values.ck3)) throw new Error('请补充素材并完成三项发布前检查。');
    if (values.scheduledAt && !Number.isFinite(Date.parse(values.scheduledAt))) throw new Error('计划时间无效。');
    if (values.publishedUrl && !/^https?:\/\//i.test(values.publishedUrl)) throw new Error('作品链接需要使用 HTTP 或 HTTPS。');
    const now = new Date().toISOString();
    const draft = { ...(asNew ? {} : current), ...values, id: asNew ? crypto.randomUUID() : selected || crypto.randomUUID(), date: current?.date || new Date().toLocaleDateString('zh-CN'), updatedAt: now, scheduledAt: values.scheduledAt ? new Date(values.scheduledAt).toISOString() : '', publishedAt: values.status === '已发布' ? (asNew ? now : current?.publishedAt || now) : '' };
    if (asNew) { delete draft.sourceVideoId; draft.status = '待人工准备'; draft.publishedAt = ''; draft.publishedUrl = ''; draft.ck1 = draft.ck2 = draft.ck3 = false; draft.date = new Date().toLocaleDateString('zh-CN'); values = { ...draft, scheduledAt: localInput(draft.scheduledAt) }; }
    if (current && !asNew) Object.assign(current, draft); else getState().drafts.push(draft);
    selected = draft.id; baseline = JSON.stringify(draft); dirty = false; clear(); save(); render(); notify('发布草稿已保存到本页，正在同步');
  }
  function handleSubmit(event) {
    if (event.target.id !== 'planner-form') return false;
    event.preventDefault(); capture(event.target);
    try { commit(); } catch (error) { event.target.querySelector('.form-error').textContent = error.message; } return true;
  }
  document.addEventListener('input', event => { const form = event.target.closest('#planner-form'); if (form) capture(form); if (event.target.id === 'plan-query' && !event.isComposing) { query = event.target.value; updateResults(); } });
  document.addEventListener('compositionend', event => { if (event.target.id === 'plan-query') { query = event.target.value; updateResults(); } });
  document.addEventListener('change', event => { const form = event.target.closest('#planner-form'); if (form) capture(form); if (event.target.id === 'plan-filter') { status = event.target.value; updateResults(); } });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-plan]'); if (!button) return;
    const action = button.dataset.plan; const id = button.dataset.id;
    try {
      if (action === 'new') open();
      if (action === 'edit') open(id);
      if (action === 'delete' && remove('drafts', id)) { if (selected === id) reset(); render(); }
      if (action === 'track') track(id);
      if (action === 'save-new') { capture(document.querySelector('#planner-form')); commit(true); }
      if (['list', 'calendar'].includes(action)) { mode = action; day = ''; render(); }
      if (['previous', 'next', 'today'].includes(action)) { month = action === 'today' ? new Date(new Date().getFullYear(), new Date().getMonth(), 1) : new Date(month.getFullYear(), month.getMonth() + (action === 'previous' ? -1 : 1), 1); day = ''; render(); }
      if (action === 'day') { day = button.dataset.day; mode = 'list'; render(); }
      if (action === 'clear-day') { day = ''; updateResults(); }
      if (action === 'export') csv([['标题', '状态', '计划发布时间', '实际发布记录', '素材', '文案'], ...filtered().map(d => [d.pubTitle || d.title, d.status, dateTime(d.scheduledAt), d.publishedAt ? dateTime(d.publishedAt) : '', d.asset, d.caption])], `doufeng-schedule-${localDay()}.csv`);
    } catch (error) { notify(error.message); }
  });
  window.addEventListener('beforeunload', event => { if (dirty) { persist(); event.preventDefault(); event.returnValue = ''; } });
  return { render: view, open, handleSubmit, reset({ preserveEditor = false } = {}) { if (!preserveEditor) reset(); } };
}
