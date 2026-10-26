import { esc, request } from './workspace-ui.js';

const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未回采';
const reviewLabels = { pending: '审核中', published: '已发布', rejected: '审核未通过', unknown: '状态待核实' };
const metric = (value, suffix = '') => typeof value === 'number' && Number.isFinite(value) ? `${value}${suffix}` : '—';
function workLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['www.douyin.com', 'douyin.com'].includes(url.hostname) && /^\/video\/\d{1,32}$/.test(url.pathname) ? url.href : '';
  } catch { return ''; }
}

export function createDouyinTracking({ notify, refreshWorkspace }) {
  let snapshot, problem = '', loading = false, busy = false;
  const drafts = new Map();
  const root = () => document.querySelector('#douyin-tracking-root');
  function markup() {
    const disabled = busy || loading || snapshot?.scheduler.busy;
    const header = `<div class="card-title"><h3>抖音审核与自动回采</h3><span class="pill">${snapshot?.scheduler.running ? snapshot.config?.enabled ? `每天 ${esc(snapshot.config.dailyTime)} 集中检查` : '自动回采已暂停' : '服务未运行'}</span></div>
      <p class="form-hint">每天集中检查一次，同一轮复用一个临时窗口，完成后关闭。服务启动和刷新本页不会打开抖音。电脑、本地服务和浏览器扩展需保持运行。</p>
      ${snapshot?.config ? `<div class="form-grid"><div class="field"><label for="tracking-daily-time">每日回采时间（北京时间）</label><input type="time" id="tracking-daily-time" value="${esc(snapshot.config.dailyTime)}" ${disabled ? 'disabled' : ''}></div><div class="field"><label class="check-row"><input type="checkbox" id="tracking-enabled" ${snapshot.config.enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>每天自动回采</label></div></div><div class="form-actions"><button type="button" class="button button-light" data-douyin-tracking="settings" ${disabled ? 'disabled' : ''}>保存回采安排</button></div><p class="form-hint">下次自动回采：${snapshot.scheduler.nextRunAt ? when(snapshot.scheduler.nextRunAt) : '未安排'}。立即回采会打开一个临时窗口。</p>` : ''}
      <div class="form-actions"><button type="button" class="button button-green" data-douyin-tracking="check" ${disabled || !snapshot?.targets.some(target => target.boundWorkId || ['submitted', 'published'].includes(target.status)) ? 'disabled' : ''}>立即识别并回采作品</button><button type="button" class="button button-light" data-douyin-tracking="refresh" ${disabled ? 'disabled' : ''}>刷新状态</button></div>`;
    const warning = problem || snapshot?.scheduler.error;
    if (!snapshot) return `<section class="card">${header}<p role="status">${esc(problem || '正在读取回采状态…')}</p></section>`;
    const targets = snapshot.targets || [];
    const rows = targets.map(target => {
      const record = snapshot.records.find(item => item.target.ref === target.ref);
      const observation = record?.observation;
      const link = workLink(target.boundUrl);
      const pending = record && record.projectedSequence < record.sequence;
      return `<article class="card" data-tracking-target="${esc(target.ref)}">
        <h4>${esc(target.title || '未命名作品')}</h4><p class="form-hint">${target.kind === 'daily' ? '每日生产' : '发布队列'} · 抖音号 ${esc(target.accountId)} · 提交 ${when(target.submitStartedAt)}</p>
        ${target.boundWorkId
          ? `<p>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">查看已绑定作品 ${esc(target.boundWorkId)}</a>` : `作品 ${esc(target.boundWorkId)}`} · <b>${esc(reviewLabels[observation?.reviewState] || '等待回采')}</b></p>
             <p>播放 ${metric(observation?.metrics.plays)} · 点赞 ${metric(observation?.metrics.likes)} · 评论 ${metric(observation?.metrics.mComments)} · 完播 ${metric(observation?.metrics.completion, '%')}</p>
             <p class="form-hint">${record?.binding?.source === 'automatic' ? '自动核实绑定 · ' : record?.binding?.source === 'manual' ? '通过提供的链接核实绑定 · ' : ''}最近观察：${when(observation?.observedAt)}${pending ? ' · 效果记录待同步' : ''}</p>
             <button type="button" class="button button-light" data-douyin-tracking="check-one" ${disabled ? 'disabled' : ''}>回采这条作品</button>`
          : `<p class="form-hint">${target.status === 'uncertain' ? '提交结果不确定，请先核实作品。提供完整链接后可继续回采。' : '等待自动识别。作品尚不可见或存在多个匹配时会保留未绑定状态；也可提供链接辅助核实。'}</p>
             ${target.status === 'uncertain' ? '' : `<button type="button" class="button button-light" data-douyin-tracking="check-one" ${disabled ? 'disabled' : ''}>立即识别这条作品</button>`}
             <div class="field"><label>手动辅助核实：作品完整链接</label><input type="url" data-tracking-url placeholder="https://www.douyin.com/video/…" value="${esc(drafts.get(target.ref) || '')}" ${disabled ? 'disabled' : ''}></div>
             <button type="button" class="button button-green" data-douyin-tracking="bind" ${disabled ? 'disabled' : ''}>核实并绑定作品</button>`}
        ${record?.projectionError ? `<p class="form-error">${esc(record.projectionError)}</p>` : ''}
      </article>`;
    }).join('');
    return `<section class="card">${header}${warning ? `<p class="form-error" role="status">${esc(warning)}</p>` : ''}<p class="form-hint">“—”表示平台未提供该指标。提交成功与审核通过分别记录。</p></section>
      ${targets.length ? `<div class="grid grid-2">${rows}</div>` : '<section class="card"><p>还没有可核实的提交记录。已提交且保留账号与提交凭据的作品会显示在这里。</p></section>'}`;
  }
  function paint() { const element = root(); if (element) element.innerHTML = markup(); }
  async function load() {
    if (!root() || loading || busy) { paint(); return; }
    loading = true; paint();
    try { snapshot = await request('/api/douyin-tracking'); problem = ''; }
    catch (error) { problem = error.message; }
    finally { loading = false; paint(); }
  }
  document.addEventListener('input', event => {
    if (!event.target.matches('[data-tracking-url]')) return;
    const ref = event.target.closest('[data-tracking-target]')?.dataset.trackingTarget;
    if (ref) drafts.set(ref, event.target.value);
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-douyin-tracking]');
    if (!button || button.disabled || busy) return;
    const action = button.dataset.douyinTracking;
    if (action === 'refresh') { await load(); return; }
    const targetRef = button.closest('[data-tracking-target]')?.dataset.trackingTarget;
    if (!['check', 'check-one', 'bind', 'settings'].includes(action)) return;
    const settings = action === 'settings' ? { enabled: root().querySelector('#tracking-enabled').checked, dailyTime: root().querySelector('#tracking-daily-time').value } : null;
    const workURL = action === 'bind' ? workLink(drafts.get(targetRef)) : '';
    if (action === 'bind' && !workURL) { notify('请填写包含作品编号的抖音完整链接。'); return; }
    busy = true; problem = ''; paint();
    try {
      if (action === 'settings') {
        snapshot = await request('/api/douyin-tracking/settings', { method: 'POST', headers: { 'If-Match': snapshot.revision }, body: JSON.stringify(settings) });
        notify('每日集中回采安排已保存');
        return;
      }
      snapshot = await request('/api/douyin-tracking/' + (action === 'bind' ? 'bind' : 'check'), {
        method: 'POST', body: JSON.stringify(action === 'bind' ? { targetRef, workURL } : targetRef ? { targetRef } : {}),
        signal: AbortSignal.timeout(300000),
      });
      if (action === 'bind') drafts.delete(targetRef);
      await refreshWorkspace();
      const errors = [...(snapshot.result?.results || []), ...(snapshot.result?.projections || [])].filter(item => item.error);
      problem = errors.map(item => item.error).join('；') || snapshot.scheduler.error || '';
      const unresolved = (snapshot.result?.results || []).some(item => item.unresolved);
      const automaticallyBound = (snapshot.result?.results || []).some(item => item.automaticallyBound);
      notify(unresolved ? '部分作品暂未核实，已保留原状态和数据' : problem ? '检查已完成，部分作品需要处理' : action === 'bind' || automaticallyBound ? '作品已核实绑定，后续自动回采' : '回采检查完成');
    } catch (error) { problem = error.message; notify(problem); }
    finally { busy = false; paint(); }
  });
  return { mount: load };
}
