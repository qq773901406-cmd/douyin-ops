import { normalizeState } from './workbuddy/connector/lib/workspace-model.mjs';

const KEY = 'douyinOpsWorkbench.v1';
const PENDING = `${KEY}.pending`;
const RECOVERY = `${KEY}.recovery.`;
const read = (storage, key) => { try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; } };

function pendingSnapshot() {
  try {
    const pending = read(sessionStorage, PENDING);
    if (!pending || !pending.state || typeof pending.state !== 'object' || Array.isArray(pending.state) || (pending.revision !== null && typeof pending.revision !== 'string')) return null;
    return { ...pending, state: normalizeState(pending.state) };
  } catch { return null; }
}

export function cachedState(fallback) {
  try { return normalizeState(pendingSnapshot()?.state || read(localStorage, KEY) || fallback); }
  catch { return normalizeState(fallback); }
}

export function createStateSync({ getState, setState, render, notify }) {
  const restored = pendingSnapshot();
  let revision = restored?.revision ?? null;
  let dirty = !!restored;
  let sequence = 0;
  let sending = false;
  let conflict = false;
  let initialized = false;
  let reloading = false;
  const recoveryKey = `${RECOVERY}${crypto.randomUUID()}`;
  const previousRecovery = restored?.recoveryKey;
  let status = '正在读取工作区…';
  let storageError = '';

  async function request(method, body) {
    const response = await fetch('/api/state', {
      method, cache: 'no-store', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json', ...(method === 'PUT' ? { 'If-Match': revision } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message || '保存失败'), { status: response.status });
    if (typeof data.revision !== 'string') throw new Error('本地服务版本较旧，请重启 node server.mjs 后重试。');
    return data;
  }

  function recoveryEntries() {
    try { return Object.keys(localStorage).filter(key => key.startsWith(RECOVERY) && key !== recoveryKey && key !== previousRecovery).map(key => read(localStorage, key)).filter(Boolean); }
    catch { return []; }
  }

  function show() {
    const el = document.querySelector('#sync-status');
    el.className = `sync-status ${conflict || storageError ? 'sync-warning' : dirty ? 'sync-pending' : ''}`;
    el.querySelector('[data-sync-message]').textContent = storageError || status;
    el.querySelector('[data-sync="retry"]').hidden = !dirty || conflict || sending;
    el.querySelector('[data-sync="reload"]').hidden = !initialized || sending;
    el.querySelector('[data-sync="backup"]').hidden = !dirty && !storageError;
    const recoveries = recoveryEntries();
    el.querySelector('[data-sync="recoveries"]').hidden = !recoveries.length;
    el.querySelector('[data-sync="recoveries"]').textContent = `未同步备份（${recoveries.length}）`;
  }

  function persist() {
    const pending = { revision, state: getState(), recoveryKey, savedAt: new Date().toISOString() };
    const failures = [];
    for (const [storage, key, value] of [['localStorage', KEY, getState()], ['sessionStorage', PENDING, pending], ['localStorage', recoveryKey, pending]]) {
      try { window[storage].setItem(key, JSON.stringify(value)); } catch { failures.push(key); }
    }
    storageError = failures.length ? '浏览器备份写入失败（空间或权限受限），请导出备份并保持本页打开。' : '';
    show();
  }

  function clearPending() {
    for (const [storage, key] of [['sessionStorage', PENDING], ['localStorage', recoveryKey], ['localStorage', previousRecovery]]) {
      if (key) { try { window[storage].removeItem(key); } catch {} }
    }
    try { localStorage.setItem(KEY, JSON.stringify(getState())); } catch {}
  }

  async function flush() {
    if (!initialized || sending || reloading || !dirty || conflict) return;
    sending = true; status = '正在保存到本地服务…'; show();
    try {
      if (revision === null) {
        const remote = await request('GET');
        if (remote.state) throw Object.assign(new Error('服务端已有数据，请导出本页备份并载入最新数据后合并。'), { status: 409 });
        revision = remote.revision;
      }
      while (dirty) {
        const version = sequence;
        const snapshot = structuredClone(getState());
        const remote = await request('PUT', snapshot);
        revision = remote.revision;
        dirty = sequence !== version;
        if (dirty) persist();
        else { clearPending(); status = '已同步到本地服务'; storageError = ''; }
      }
    } catch (error) {
      conflict = error.status === 409;
      status = conflict ? error.message : `尚未同步：${error.message}。本页内容已保留，可重试。`;
      persist();
    } finally { sending = false; show(); }
  }

  function save() {
    sequence += 1; dirty = true; persist(); void flush();
  }

  async function initialize() {
    document.querySelector('#view').inert = true;
    try {
      const remote = await request('GET');
      if (dirty) {
        if (revision === null && remote.state === null) revision = remote.revision;
        conflict = revision !== remote.revision;
        status = conflict ? '恢复了本页未同步内容，但工作区已有更新。请导出备份后载入最新数据。' : '正在恢复未同步内容…';
        persist();
      } else {
        revision = remote.revision;
        if (remote.state) setState(normalizeState(remote.state), { initial: true });
        else { dirty = true; persist(); }
        status = remote.state ? '已载入本地工作区' : '正在创建工作区…';
        render();
      }
    } catch (error) { status = `本地服务暂不可用：${error.message}。可继续编辑，保存后重试同步。`; }
    finally { initialized = true; document.querySelector('#view').inert = false; show(); }
    await flush();
  }

  function download(value, prefix) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${prefix}-${Date.now()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showRecoveries() {
    document.querySelector('#recovery-dialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'recovery-dialog'; dialog.className = 'recovery-dialog';
    const heading = document.createElement('h2'); heading.textContent = '未同步的工作区备份'; dialog.append(heading);
    const hint = document.createElement('p'); hint.textContent = '这些内容来自其他页面或之前关闭的页面。可先导出 JSON，或载入本页继续处理；载入后仍会检查服务端版本。'; dialog.append(hint);
    for (const entry of recoveryEntries()) {
      const row = document.createElement('section'); row.className = 'kb-item';
      const title = document.createElement('b'); title.textContent = `${entry.state?.account || '工作区'} · ${new Date(entry.savedAt).toLocaleString('zh-CN')}`; row.append(title);
      const actions = document.createElement('div'); actions.className = 'form-actions';
      for (const label of ['导出 JSON', '载入本页', '移除备份']) {
        const action = document.createElement('button'); action.type = 'button'; action.className = 'button button-light'; action.textContent = label;
        action.addEventListener('click', () => {
          try {
            if (label === '导出 JSON') { download(entry.state, 'doufeng-recovery'); return; }
            if (label === '移除备份') {
              if (!confirm('移除这份浏览器备份？建议先导出 JSON。')) return;
              if (entry.recoveryKey?.startsWith(RECOVERY)) localStorage.removeItem(entry.recoveryKey);
              row.remove(); show(); return;
            }
            if (!confirm('载入备份会重置尚未提交的表单。本页未同步的工作区数据将先下载备份，继续吗？')) return;
            const next = normalizeState(entry.state);
            if (dirty) download(getState(), 'doufeng-before-recovery');
            setState(next); revision = entry.revision ?? null; conflict = false;
            status = '已载入备份，正在检查同步版本…'; render(); save(); dialog.close();
          } catch (error) { notify(error.message); }
        });
        actions.append(action);
      }
      row.append(actions); dialog.append(row);
    }
    const close = document.createElement('button'); close.type = 'button'; close.className = 'button button-dark'; close.style.marginTop = '16px'; close.textContent = '关闭'; close.addEventListener('click', () => dialog.close()); dialog.append(close);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-sync]');
    if (!button) return;
    if (button.dataset.sync === 'retry') { await flush(); return; }
    if (button.dataset.sync === 'backup') { download(getState(), 'doufeng-unsynced'); return; }
    if (button.dataset.sync === 'recoveries') {
      if (!sending && !reloading) showRecoveries(); return;
    }
    if (button.dataset.sync === 'reload') {
      if (!confirm('载入最新数据会重置页面中尚未提交的表单。本页未同步的工作区数据将先下载备份，继续吗？')) return;
      if (sending || reloading) return;
      button.disabled = true; reloading = true; document.querySelector('#view').inert = true;
      try {
        const remote = await request('GET');
        if (dirty) download(getState(), 'doufeng-before-reload');
        setState(normalizeState(remote.state || {})); revision = remote.revision;
        dirty = false; conflict = false; storageError = ''; clearPending(); status = '已载入最新数据'; render(); show(); notify('工作区已更新');
      } catch (error) { notify(error.message); }
      finally { button.disabled = false; reloading = false; document.querySelector('#view').inert = false; }
    }
  });
  window.addEventListener('online', () => { void flush(); });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('storage', show);
  return {
    save, initialize,
    inspect: () => ({ dirty, sending, reloading, initialized, revision }),
    async transaction(operation) {
      if (!initialized || revision === null || dirty || sending || reloading) throw new Error('请等待当前修改同步完成；有冲突时先处理顶部提示。');
      reloading = true; document.querySelector('.shell').inert = true;
      try {
        const remote = await operation(revision);
        if (!remote?.state || typeof remote.revision !== 'string') throw new Error('恢复结果不完整，请载入最新数据确认。');
        setState(normalizeState(remote.state)); revision = remote.revision; dirty = false; conflict = false; clearPending();
        status = '工作区已恢复，并已同步到本地服务'; render(); show();
      } finally { reloading = false; document.querySelector('.shell').inert = false; show(); }
    }
  };
}
