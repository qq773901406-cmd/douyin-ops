export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const dateTime = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未设置';
export const localInput = value => { if (!value || !Number.isFinite(Date.parse(value))) return ''; const d = new Date(value); return `${localDay(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export async function request(path, options = {}) {
  const response = await fetch(path, { signal: AbortSignal.timeout(15000), ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  let data; try { data = await response.json(); } catch { throw new Error('服务返回了无法读取的响应，请检查本地服务。'); }
  if (!response.ok) throw Object.assign(new Error(data.message || '请求失败'), { status: response.status });
  return data;
}

export function download(value, filename, type = 'application/json') {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csv(rows, filename) {
  const cell = value => { let text = String(value ?? ''); if (/^[=+@\-\t\r\n]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  download('\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n'), filename, 'text/csv;charset=utf-8');
}

export function dialog(title, body, { wide = false, guard = false } = {}) {
  const el = document.createElement('dialog'); el.className = `app-dialog ${wide ? 'wide' : ''}`;
  el.innerHTML = `<header class="dialog-head"><h2>${esc(title)}</h2><button type="button" class="icon-button" data-dialog-close aria-label="关闭">✕</button></header>${body}`;
  let dirty = false; el.addEventListener('input', () => { dirty = true; });
  const canClose = () => !guard || !dirty || confirm('放弃尚未保存的编辑？');
  el.querySelector('[data-dialog-close]').onclick = () => { if (canClose()) el.close(); };
  el.addEventListener('cancel', event => { if (!canClose()) event.preventDefault(); });
  el.addEventListener('close', () => el.remove());
  document.body.append(el); el.showModal(); return el;
}

export function createFormMemory() {
  const allowed = new Set(['diagnosis-form', 'research-form', 'ideas-form', 'remix-form', 'comment-form', 'metrics-form', 'record-form', 'settings-form']);
  const key = form => `doufeng.form.${form.id}`;
  function capture(form) {
    if (!allowed.has(form?.id)) return;
    const data = {};
    for (const input of form.elements) if (input.name && !['file', 'password', 'submit'].includes(input.type)) data[input.name] = input.type === 'checkbox' ? input.checked : input.value;
    try { sessionStorage.setItem(key(form), JSON.stringify(data)); } catch {}
  }
  document.addEventListener('input', event => capture(event.target.closest('form')));
  document.addEventListener('change', event => capture(event.target.closest('form')));
  return {
    restore() {
      for (const form of document.querySelectorAll('form')) {
        if (!allowed.has(form.id)) continue;
        try { const data = JSON.parse(sessionStorage.getItem(key(form)) || 'null'); if (!data) continue; for (const input of form.elements) if (Object.hasOwn(data, input.name) && !['file', 'password'].includes(input.type)) { if (input.type === 'checkbox') input.checked = !!data[input.name]; else input.value = data[input.name]; } } catch {}
      }
    },
    clear(form) { if (allowed.has(form?.id)) { try { sessionStorage.removeItem(key(form)); } catch {} } },
    reset() { for (const id of allowed) { try { sessionStorage.removeItem(`doufeng.form.${id}`); } catch {} } }
  };
}
