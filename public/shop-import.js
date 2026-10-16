import { esc, dialog, localDay } from './workspace-ui.js';
import { parseProductReports, reportNames } from '../workbuddy/connector/lib/shop-products.mjs';

export async function uploadShopImage(file, name = file.name) {
  if (!/\.(png|jpe?g|webp)$/i.test(name) || !file.size || file.size > 20 * 1024 * 1024) throw new Error('请选择非空的 PNG / JPG / WebP 图片，单张不超过 20MB。');
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('图片无法解码，可能已经损坏，请重新选择图片。'); }
  finally { bitmap?.close(); }
  const response = await fetch(`/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: AbortSignal.timeout(60000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.message || '图片保存失败');
  return { name, path: result.path, createdAt: new Date().toISOString() };
}

export async function prepareShopImport(files) {
  if (files.length > 5000) throw new Error('一次请选择最多包含 5000 个文件的日报目录。');
  const groups = new Map(); let bytes = 0;
  for (const file of files) {
    const relative = file.webkitRelativePath || file.name; const parts = relative.split('/');
    const key = Object.keys(reportNames).find(key => reportNames[key] === parts.at(-1));
    if (!key || parts.length < 2) continue;
    if (file.size > 200 * 1024) throw new Error(`${file.name} 超过 200KB，请先精简报告。`);
    bytes += file.size; if (bytes > 4 * 1024 * 1024) throw new Error('本次报告总量超过 4MB，请按日期分批导入。');
    const parent = parts.slice(0, -1).join('/');
    if (!groups.has(parent)) groups.set(parent, { title: parts.at(-2), date: parts.find(part => /^\d{4}-\d{2}-\d{2}$/.test(part)) || '', documents: {}, parent, clipped: false });
    const content = await file.text(); const group = groups.get(parent); group.documents[key] = content.slice(0, 12000); group.clipped ||= content.length > 12000;
  }
  if (!groups.size) throw new Error('没有找到选品报告。请选择原项目 output、日期目录或含 01_全链路分析.md 等文件的商品目录。');
  if (groups.size > 50) throw new Error('单次最多导入 50 款商品，请按日期分批选择。');
  return [...groups.values()].map(group => ({ ...group, product: parseProductReports(group.title, group.documents, group.date), pictures: files.filter(file => (file.webkitRelativePath || '').startsWith(`${group.parent}/06_素材/images/`) && /\.(png|jpe?g|webp)$/i.test(file.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 2) }));
}

export async function importShopFolder(files, { getState, save, render, notify }) {
  const entries = await prepareShopImport(files);
  const existing = new Set(getState().products.map(item => item.sourceKey).filter(Boolean));
  const el = dialog('导入选品日报', `<p class="muted">发现 ${entries.length} 款商品。相同“日期＋商品名”的记录会跳过。每份报告保留前 12000 字，每款最多复制 2 张商品图。</p><div class="shop-import-list">${entries.map((entry, index) => `<label class="shop-import-row"><input type="checkbox" data-import-index="${index}" ${existing.has(entry.product.sourceKey) ? 'disabled' : 'checked'}><span><b>${esc(entry.title)}</b><small>${esc(entry.date || '未识别日期')} · ${Object.keys(entry.documents).length} / 5 份报告 · ${entry.pictures.length} 张图片${entry.clipped ? ' · 长报告已截取' : ''}</small></span><span class="pill">${existing.has(entry.product.sourceKey) ? '已存在' : '待导入'}</span></label>`).join('')}</div><p class="form-hint">导入的是原始研究资料，商品价格和结论仍需核实。图片复制失败会保留报告并提示补传。</p><p class="form-error" role="alert"></p><div class="form-actions"><button class="button button-green" data-confirm-import>导入选中的商品</button><span data-import-progress role="status"></span></div>`, { wide: true });
  let busy = false; el.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  el.querySelector('[data-confirm-import]').onclick = async event => {
    if (busy) return;
    const chosen = [...el.querySelectorAll('[data-import-index]:checked')].map(input => entries[Number(input.dataset.importIndex)]);
    if (!chosen.length) { el.querySelector('.form-error').textContent = '请至少选择一款新商品。'; return; }
    const button = event.currentTarget, close = el.querySelector('[data-dialog-close]'); busy = true; button.disabled = close.disabled = true;
    const warnings = []; const staged = [];
    try {
      for (const [index, entry] of chosen.entries()) {
        el.querySelector('[data-import-progress]').textContent = `正在准备 ${index + 1} / ${chosen.length}：${entry.title}`;
        const product = structuredClone(entry.product); product.images = [];
        for (const picture of entry.pictures) { try { product.images.push(await uploadShopImage(picture)); } catch (error) { warnings.push(`${entry.title}：${error.message}`); } }
        const now = new Date().toISOString(); staged.push({ ...product, id: crypto.randomUUID(), createdAt: now, updatedAt: now, date: entry.date || localDay() });
      }
      const keys = new Set(getState().products.map(item => item.sourceKey).filter(Boolean)); let added = 0;
      for (const product of staged) if (!keys.has(product.sourceKey)) { getState().products.push(product); keys.add(product.sourceKey); added++; }
      if (added) save(); el.close(); render(); notify(`已导入 ${added} 款商品，正在同步${warnings.length ? `；${warnings.length} 张图片需补传` : ''}`);
      if (warnings.length) dialog('图片导入提示', `<p>商品报告已保留，可在商品编辑中补传图片。</p><div class="output-card">${esc(warnings.join('\n'))}</div>`);
    } catch (error) { el.querySelector('.form-error').textContent = error.message; }
    finally { busy = false; button.disabled = close.disabled = false; }
  };
}
