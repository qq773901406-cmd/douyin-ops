import { esc, dialog, dateTime, csv } from './workspace-ui.js';
import { collectionLabels, recordTitle, validateMetric } from './workbuddy/connector/lib/workspace-actions.mjs';

const specs = {
  records: [['title', '标题'], ['category', '分类'], ['summary', '内容', 'textarea']],
  ideas: [['title', '选题名称'], ['angle', '角度'], ['hook', '开场钩子', 'textarea'], ['script', '脚本', 'textarea'], ['cta', '结尾互动'], ['duration', '建议时长'], ['bgm', '音乐方向']],
  research: [['title', '主题'], ['creator', '作者'], ['url', '来源链接', 'url'], ['hook', '开场钩子', 'textarea'], ['structure', '内容结构', 'textarea'], ['takeaway', '可借鉴点', 'textarea']],
  comments: [['comment', '原评论', 'textarea'], ['context', '对应内容'], ['replyType', '回复类型'], ['reply', '回复草稿', 'textarea']],
  metrics: [['mTitle', '视频标题'], ['plays', '播放量', 'number'], ['likes', '点赞', 'number'], ['mComments', '评论', 'number'], ['shares', '分享', 'number'], ['completion', '完播率（%）', 'number'], ['reflection', '复盘结论', 'textarea']]
};

