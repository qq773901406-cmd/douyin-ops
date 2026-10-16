import { esc, localDay, dialog, csv, download } from './workspace-ui.js';
import { newProduct, validateProduct, productProfit, productStatuses, shopPlatforms, reportNames, productBrief, findProductImageDraft } from './workbuddy/connector/lib/shop-products.mjs';
import { importShopFolder, uploadShopImage } from './shop-import.js';
import { productCard, coverCard, canvasBlob } from './shop-cards.js';

const editorKey = 'doufeng.shop-editor.v1';
const imageUrl = path => `/api/media?path=${encodeURIComponent(path)}`;
const filename = title => String(title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 50);
const money = (value, currency) => value === '' || value == null ? '待补充' : `${currency} ${Number(value).toFixed(2)}`;

export function createShopWorkspace({ getState, save, render, notify, go, openDraft, openVideo, remove }) {
  let query = '', status = '', sourceDate = '', sort = 'recent', currentPage = 1;
  const readCache = () => {
    try {
      const cache = JSON.parse(sessionStorage.getItem(editorKey) || 'null');
      if (!cache || typeof cache.values !== 'object' || !cache.values || Array.isArray(cache.values) || (cache.id !== null && typeof cache.id !== 'string') || typeof cache.baseline !== 'string') return null;
      // Empty titles are valid in unfinished editors; validate the remaining shape.
      const values = validateProduct({ ...cache.values, title: cache.values.title || '未命名商品', sourceDate: '', supplierUrl: '', ...Object.fromEntries(['price', 'cost', 'shipping', 'feeRate', 'packaging', 'adCost', 'returnRate'].map(key => [key, ''])) });
      return { ...cache, values: { ...values, ...cache.values } };
    } catch { return null; }
  };
  const clearCache = () => { try { sessionStorage.removeItem(editorKey); } catch {} };
  function rows() {
    const items = getState().products.filter(p => (!status || p.status === status) && (!sourceDate || p.sourceDate === sourceDate) && `${p.title} ${p.category} ${p.supplier} ${p.notes}`.toLowerCase().includes(query.trim().toLowerCase()));
    return [...items].sort((a, b) => sort === 'margin' ? (productProfit(b)?.margin ?? -Infinity) - (productProfit(a)?.margin ?? -Infinity) : String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  function results() {
    const found = rows(), pages = Math.max(1, Math.ceil(found.length / 12)); currentPage = Math.min(pages, currentPage);
    return `<div class="list-meta"><span>${found.length} 款商品</span><span>第 ${currentPage} / ${pages} 页</span></div><div class="shop-products">${found.slice((currentPage - 1) * 12, currentPage * 12).map(p => {
      const profit = productProfit(p);
      return `<article class="card shop-product"><div class="shop-product-top">${p.images[0] ? `<img class="shop-thumbnail" src="${esc(imageUrl(p.images[0].path))}" alt="${esc(p.title)}" loading="lazy">` : '<div class="shop-thumbnail placeholder">▧</div>'}<div><div class="chip-list"><span class="pill">${productStatuses[p.status]}</span><span class="pill">${esc(p.sourceDate || p.category || '手动录入')}</span></div><h3>${esc(p.title)}</h3><p>${esc(p.supplier || '货源待确认')}</p></div></div><div class="shop-price-strip"><span>录入售价<b>${money(p.price, p.currency)}</b></span><span>估算利润率<b class="${profit && profit.profit < 0 ? 'danger-text' : ''}">${profit ? `${profit.margin.toFixed(1)}%` : '费用待补全'}</b></span></div><p class="shop-product-note">${esc(p.hook || p.audience || '补充受众和内容切入，让商品研究进入创作流程。')}</p><div class="row-actions"><button class="button button-light" data-shop="edit" data-id="${esc(p.id)}">资料 / 成本</button><button class="button button-light" data-shop="card" data-id="${esc(p.id)}">商品卡片</button><button class="button button-green" data-shop="drafts" data-id="${esc(p.id)}">准备发布</button></div><div class="shop-secondary"><button class="text-link" data-shop="video" data-id="${esc(p.id)}">转为视频项目</button><button class="text-link" data-shop="brief" data-id="${esc(p.id)}">研究任务单</button><button class="text-link" data-shop="delete" data-id="${esc(p.id)}">移入回收站</button></div></article>`;
    }).join('') || '<div class="card empty shop-empty"><b>把选品研究接进创作流程</b><p>导入原项目的 output 日报目录，或先手动录入一款商品。</p><button class="button button-green" data-shop="new">录入第一款商品</button></div>'}</div><div class="pagination"><button class="button button-light" data-shop="previous" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button><button class="button button-light" data-shop="next" ${currentPage >= pages ? 'disabled' : ''}>下一页</button></div>`;
  }
  function updateResults() { const target = document.querySelector('#shop-results'); if (target) target.innerHTML = results(); }
  function view() {
    const products = getState().products, complete = products.filter(p => productProfit(p));
    return `<div class="page-head"><div><p class="eyebrow">SHOP × CONTENT</p><h1>电商选品</h1><p>把选品日报、成本、商品素材和发布内容放在同一个工作区。</p></div><div class="page-actions"><label class="button button-light shop-import-button">导入日报目录<input id="shop-folder" type="file" webkitdirectory multiple hidden></label><button class="button button-green" data-shop="new">＋ 录入商品</button></div></div>
      <div class="shop-overview"><div><small>商品资料</small><strong>${products.length}</strong></div><div><small>准备推广</small><strong>${products.filter(p => p.status === 'ready').length}</strong></div><div><small>已补全费用</small><strong>${complete.length}</strong></div><div><small>关联发布草稿</small><strong>${getState().drafts.filter(d => d.sourceProductId || d.sourceProductIds?.length).length}</strong></div></div>
      ${readCache() ? '<div class="notice orange shop-resume">有未保存的商品编辑。<button class="text-link" data-shop="resume">继续编辑 →</button></div>' : ''}
      <div class="shop-guide"><div><b>原项目日报 → 商品资料 → 卡片 / 视频 → 多平台草稿</b><p>兼容 output / 日期 / 商品名 下的 5 份 Markdown 报告与 06_素材/images 图片目录。</p></div><button class="text-link" data-shop="help">整合说明</button></div>
      <div class="library-toolbar"><div class="field grow"><label for="shop-query">搜索商品</label><input id="shop-query" type="search" value="${esc(query)}" placeholder="商品名称、分类、供应商"></div><div class="field"><label for="shop-status">选品状态</label><select id="shop-status"><option value="">全部状态</option>${Object.entries(productStatuses).map(([key, label]) => `<option value="${key}" ${status === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="field"><label for="shop-date">报告日期</label><input type="date" id="shop-date" value="${esc(sourceDate)}"></div><div class="field"><label for="shop-sort">排序</label><select id="shop-sort"><option value="recent" ${sort === 'recent' ? 'selected' : ''}>最近更新</option><option value="margin" ${sort === 'margin' ? 'selected' : ''}>估算利润率</option></select></div></div>
      <div class="row-actions"><button class="button button-light" data-shop="cover" ${products.length ? '' : 'disabled'}>生成当前结果汇总图</button><button class="button button-light" data-shop="csv">导出当前结果 CSV</button><button class="button button-light" data-shop="research">准备选品研究任务</button></div><div id="shop-results">${results()}</div>`;
  }
  function edit(id, resume = false) {
    const cache = resume ? readCache() : null;
    if (!resume && readCache() && !confirm('已有未保存的商品编辑，放弃它并打开当前商品？')) return;
    const original = id ? getState().products.find(p => p.id === id) : null;
    if (id && !original && !cache) { notify('商品已不存在'); return; }
    let values = structuredClone(cache?.values || original || newProduct());
    const baseline = cache?.baseline ?? JSON.stringify(original), selected = cache?.id || id || null;
    let busy = false, saved = false;
    const input = (label, key, type = 'text', full = false) => `<div class="field ${full ? 'full' : ''}"><label for="product-${key}">${label}</label>${type === 'textarea' ? `<textarea id="product-${key}" name="${key}" maxlength="12000">${esc(values[key])}</textarea>` : `<input id="product-${key}" name="${key}" type="${type}" value="${esc(values[key])}" ${key === 'title' ? 'required maxlength="160"' : 'maxlength="5000"'} ${type === 'number' ? `min="0" step="0.01" ${['feeRate', 'returnRate'].includes(key) ? 'max="100"' : ''}` : ''}>`}</div>`;
    const el = dialog(selected ? '编辑商品资料' : '录入商品', `<form id="shop-editor"><div class="form-grid">${input('商品名称', 'title', 'text', true)}${input('分类', 'category')}<div class="field"><label for="product-status">状态</label><select name="status" id="product-status">${Object.entries(productStatuses).map(([key, label]) => `<option value="${key}" ${values.status === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>${input('报告日期', 'sourceDate', 'date')}${input('货源 / 供应商', 'supplier')}${input('货源链接', 'supplierUrl', 'url', true)}${input('目标受众', 'audience', 'text', true)}${input('内容切入 / 开场钩子', 'hook', 'textarea', true)}</div><h3 class="shop-form-heading">单件成本与估算</h3><p class="form-hint">所有金额使用同一币种。售价、采购成本、运费、平台费率必需补全才计算；包装、广告和退货预留留空按 0 计。税费和其他支出请计入相应成本。</p><div class="form-grid"><div class="field"><label for="product-currency">币种</label><select id="product-currency" name="currency">${['USD', 'CNY', 'EUR', 'GBP', 'JPY'].map(c => `<option ${values.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>${input('销售价格', 'price', 'number')}${input('采购成本', 'cost', 'number')}${input('每单运费', 'shipping', 'number')}${input('平台费率（%）', 'feeRate', 'number')}${input('包装及其他固定成本', 'packaging', 'number')}${input('每单广告成本', 'adCost', 'number')}${input('退货损耗预留（售价 %）', 'returnRate', 'number')}</div><div id="shop-profit" class="shop-profit"></div>${values.reportedMargin ? `<p class="form-hint">原报告毛利率：${esc(values.reportedMargin)}（原报告值，未核实，不参与上方计算）</p>` : ''}<h3 class="shop-form-heading">内容与素材</h3><div class="form-grid">${input('中文发布文案', 'captionZh', 'textarea', true)}${input('English caption', 'captionEn', 'textarea', true)}${input('备注 / 研究结论', 'notes', 'textarea', true)}</div><div id="shop-editor-media" class="shop-editor-media"></div><label class="button button-light">添加商品图片<input id="shop-image" type="file" accept="image/png,image/jpeg,image/webp" hidden></label><p class="form-hint">单张不超过 20MB；移除引用不会删除本机素材文件。</p>${Object.keys(values.documents).length ? `<h3 class="shop-form-heading">原始日报</h3>${Object.entries(values.documents).map(([key, text]) => `<details class="shop-report"><summary>${esc(reportNames[key])}</summary><pre>${esc(text)}</pre></details>`).join('')}` : ''}<p class="form-error" role="alert"></p><div class="form-actions"><button class="button button-green" type="submit">保存商品资料</button><span class="form-hint">编辑暂存在当前标签页，保存后同步到本机。</span></div></form>`, { wide: true, guard: true });
    const form = el.querySelector('form');
    const copyButton = document.createElement('button'); copyButton.type = 'submit'; copyButton.value = 'copy'; copyButton.className = 'button button-light'; copyButton.textContent = '另存为新商品'; copyButton.hidden = true; form.querySelector('.form-actions').append(copyButton);
    if (cache) el.dispatchEvent(new Event('editor-change'));
    function capture() {
      Object.assign(values, Object.fromEntries(new FormData(form)));
      el.dispatchEvent(new Event('editor-change'));
      try { sessionStorage.setItem(editorKey, JSON.stringify({ id: selected, values, baseline })); } catch { el.querySelector('.form-error').textContent = '编辑暂存失败，请及时保存商品。'; }
    }
    function profitView() {
      const p = { ...values, ...Object.fromEntries(new FormData(form)) }, result = productProfit(p);
      el.querySelector('#shop-profit').innerHTML = result ? `<span>估算总成本<b>${money(result.totalCost, p.currency)}</b></span><span>每单估算利润<b>${money(result.profit, p.currency)}</b></span><span>估算利润率<b>${result.margin.toFixed(1)}%</b></span>` : '<p>请补全售价、采购成本、运费和平台费率，并检查金额非负、比例在 0–100 之间。</p>';
    }
    function mediaView() {
      el.querySelector('#shop-editor-media').innerHTML = ['images', 'cards'].flatMap(key => values[key].map((item, index) => `<div><img src="${esc(imageUrl(item.path))}" alt="${esc(item.name)}"><small>${key === 'cards' ? '生成卡片' : '商品图'}</small><button type="button" class="text-link" data-product-remove="${key}:${index}">移除</button></div>`)).join('');
    }
    form.addEventListener('input', () => { capture(); profitView(); }); form.addEventListener('change', () => { capture(); profitView(); });
    el.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    el.addEventListener('close', () => { if (!saved) clearCache(); if (document.querySelector('#shop-results')) render(); });
    el.addEventListener('click', event => { const target = event.target.closest('[data-product-remove]'); if (!target || busy) return; const [key, index] = target.dataset.productRemove.split(':'); values[key].splice(Number(index), 1); capture(); mediaView(); });
    el.querySelector('#shop-image').onchange = async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file || busy) return;
      if (values.images.length >= 20) { el.querySelector('.form-error').textContent = '每款最多 20 张商品图，请先移除一张。'; return; }
      busy = true; const close = el.querySelector('[data-dialog-close]'); close.disabled = true; form.querySelector('[type=submit]').disabled = true;
      try { values.images.push(await uploadShopImage(file)); capture(); mediaView(); }
      catch (error) { el.querySelector('.form-error').textContent = error.message; }
      finally { busy = false; close.disabled = false; form.querySelector('[type=submit]').disabled = false; }
    };
    form.onsubmit = event => {
      event.preventDefault(); event.stopPropagation(); if (busy) return;
      try {
        capture(); const asCopy = event.submitter?.value === 'copy', current = selected && !asCopy ? getState().products.find(p => p.id === selected) : null;
        if (!asCopy && selected && JSON.stringify(current) !== baseline) { copyButton.hidden = false; throw new Error('商品已更新或删除。可另存为新商品保留本次编辑，或关闭后重新打开最新资料。'); }
        const now = new Date().toISOString(); const product = validateProduct({ ...values, id: asCopy ? crypto.randomUUID() : selected || crypto.randomUUID(), ...(asCopy ? { sourceKey: '' } : {}), createdAt: current?.createdAt || now, updatedAt: now, date: current?.date || localDay() });
        if (current) getState().products[getState().products.indexOf(current)] = product; else getState().products.push(product);
        saved = true; clearCache(); save(); el.close(); render(); notify('商品资料已保存，正在同步');
      } catch (error) { el.querySelector('.form-error').textContent = error.message; }
    };
    profitView(); mediaView();
  }
  function drafts(product) {
    const el = dialog('准备多平台发布草稿', `<h3>${esc(product.title)}</h3><p class="muted">为选中的平台创建独立草稿；已有未发布草稿会直接复用。可在发布计划继续检查和排期。</p><div class="shop-platforms">${Object.entries(shopPlatforms).map(([key, label]) => `<label class="check-row"><input type="checkbox" name="platform" value="${key}" ${key === 'douyin' ? 'checked' : ''}>${label}<small>${['instagram', 'facebook', 'youtube'].includes(key) ? '英文文案' : '中文文案'}</small></label>`).join('')}</div><p class="form-hint">商品卡片优先作为素材，其次使用商品图片。英文文案为空时会留出待补充提示。</p><p class="form-error" role="alert"></p><div class="form-actions"><button class="button button-green" data-create-shop-drafts>创建 / 打开草稿</button><button class="button button-light" data-export-shop-task>导出文案与素材清单</button></div>`, { wide: true });
    const selected = () => [...el.querySelectorAll('[name=platform]:checked')].map(input => input.value);
    const images = product.cards.length ? product.cards : product.images;
    const caption = platform => ['instagram', 'facebook', 'youtube'].includes(platform) ? product.captionEn || '[Add verified English product details before publishing.]' : product.captionZh || `${product.title}\n${product.hook || '请补充经过核实的商品卖点和适用场景。'}`;
    el.querySelector('[data-export-shop-task]').onclick = () => {
      if (!selected().length) { el.querySelector('.form-error').textContent = '请至少选择一个平台。'; return; }
      download({ source: 'doufeng-shop', product: product.title, tasks: selected().map(platform => ({ platform, title: product.title, desc: caption(platform), images: images.map(item => item.path), status: 'awaiting-review' })) }, `shop-publish-${filename(product.title)}.json`);
    };
    el.querySelector('[data-create-shop-drafts]').onclick = () => {
      const platforms = selected(); if (!platforms.length) { el.querySelector('.form-error').textContent = '请至少选择一个平台。'; return; }
      if (!getState().products.some(p => p.id === product.id)) { el.querySelector('.form-error').textContent = '商品已不存在，请重新打开。'; return; }
      const ids = []; let added = 0;
      for (const platform of platforms) {
        let draft = findProductImageDraft(getState().drafts, product.id, platform);
        if (!draft) { draft = { id: crypto.randomUUID(), sourceProductId: product.id, platform, pubTitle: product.title, format: '图文', status: '待人工准备', asset: images[0]?.path || '', images: images.map(item => item.path), cover: images[0]?.name || '', caption: caption(platform), hashtags: '', scheduledAt: '', ck1: false, ck2: false, ck3: false, date: localDay(), updatedAt: new Date().toISOString() }; getState().drafts.push(draft); added++; }
        ids.push(draft.id);
      }
      if (added) save(); el.close(); if (ids.length === 1) openDraft(ids[0]); else go('publish'); notify(`已创建 ${added} 条草稿，复用 ${ids.length - added} 条已有草稿`);
    };
  }
  async function card(product = null) {
    const items = rows(); if (!product && !items.length) { notify('当前没有可生成汇总图的商品'); return; }
    const el = dialog(product ? '商品卡片预览' : '选品汇总图', '<p role="status">正在生成本地 PNG…</p>', { wide: true });
    let canvas;
    try { canvas = product ? await productCard(product, localDay()) : coverCard(items, localDay()); }
    catch (error) { if (el.isConnected) { el.querySelector('p').textContent = `生成失败：${error.message}。请关闭后重试。`; el.querySelector('p').setAttribute('role', 'alert'); } return; }
    if (!el.isConnected) return;
    el.querySelector('p').remove(); canvas.className = 'shop-card-preview'; el.append(canvas);
    const actions = document.createElement('div'); actions.className = 'form-actions'; actions.innerHTML = `<button class="button button-light" data-card-download>下载 PNG</button><button class="button button-green" data-card-save>${product ? '保存到商品素材' : '保存为汇总发布草稿'}</button><p class="form-error" role="alert"></p>`; el.append(actions);
    let busy = false; el.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    actions.querySelector('[data-card-download]').onclick = async () => {
      try { const url = URL.createObjectURL(await canvasBlob(canvas)); const a = document.createElement('a'); a.href = url; a.download = `shop-${filename(product?.title || localDay() + '-汇总')}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (error) { actions.querySelector('.form-error').textContent = error.message; }
    };
    actions.querySelector('[data-card-save]').onclick = async event => {
      if (busy) return; busy = true; event.currentTarget.disabled = true; el.querySelector('[data-dialog-close]').disabled = true;
      try {
        const current = product ? getState().products.find(p => p.id === product.id) : null;
        if (product && !current) throw new Error('商品已不存在。');
        if (current?.cards.length >= 20) throw new Error('商品卡片已满 20 张，请先在商品编辑中移除旧卡片。');
        const file = await uploadShopImage(await canvasBlob(canvas), `shop-${filename(product?.title || localDay() + '-汇总')}.png`);
        if (current) { current.cards.push(file); current.updatedAt = new Date().toISOString(); save(); el.close(); render(); notify('卡片已保存到商品素材，可用于发布草稿'); }
        else { const id = crypto.randomUUID(); getState().drafts.push({ id, sourceProductIds: items.slice(0, 8).map(p => p.id), platform: 'douyin', pubTitle: `${localDay()} 选品研究汇总`, format: '图文', status: '待人工准备', asset: file.path, images: [file.path], caption: items.slice(0, 8).map(p => p.title).join('\n'), date: localDay(), updatedAt: new Date().toISOString() }); save(); el.close(); openDraft(id); notify('汇总卡片已进入发布草稿'); }
      } catch (error) { actions.querySelector('.form-error').textContent = error.message; }
      finally { busy = false; if (el.isConnected) { actions.querySelector('[data-card-save]').disabled = false; el.querySelector('[data-dialog-close]').disabled = false; } }
    };
  }
  function toVideo(product) {
    const existing = getState().videos.find(p => p.sourceProductId === product.id && p.status !== 'completed'); if (existing) { openVideo(existing.id); return; }
    const now = new Date().toISOString(), id = crypto.randomUUID();
    getState().videos.push({ id, sourceProductId: product.id, title: `${product.title} · 商品视频`, subject: product.title, setting: '根据真实使用场景补充', style: '清楚展示商品特点与使用过程', ratio: '9:16', budget: 'free', provider: '', cost: '', status: 'planned', asset: '', blocker: '', notes: `货源：${product.supplier || '待确认'}\n目标受众：${product.audience || '待补充'}\n${product.documents.script || ''}`.slice(0, 5000), shots: [{ seconds: 3, action: product.hook || '展示商品与真实使用场景', camera: '近景' }, { seconds: 9, action: '用原创画面展示已核实的功能、使用步骤和适用条件', camera: '中景与细节特写' }, { seconds: 3, action: '总结适合的人群，留下自然的互动问题', camera: '全景定格' }], createdAt: now, updatedAt: now });
    save(); openVideo(id); notify('已创建商品视频项目，原脚本保存在制作备注中');
  }
  function researchTask(product) {
    const prompt = product ? productBrief(product) : `请围绕我的内容方向“${getState().pillars || '先由我确定选品方向'}”和受众“${getState().audience || '待确定'}”准备选品研究。\n先给出候选商品及来源，区分事实、估算和待核实项。不要虚构销量、价格或供应商。\n每款按 output/YYYY-MM-DD/商品名/ 保存以下文件：\n${Object.values(reportNames).join('\n')}\n06_素材/images/\n发布文案分为“## 中文”和“## English”。研究完成后将目录导入豆蜂电商选品。只准备内容，不自动发布或发送消息。`;
    const el = dialog('交给 WorkBuddy 的研究任务', `<p class="muted">复制任务到 WorkBuddy 执行，完成后将日报目录导入这里。</p><div class="field"><textarea rows="15" readonly>${esc(prompt)}</textarea></div><div class="form-actions"><button class="button button-green" data-brief-copy>复制任务</button><button class="button button-light" data-brief-download>下载任务单</button></div>` , { wide: true });
    el.querySelector('[data-brief-copy]').onclick = async () => { try { await navigator.clipboard.writeText(prompt); notify('研究任务已复制'); } catch { el.querySelector('textarea').select(); } };
    el.querySelector('[data-brief-download]').onclick = () => download(prompt, `shop-research-${filename(product?.title || localDay())}.txt`, 'text/plain;charset=utf-8');
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-shop]'); if (!button || button.disabled) return;
    const action = button.dataset.shop, product = getState().products.find(p => p.id === button.dataset.id);
    try {
      if (action === 'new') edit();
      if (action === 'resume') edit(readCache()?.id, true);
      if (action === 'edit') edit(button.dataset.id);
      if (action === 'delete') remove('products', button.dataset.id);
      if (action === 'card' && product) await card(product);
      if (action === 'cover') await card();
      if (action === 'drafts' && product) drafts(product);
      if (action === 'video' && product) toVideo(product);
      if (action === 'brief' && product) researchTask(product);
      if (action === 'research') researchTask();
      if (action === 'previous' || action === 'next') { currentPage += action === 'next' ? 1 : -1; updateResults(); }
      if (action === 'csv') csv([['商品', '状态', '币种', '售价', '采购', '运费', '平台费率%', '估算利润', '估算利润率%', '供应商', '报告日期'], ...rows().map(p => { const result = productProfit(p); return [p.title, productStatuses[p.status], p.currency, p.price, p.cost, p.shipping, p.feeRate, result?.profit.toFixed(2) || '', result?.margin.toFixed(2) || '', p.supplier, p.sourceDate]; })], `shop-products-${localDay()}.csv`);
      if (action === 'help') dialog('项目整合说明', '<p>原项目的日报格式、价格表解析、商品卡片和多平台草稿已接入豆蜂。商品数据与现有工作区共用备份、回收站和搜索。</p><p>图片使用你选择的本地素材。研究任务可交给 WorkBuddy；平台发布需在确认草稿后通过相应工具完成。</p><p>本轮未启用原项目的浏览器登录、自动发布、定时任务和企微推送。</p><a href="https://github.com/qq773901406-cmd/shop-dropshipping-automation" target="_blank" rel="noopener noreferrer">查看来源项目 ↗</a>');
    } catch (error) { notify(error.message); }
  });
  document.addEventListener('input', event => { if (event.target.id === 'shop-query' && !event.isComposing) { query = event.target.value; currentPage = 1; updateResults(); } });
  document.addEventListener('compositionend', event => { if (event.target.id === 'shop-query') { query = event.target.value; currentPage = 1; updateResults(); } });
  document.addEventListener('change', async event => {
    if (event.target.id === 'shop-status') { status = event.target.value; currentPage = 1; updateResults(); }
    if (event.target.id === 'shop-date') { sourceDate = event.target.value; currentPage = 1; updateResults(); }
    if (event.target.id === 'shop-sort') { sort = event.target.value; currentPage = 1; updateResults(); }
    if (event.target.id === 'shop-folder') { const files = [...event.target.files]; event.target.value = ''; if (files.length) { try { await importShopFolder(files, { getState, save, render, notify }); } catch (error) { notify(error.message); } } }
  });
  window.addEventListener('beforeunload', event => { if (readCache()) { event.preventDefault(); event.returnValue = ''; } });
  return { render: view, edit, reset({ preserveEditor = false } = {}) { if (!preserveEditor) clearCache(); } };
}
