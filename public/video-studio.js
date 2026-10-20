import { newVideo, newShot, copyVideo, validateVideo, videoPrompt, videoQuality, videoStatuses, videoRatios, videoReviewStatuses } from '../workbuddy/connector/lib/video-projects.mjs';
import { moveToTrash } from '../workbuddy/connector/lib/workspace-actions.mjs';

const EDITOR_KEY = 'doufeng.video-editor.v1';
const fields = ['title', 'subject', 'setting', 'style', 'referenceVideo', 'characterReference', 'visualIdentity', 'ratio', 'budget', 'provider', 'cost', 'status', 'asset', 'blocker', 'notes'];
const shotFields = ['action', 'camera', 'referenceImage', 'startState', 'endState', 'asset', 'reviewStatus', 'reviewNotes'];
const visualFields = ['subject', 'setting', 'style', 'characterReference', 'visualIdentity', 'ratio'];
const shotVisualFields = ['seconds', 'action', 'camera', 'referenceImage', 'startState', 'endState', 'asset'];
const comparable = (key, value) => key === 'seconds' ? Number(value) : String(value ?? '').replace(/\r\n/gu, '\n').trim();
const totalSeconds = project => project.shots.reduce((sum, shot) => sum + (Number(shot.seconds) || 0), 0);
const dateValue = project => Date.parse(project.updatedAt || project.createdAt) || 0;
const searchText = value => String(value || '').normalize('NFKC').toLocaleLowerCase().trim();

function readEditor() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(EDITOR_KEY) || 'null');
    const p = saved?.project;
    if (saved?.version !== 1 || !p || !Array.isArray(p.shots) || p.shots.length < 1 || p.shots.length > 12) return null;
    const project = newVideo();
    for (const key of [...fields, 'id', 'createdAt', 'updatedAt', 'sourceProductId']) if (typeof p[key] === 'string') project[key] = p[key];
    project.shots = p.shots.map((shot, index) => {
      const restored = newShot({ id: typeof shot?.id === 'string' && shot.id ? shot.id : `legacy-shot-${index + 1}`, seconds: Number(shot?.seconds) || '' });
      for (const key of shotFields) if (typeof shot?.[key] === 'string') restored[key] = shot[key];
      return restored;
    });
    return { project, savedAt: saved.savedAt };
  } catch { return null; }
}

