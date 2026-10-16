import { esc, dialog, download } from './workspace-ui.js';

const labels = { selecting: '选品中', rendering: '制作中', publishing: '发布中', preview: '预览成片', submitted: '已提交待审核', published: '已确认发布', failed: '已停止', uncertain: '结果待核实', skipped: '今日已跳过' };
const when = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
export function createDailyProduction({ notify, refreshWorkspace }) {
  let snapshot, problem = '', loading = false, busy = false, authorized = false, sourceDraft = null, browsers = [], browserId = '';
  async function request(route = '', body) {
    const response = await fetch('/api/daily-production' + route, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'If-Match': snapshot?.revision || 'missing' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(route === '/connect' ? 180000 : route === '/sync' ? 180000 : 20000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.message || '操作未完成'); return data;
  }
  function setupMarkup() {
    return `<section class="card" style="margin-bottom:20px"><div class="card-title"><h3>首次连接，以后沿用</h3><span class="pill">本机保存</span></div><details ${!snapshot.lastSync ? 'open' : ''}><summary>商品日报来源</summary><div class="field"><label for="daily-source-folder">原选品项目的 output 目录</label><input id="daily-source-folder" value="${esc(sourceDraft ?? snapshot.config.sourceFolder)}" ${busy || snapshot.busy ? 'disabled' : ''}><small>可直接使用默认收件目录，也可只改一次为原项目的 output、日期或单品目录。</small></div><p class="form-hint">自动识别 01_全链路分析.md、05_发布文案.md 和 06_素材/images/；只导入有图片的新商品，保留已有编辑。更换来源会暂停计划。</p><div class="form-actions"><button class="button button-light" data-daily="source" ${busy || snapshot.busy ? 'disabled' : ''}>保存来源</button><button class="button button-light" data-daily="sync" ${busy || snapshot.busy || sourceDraft !== null ? 'disabled' : ''}>立即同步商品</button></div></details>${snapshot.lastSync ? `<p class="form-hint">上次同步 ${when(snapshot.lastSync.at)}：新增 ${snapshot.lastSync.added} 款，已有 ${snapshot.lastSync.existing} 款。</p>${snapshot.lastSync.warnings?.length ? `<details><summary>查看 ${snapshot.lastSync.warnings.length} 条导入提示</summary>${snapshot.lastSync.warnings.map(w => `<p class="form-hint">${esc(w)}</p>`).join('')}</details>` : ''}` : ''}<div class="form-actions"><button class="button button-light" data-daily="connect" ${busy || snapshot.busy ? 'disabled' : ''}>自动识别抖音账号</button><button class="text-link" data-daily="browsers" ${busy ? 'disabled' : ''}>选择浏览器</button>${browsers.length ? `<select id="daily-browser" aria-label="发布浏览器" ${busy ? 'disabled' : ''}><option value="">自动选择唯一连接</option>${browsers.map(b => `<option value="${esc(b.id)}" ${b.id === browserId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>` : ''}</div><p class="form-hint">登录状态沿用本机浏览器。只有一个连接时自动选择；不需要填写账号编号。</p></section>`;
  }
  function markup() {
    if (!snapshot) return `<div class="card empty">${esc(problem || '正在读取每日生产状态…')}</div>`;
    return `${problem ? `<div class="notice orange" role="alert">${esc(problem)}</div>` : ''}${busy ? '<p role="status">正在处理，请稍候…</p>' : ''}${setupMarkup()}
      <section class="card"><div class="card-title"><h3>每天 06:00 · 免费本地合成 · 抖音 1 条</h3><span class="pill">${snapshot.config.enabled ? '已开启' : '已暂停'}</span></div><p>从商品库选择尚未发布的商品 → 商品图片配字幕 → 生成竖屏视频 → 制作完成后公开发布。</p><p class="form-hint">普通商品介绍，不挂商品链接。每天最多 1 条；开启时已过 06:00，则从明天开始。电脑和本地服务需要持续运行。</p><p>目标抖音号：<b>${esc(snapshot.config.accountId || '尚未绑定')}</b> · 可选商品：<b>${snapshot.eligible}</b> 款</p>
      ${!snapshot.config.enabled ? `<label class="check-row"><input type="checkbox" data-daily-consent ${authorized ? 'checked' : ''}>允许每天从我的商品库选 1 款，使用已有图片和文案制作商品介绍视频，并发布到已识别的抖音账号，无需逐条批准。</label>` : ''}
      <p class="form-hint">下次开始：${when(snapshot.nextRunAt)}。${snapshot.busy ? '当前任务正在处理，可随时暂停后续发布。' : ''}</p><div class="form-actions"><button class="button button-green" data-daily="toggle" ${busy || !snapshot.config.enabled && (!authorized || sourceDraft !== null) ? 'disabled' : ''}>${snapshot.config.enabled ? '暂停每日生产' : '开启每日生产'}</button><button class="button button-light" data-daily="preview" ${busy || snapshot.busy || sourceDraft !== null ? 'disabled' : ''}>仅生成一条预览</button><button class="button button-light" data-daily="export">导出运行记录</button></div></section>
      <section class="card" style="margin-top:20px"><div class="card-title"><h3>当前接入情况</h3></div><p><b>商品来源：</b>${esc(snapshot.sourceMessage)}</p><p><b>视频制作：</b>本机生成 720×1280 字幕视频，不调用付费模型。</p><p><b>效果数据：</b>${esc(snapshot.metricsMessage)}</p><div class="form-actions"><button class="button button-light" data-go="shop">查看 / 导入商品库</button></div>${snapshot.error ? `<p class="form-error" role="alert">${esc(snapshot.error)}</p>` : ''}</section>
      <section class="card" style="margin-top:20px"><div class="card-title"><h3>每天的执行结果</h3><span class="pill">已提交 ${snapshot.runs.filter(r => r.status === 'submitted').length} · 已发布 ${snapshot.runs.filter(r => r.status === 'published').length}</span></div>${snapshot.runs.slice(-30).reverse().map(run => `<article class="automation-item"><span class="pill">${labels[run.status] || esc(run.status)}</span><h3>${esc(run.title || '每日商品介绍')}</h3><small>${when(run.startedAt)}${run.previewOnly ? ' · 仅预览' : ''}${run.seconds ? ` · ${run.seconds} 秒` : ''}</small><p>${esc(run.message)}</p>${run.asset ? `<video class="automation-review-video" controls preload="none" src="/api/daily-production/media?id=${encodeURIComponent(run.id)}"></video>` : ''}${['uncertain', 'submitted'].includes(run.status) ? `<button class="button button-light" data-daily="reconcile" data-id="${esc(run.id)}">核实发布结果</button>` : ''}${run.status === 'published' && /^https:\/\/(?:www\.|v\.)?douyin\.com\//.test(run.publishedUrl || '') ? `<a class="button button-light" href="${esc(run.publishedUrl)}" target="_blank" rel="noopener noreferrer">查看作品</a>` : ''}${run.status === 'uncertain' ? '<p class="form-hint">请先到抖音核实这次提交。此任务不会自动重发。</p>' : ''}</article>`).join('') || '<p class="muted">生成记录和发布回执会显示在这里。</p>'}</section>`;
  }
  function update() { const el = document.querySelector('#daily-production-root'); if (el) el.innerHTML = markup(); }
  async function load() {
    if (loading || busy) return;
    loading = true;
    try { snapshot = await request(); await refreshWorkspace(); problem = ''; } catch (error) { problem = error.message; }
    finally { loading = false; update(); }
  }
  document.addEventListener('input', event => { if (event.target.id === 'daily-source-folder') { sourceDraft = event.target.value; document.querySelectorAll('[data-daily="sync"],[data-daily="preview"]').forEach(b => { b.disabled = true; }); if (!snapshot.config.enabled) document.querySelector('[data-daily="toggle"]').disabled = true; } });
  document.addEventListener('change', event => { if (event.target.matches('[data-daily-consent]')) { authorized = event.target.checked; update(); } if (event.target.id === 'daily-browser') browserId = event.target.value; });
  function reconcile(run) {
    if (!run) { notify('记录已变化，请刷新后重试。'); return; }
    const el = dialog('核实发布结果', `<p>${esc(run.title)}。请到抖音确认后选择实际结果。</p><form><div class="field"><label for="daily-result">结果</label><select id="daily-result" name="result"><option value="published">作品已经发布</option><option value="not-published">确认完全未发布</option></select></div><div class="field"><label for="daily-url">已发布作品链接</label><input id="daily-url" type="url" name="url"></div><label class="check-row"><input name="confirmed" type="checkbox" required>我已在抖音核实此条视频</label><p class="form-error" role="alert"></p><button class="button button-green">保存核实结果</button></form>`);
    let pending = false;
    el.querySelector('form').onsubmit = async event => {
      event.preventDefault(); event.stopPropagation(); if (pending) return;
      pending = busy = true; event.submitter.disabled = true;
      try { snapshot = await request('/reconcile', { ...Object.fromEntries(new FormData(event.target)), id: run.id, confirmed: true }); el.close(); await refreshWorkspace(); problem = ''; update(); }
      catch (error) { el.querySelector('.form-error').textContent = error.message; }
      finally { pending = busy = false; if (el.isConnected) event.submitter.disabled = false; update(); }
    };
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-daily]'); if (!button || button.disabled || busy) return;
    if (button.dataset.daily === 'refresh') { await load(); return; }
    if (button.dataset.daily === 'reconcile') { reconcile(snapshot.runs.find(r => r.id === button.dataset.id)); return; }
    if (button.dataset.daily === 'export') { download({ exportedAt: new Date().toISOString(), ...snapshot }, 'doufeng-daily-production.json'); return; }
    busy = true; update();
    try {
      const action = button.dataset.daily;
      if (action === 'browsers') { browsers = (await request('/browsers')).browsers; if (!browsers.length) throw new Error('没有可用浏览器，请连接扩展后重试。'); }
      else {
        if (action === 'toggle' && !snapshot.config.enabled) snapshot = await request('/sync', {});
        snapshot = await request('/' + action, action === 'toggle' ? { enabled: !snapshot.config.enabled, authorized } : action === 'source' ? { folder: sourceDraft ?? snapshot.config.sourceFolder } : action === 'connect' ? { browserId } : {});
        if (action === 'source') { sourceDraft = null; authorized = false; }
        await refreshWorkspace();
        notify(({ preview: '已开始生成预览，不会发布', source: '来源已保存，以后开工前自动同步', sync: '商品同步完成', connect: '账号已识别，请核对目标抖音号', toggle: snapshot.config.enabled ? '已开启，每天早上 6 点开始' : '已暂停每日生产' })[action]);
      }
      problem = '';
    } catch (error) { problem = error.message; }
    finally { busy = false; update(); }
  });
  setInterval(() => { const root = document.querySelector('#daily-production-root'); if (root && !document.querySelector('dialog[open]') && !root.contains(document.activeElement) && ![...root.querySelectorAll('video')].some(video => !video.paused)) void load(); }, 5000);
  return { mount: load, render: () => `<div class="page-head"><div><p class="eyebrow">DAILY PRODUCTION</p><h1>每日自动生产</h1><p>一次设置，查看每天的选品、成片和发布结果。</p></div><button class="button button-light" data-daily="refresh">刷新</button></div><div id="daily-production-root">${markup()}</div>` };
}
