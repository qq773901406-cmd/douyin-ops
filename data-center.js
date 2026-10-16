import { esc, dialog, request, dateTime, download, localDay } from './workspace-ui.js';
import { normalizeState, collections } from './workbuddy/connector/lib/workspace-model.mjs';
import { restoreTrash, collectionLabels, recordTitle } from './workbuddy/connector/lib/workspace-actions.mjs';

export function createDataCenter({ getState, getSync, save, render, notify }) {
  let backups = [], system = null, error = '', loading = false, loadedAt = 0;
  const kinds = { auto: '自动快照', manual: '手动备份', restore: '恢复前保护' };
  const counts = state => collections.map(key => `<span>${collectionLabels[key]} <b>${state[key].length}</b></span>`).join('');
  function backupRows() {
    if (loading) return '<div class="empty" role="status">正在读取本机备份…</div>';
    if (error) return `<div class="notice orange">${esc(error)}</div>`;
    return backups.map(item => `<article class="backup-row"><div><span class="pill">${esc(kinds[item.kind] || '待检查')}</span><b>${esc(item.label || '工作区备份')}</b><small>${dateTime(item.createdAt)} · ${item.bytes ? (item.bytes / 1024).toFixed(1) + ' KB' : '不可读'}</small></div>${item.available ? `<div class="row-actions"><button class="button button-light" data-backup="download" data-id="${item.id}">导出</button><button class="button button-light" data-backup="preview" data-id="${item.id}">查看 / 恢复</button></div>` : '<span class="pill orange">需检查原文件</span>'}</article>`).join('') || '<div class="empty">尚无备份。保存修改时会自动保留上一版，也可以手动创建。</div>';
  }
  function systemMarkup() {
    return system ? `<dl class="system-details"><dt>版本</dt><dd>${esc(system.version)} · 本地个人版</dd><dt>数据目录</dt><dd>${esc(system.dataDir)}</dd><dt>运行环境</dt><dd>Node ${esc(system.node)}</dd><dt>服务进程</dt><dd>${esc(system.pid)}</dd><dt>本次运行</dt><dd>${Math.floor(system.uptime / 60)} 分钟</dd></dl>` : '<p class="muted">等待本地服务信息</p>';
  }
  function view() {
    const trash = getState().trash || [];
    return `<div class="page-head"><div><p class="eyebrow">DATA & RECOVERY</p><h1>数据管理</h1><p>查看备份、恢复误删内容，并了解数据保存在哪里。</p></div><button class="button button-light" data-backup="refresh">刷新</button></div>
      <div class="card data-overview"><div class="card-title"><h3>当前工作区：${esc(getState().account)}</h3><span class="pill green">本地保存</span></div><div class="data-counts">${counts(getState())}</div><div class="form-actions"><button class="button button-green" data-backup="create">创建手动备份</button><button class="button button-light" data-backup="export-current">导出当前工作区</button><label class="button button-light">导入 JSON<input id="workspace-import" type="file" accept=".json,application/json" hidden></label></div><p class="form-hint">JSON 备份包含账号设置、业务记录和回收站；素材文件需要单独保管。导出当前工作区也会包含尚未同步的记录。</p></div>
      <div class="grid grid-2 data-columns"><section class="card"><div class="card-title"><h3>备份历史</h3><span class="pill">最近 30 个自动快照</span></div><p class="form-hint">手动备份和恢复前保护保留在本机。恢复前会自动备份当前工作区。</p><div id="backup-list">${backupRows()}</div></section><div><section class="card"><div class="card-title"><h3>本机环境</h3></div><div id="system-details">${systemMarkup()}</div><p class="form-hint">双击项目目录的 start.cmd 可启动或重新打开工作台。运行日志位于数据目录的 logs 文件夹。</p></section><section class="card" style="margin-top:16px"><div class="card-title"><h3>回收站</h3><span class="pill">${trash.length} 条</span></div>${trash.length ? trash.slice().reverse().map(entry => `<article class="trash-row"><div><b>${esc(recordTitle(entry.item))}</b><small>${esc(collectionLabels[entry.collection])} · ${dateTime(entry.deletedAt)}</small></div><div class="row-actions"><button class="button button-light" data-trash="restore" data-id="${esc(entry.id)}">恢复</button><button class="text-link danger-text" data-trash="purge" data-id="${esc(entry.id)}">永久删除</button></div></article>`).join('') : '<div class="empty">回收站为空。删除业务记录后，可在这里恢复。</div>'}</section></div></div>`;
  }
  async function load(force = false) {
    if (loading || (!force && Date.now() - loadedAt < 15000)) return;
    loading = true; error = ''; update();
    try { const responses = await Promise.all([request('/api/backups'), request('/api/system')]); backups = responses[0].backups; system = responses[1]; loadedAt = Date.now(); }
    catch (problem) { error = problem.message; }
    finally { loading = false; update(); }
  }
  function update() { const list = document.querySelector('#backup-list'); if (list) list.innerHTML = backupRows(); const details = document.querySelector('#system-details'); if (details) details.innerHTML = systemMarkup(); }
  function preview(state, source, id) {
    const incoming = normalizeState(state), current = getState();
    const el = dialog('检查恢复内容', `<p>来源：${esc(source)}</p><div class="notice orange">恢复会替换当前工作区。当前数据会先保存为“恢复前保护”；页面中的未提交表单会重置。</div><div class="table-wrap"><table class="data-table"><thead><tr><th>内容</th><th>当前</th><th>恢复后</th></tr></thead><tbody><tr><td>账号名称</td><td>${esc(current.account)}</td><td>${esc(incoming.account)}</td></tr>${collections.map(key => `<tr><td>${collectionLabels[key]}</td><td>${current[key].length}</td><td>${incoming[key].length}</td></tr>`).join('')}<tr><td>回收站</td><td>${current.trash?.length || 0}</td><td>${incoming.trash.length}</td></tr></tbody></table></div><p class="form-error" role="alert"></p><div class="form-actions"><button class="button button-green" data-confirm-restore>确认恢复这些数据</button></div>`, { wide: true });
    el.querySelector('[data-confirm-restore]').onclick = async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        await getSync().transaction(revision => request('/api/backups/restore', { method: 'POST', headers: { 'If-Match': revision }, body: JSON.stringify(id ? { id } : { state: incoming }) }));
        el.close(); loadedAt = 0; await load(true); notify('工作区已恢复，恢复前数据已另存备份');
      } catch (problem) { el.querySelector('.form-error').textContent = problem.message; }
      finally { button.disabled = false; }
    };
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-backup], [data-trash]'); if (!button || button.disabled) return;
    button.disabled = true;
    try {
      const action = button.dataset.backup;
      if (action === 'refresh') await load(true);
      if (action === 'export-current') download(getState(), `doufeng-${localDay()}.json`);
      if (action === 'create') {
        const sync = getSync().inspect(); if (!sync.initialized || sync.dirty || sync.sending || sync.reloading || sync.revision === null) throw new Error('请先等待当前工作区同步完成；也可导出当前工作区保留未同步内容。');
        await request('/api/backups', { method: 'POST', body: JSON.stringify({ label: '手动备份' }) }); await load(true); notify('手动备份已创建');
      }
      if (['download', 'preview'].includes(action)) {
        const data = await request(`/api/backups/${encodeURIComponent(button.dataset.id)}`);
        if (action === 'download') download(data.backup, `doufeng-${button.dataset.id}`); else preview(data.backup.state, dateTime(data.backup.createdAt), button.dataset.id);
      }
      if (button.dataset.trash === 'restore') { restoreTrash(getState(), button.dataset.id); save(); render(); notify('记录已恢复，正在同步'); }
      if (button.dataset.trash === 'purge' && confirm('永久删除这条回收站记录？以后只能从历史备份找回。')) { getState().trash = getState().trash.filter(entry => entry.id !== button.dataset.id); save(); render(); notify('已从回收站移除，正在同步'); }
    } catch (problem) { notify(problem.message); }
    finally { button.disabled = false; }
  });
  document.addEventListener('change', async event => {
    if (event.target.id !== 'workspace-import') return;
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('当前导入上限为 8MB，请拆分过大的工作区或保留文件寻求迁移。');
      const parsed = JSON.parse(await file.text());
      if (parsed.format && (parsed.format !== 'doufeng-workspace' || parsed.version !== 1)) throw new Error('不支持这个备份版本。');
      const state = parsed.format ? parsed.state : parsed;
      if (!state || !Array.isArray(state.records) || !Array.isArray(state.drafts)) throw new Error('文件不是有效的工作区备份。');
      preview(state, file.name);
    } catch (problem) { notify(problem.message); }
  });
  return { render: view, mount: () => { void load(); } };
}
