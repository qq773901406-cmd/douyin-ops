import { esc, request, dialog } from './workspace-ui.js';

const API = '/api/superagent/workflow';
const REPOSITORY = 'qq773901406-cmd/douyin-ops';
const labels = { observed: '观察中', queued: '排队中', working: '工作中', waiting_answer: '等待回答', awaiting_review: '待审核', completed: '已完成', failed: '失败', blocked: '受阻', cancelled: '已停止' };
const tabs = { tickets: '任务', events: '事件与评估', health: '投递与运行', settings: '设置', legacy: '历史观察' };
const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const latestReport = ticket => ticket.reports?.at(-1);
const idOf = record => record?.id || record?.version || record?.revision || '—';
const stamp = record => record?.at || record?.createdAt || record?.updatedAt;
const compact = (value, limit = 220) => String(value ?? '').slice(0, limit);
const textOf = ticket => ticket.inputs?.map(row => row.text || '').join('\n\n') || ticket.messages?.map(row => row.text || '').join('\n\n') || ticket.text || '';
const pre = value => `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:auto">${esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre>`;
const metric = (label, count, note) => `<div class="card metric-card"><div class="metric-top">${label}</div><div class="metric-value">${esc(count)}</div><div class="metric-note">${note}</div></div>`;
const pill = status => `<span class="pill ${['working', 'completed'].includes(status) ? 'green' : ['failed', 'blocked', 'waiting_answer'].includes(status) ? 'orange' : ''}">${esc(labels[status] || status || '未知')}</span>`;
const input = (name, label, value, type = 'text', hint = '') => `<div class="field"><label for="sg-${name}">${label}</label><input id="sg-${name}" name="${name}" type="${type}" value="${esc(value)}" ${type === 'number' ? 'min="1" max="4" step="1"' : 'maxlength="2000"'}>${hint ? `<small class="form-hint">${hint}</small>` : ''}</div>`;
const textarea = (name, label, value, hint = '', max = 16000) => `<div class="field full"><label for="sg-${name}">${label}</label><textarea id="sg-${name}" name="${name}" maxlength="${max}">${esc(value)}</textarea>${hint ? `<small class="form-hint">${hint}</small>` : ''}</div>`;
const check = (name, label, value) => `<label class="check-row"><input type="checkbox" name="${name}" ${value ? 'checked' : ''}>${label}</label>`;
const select = (name, label, value, options) => `<div class="field"><label for="sg-${name}">${label}</label><select id="sg-${name}" name="${name}">${options.map(([key, text]) => `<option value="${key}" ${value === key ? 'selected' : ''}>${text}</option>`).join('')}</select></div>`;
const listIds = value => String(value || '').split(/[\s,，]+/).map(item => item.trim()).filter(Boolean);

export function safePullRequestUrl(value) {
  try {
    const url = new URL(value), match = /^\/qq773901406-cmd\/douyin-ops\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || !match) return null;
    return `https://github.com/${REPOSITORY}/pull/${match[1]}`;
  } catch { return null; }
}

export function settingsFormValues(settings = {}) {
  return {
    mode: settings.mode || 'observe', acceptMode: settings.acceptMode || 'observe', concurrency: String(settings.concurrency ?? 1),
    sourceEnabled: !!settings.source?.enabled, corpId: settings.source?.corpId || '', clientId: settings.source?.clientId || '',
    allowedUserIds: (settings.source?.allowedUserIds || []).join('\n'), allowedConversationIds: (settings.source?.allowedConversationIds || []).join('\n'),
    modelEnabled: !!settings.model?.enabled, modelEndpoint: settings.model?.endpoint || 'http://127.0.0.1:11434', modelName: settings.model?.name || '',
    workerEnabled: !!settings.worker?.enabled, workerEndpoint: settings.worker?.endpoint || '', workerIsolated: !!settings.worker?.isolated,
    githubEnabled: !!settings.github?.enabled, baseBranch: settings.github?.baseBranch || 'main',
    routerPrompt: settings.prompts?.router || '', workerPrompt: settings.prompts?.worker || '', rules: JSON.stringify(settings.rules || [], null, 2),
  };
}

