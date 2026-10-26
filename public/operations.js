import { esc, request, localInput, dialog, download } from './workspace-ui.js';
import { shopPlatforms } from '../workbuddy/connector/lib/shop-products.mjs';
import { restorePendingForm, operationRequestBody } from './operations-form.js';

const statuses = { paused: '待执行', scheduled: '已排期', running: '执行中', completed: '已完成', requires_action: '需要处理', failed: '失败', unknown: '结果待核实', interrupted: '执行中断', cancelled: '已取消' };
const when = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
export function createOperations({ notify, go, refreshWorkspace }) {
  let snapshot, kind = 'workflow.news', timer, busy = false, error = '', formDraft = {}, generation = 0, lastCompleted = null;
  const pendingKey = 'doufeng.operations.pending.v1';
  let pendingAttempt = null, restorePending = true;
  try { pendingAttempt = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); } catch {}
  const root = () => document.getElementById('operations-root');
  const spec = () => snapshot?.catalog.find(row => row.kind === kind) || snapshot?.catalog[0];
  const fieldValue = field => formDraft[field.name] ?? field.value ?? '';
  function fieldMarkup(field) {
    const value = fieldValue(field), attrs = `name="${esc(field.name)}" id="ops-${esc(field.name)}" ${field.required ? 'required' : ''}`;
    if (field.type === 'checkbox') return `<label class="check-row full"><input type="checkbox" ${attrs} ${value === true || value === 'on' ? 'checked' : ''}>${esc(field.label)}</label>`;
    if (field.type === 'platforms') return `<fieldset class="full"><legend>${esc(field.label)}</legend>${Object.entries(shopPlatforms).map(([id, label]) => `<label class="check-row"><input type="checkbox" name="platforms" value="${id}" ${(formDraft.platforms || ['douyin']).includes(id) ? 'checked' : ''}>${esc(label)}</label>`).join('')}</fieldset>`;
    let input;
    if (['lines', 'textarea'].includes(field.type)) input = `<textarea ${attrs} maxlength="10000" rows="3">${esc(Array.isArray(value) ? value.join('\n') : value)}</textarea>`;
    else if (['select', 'product', 'draft', 'wanTask'].includes(field.type)) {
      const choices = field.type === 'product' ? Object.fromEntries((snapshot.products || []).map(row => [row.id, `${row.title}（${row.imageCount}张本地图）`])) : field.type === 'draft' ? Object.fromEntries((snapshot.drafts || []).map(row => [row.id, `${shopPlatforms[row.platform] || row.platform} · ${row.title}`])) : field.type === 'wanTask' ? Object.fromEntries((snapshot.tasks || []).filter(row => row.kind === 'media.wan').map(row => [row.id, `${row.name}（${statuses[row.status] || row.status}）`])) : field.options;
      input = `<select ${attrs}>${field.type !== 'select' ? '<option value="">请选择</option>' : ''}${Object.entries(choices || {}).map(([id, label]) => `<option value="${esc(id)}" ${String(value) === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    } else input = `<input ${attrs} type="${field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}" value="${esc(value)}" maxlength="6000" ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} ${field.step !== undefined ? `step="${field.step}"` : ''}>`;
    return `<div class="field ${['lines', 'textarea'].includes(field.type) ? 'full' : ''}"><label for="ops-${esc(field.name)}">${esc(field.label)}</label>${input}</div>`;
  }
  function editor() {
    const definition = spec(); if (!definition) return '<p>正在读取任务类型…</p>';
    return `<form id="operations-form"><div class="form-grid"><div class="field full"><label for="ops-kind">自动执行的功能</label><select id="ops-kind" name="kind">${snapshot.catalog.map(row => `<option value="${esc(row.kind)}" ${row.kind === definition.kind ? 'selected' : ''}>${esc(row.group)} · ${esc(row.label)}</option>`).join('')}</select></div><p class="form-hint full">${esc(definition.description)}</p><div class="field full"><label for="ops-name">任务名称</label><input id="ops-name" name="name" value="${esc(formDraft.name || definition.label)}" maxlength="160" required></div>${definition.fields.map(fieldMarkup).join('')}
      <div class="field"><label for="ops-repeat">执行频率</label><select id="ops-repeat" name="repeat"><option value="once">仅一次</option>${definition.recurring ? `<option value="daily" ${formDraft.repeat === 'daily' ? 'selected' : ''}>每天</option><option value="weekly" ${formDraft.repeat === 'weekly' ? 'selected' : ''}>每周</option>` : ''}</select></div>
      <div class="field"><label for="ops-at">首次执行时间（北京时间）</label><input id="ops-at" name="at" type="datetime-local" value="${esc(formDraft.at || localInput(new Date(Date.now() + 5 * 60000).toISOString()))}" required></div></div>
      <p class="form-hint">执行结果保留来源、时间和回执。单次任务结束后停止；外部生成结果不明时不会重试。成片只进入草稿或待审批队列，发布沿用原账号与逐条审批。</p>
      <p class="form-error" role="alert" data-ops-form-error></p><div class="form-actions"><button class="button button-green" type="submit" name="intent" value="run" ${busy ? 'disabled' : ''}>保存并立即执行</button><button class="button button-light" type="submit" name="intent" value="schedule" ${busy ? 'disabled' : ''}>保存并启用排期</button><button class="button button-light" type="submit" name="intent" value="save" ${busy ? 'disabled' : ''}>仅保存</button></div></form>`;
  }
  function captureForm() {
    const form = document.getElementById('operations-form'); if (!form) return;
    const data = new FormData(form); formDraft = Object.fromEntries(data);
    formDraft.platforms = data.getAll('platforms');
    for (const field of spec()?.fields || []) if (field.type === 'checkbox') formDraft[field.name] = data.has(field.name);
  }
  function paintEditor() { const el = root()?.querySelector('[data-ops-editor]'); if (el) el.innerHTML = editor(); }
  function paint() {
    const el = root(); if (!el || !snapshot) return;
    el.querySelector('[data-ops-status]').textContent = error || `调度${snapshot.scheduler.running ? '运行中' : '未启动'} · ${snapshot.tasks.filter(t => t.enabled).length}个已启用任务 · ${snapshot.scheduler.busy ? '正在执行' : '空闲'}${snapshot.scheduler.error ? ' · ' + snapshot.scheduler.error : ''}`;
    el.querySelector('[data-ops-list]').innerHTML = snapshot.tasks.length ? [...snapshot.tasks].reverse().slice(0, 60).map(task => {
      const run = snapshot.runs.find(r => r.id === task.lastRunId), attempted = snapshot.runs.some(r => r.taskId === task.id);
      const terminal = task.schedule.type === 'once' && attempted || ['unknown', 'interrupted', 'running'].includes(task.status);
      const output = run?.output, media = output?.asset;
      const originalWanTaskId = task.kind === 'media.wan' ? task.id : task.kind === 'media.wanRecover' && task.status !== 'completed' ? task.input.taskId : null;
      const recovered = originalWanTaskId && snapshot.runs.some(row => row.status === 'completed' && row.output?.originalTaskId === originalWanTaskId);
      const summary = recovered ? '已有视频已由恢复任务下载并完成核验；原中断回执保留在详情中。' : task.kind === 'media.wan' && task.status === 'unknown' ? '生成结果尚未完成本地核验。可查看回执，或恢复下载已返回的视频。' : output?.summary || (run?.error ? String(run.error).slice(0, 160) + (run.error.length > 160 ? '…（完整原因见回执）' : '') : run?.progress?.message) || '已记录执行意图，正在处理。';
      const recovery = task.kind === 'media.wan' && task.status === 'unknown' && !recovered ? `<button class="button button-light" data-operation-kind="media.wanRecover" data-source-task-id="${esc(task.id)}">恢复已有视频下载</button>` : '';
      return `<article class="card"><div class="card-title"><h3>${esc(task.name)}</h3><span class="pill ${recovered || task.status === 'completed' ? 'green' : ['failed', 'unknown', 'requires_action', 'interrupted'].includes(task.status) ? 'orange' : ''}">${esc(recovered ? '已恢复下载' : statuses[task.status] || task.status)}</span></div><p class="muted">${esc(snapshot.catalog.find(c => c.kind === task.kind)?.label || task.kind)} · ${task.schedule.type === 'once' ? '单次' : task.schedule.type === 'daily' ? '每天' : '每周'} · 下次 ${esc(when(task.nextRunAt))}</p>${run ? `<p>${esc(summary)}</p><p class="form-hint">开始 ${esc(when(run.startedAt))} · 结束 ${esc(when(run.finishedAt))}</p>` : ''}<div class="form-actions">${!terminal ? `<button class="button button-light" data-ops="run" data-id="${esc(task.id)}" ${busy ? 'disabled' : ''}>立即执行</button>` : ''}${task.enabled || task.status === 'running' ? `<button class="button button-light" data-ops="cancel" data-id="${esc(task.id)}">${task.status === 'running' ? '取消执行' : '暂停'}</button>` : task.readOnly && !terminal ? `<button class="button button-light" data-ops="resume" data-id="${esc(task.id)}">启用排期</button>` : ''}<button class="button button-light" data-ops="details" data-id="${esc(task.id)}">参数与回执</button>${recovery}${media ? `<a class="button button-light" href="/api/media?path=${encodeURIComponent(media)}" target="_blank" rel="noopener">预览成片</a>` : ''}</div></article>`;
    }).join('') : '<div class="card empty">还没有运营任务。选择功能后，可先执行一次验证，再设置周期。</div>';
  }
  async function load({ editor: refreshEditor = false } = {}) {
    const current = ++generation;
    try {
      const next = await request('/api/operations'); if (current !== generation) return;
      snapshot = next;
      if (restorePending) {
        restorePending = false;
        const restored = restorePendingForm(pendingAttempt, next.catalog);
        if (restored) { kind = restored.kind; formDraft = restored.formDraft; }
        else pendingAttempt = null;
      }
      error = ''; paint(); if (refreshEditor) paintEditor();
      const finished = next.runs.filter(run => run.status === 'completed').map(run => run.id).join(',');
      const changed = lastCompleted !== null && finished !== lastCompleted;
      lastCompleted = finished;
      if (changed && root()) { captureForm(); await refreshWorkspace?.(); }
    } catch (e) { error = e.message; if (root()) root().querySelector('[data-ops-status]').textContent = error; }
  }
  async function mutate(route, body = {}) {
    if (!snapshot) throw new Error('请等待任务状态加载。');
    const result = await request('/api/operations' + route, { method: 'POST', headers: { 'If-Match': snapshot.revision }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    snapshot = result; paint(); return result;
  }
  async function submit(event) {
    if (event.target.id !== 'operations-form') return false;
    event.preventDefault(); if (busy) return true;
    captureForm(); busy = true; const form = event.target;
    try {
      const intent = event.submitter?.value || 'save';
      const body = operationRequestBody(spec(), kind, formDraft, intent), fingerprint = JSON.stringify(body);
      if (pendingAttempt?.fingerprint !== fingerprint) pendingAttempt = { fingerprint, key: crypto.randomUUID() };
      sessionStorage.setItem(pendingKey, JSON.stringify(pendingAttempt));
      const key = pendingAttempt.key;
      const result = await mutate('/tasks', { ...body, idempotencyKey: key });
      const task = result.tasks.find(row => row.idempotencyKey === key);
      if (!task) throw new Error('任务已保存但未能定位，请刷新列表核实。');
      if (intent === 'run' && result.runs.some(run => run.taskId === task.id)) { notify('这份任务已经执行过，请查看原回执。'); return true; }
      if (intent === 'run') await mutate(`/tasks/${task.id}/run`);
      notify(intent === 'run' ? '任务已开始，执行结果会自动更新' : intent === 'schedule' ? '排期已启用' : '任务已保存');
    } catch (e) {
      const target = form.querySelector('[data-ops-form-error]'); if (target) target.textContent = e.message + '。若请求超时，请先查看任务回执，避免重复创建或提交。';
      notify(e.message); await load();
    } finally { busy = false; paint(); }
    return true;
  }
  async function handleClick(event) {
    const entry = event.target.closest('[data-operation-kind]');
    if (entry) { restorePending = false; kind = entry.dataset.operationKind; formDraft = kind === 'media.wanRecover' && entry.dataset.sourceTaskId ? { taskId: entry.dataset.sourceTaskId } : {}; go('operations'); return true; }
    const button = event.target.closest('[data-ops]'); if (!button) return false;
    try {
      if (button.dataset.ops === 'refresh') { await load({ editor: false }); return true; }
      if (button.dataset.ops === 'environment') {
        const data = await request('/api/operations/environment', { signal: AbortSignal.timeout(60000) });
        const environment = data.environment, media = environment.media, text = environment.text;
        const modal = dialog('制作环境', `<p>本机依赖检查不会提交图片或消耗远端生成额度。</p><ul><li>本地视频制作：${media.local ? '已就绪' : '需要安装制作依赖'}</li><li>免费 Wan 图生视频：${media.wan ? '依赖已就绪，实际可用额度以执行时为准' : '需要配置已有依赖目录'}</li><li>本地 AI 脚本：${text.ready ? '已就绪，可用模型：' + esc((text.models || []).map(model => typeof model === 'string' ? model : model.name).join('、')) : '尚未就绪，请先启动本机 Ollama 并安装文本模型'}</li></ul><div class="field"><label for="wan-deps">已有 Wan Python 依赖目录</label><input id="wan-deps" value="${esc(snapshot.settings?.wanDepsDir || '')}" placeholder="留空使用 Python 默认环境"></div><details><summary>查看检测详情</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(environment, null, 2))}</pre></details><p role="alert" data-env-error></p><button type="button" class="button button-green" data-env-save>保存依赖目录</button>`, { wide: true });
        modal.querySelector('[data-env-save]').onclick = async () => {
          try { const result = await request('/api/operations/settings', { method: 'POST', headers: { 'If-Match': snapshot.settingsRevision }, body: JSON.stringify({ wanDepsDir: modal.querySelector('#wan-deps').value }) }); snapshot = result; notify('制作环境设置已保存'); modal.close(); }
          catch (e) { modal.querySelector('[data-env-error]').textContent = e.message; }
        }; return true;
      }
      if (button.dataset.ops === 'details') {
        const task = snapshot.tasks.find(t => t.id === button.dataset.id), runs = snapshot.runs.filter(r => r.taskId === task.id);
        const modal = dialog(task.name, `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto">${esc(JSON.stringify({ task, runs }, null, 2))}</pre><button class="button button-light" data-export>导出回执</button>`, { wide: true });
        modal.querySelector('[data-export]').onclick = () => download({ task, runs }, `task-${task.id}.json`); return true;
      }
      if (busy) return true;
      busy = true; await mutate(`/tasks/${button.dataset.id}/${button.dataset.ops}`); notify('任务状态已更新');
    } catch (e) { notify(e.message); await load(); } finally { busy = false; paint(); }
    return true;
  }
  document.addEventListener('change', event => {
    if (event.target.id === 'ops-kind') { restorePending = false; kind = event.target.value; formDraft = {}; paintEditor(); }
  });
  return { handleClick, handleSubmit(event) { if (event.target.id !== 'operations-form') return false; void submit(event); return true; },
    render() { return `<section id="operations-root"><div class="page-head"><div><p class="eyebrow">AUTOMATION</p><h1>运营任务中心</h1><p>采集、研究、制作、回采和备份的执行记录放在一起。</p></div><div class="form-actions"><button class="button button-light" data-ops="environment">制作环境</button><button class="button button-light" data-ops="refresh">刷新</button></div></div><p role="status" data-ops-status>正在连接任务调度器…</p><section class="card" data-ops-editor>${snapshot ? editor() : '正在加载…'}</section><div class="section-row"><h2>任务与执行结果</h2></div><div class="grid grid-2" data-ops-list></div></section>`; },
    async mount() { clearTimeout(timer); await load({ editor: true }); const poll = async () => { if (!root()) return; await load(); timer = setTimeout(poll, 3000); }; timer = setTimeout(poll, 3000); },
  };
}