export function createContentLibrary({ getState, save, render, notify, openVideo, openDraft, remove }) {
  let collection = 'records', query = '', category = '', page = 1;
  const perPage = 12;
  function matches(item, term) { return JSON.stringify(item).normalize('NFKC').toLocaleLowerCase().includes(term.normalize('NFKC').toLocaleLowerCase().trim()); }
  function rows() { return [...getState()[collection]].reverse().filter(item => matches(item, query) && (!category || item.category === category)); }
  function results() {
    const found = rows(); const pages = Math.max(1, Math.ceil(found.length / perPage)); page = Math.min(page, pages);
    return `<div class="list-meta"><span>${found.length} 条结果</span><span>第 ${page} / ${pages} 页</span></div><div class="library-list">${found.slice((page - 1) * perPage, page * perPage).map(item => `<article class="library-row"><div><span class="pill">${esc(item.category || collectionLabels[collection])}</span><h3>${esc(recordTitle(item))}</h3><p>${esc(item.summary || item.script || item.takeaway || item.reply || item.reflection || '')}</p><small>${esc(item.date || dateTime(item.updatedAt))}</small></div><div class="row-actions"><button class="button button-light" data-library-edit="${esc(item.id)}">查看 / 编辑</button><button class="text-link" data-library-delete="${esc(item.id)}">移入回收站</button></div></article>`).join('') || '<div class="empty"><b>没有找到内容</b><p>试试其他关键词，或创建一条新记录。</p></div>'}</div><div class="pagination"><button class="button button-light" data-library-page="-1" ${page <= 1 ? 'disabled' : ''}>上一页</button><button class="button button-light" data-library-page="1" ${page >= pages ? 'disabled' : ''}>下一页</button></div>`;
  }
  function updateResults() { const el = document.querySelector('#library-results'); if (el) el.innerHTML = results(); }
  function view() {
    return `<div class="page-head"><div><p class="eyebrow">CONTENT LIBRARY</p><h1>内容库</h1><p>集中检索和编辑选题、观察、知识、回复与复盘。</p></div><div class="page-actions"><button class="button button-light" data-library-export>导出当前结果 CSV</button><button class="button button-green" data-library-new>新建${collectionLabels[collection]}</button></div></div>
      <div class="library-toolbar"><div class="field"><label for="library-type">内容类型</label><select id="library-type">${Object.keys(specs).map(key => `<option value="${key}" ${key === collection ? 'selected' : ''}>${collectionLabels[key]}</option>`).join('')}</select></div><div class="field grow"><label for="library-query">搜索内容</label><input type="search" id="library-query" value="${esc(query)}" placeholder="输入标题、正文或关键词"></div>${collection === 'records' ? `<div class="field"><label for="library-category">分类</label><select id="library-category"><option value="">全部分类</option>${[...new Set(getState().records.map(r => r.category).filter(Boolean))].map(c => `<option ${category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>` : ''}</div><section id="library-results">${results()}</section>`;
  }
  function edit(key, id) {
    if (key === 'videos') { openVideo(id); return; }
    if (key === 'drafts') { openDraft(id); return; }
    if (!specs[key]) return;
    const original = id ? getState()[key].find(item => item.id === id) : null;
    if (id && !original) { notify('记录已不存在'); return; }
    const baseline = JSON.stringify(original);
    const fields = specs[key]; const item = original || {};
    const el = dialog(`${id ? '编辑' : '新建'}${collectionLabels[key]}`, `<form id="library-editor"><div class="form-grid">${fields.map(([name, label, type = 'text'], i) => `<div class="field ${type === 'textarea' ? 'full' : ''}"><label for="lib-${name}">${label}</label>${type === 'textarea' ? `<textarea id="lib-${name}" name="${name}" maxlength="30000" ${i === 0 ? 'required' : ''}>${esc(item[name] || '')}</textarea>` : `<input id="lib-${name}" name="${name}" type="${type}" value="${esc(item[name] ?? (name === 'mTitle' ? item.title : name === 'creator' ? item.author : '') ?? '')}" ${i === 0 ? 'required' : ''} ${type === 'number' ? `min="0" ${name === 'completion' ? 'max="100" step="0.01"' : 'step="1"'}` : 'maxlength="5000"'}>`}</div>`).join('')}</div><p class="form-error" role="alert"></p><div class="form-actions"><button class="button button-green" type="submit">保存记录</button><span class="form-hint">保存后同步到本地工作区。</span></div></form>`, { wide: true, guard: true });
    el.querySelector('form').onsubmit = event => {
      event.preventDefault(); event.stopPropagation();
      try {
        const current = id ? getState()[key].find(record => record.id === id) : null;
        if (id && JSON.stringify(current) !== baseline) throw new Error('记录已变化，请关闭后重新打开，避免覆盖较新的内容。');
        const data = Object.fromEntries(new FormData(event.target));
        if (!String(data[fields[0][0]] || '').trim()) throw new Error('请填写第一项内容。');
        if (key === 'metrics') validateMetric(data);
        if (current) Object.assign(current, data, { updatedAt: new Date().toISOString() });
        else getState()[key].push({ ...data, id: crypto.randomUUID(), date: new Date().toLocaleDateString('zh-CN'), createdAt: new Date().toISOString(), ...(key === 'records' ? { type: '手动记录' } : {}) });
        save(); el.close(); render(); notify('内容已更新，正在同步');
      } catch (error) { el.querySelector('.form-error').textContent = error.message; }
    };
  }
  function search() {
    const el = dialog('搜索工作区', '<div class="field"><label for="global-query">标题、正文、角色或制作工具</label><input id="global-query" type="search" placeholder="输入关键词开始查找" autocomplete="off"></div><div id="global-results" class="search-results"></div>', { wide: true });
    const input = el.querySelector('input');
    const update = () => {
      const term = input.value.trim(); const all = [];
      if (term) for (const key of Object.keys(collectionLabels)) for (const item of getState()[key]) if (matches(item, term)) all.push({ key, item });
      el.querySelector('#global-results').innerHTML = term ? `<p class="form-hint">共 ${all.length} 条匹配，最多显示 60 条。</p>${all.slice(0, 60).map(({ key, item }, index) => `<button class="search-result" data-result="${index}"><span class="pill">${collectionLabels[key]}</span><span>${esc(recordTitle(item))}</span><span>→</span></button>`).join('') || '<div class="empty">没有匹配内容</div>'}` : '<div class="empty">搜索覆盖选题、视频、发布草稿和运营记录。</div>';
      for (const button of el.querySelectorAll('[data-result]')) button.onclick = () => { const found = all[Number(button.dataset.result)]; el.close(); edit(found.key, found.item.id); };
    };
    input.oninput = event => { if (!event.isComposing) update(); }; input.oncompositionend = update; update(); input.focus();
  }
  document.addEventListener('click', event => {
    const target = event.target;
    if (target.closest('[data-open-search]')) search();
    const editor = target.closest('[data-library-edit]'); if (editor) edit(collection, editor.dataset.libraryEdit);
    if (target.closest('[data-library-new]')) edit(collection);
    const del = target.closest('[data-library-delete]'); if (del) remove(collection, del.dataset.libraryDelete);
    const paging = target.closest('[data-library-page]'); if (paging) { page += Number(paging.dataset.libraryPage); updateResults(); }
    if (target.closest('[data-library-export]')) csv([['类型', '标题', '日期', '内容'], ...rows().map(item => [collectionLabels[collection], recordTitle(item), item.date, item.summary || item.script || item.reply || item.reflection || item.takeaway || ''])], `doufeng-${collection}.csv`);
  });
  document.addEventListener('input', event => { if (event.target.id === 'library-query' && !event.isComposing) { query = event.target.value; page = 1; updateResults(); } });
  document.addEventListener('compositionend', event => { if (event.target.id === 'library-query') { query = event.target.value; page = 1; updateResults(); } });
  document.addEventListener('change', event => {
    if (event.target.id === 'library-type') { collection = event.target.value; category = ''; page = 1; render(); }
    if (event.target.id === 'library-category') { category = event.target.value; page = 1; updateResults(); }
  });
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) { event.preventDefault(); search(); } });
  return { render: view, edit, search };
}