export function settingsFromForm(values, original) {
  let rules;
  try { rules = JSON.parse(values.rules || '[]'); } catch { throw new Error('候选规则必须是有效的 JSON 数组。'); }
  if (!Array.isArray(rules)) throw new Error('候选规则必须是 JSON 数组。');
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('并发任务数须为 1–4 的整数。');
  return { ...structuredClone(original), mode: values.mode, acceptMode: values.acceptMode, concurrency,
    source: { ...original.source, enabled: values.sourceEnabled === true, corpId: values.corpId.trim(), clientId: values.clientId.trim(), allowedUserIds: listIds(values.allowedUserIds), allowedConversationIds: listIds(values.allowedConversationIds) },
    model: { ...original.model, enabled: values.modelEnabled === true, endpoint: values.modelEndpoint.trim(), name: values.modelName.trim() },
    worker: { ...original.worker, enabled: values.workerEnabled === true, endpoint: values.workerEndpoint.trim(), isolated: values.workerIsolated === true },
    github: { ...original.github, enabled: values.githubEnabled === true, baseBranch: values.baseBranch.trim() },
    prompts: { ...original.prompts, router: values.routerPrompt, worker: values.workerPrompt }, rules,
  };
}

export function createSuperagentPanel({ notify }) {
  let snapshot, legacy, tab = 'tickets', error = '', timer, generation = 0, mountGeneration = 0, busy = false, lastLoadedAt;
  let settingsBase, settingsRevision, draft, dirty = false, settingsError = '', requestText = '', pendingRequest;
  let filter = '', statusFilter = '', visibleCount = 30;
  const cache = new WeakMap();
  const root = () => document.getElementById('superagent-root');
  const writeHtml = (element, markup) => { if (element && cache.get(element) !== markup) { element.innerHTML = markup; cache.set(element, markup); } };
  const button = (action, label, id = '', enabled = true, kind = 'button-light') => `<button type="button" class="button ${kind}" data-superagent="${action}" ${id ? `data-id="${esc(id)}"` : ''} ${['details', 'legacy-details', 'more', 'reload-settings'].includes(action) ? '' : 'data-sg-mutation'} ${!enabled ? `disabled data-sg-unavailable title="${action === 'evaluate' ? '请在设置中启用评估模型和候选评估' : '需要手动执行模式、已就绪的独立 Worker，且处理未暂停'}"` : ''}>${label}</button>`;

  function captureSettings() {
    const form = root()?.querySelector('#sg-settings-form'); if (!form) return;
    draft ||= settingsFormValues(settingsBase || {});
    for (const field of form.elements) if (field.name && field.type !== 'submit') draft[field.name] = field.type === 'checkbox' ? field.checked : field.value;
  }
  function captureDrafts() { captureSettings(); const composer = root()?.querySelector('[name="requestText"]'); if (composer) requestText = composer.value; }
  function resetSettings() { settingsBase = structuredClone(snapshot.settings); settingsRevision = snapshot.settingsRevision; draft = settingsFormValues(settingsBase); dirty = false; settingsError = ''; }

  function taskMarkup(ticket) {
    const report = latestReport(ticket), url = safePullRequestUrl(ticket.prUrl), done = ['completed', 'cancelled'].includes(ticket.status);
    const canQueue = snapshot.settings?.mode === 'manual' && snapshot.worker?.ready === true && !snapshot.settings?.paused;
    return `<article class="card"><div class="card-title"><h3 style="overflow-wrap:anywhere">${esc(ticket.title || compact(textOf(ticket), 90) || '开发任务')}</h3>${pill(ticket.status)}</div>
      <p class="form-hint" style="overflow-wrap:anywhere">${esc(ticket.source || 'local')} · ${esc(ticket.conversationId || '本机工作台')} · ${esc(when(ticket.updatedAt || ticket.createdAt))}</p>
      <p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(compact(report?.summary || textOf(ticket)))}</p>${report?.question ? `<p class="notice orange">待回答：${esc(report.question)}</p>` : ''}
      <div class="form-actions">${button('details', '详情', ticket.id)}${!done ? button('followup', ticket.status === 'waiting_answer' ? '回答问题' : '补充信息', ticket.id) : ''}
      ${ticket.status === 'observed' ? button('evaluate', '评估', ticket.id, snapshot.settings?.model?.enabled === true && snapshot.settings?.acceptMode !== 'off') : ''}
      ${ticket.status === 'observed' ? button('queue', '授权并排队', ticket.id, canQueue, 'button-green') : ''}
      ${['blocked', 'failed'].includes(ticket.status) ? button('retry', '重试任务', ticket.id, canQueue) : ''}
      ${!done ? button('stop', '停止任务', ticket.id, true, 'button-danger') : ''}
      ${['observed', 'awaiting_review', 'waiting_answer', 'blocked', 'failed'].includes(ticket.status) ? button('complete', '标记完成', ticket.id) : ''}
      ${url ? `<a class="button button-light" href="${esc(url)}" target="_blank" rel="noopener noreferrer">查看 PR ↗</a>` : ''}</div></article>`;
  }

  function settingsMarkup() {
    if (!snapshot) return '';
    if (!settingsBase) resetSettings(); const d = draft;
    return `<form id="sg-settings-form"><p class="notice">配置在本机保存。执行模式需要独立 Worker 就绪；候选评估不会直接授予代码执行权限。自动合并始终禁止。</p>
      <section class="card"><div class="card-title"><h3>处理方式</h3><span class="pill">${esc(snapshot.settings.repository || REPOSITORY)}</span></div><div class="form-grid">${select('mode', '执行模式', d.mode, [['observe', '观察：登记与评估'], ['manual', '手动：逐项授权执行']])}${select('acceptMode', '推断候选', d.acceptMode, [['off', '关闭'], ['observe', '观察：记录评估建议'], ['auto', '自动候选：仍需授权执行']])}${input('concurrency', '最大并发任务', d.concurrency, 'number')}</div></section>
      <div class="section-row"><h2>外部接入</h2></div><div class="grid grid-2"><section class="card"><h3>钉钉机器人</h3>${check('sourceEnabled', '启用消息接收', d.sourceEnabled)}<div class="form-grid">${input('corpId', '企业 corpId', d.corpId)}${input('clientId', '机器人 ClientId', d.clientId)}${textarea('allowedUserIds', '允许发起任务的 userId', d.allowedUserIds, '每行一个 ID；群消息还需满足群白名单。', 8000)}${textarea('allowedConversationIds', '允许群聊 conversationId', d.allowedConversationIds, '每行一个 ID，群内还需 @机器人。', 8000)}</div><p class="form-hint">应用密钥由本机环境变量提供；此处只保存非敏感标识。</p></section>
      <section class="card"><h3>评估模型</h3>${check('modelEnabled', '启用本机模型评估', d.modelEnabled)}<div class="form-grid">${input('modelEndpoint', '本机 Ollama 地址', d.modelEndpoint)}${input('modelName', '模型名称', d.modelName)}</div><p class="form-hint">模型返回任务建议，权限由服务端检查。</p><h3>GitHub</h3>${check('githubEnabled', '启用仓库事件接收', d.githubEnabled)}${input('baseBranch', 'PR 目标分支', d.baseBranch)}<p class="form-hint">仓库固定为 ${REPOSITORY}，机器人凭据在本机配置。</p></section></div>
      <section class="card" style="margin-top:15px"><h3>独立 Worker</h3>${check('workerEnabled', '启用 Worker 接入', d.workerEnabled)}${input('workerEndpoint', 'Worker 服务地址', d.workerEndpoint)}${check('workerIsolated', '已在独立环境部署 Worker，并隔离宿主运行数据与凭据', d.workerIsolated)}<p class="form-hint">此选项记录部署情况；目录和复选框本身不提供隔离。连接检查通过后，才可逐项授权任务。</p></section>
      <div class="section-row"><h2>规则与提示词</h2></div><section class="card"><div class="form-grid">${textarea('rules', '候选规则（JSON 数组）', d.rules, '规则结构见使用说明；空数组不推断新工作。')}${textarea('routerPrompt', '路由提示词', d.routerPrompt)}${textarea('workerPrompt', 'Worker 提示词', d.workerPrompt)}</div></section>
      <p class="form-error" role="alert" data-sg-settings-error>${esc(settingsError)}</p><p class="form-hint" data-sg-settings-revision></p><div class="form-actions"><button class="button button-green" type="submit" data-sg-mutation>保存设置</button>${button('reload-settings', '重载已保存设置')}</div></form>
      <div class="section-row"><h2>设置版本</h2><span class="form-hint">恢复会创建新版本</span></div><div data-sg-settings-history></div>`;
  }

  function tabMarkup() {
    if (tab === 'tickets') return `<form id="sg-request-form" class="card"><div class="card-title"><h3>提出开发任务</h3><span class="pill">本机请求</span></div><div class="field"><label for="sg-request-text">希望修改或检查什么？</label><textarea id="sg-request-text" name="requestText" maxlength="8000" required placeholder="描述目标、范围和验收要求">${esc(requestText)}</textarea></div><div class="form-actions"><button class="button button-green" type="submit" data-sg-mutation>登记任务</button><span class="form-hint">登记后可评估；执行需要单独授权。</span></div><p class="form-error" role="alert" data-sg-request-error></p></form>
      <div class="section-row"><h2>任务列表</h2><span class="form-hint" data-sg-ticket-count></span></div><div class="form-grid" style="margin-bottom:15px"><div class="field"><label for="sg-search">搜索任务</label><input id="sg-search" name="search" placeholder="标题、内容或任务编号" value="${esc(filter)}"></div>${select('status-filter', '状态', statusFilter, [['', '全部状态'], ...Object.entries(labels)])}</div><div class="grid grid-2" data-sg-tickets></div><div class="form-actions">${button('more', '显示更多')}</div>`;
    if (tab === 'events') return '<div class="section-row"><h2>事件记录</h2></div><div data-sg-events></div><div class="section-row"><h2>评估决定</h2></div><div data-sg-decisions></div>';
    if (tab === 'health') return '<div class="grid grid-2" data-sg-health></div><div class="section-row"><h2>消息投递</h2><span class="form-hint">发送结果不确定的消息不会自动重发</span></div><div data-sg-outbox></div>';
    if (tab === 'settings') return settingsMarkup();
    return `<section class="card"><h3>第一阶段观察记录</h3><p>保留原有固定演示和观察记录。历史记录不会自动转成可执行任务。</p>${button('demo', '生成本地演示任务')}</section><div class="section-row"><h2>历史记录</h2></div><div class="grid grid-2" data-sg-legacy></div>`;
  }

  function table(headers, rows) {
    if (!rows.length) return '<div class="card empty">暂无记录</div>';
    return `<div class="card table-wrap"><table class="data-table"><thead><tr>${headers.map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }
  function row(cells) { return `<tr>${cells.map(value => `<td style="white-space:pre-wrap;overflow-wrap:anywhere;max-width:380px">${value}</td>`).join('')}</tr>`; }
  function healthMarkup() {
    const health = snapshot.health || {}, items = Array.isArray(health) ? health : Object.entries(health).map(([name, value]) => ({ name, ...(typeof value === 'object' && value !== null ? value : { message: String(value) }) }));
    const names = { Worker: '独立 Worker', source: '钉钉接入', model: '模型评估', github: 'GitHub 接入', runtime: '任务调度' };
    const states = { disabled: '未启用', connected: '已连接', connecting: '连接中', unconfigured: '未配置', error: '异常', stopped: '已停止', ready: '就绪', blocked: '受阻' };
    return [{ name: 'Worker', ...snapshot.worker }, ...items].map(item => { const name = item.name || item.component || item.id || '运行状态', state = item.state || item.status; return `<section class="card"><div class="card-title"><h3>${esc(names[name] || name)}</h3><span class="pill ${item.ready || item.state === 'connected' ? 'green' : 'orange'}">${esc(states[state] || state || (item.ready ? '就绪' : '待配置'))}</span></div><p style="overflow-wrap:anywhere">${esc(item.message || item.error || '等待状态更新')}</p></section>`; }).join('');
  }

  function paint() {
    const el = root(); if (!el) return;
    el.querySelector('[data-sg-error]').textContent = error ? `${error}${snapshot ? '。当前保留上次读取的内容。' : ''}` : '';
    if (!snapshot) return;
    const tickets = snapshot.tickets || [], count = statuses => tickets.filter(ticket => statuses.includes(ticket.status)).length;
    const state = snapshot.settings?.paused ? '处理已暂停' : snapshot.settings?.mode === 'manual' ? '手动授权模式' : '观察模式';
    el.querySelector('[data-sg-mode]').textContent = state;
    el.querySelector('[data-sg-updated]').textContent = `最后刷新 ${when(lastLoadedAt)}（北京时间）`;
    const pause = el.querySelector('[data-superagent="pause"]'); if (pause) pause.textContent = snapshot.settings?.paused ? '恢复处理' : '暂停处理';
    writeHtml(el.querySelector('[data-sg-stats]'), metric('观察 / 排队', count(['observed', 'queued']), '等待评估或执行') + metric('工作中', count(['working']), 'Worker 正在处理') + metric('需要你处理', count(['waiting_answer', 'awaiting_review']), '回答问题或审核结果') + metric('失败 / 受阻', count(['failed', 'blocked']), '查看原因后重试'));
    if (!el.querySelector('[data-sg-content]').hasChildNodes()) writeHtml(el.querySelector('[data-sg-content]'), tabMarkup());
    if (tab === 'tickets') {
      const needle = filter.toLowerCase(), selected = tickets.filter(ticket => (!statusFilter || ticket.status === statusFilter) && (!needle || `${ticket.id} ${ticket.title} ${textOf(ticket)}`.toLowerCase().includes(needle))).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
      writeHtml(el.querySelector('[data-sg-tickets]'), selected.length ? selected.slice(0, visibleCount).map(taskMarkup).join('') : '<div class="card empty"><b>没有匹配的任务</b><p>可在上方提出开发需求，或调整搜索条件。</p></div>');
      el.querySelector('[data-sg-ticket-count]').textContent = `${selected.length} / ${tickets.length} 条任务`;
      el.querySelector('[data-superagent="more"]').hidden = selected.length <= visibleCount;
    } else if (tab === 'events') {
      writeHtml(el.querySelector('[data-sg-events]'), table(['时间 / 来源', '消息', '关联任务'], [...(snapshot.events || [])].reverse().slice(0, 100).map(event => row([`${esc(when(stamp(event)))}<br>${esc(event.source || event.kind || '—')}`, esc(compact(event.text || event.message || event.type)), esc(event.ticketId || '—')]))));
      const outcomes = { would_accept: '观察建议：可接单', accepted_pending_authorization: '候选已接纳，等待执行授权', suggested: '模型建议', unavailable: '评估未完成' }, actions = { accept: '接单', ignore: '忽略', attach: '关联任务', stop: '停止', unavailable: '未完成' };
      writeHtml(el.querySelector('[data-sg-decisions]'), table(['时间', '决定 / 原因', '规则 / 任务'], [...(snapshot.decisions || [])].reverse().slice(0, 100).map(decision => row([esc(when(stamp(decision))), `${esc(outcomes[decision.outcome] || decision.outcome || '评估记录')} · ${esc(actions[decision.action] || decision.action || '—')}<br>${esc(decision.reason || decision.summary || '')}`, `${esc((decision.matchedRules || []).join('、'))}<br>${esc(decision.ticketId || '—')}${decision.targetTicketId ? `<br>建议关联：${esc(decision.targetTicketId)}` : ''}`]))));
    } else if (tab === 'health') {
      writeHtml(el.querySelector('[data-sg-health]'), healthMarkup());
      const deliveryLabels = { preview: '预览', pending: '待发送', sending: '发送中', sent: '已发送', failed: '失败', uncertain: '结果不确定', withdrawn: '已撤销' };
      writeHtml(el.querySelector('[data-sg-outbox]'), table(['时间 / 状态', '消息', '结果', '人工核对'], [...(snapshot.outbox || [])].reverse().slice(0, 100).map(message => row([
        `${esc(when(stamp(message)))}<br>${esc(deliveryLabels[message.status] || message.status || '—')}`, esc(compact(message.text || message.summary)), esc(message.error || message.reason || '—'),
        ['uncertain', 'failed'].includes(message.status) ? `${message.status === 'uncertain' ? '<p class="form-hint">请先核对原会话的发送状态，结果不确定时不重新发送。</p>' : ''}<div class="form-actions">${button('delivery-sent', '已核实送达', message.id)}${button('delivery-withdrawn', '放弃此条', message.id)}${message.status === 'failed' ? button('delivery-retry', '重试投递', message.id) : ''}</div>` : '—',
      ]))));
    } else if (tab === 'settings') {
      el.querySelector('[data-sg-settings-error]').textContent = settingsError;
      el.querySelector('[data-sg-settings-revision]').textContent = settingsRevision !== snapshot.settingsRevision ? '服务端设置已有新版本。当前草稿已保留，请重载设置后再保存。' : dirty ? '有未保存的修改；自动刷新不会覆盖草稿。' : '已载入当前设置。';
      writeHtml(el.querySelector('[data-sg-settings-history]'), table(['时间 / 版本', '说明', '操作'], [...(snapshot.settingsHistory || [])].reverse().slice(0, 30).map(version => row([`${esc(when(stamp(version)))}<br>${esc(idOf(version))}`, esc(version.reason || version.origin || '保存设置'), button('restore-settings', '恢复此版', idOf(version))]))));
    } else if (tab === 'legacy') {
      writeHtml(el.querySelector('[data-sg-legacy]'), legacy ? (legacy.tickets || []).map(ticket => `<article class="card"><div class="card-title"><h3>${esc(compact(textOf(ticket), 90))}</h3>${pill(ticket.status)}</div><p class="form-hint">${ticket.source === 'local-demo' ? '本地演示' : '钉钉观察记录'} · ${esc(when(ticket.createdAt))}</p><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(compact(textOf(ticket)))}</p><div class="form-actions">${button('legacy-details', '详情', ticket.id)}${ticket.status === 'observed' ? button('legacy-cancel', '取消记录', ticket.id) : ''}</div></article>`).join('') || '<div class="card empty">没有历史观察记录</div>' : '<div class="card">正在读取历史记录…</div>');
    }
    for (const node of el.querySelectorAll('[data-sg-mutation]')) node.disabled = busy || !!error || node.hasAttribute('data-sg-unavailable');
    el.querySelector('[data-superagent="refresh"]').disabled = busy;
  }

  async function load() {
    const current = ++generation;
    try {
      const next = await request(API);
      if (current !== generation) return;
      snapshot = next; lastLoadedAt = new Date().toISOString(); error = '';
      if (tab === 'legacy') legacy = await request('/api/superagent');
      if (current === generation) paint();
    } catch (e) { if (current === generation) { error = e.message; paint(); } }
  }

  function taskDetails(ticket) {
    const reports = (ticket.reports || []).map(report => `<section class="card" style="margin-top:12px">${pill(report.status)} <small>${esc(when(stamp(report)))}</small><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(report.summary || '')}</p>${report.question ? `<p class="notice orange">${esc(report.question)}</p>` : ''}</section>`).join('');
    const inputs = (ticket.inputs || ticket.messages || []).map(message => `<div class="kb-item"><div class="kb-meta">${esc(message.senderId || message.source || '输入')} · ${esc(when(stamp(message)))}</div><p>${esc(message.text || '')}</p></div>`).join('');
    dialog('任务详情', `<dl class="system-details"><dt>编号</dt><dd>${esc(ticket.id)}</dd><dt>状态</dt><dd>${esc(labels[ticket.status] || ticket.status)}</dd><dt>来源</dt><dd>${esc(ticket.source || '—')}</dd><dt>会话</dt><dd>${esc(ticket.conversationId || ticket.messages?.[0]?.conversationId || '—')}</dd></dl><h3>对话与补充</h3>${inputs || pre(textOf(ticket))}<h3>执行报告</h3>${reports || '<p class="muted">尚无报告</p>'}<details style="margin-top:16px"><summary>授权与派工记录</summary>${pre({ mandate: ticket.mandate || { executionAllowed: false }, assignment: ticket.assignment || null })}</details>`, { wide: true });
  }

  async function postRequest(payload, pending) {
    const fingerprint = JSON.stringify(payload);
    if (!pending || pending.fingerprint !== fingerprint) pending = { fingerprint, key: crypto.randomUUID() };
    return { pending, send: () => request(`${API}/requests`, { method: 'POST', body: JSON.stringify({ ...payload, idempotencyKey: pending.key }), signal: AbortSignal.timeout(65000) }) };
  }
  function followup(ticket) {
    const modal = dialog(ticket.status === 'waiting_answer' ? '回答任务中的问题' : '补充同一任务', `<p>${esc(ticket.title || ticket.id)}</p>${latestReport(ticket)?.question ? `<p class="notice">${esc(latestReport(ticket).question)}</p>` : ''}<form id="sg-followup-form"><div class="field"><label for="sg-followup-text">补充内容</label><textarea id="sg-followup-text" name="text" required maxlength="8000"></textarea></div><p class="form-error" role="alert" data-followup-error></p><div class="form-actions"><button type="submit" class="button button-green">发送到此任务</button></div></form>`, { wide: true, guard: true });
    let pending, submitting = false;
    modal.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault(); event.stopPropagation(); if (submitting) return;
      const text = modal.querySelector('textarea').value.trim(); if (!text) return;
      submitting = true; const submit = modal.querySelector('[type="submit"]'); submit.disabled = true;
      try { const attempt = await postRequest({ text, ticketId: ticket.id, conversationId: ticket.conversationId || 'local-console' }, pending); pending = attempt.pending; await attempt.send(); modal.close(); await load(); notify('补充信息已记录在同一任务中'); }
      catch (e) { modal.querySelector('[data-followup-error]').textContent = `${e.message}。若请求超时，可重试，系统会检查重复提交。`; }
      finally { submitting = false; submit.disabled = false; }
    });
  }

  async function submit(event) {
    const form = event.target; if (!['sg-request-form', 'sg-settings-form'].includes(form?.id)) return;
    event.preventDefault(); event.stopImmediatePropagation(); if (busy || error) return;
    captureDrafts(); busy = true; generation++; paint();
    try {
      if (form.id === 'sg-request-form') {
        const text = requestText.trim(); if (!text) throw new Error('请填写开发需求。');
        const attempt = await postRequest({ text, conversationId: 'local-console' }, pendingRequest); pendingRequest = attempt.pending;
        await attempt.send(); requestText = ''; pendingRequest = null;
        form.querySelector('[name="requestText"]').value = ''; form.querySelector('[data-sg-request-error]').textContent = ''; notify('开发任务已登记');
      } else {
        const value = settingsFromForm(draft, settingsBase);
        await request(`${API}/settings`, { method: 'PUT', headers: { 'If-Match': settingsRevision }, body: JSON.stringify(value) });
        dirty = false; settingsBase = null; settingsError = ''; notify('设置已保存');
      }
      await load();
      if (form.id === 'sg-settings-form' && !error) { resetSettings(); writeHtml(root()?.querySelector('[data-sg-content]'), tabMarkup()); }
    } catch (e) {
      if (form.id === 'sg-settings-form') settingsError = e.message + '。草稿已保留。';
      else form.querySelector('[data-sg-request-error]').textContent = e.message + '。内容已保留；重复提交会按同一请求核对。';
      notify(e.message); await load();
    } finally { busy = false; paint(); }
  }
  document.addEventListener('submit', submit);
  for (const name of ['input', 'change']) document.addEventListener(name, event => {
    const form = event.target.closest?.('form');
    if (form?.id === 'sg-settings-form') { captureSettings(); dirty = true; paint(); }
    if (form?.id === 'sg-request-form') requestText = form.querySelector('[name="requestText"]').value;
    if (event.target.id === 'sg-search') { filter = event.target.value; visibleCount = 30; paint(); }
    if (event.target.id === 'sg-status-filter') { statusFilter = event.target.value; visibleCount = 30; paint(); }
  });

  async function handleClick(event) {
    const node = event.target.closest('[data-superagent]'); if (!node) return false;
    const action = node.dataset.superagent;
    if (action === 'tab') { captureDrafts(); tab = node.dataset.tab; if (!Object.hasOwn(tabs, tab)) tab = 'tickets'; writeHtml(root()?.querySelector('[data-sg-content]'), tabMarkup()); for (const item of root().querySelectorAll('[data-superagent="tab"]')) { item.className = `button ${item.dataset.tab === tab ? 'button-green' : 'button-light'}`; item.setAttribute('aria-selected', String(item.dataset.tab === tab)); } paint(); if (tab === 'legacy') await load(); return true; }
    if (action === 'more') { visibleCount += 30; paint(); return true; }
    const ticket = snapshot?.tickets?.find(item => item.id === node.dataset.id);
    if (action === 'details') { if (ticket) taskDetails(ticket); return true; }
    if (action === 'followup') { if (ticket && !busy && !error) followup(ticket); return true; }
    if (action === 'legacy-details') { const old = legacy?.tickets?.find(item => item.id === node.dataset.id); if (old) taskDetails(old); return true; }
    if (busy) return true;
    if (action === 'reload-settings') { resetSettings(); writeHtml(root()?.querySelector('[data-sg-content]'), tabMarkup()); paint(); return true; }
    if (error && action !== 'refresh') { notify('请先刷新并确认服务状态'); return true; }
    busy = true; generation++; paint();
    try {
      if (action === 'refresh') { await load(); return true; }
      if (!snapshot) throw new Error('请等待状态加载。');
      if (action === 'pause') await request(`${API}/pause`, { method: 'POST', headers: { 'If-Match': snapshot.settingsRevision }, body: JSON.stringify({ paused: !snapshot.settings.paused }) });
      else if (action === 'restore-settings') { await request(`${API}/settings/restore`, { method: 'POST', headers: { 'If-Match': snapshot.settingsRevision }, body: JSON.stringify({ version: node.dataset.id }) }); if (!dirty) settingsBase = null; }
      else if (action === 'demo') { const result = await request('/api/superagent/demo', { method: 'POST', body: '{}' }); const sample = result.tickets?.find(row => row.source === 'local-demo'); notify(sample?.status === 'cancelled' ? '演示记录已取消，不会重新创建' : result.duplicate ? '演示已记录，重复消息已忽略' : '本地演示已记录'); }
      else if (action === 'legacy-cancel') { const old = legacy?.tickets?.find(row => row.id === node.dataset.id); if (!old) throw new Error('历史记录已变化，请刷新。'); const demo = old.source === 'local-demo'; await request(`/api/superagent/${demo ? 'demo' : 'tickets'}/${encodeURIComponent(old.id)}/cancel`, { method: 'POST', headers: { 'If-Match': demo ? legacy.demoRevision : legacy.revision }, body: '{}' }); }
      else if (['delivery-sent', 'delivery-withdrawn', 'delivery-retry'].includes(action)) {
        const message = snapshot.outbox?.find(item => item.id === node.dataset.id), resolution = action.slice('delivery-'.length);
        if (!message || !['uncertain', 'failed'].includes(message.status)) throw new Error('投递状态已变化，请刷新后核对。');
        if (resolution === 'retry' && message.status !== 'failed') throw new Error('结果不确定的消息不能重发，请先核对原会话。');
        await request(`${API}/outbox/${encodeURIComponent(message.id)}/reconcile`, { method: 'POST', headers: { 'If-Match': snapshot.revision }, body: JSON.stringify({ resolution }) });
        notify(resolution === 'sent' ? '已记录人工核实送达' : resolution === 'withdrawn' ? '已放弃此条投递，任务执行状态保持不变' : '已重新排队投递');
      }
      else if (['queue', 'stop', 'retry', 'evaluate', 'complete'].includes(action)) { if (!ticket) throw new Error('任务不存在，请刷新。'); await request(`${API}/tickets/${encodeURIComponent(ticket.id)}/${action}`, { method: 'POST', headers: { 'If-Match': snapshot.revision }, body: '{}', signal: AbortSignal.timeout(65000) }); }
      await load();
      if (action === 'restore-settings' && !dirty && !error) { resetSettings(); writeHtml(root()?.querySelector('[data-sg-content]'), tabMarkup()); }
    } catch (e) { notify(e.message); await load(); }
    finally { busy = false; paint(); }
    return true;
  }

  return { handleClick,
    render() { captureDrafts(); return `<section id="superagent-root"><div class="page-head"><div><p class="eyebrow">钉钉 · 开发协作</p><h1>AI 开发代理</h1><p>从请求、评估到执行与审核，保留每一步的依据。</p></div><div class="page-actions"><span class="pill" data-sg-mode>连接中</span><button type="button" class="button button-light" data-superagent="pause" data-sg-mutation>暂停处理</button><button type="button" class="button button-light" data-superagent="refresh">刷新</button></div></div><p class="form-error" role="alert" data-sg-error></p><div class="grid grid-4" data-sg-stats></div><div class="section-row" style="flex-wrap:wrap;gap:10px"><div role="tablist" aria-label="开发代理页面" class="page-actions">${Object.entries(tabs).map(([key, label]) => `<button type="button" role="tab" aria-selected="${key === tab}" class="button ${key === tab ? 'button-green' : 'button-light'}" data-superagent="tab" data-tab="${key}">${label}</button>`).join('')}</div><span class="form-hint" data-sg-updated></span></div><div role="tabpanel" data-sg-content>${snapshot ? tabMarkup() : ''}</div></section>`; },
    async mount() { clearTimeout(timer); const current = ++mountGeneration; paint(); await load(); const poll = async () => { if (current !== mountGeneration || !root()) return; if (!busy) await load(); if (current === mountGeneration && root()) timer = setTimeout(poll, 5000); }; if (current === mountGeneration && root()) timer = setTimeout(poll, 5000); },
  };
}