export function createVideoStudio({ getState, save, go, openDraft, notify, esc }) {
  const recovered = readEditor();
  let editing = recovered?.project || newVideo();
  let changed = !!recovered;
  let draftSaved = !!recovered;
  let editorStorageError = false;
  let filter = 'all';
  let query = '';
  let sort = 'updated';
  let draftTimer;
  let upload = null;
  let referencesOpen = !recovered;
  let openShotDetails = new Set();
  const $ = selector => document.querySelector(selector);
  const button = (label, action, extra = '') => `<button type="button" class="button button-light" data-video="${action}" ${extra}>${label}</button>`;
  const field = (label, name, value, multiline = false, attrs = '') => `<div class="field"><label for="video-${name}">${label}</label>${multiline ? `<textarea id="video-${name}" name="${name}" maxlength="5000" ${attrs}>${esc(value)}</textarea>` : `<input id="video-${name}" name="${name}" value="${esc(value)}" ${attrs}>`}</div>`;
  const options = (values, selected) => Object.entries(values).map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
  const select = (label, name, values, value) => `<div class="field"><label for="video-${name}">${label}</label><select id="video-${name}" name="${name}">${options(values, value)}</select></div>`;
  const shotField = (label, key, shot, index, multiline = false, placeholder = '') => {
    const id = `shot-${key}-${index}`;
    const attrs = `id="${id}" data-shot-field="${key}" maxlength="${key === 'reviewNotes' ? 5000 : 2000}" placeholder="${esc(placeholder)}"`;
    return `<div class="field"><label for="${id}">${label}</label>${multiline ? `<textarea ${attrs}>${esc(shot[key] || '')}</textarea>` : `<input ${attrs} value="${esc(shot[key] || '')}">`}</div>`;
  };

  function shotStage(shot) {
    if (shot.reviewStatus === 'rejected') return { key: 'rejected', label: '退回', color: 'orange' };
    if (!String(shot.asset || '').trim()) return { key: 'unproduced', label: '待生成', color: '' };
    if (shot.reviewStatus === 'approved') return { key: 'approved', label: '通过', color: 'green' };
    return { key: 'pending', label: '待验收', color: 'blue' };
  }

  function qualityMarkup() {
    const counts = { unproduced: 0, pending: 0, approved: 0, rejected: 0 };
    for (const shot of editing.shots) counts[shotStage(shot).key]++;
    const quality = videoQuality(editing);
    return `<div class="chip-list" aria-label="当前项目分镜进度"><span class="pill">待生成 ${counts.unproduced}</span><span class="pill blue">待验收 ${counts.pending}</span><span class="pill green">通过 ${counts.approved}</span><span class="pill orange">退回 ${counts.rejected}</span></div>
      <p class="form-hint">${quality.readyForAssembly ? '制作记录已满足合成检查条件。合成前仍需打开实际素材，检查连续性、动作与声音。' : '逐镜生成、逐镜验收，通过后再合成。参考图和素材路径只作记录，填入路径不代表文件已生成或校验。'}</p>
      ${quality.issues.length ? `<details data-quality-issues><summary class="form-hint">查看 ${quality.issues.length} 项制作检查提示</summary><ul class="form-hint">${quality.issues.map(issue => `<li>${esc(issue.message)}</li>`).join('')}</ul></details>` : ''}`;
  }

  function updateQuality() {
    const panel = $('#video-quality-summary');
    if (panel) {
      const expanded = !!panel.querySelector('[data-quality-issues]')?.open;
      panel.innerHTML = qualityMarkup();
      if (expanded && panel.querySelector('[data-quality-issues]')) panel.querySelector('[data-quality-issues]').open = true;
    }
    document.querySelectorAll('[data-shot-stage]').forEach((el, index) => {
      if (!editing.shots[index]) return;
      const stage = shotStage(editing.shots[index]);
      el.textContent = stage.label; el.className = `pill ${stage.color}`;
    });
  }

  function capture() {
    const form = $('#video-form');
    if (!form) return;
    const data = Object.fromEntries(new FormData(form));
    const visualChanged = visualFields.some(key => comparable(key, editing[key]) !== comparable(key, data[key]));
    for (const key of fields) editing[key] = data[key] ?? '';
    referencesOpen = !!form.querySelector('[data-video-references]')?.open;
    openShotDetails = new Set();
    const invalidated = [];
    editing.shots = [...form.querySelectorAll('[data-shot]')].map((row, index) => {
      const previous = editing.shots[index];
      const shot = { ...previous, seconds: row.querySelector('[data-shot-seconds]').value, action: row.querySelector('[data-shot-action]').value, camera: row.querySelector('[data-shot-camera]').value };
      for (const input of row.querySelectorAll('[data-shot-field]')) shot[input.dataset.shotField] = input.value;
      if (previous.reviewStatus === 'approved' && shot.reviewStatus === 'approved' && (visualChanged || shotVisualFields.some(key => comparable(key, previous[key]) !== comparable(key, shot[key])))) {
        shot.reviewStatus = 'pending';
        row.querySelector('[data-shot-field="reviewStatus"]').value = 'pending';
        invalidated.push(index + 1);
      }
      if (row.querySelector('[data-shot-details]')?.open) openShotDetails.add(shot.id);
      return shot;
    });
    if (invalidated.length) notify(`镜头 ${invalidated.join('、')} 的设定或素材已修改，已转为待验收；原验收备注保留`);
  }

  function staleMessage() {
    if (!editing.id) return '';
    const current = getState().videos.find(p => p.id === editing.id);
    if (!current) return '原项目已不存在。可将当前分镜另存为新项目。';
    if (current.updatedAt !== editing.updatedAt) return '原项目已有更新。请重新打开最新项目，或将当前分镜另存为新项目。';
    return '';
  }

  function editorStatus() {
    if (editorStorageError) return '暂存失败，请先保存或导出';
    if (changed) return draftSaved ? '编辑已暂存本标签页' : '正在暂存编辑…';
    return editing.id ? '已保存项目 · 同步见顶部' : '填写后保存';
  }

  function updateEditorStatus() {
    if ($('#video-edit-status')) $('#video-edit-status').textContent = editorStatus();
  }

  function persistEditor() {
    clearTimeout(draftTimer);
    if (!changed) return;
    try {
      sessionStorage.setItem(EDITOR_KEY, JSON.stringify({ version: 1, project: editing, savedAt: new Date().toISOString() }));
      draftSaved = true; editorStorageError = false;
    } catch { draftSaved = false; editorStorageError = true; }
    updateEditorStatus();
  }

  function clearEditorDraft() {
    clearTimeout(draftTimer);
    try { sessionStorage.removeItem(EDITOR_KEY); editorStorageError = false; }
    catch { editorStorageError = true; }
    draftSaved = false;
  }

  function markChanged(immediate = false) {
    changed = true; draftSaved = false;
    clearTimeout(draftTimer);
    if (immediate) persistEditor(); else draftTimer = setTimeout(persistEditor, 350);
    updateEditorStatus();
    if ($('#video-error')) $('#video-error').textContent = '';
    if ($('#video-duration')) $('#video-duration').textContent = `${totalSeconds(editing)} 秒 · ${editing.shots.length} 个镜头`;
    let elapsed = 0;
    document.querySelectorAll('[data-shot-time]').forEach((el, index) => { const start = elapsed; elapsed += Number(editing.shots[index]?.seconds) || 0; el.textContent = `${start}–${elapsed} 秒`; });
    updateQuality();
  }

  function cancelUpload() {
    if (!upload) return;
    const xhr = upload.xhr; upload = null; xhr.abort();
    updateUploadStatus();
  }

  function canReplaceEditor() {
    if ((changed || upload) && !confirm(upload ? '正在上传成片。取消上传并放弃当前未保存的编辑？' : '当前制作表单尚未保存，放弃这些修改？')) return false;
    cancelUpload(); return true;
  }

  function setEditor(project, isChanged) {
    clearEditorDraft(); editing = structuredClone(project); changed = isChanged;
    editing.shots = editing.shots.map((shot, index) => newShot({ ...shot, id: shot.id || `legacy-shot-${index + 1}` }));
    referencesOpen = !editing.characterReference || !editing.visualIdentity;
    openShotDetails = new Set();
    if (changed) persistEditor();
  }

  function repaint(focusSelector) {
    $('#view').innerHTML = render();
    if (focusSelector) $(focusSelector)?.focus({ preventScroll: true });
  }

  function download(text, extension, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = url; a.download = `video-plan-${new Date().toISOString().slice(0, 10)}.${extension}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function mediaMarkup() {
    const asset = editing.asset.trim();
    let external;
    try { const url = new URL(asset); if (['http:', 'https:'].includes(url.protocol)) external = url.href; } catch {}
    const localVideo = !external && /^(?:[a-z]:[\\/]|\/)/i.test(asset) && /\.(mp4|mov|webm)$/i.test(asset);
    return `<div class="media-toolbar">${button('选择成片并上传', 'choose-media', upload ? 'disabled' : '')}<input type="file" id="video-media-file" accept=".mp4,.webm,.mov" hidden><span class="form-hint">复制到本地工作区，支持 MP4 / WebM / MOV，最大 4GB。</span></div>
      <div class="media-progress" id="video-upload-progress" ${upload ? '' : 'hidden'}><progress max="100" value="${upload?.percent || 0}" aria-label="成片上传进度"></progress><span role="status">${esc(upload?.message || '')}</span>${button('取消上传', 'cancel-upload')}</div>
      ${external ? `<a class="button button-light" href="${esc(external)}" target="_blank" rel="noopener noreferrer">打开成片链接 ↗</a>` : localVideo ? `<video id="video-media-preview" class="media-preview" controls playsinline preload="metadata" src="/api/media?path=${encodeURIComponent(asset)}">当前浏览器不支持视频预览。</video><p id="video-media-error" class="form-hint" hidden>无法预览。请确认素材已上传到工作台；某些 MOV 或视频编码需要先转成兼容的 MP4。原文件路径仍然保留。</p>` : `<p class="form-hint">上传成片后可在这里播放；其他本地路径仅作为制作记录保留。</p>`}`;
  }

  function updateMediaPanel() {
    if ($('#video-media-panel')) $('#video-media-panel').innerHTML = mediaMarkup();
    if ($('#video-asset')) $('#video-asset').readOnly = !!upload;
    if ($('#video-save')) $('#video-save').disabled = !!upload;
  }

  function updateUploadStatus() {
    const progress = $('#video-upload-progress');
    if (progress) {
      progress.hidden = !upload;
      if (upload) { progress.querySelector('progress').value = upload.percent; progress.querySelector('[role="status"]').textContent = upload.message; }
    }
    const choose = $('[data-video="choose-media"]'); if (choose) choose.disabled = !!upload;
    if ($('#video-save')) $('#video-save').disabled = !!upload;
    if ($('#video-asset')) $('#video-asset').readOnly = !!upload;
  }

  function uploadFile(file) {
    if (!file || upload) return;
    if (!/\.(mp4|webm|mov)$/i.test(file.name) || !file.size || file.size > 4 * 1024 ** 3) { notify('请选择不超过 4GB 的 MP4、WebM 或 MOV 视频。'); return; }
    capture();
    const xhr = new XMLHttpRequest();
    const current = { xhr, percent: 0, message: `正在上传 ${file.name}` };
    upload = current; updateUploadStatus();
    xhr.open('POST', `/api/uploads?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => {
      if (upload !== current) return;
      current.percent = event.lengthComputable ? Math.round(event.loaded / event.total * 100) : 0;
      current.message = current.percent === 100 ? '文件已发送，正在完成保存…' : `正在上传 ${file.name} · ${current.percent}%`;
      updateUploadStatus();
    };
    const failed = message => {
      if (upload !== current) return;
      upload = null; updateUploadStatus(); notify(message);
      if ($('#video-error')) $('#video-error').textContent = message;
    };
    xhr.onerror = () => failed('上传失败，请检查本地服务后重新选择文件。');
    xhr.onabort = () => failed('上传已取消。');
    xhr.onload = () => {
      if (upload !== current) return;
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300 || !result.ok || typeof result.path !== 'string') throw new Error(result.message || '上传失败');
        upload = null; editing.asset = result.path;
        if ($('#video-asset')) $('#video-asset').value = result.path;
        markChanged(true); updateMediaPanel();
        notify(result.warning || '成片已上传并暂存路径，保存项目后归档');
      } catch (error) { failed(error.message || '上传结果无法读取，请重试。'); }
    };
    try { xhr.send(file); } catch { failed('无法开始上传，请重新选择文件。'); }
  }

  function filteredProjects() {
    const term = searchText(query);
    return getState().videos.filter(p => (filter === 'all' || p.status === filter) && (!term || searchText([p.title, p.subject, p.setting, p.provider, p.blocker, p.notes].join(' ')).includes(term))).map((project, index) => ({ project, index })).sort((a, b) => {
      const by = sort === 'title' ? a.project.title.localeCompare(b.project.title, 'zh-CN') : sort === 'duration' ? totalSeconds(a.project) - totalSeconds(b.project) : dateValue(b.project) - dateValue(a.project);
      return by || b.index - a.index;
    }).map(item => item.project);
  }

  function projectList() {
    const visible = filteredProjects();
    return `<p class="project-count" role="status">找到 ${visible.length} 个项目 / 共 ${getState().videos.length} 个</p>${visible.length ? visible.map(p => `<article class="card project-card ${p.id === editing.id ? 'selected' : ''}"><div class="kb-meta"><span class="pill ${p.status === 'completed' ? 'green' : p.status === 'blocked' ? 'orange' : ''}">${esc(videoStatuses[p.status])}</span><span>${esc(p.ratio)} · ${totalSeconds(p)} 秒</span></div><h3>${esc(p.title)}</h3><p class="project-description">${esc(p.subject || '尚未填写主角')}</p>${p.status === 'blocked' ? `<p class="project-blocker">${esc(p.blocker)}</p>` : ''}<small class="muted">${esc(p.provider || '工具待选择')} · ${p.cost === '' ? '费用待核实' : esc(p.cost) + ' 元'}</small>${dateValue(p) ? `<p class="project-updated">更新于 ${esc(new Date(dateValue(p)).toLocaleString('zh-CN'))}</p>` : ''}<div class="form-actions">${button('编辑', 'edit', `data-id="${esc(p.id)}"`)}${button('复制项目', 'duplicate', `data-id="${esc(p.id)}"`)}${p.status === 'completed' ? button('准备发布', 'publish', `data-id="${esc(p.id)}"`) : ''}${button('删除', 'delete', `data-id="${esc(p.id)}"`)}</div></article>`).join('') : `<div class="card empty"><div class="empty-icon">▶</div><b>${getState().videos.length ? '没有找到匹配项目' : '先做第一条视频'}</b><div>${getState().videos.length ? '试试其他关键词或状态。' : '填写左侧信息，或使用“小猫跳舞模板”。'}</div>${query || filter !== 'all' ? button('清除筛选', 'clear-filters') : ''}</div>`}`;
  }

  function updateProjectList() { if ($('#video-project-list')) $('#video-project-list').innerHTML = projectList(); }

  function render() {
    const projects = getState().videos;
    let elapsed = 0;
    return `<div class="page-head"><div><p class="eyebrow">VIDEO STUDIO</p><h1>把一个想法，做成一条视频。</h1><p>整理分镜与制作说明，记录进度，成片后接着准备发布。</p></div><div class="page-actions">${button('＋ 空白项目', 'new')}${button('小猫跳舞模板', 'kitten')}</div></div>
      <div class="studio-summary"><span><b>${projects.length}</b> 个制作项目</span><span><b>${projects.filter(p => p.status === 'producing').length}</b> 制作中</span><span><b>${projects.filter(p => p.status === 'completed').length}</b> 已完成</span><p>制作单交给 Agent 或选用的工具执行，逐镜验收后合成。</p></div>
      <div class="studio-layout"><section class="card studio-editor"><div class="card-title"><h3>${editing.id ? '编辑制作项目' : '新建制作项目'}</h3><span id="video-edit-status" class="pill" role="status">${editorStatus()}</span></div>
      <p class="form-hint">未提交的编辑会暂存于当前标签页，刷新后可继续。保存项目：Ctrl / ⌘ + S。</p>
      ${staleMessage() ? `<div class="notice orange">${esc(staleMessage())}</div>` : ''}
      <form id="video-form"><div class="form-grid">
      <div class="full">${field('视频名称', 'title', editing.title, false, 'required maxlength="120" placeholder="例如：小猫捡到发夹后跳舞"')}</div>
      ${field('主角与外观', 'subject', editing.subject, true)}${field('场景', 'setting', editing.setting, true)}
      ${field('画面风格', 'style', editing.style)}${select('画幅', 'ratio', Object.fromEntries(videoRatios.map(x => [x, x])), editing.ratio)}
      </div><div class="divider"></div>
      <details data-video-references ${referencesOpen ? 'open' : ''}><summary><b>角色参考与视觉约束</b></summary>
      <p class="form-hint">先确定角色与场景，再制作各镜头。参考路径只作记录；实际生成时由 Agent 或所选工具读取可访问的素材。</p>
      <div class="form-grid">${field('角色参考图路径或链接', 'characterReference', editing.characterReference || '', false, 'maxlength="2000" placeholder="统一使用的角色参考图"')}${field('参考视频 URL', 'referenceVideo', editing.referenceVideo || '', false, 'maxlength="2000" placeholder="用于参考节奏、动作或构图的视频链接"')}
      <div class="full">${field('全片视觉约束', 'visualIdentity', editing.visualIdentity || '', true, 'placeholder="例如：固定毛色、脸型、体型和木地板场景；发夹戴上后持续保留；只出现猫爪"')}</div></div></details>
      <div class="section-row"><h2>分镜脚本与验收</h2><span class="pill" id="video-duration">${totalSeconds(editing)} 秒 · ${editing.shots.length} 个镜头</span></div>
      <div id="video-quality-summary" class="media-panel" role="status" aria-live="polite">${qualityMarkup()}</div>
      <div class="shot-list">${editing.shots.map((shot, index) => {
        const start = elapsed; elapsed += Number(shot.seconds) || 0;
        const stage = shotStage(shot);
        return `<section class="shot" data-shot="${index}"><div class="shot-heading"><b>镜头 ${String(index + 1).padStart(2, '0')} <small data-shot-time>${start}–${elapsed} 秒</small></b><span data-shot-stage class="pill ${stage.color}">${stage.label}</span><label>时长 <input type="number" data-shot-seconds min="1" max="120" step="1" required value="${esc(shot.seconds)}" aria-label="镜头 ${index + 1} 时长"> 秒</label></div>
        <div class="field"><label for="shot-action-${index}">画面与动作</label><textarea id="shot-action-${index}" data-shot-action required maxlength="5000" placeholder="每镜优先安排一个清晰动作">${esc(shot.action)}</textarea></div>
        <div class="field"><label for="shot-camera-${index}">镜头与构图</label><input id="shot-camera-${index}" data-shot-camera maxlength="1000" value="${esc(shot.camera)}"></div>
        <details data-shot-details ${openShotDetails.has(shot.id) ? 'open' : ''}><summary>参考、起止状态与验收</summary>
        <p class="form-hint">对照相邻镜头，记录角色、道具、场景与姿态。看过实际素材后再验收；设定或素材修改后，已通过的镜头会转回待验收。</p>
        <div class="form-grid"><div class="full">${shotField('本镜参考图路径或链接', 'referenceImage', shot, index, false, '该镜头的起始画面；未填写时参考全片角色图')}</div>
        ${shotField('起始状态', 'startState', shot, index, true, '例如：小猫站在木地板上，粉色发夹在右前爪旁')}${shotField('结束状态', 'endState', shot, index, true, '例如：同一只小猫低头看发夹，发夹位置不变')}
        <div class="full">${shotField('本镜素材路径或链接', 'asset', shot, index, false, '生成成功后填回实际素材路径')}</div>
        <div class="field"><label for="shot-reviewStatus-${index}">验收状态</label><select id="shot-reviewStatus-${index}" data-shot-field="reviewStatus">${options(videoReviewStatuses, shot.reviewStatus || 'pending')}</select></div>
        <div class="full">${shotField('验收问题 / 修改备注', 'reviewNotes', shot, index, true, '例如：第 2 秒发夹消失，退回重做；或记录已核对的动作与衔接')}</div></div></details>
        <div class="shot-actions">${button('↑ 上移', 'move-up', `data-index="${index}" ${index === 0 ? 'disabled' : ''}`)}${button('↓ 下移', 'move-down', `data-index="${index}" ${index === editing.shots.length - 1 ? 'disabled' : ''}`)}${button('复制分镜', 'copy-shot', `data-index="${index}" ${editing.shots.length >= 12 ? 'disabled' : ''}`)}${button('移除', 'remove-shot', `data-index="${index}" ${editing.shots.length === 1 ? 'disabled' : ''}`)}</div></section>`;
      }).join('')}</div>
      <div class="form-actions">${button('＋ 添加分镜', 'add-shot', editing.shots.length >= 12 ? 'disabled' : '')}<span class="form-hint">每个镜头 1–120 秒，最多 12 个。</span></div>
      <div class="divider"></div><div class="form-grid">
      ${select('制作状态', 'status', videoStatuses, editing.status)}${field('计划使用的工具', 'provider', editing.provider, false, 'placeholder="例如：WorkBuddy、Wan、剪辑软件"')}
      ${select('费用策略', 'budget', { free: '仅免费方案', confirm: '付费前确认' }, editing.budget)}${field('预计费用（元，未知留空）', 'cost', editing.cost, false, 'type="number" min="0" step="0.01" placeholder="待核实"')}
      <div class="full">${field('成片文件路径或链接', 'asset', editing.asset, false, `placeholder="上传后自动填写，也可手动记录" ${upload ? 'readonly' : ''}`)}<div id="video-media-panel" class="media-panel">${mediaMarkup()}</div></div>
      ${field('遇到的问题', 'blocker', editing.blocker, true, 'placeholder="例如：额度不足、缺少动作参考"')}${field('补充要求 / 音乐说明', 'notes', editing.notes, true)}
      </div><div class="form-actions studio-save-bar"><button class="button button-green" id="video-save" type="submit" ${upload ? 'disabled' : ''}>保存制作项目</button>${button('预览提示词', 'preview-prompt')}${button('复制提示词', 'copy')}${button('导出制作单', 'export')}${editing.id ? button('另存为新项目', 'save-as-new') : ''}</div>
      <p id="video-error" class="form-error" role="alert"></p></form></section>
      <aside class="studio-projects"><div class="section-row"><h2>我的制作项目</h2></div>
      <div class="project-filters"><div class="field"><label for="video-search">搜索项目</label><input id="video-search" type="search" value="${esc(query)}" placeholder="名称、角色、场景或制作工具"></div><div class="project-filter-row"><div class="field"><label for="video-filter">制作状态</label><select id="video-filter">${options({ all: '全部状态', ...videoStatuses }, filter)}</select></div><div class="field"><label for="video-sort">排列方式</label><select id="video-sort">${options({ updated: '最近更新', title: '名称顺序', duration: '时长从短到长' }, sort)}</select></div></div></div>
      <div id="video-project-list">${projectList()}</div>
      <div class="notice green"><span>↗</span><span><b>接着完成制作</b><br>把完整制作单交给 Agent 或选用的工具执行；生成后填回每镜素材、记录验收，再合成并上传成片。这里的参考路径与验收状态均为制作记录。价格和免费额度以工具实际显示为准。</span></div></aside></div>`;
  }

  function showPrompt(text, message = '核对角色参考、分镜起止状态与验收要求后，把制作单交给 Agent 或你选择的生成、剪辑工具执行。') {
    $('#video-prompt-dialog')?.remove();
    const dialog = document.createElement('dialog'); dialog.id = 'video-prompt-dialog'; dialog.className = 'recovery-dialog prompt-dialog';
    dialog.innerHTML = `<h2>制作提示词</h2><p>${esc(message)}</p><label class="sr-only" for="video-prompt-text">完整制作提示词</label><textarea id="video-prompt-text" readonly></textarea><div class="form-actions">${button('选中全部', 'select-prompt')}${button('导出 TXT', 'export')}${button('关闭', 'close-prompt')}</div>`;
    dialog.querySelector('textarea').value = text;
    dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
  }

  function saveProject(asNew = false) {
    if (upload) throw new Error('请等待成片上传完成，或先取消上传。');
    if (!asNew && staleMessage()) throw new Error(staleMessage());
    const now = new Date().toISOString();
    // Saving an edit as new preserves its content; duplicating a project starts a fresh production.
    const project = validateVideo({ ...editing, id: asNew ? crypto.randomUUID() : editing.id || crypto.randomUUID(), createdAt: asNew ? now : editing.createdAt || now, updatedAt: now });
    const videos = getState().videos;
    const index = videos.findIndex(p => p.id === project.id);
    if (index < 0) videos.push(project); else videos[index] = project;
    setEditor(project, false); save(); repaint(); notify('制作项目已记录，正在同步到本地服务');
  }

  async function handleClick(event) {
    const target = event.target.closest('[data-video]');
    if (!target) return false;
    capture();
    const action = target.dataset.video;
    const state = getState();
    const project = state.videos.find(p => p.id === target.dataset.id);
    try {
      if (['new', 'kitten', 'edit', 'duplicate'].includes(action)) {
        if (['edit', 'duplicate'].includes(action) && !project) throw new Error('项目已不存在，请刷新列表。');
        if (!canReplaceEditor()) return true;
        setEditor(action === 'edit' ? project : action === 'duplicate' ? copyVideo(project) : newVideo(action === 'kitten' ? 'kitten' : 'blank'), ['kitten', 'duplicate'].includes(action));
        repaint('#video-title');
        if (action === 'duplicate') notify('副本已载入编辑区，保存后创建新项目；制作状态、成片、逐镜素材与验收、费用已重置');
      } else if (action === 'add-shot') {
        if (editing.shots.length < 12) { editing.shots.push(newShot()); markChanged(true); repaint(`#shot-action-${editing.shots.length - 1}`); }
      } else if (['remove-shot', 'move-up', 'move-down', 'copy-shot'].includes(action)) {
        const index = Number(target.dataset.index);
        if (!Number.isInteger(index) || !editing.shots[index]) return true;
        let next = index;
        if (action === 'remove-shot' && editing.shots.length > 1) { editing.shots.splice(index, 1); next = Math.min(index, editing.shots.length - 1); }
        if (action === 'copy-shot' && editing.shots.length < 12) {
          editing.shots.splice(index + 1, 0, newShot({ ...structuredClone(editing.shots[index]), id: undefined, asset: '', reviewStatus: 'pending', reviewNotes: '' }));
          next = index + 1;
          notify('分镜设定已复制；副本需重新制作并验收，素材和验收记录已重置');
        }
        if (action.startsWith('move-')) { next = index + (action === 'move-up' ? -1 : 1); if (next < 0 || next >= editing.shots.length) return true; [editing.shots[index], editing.shots[next]] = [editing.shots[next], editing.shots[index]]; }
        markChanged(true); repaint(`#shot-action-${next}`);
      } else if (action === 'choose-media') $('#video-media-file')?.click();
      else if (action === 'cancel-upload') { cancelUpload(); notify('已取消上传，原成片路径保留'); }
      else if (action === 'preview-prompt') showPrompt(videoPrompt(editing));
      else if (action === 'close-prompt') $('#video-prompt-dialog')?.close();
      else if (action === 'select-prompt') { $('#video-prompt-text')?.focus(); $('#video-prompt-text')?.select(); }
      else if (action === 'copy') {
        const text = videoPrompt(editing);
        try { await navigator.clipboard.writeText(text); notify('制作提示词已复制'); }
        catch { showPrompt(text, '浏览器未开放剪贴板权限，请选中全部后按 Ctrl / ⌘ + C 复制。'); }
      } else if (action === 'export') { download(videoPrompt(editing), 'txt', 'text/plain;charset=utf-8'); notify('制作单已导出'); }
      else if (action === 'save-as-new') saveProject(true);
      else if (action === 'clear-filters') { query = ''; filter = 'all'; $('#video-search').value = ''; $('#video-filter').value = 'all'; updateProjectList(); }
      else if (action === 'delete' && project && confirm(`将“${project.title}”移入回收站？当前项目未保存的编辑会放弃，已有发布草稿和素材文件会保留。`)) {
        moveToTrash(state, 'videos', project.id);
        if (editing.id === project.id) { cancelUpload(); setEditor(newVideo(), false); }
        save(); repaint(); notify('项目已移入回收站，可在数据管理中恢复');
      } else if (action === 'publish' && project) {
        const valid = validateVideo(project);
        if (valid.status !== 'completed') throw new Error('请先完成制作并填写成片路径。');
        if (!canReplaceEditor()) return true;
        let draft = state.drafts.find(d => d.sourceVideoId === project.id);
        if (!draft) {
          draft = { id: crypto.randomUUID(), sourceVideoId: project.id, sourceProductId: project.sourceProductId || '', platform: 'douyin', pubTitle: project.title, format: '视频', asset: project.asset, caption: '', hashtags: '', cover: '', status: '待人工准备', date: new Date().toLocaleDateString('zh-CN') };
          state.drafts.push(draft);
          state.records.push({ id: crypto.randomUUID(), type: '发布准备', category: '动作', title: project.title, summary: `来自视频制作台。成片：${project.asset}`, date: new Date().toLocaleDateString('zh-CN') }); save();
        }
        setEditor(project, false); openDraft(draft.id); notify('发布草稿已就绪，请继续检查封面、文案和素材');
      }
    } catch (error) { if ($('#video-error')) $('#video-error').textContent = error.message; notify(error.message); }
    return true;
  }

  function handleSubmit(event) {
    if (event.target.id !== 'video-form') return false;
    event.preventDefault(); capture();
    try { saveProject(); } catch (error) { $('#video-error').textContent = error.message; }
    return true;
  }

  document.addEventListener('input', event => {
    if (event.target.id === 'video-search') { if (!event.isComposing) { query = event.target.value; updateProjectList(); } return; }
    if (!event.target.closest('#video-form') || event.target.type === 'file') return;
    capture(); markChanged();
  });
  document.addEventListener('compositionend', event => { if (event.target.id === 'video-search') { query = event.target.value; updateProjectList(); } });
  document.addEventListener('change', event => {
    if (event.target.id === 'video-filter') { filter = event.target.value; updateProjectList(); }
    if (event.target.id === 'video-sort') { sort = event.target.value; updateProjectList(); }
    if (event.target.closest('#video-form') && event.target.type !== 'file') { capture(); markChanged(true); }
    if (event.target.id === 'video-asset') updateMediaPanel();
    if (event.target.id === 'video-media-file') { uploadFile(event.target.files?.[0]); event.target.value = ''; }
  });
  document.addEventListener('error', event => { if (event.target.id === 'video-media-preview' && $('#video-media-error')) $('#video-media-error').hidden = false; }, true);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && $('#video-form') && !document.querySelector('dialog[open]')) { event.preventDefault(); if (upload) notify('请等待上传完成再保存'); else $('#video-form').requestSubmit(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistEditor(); });
  window.addEventListener('pagehide', persistEditor);
  window.addEventListener('beforeunload', event => { persistEditor(); if (changed || upload) { event.preventDefault(); event.returnValue = ''; } });
  return {
    render, handleClick, handleSubmit,
    open(id) {
      const project = getState().videos.find(item => item.id === id);
      if (!project) { notify('视频项目不存在'); return false; }
      if (!canReplaceEditor()) return false;
      setEditor(project, false); go('video'); return true;
    },
    reset({ preserveEditor = false } = {}) { if (preserveEditor) return; cancelUpload(); setEditor(newVideo(), false); },
    fromIdea(idea) {
      if (!canReplaceEditor()) return;
      setEditor({ ...newVideo(), title: idea.title, notes: idea.bgm || '', shots: [
        newShot({ seconds: 3, action: idea.hook || '开场展示主题', camera: '近景' }),
        newShot({ seconds: 9, action: idea.script || '展开主题', camera: '中景' }),
        newShot({ seconds: 3, action: idea.cta || '收尾定格', camera: '中景' })
      ] }, true); go('video');
    }
  };
}
