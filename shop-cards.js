import { productProfit } from './workbuddy/connector/lib/shop-products.mjs';

const colors = { bg: '#0d1421', panel: '#172337', ink: '#f4f7fa', muted: '#9baec5', accent: '#b7f36c', blue: '#7acfff' };
function base() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1080;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('当前浏览器无法生成图片。');
  ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, 1080, 1080); return { canvas, ctx };
}
function label(ctx, text, x, y, size = 24, color = colors.ink, weight = 400) {
  ctx.font = `${weight} ${size}px "Microsoft YaHei", "Segoe UI", sans-serif`; ctx.fillStyle = color; ctx.fillText(String(text), x, y);
}
function lines(ctx, text, x, y, width, size, max = 2, color = colors.ink) {
  ctx.font = `600 ${size}px "Microsoft YaHei", "Segoe UI", sans-serif`; ctx.fillStyle = color;
  const chars = Array.from(String(text).replace(/\s+/g, ' ')); let line = '', row = 0;
  for (let index = 0; index < chars.length; index++) {
    const next = line + chars[index];
    if (ctx.measureText(next).width > width && line) {
      if (row === max - 1) { ctx.fillText(line.slice(0, -1) + '…', x, y + row * size * 1.5); return; }
      ctx.fillText(line, x, y + row * size * 1.5); row++; line = chars[index];
    } else line = next;
  }
  if (line) ctx.fillText(line, x, y + row * size * 1.5);
}
function panel(ctx, x, y, w, h) { ctx.fillStyle = colors.panel; ctx.beginPath(); ctx.roundRect(x, y, w, h, 22); ctx.fill(); }
async function productImage(product) {
  if (!product.images?.[0]?.path) return null;
  const image = new Image(); const url = `/api/media?path=${encodeURIComponent(product.images[0].path)}`;
  return new Promise(resolve => { const timeout = setTimeout(() => resolve(null), 10000); image.onload = () => { clearTimeout(timeout); resolve(image); }; image.onerror = () => { clearTimeout(timeout); resolve(null); }; image.src = url; });
}
const money = (value, currency) => value === '' || value == null ? '待补充' : `${currency} ${Number(value).toFixed(2)}`;
function footer(ctx, date) { label(ctx, `${date}  ·  豆蜂选品工作区`, 60, 1014, 21, colors.muted); label(ctx, '金额为录入值与估算；以实际成交及成本为准', 60, 1050, 18, colors.muted); }
export async function productCard(product, date) {
  const { canvas, ctx } = base(); const profit = productProfit(product);
  label(ctx, 'PRODUCT SELECTION / 商品研究卡', 60, 70, 22, colors.accent, 600);
  lines(ctx, product.title, 60, 140, 960, 46, 2);
  panel(ctx, 60, 260, 450, 430); panel(ctx, 540, 260, 480, 430);
  const image = await productImage(product);
  if (image) {
    const scale = Math.min(414 / image.width, 394 / image.height), w = image.width * scale, h = image.height * scale;
    ctx.drawImage(image, 78 + (414 - w) / 2, 278 + (394 - h) / 2, w, h);
  } else { label(ctx, '商品素材待补充', 132, 475, 30, colors.muted); }
  label(ctx, '录入售价', 574, 310, 22, colors.muted); label(ctx, money(product.price, product.currency), 574, 363, 36, colors.blue, 600);
  label(ctx, '每单估算利润', 574, 425, 22, colors.muted); label(ctx, profit ? money(profit.profit, product.currency) : '费用待补全', 574, 480, 35, colors.accent, 600);
  label(ctx, profit ? `估算利润率 ${profit.margin.toFixed(1)}%` : '补充售价、采购、运费、平台费率', 574, 536, 22, colors.muted);
  lines(ctx, `货源：${product.supplier || '待确认'}`, 574, 597, 412, 23, 2, colors.muted);
  panel(ctx, 60, 720, 960, 245);
  label(ctx, '目标观众', 90, 768, 20, colors.accent); lines(ctx, product.audience || '在商品资料中补充目标受众', 90, 810, 900, 27, 1);
  label(ctx, '内容切入', 90, 866, 20, colors.accent); lines(ctx, product.hook || '用真实使用场景说明商品价值', 90, 908, 900, 26, 1);
  footer(ctx, date); return canvas;
}
export function coverCard(products, date) {
  const { canvas, ctx } = base();
  label(ctx, 'DAILY SELECTION / 选品汇总', 60, 70, 22, colors.accent, 600);
  label(ctx, '今天关注的商品', 60, 142, 50, colors.ink, 700);
  label(ctx, `共 ${products.length} 款 · 展示当前排序的前 8 款`, 60, 194, 23, colors.muted);
  products.slice(0, 8).forEach((p, index) => {
    const y = 232 + index * 90, profit = productProfit(p); panel(ctx, 60, y, 960, 78);
    label(ctx, String(index + 1).padStart(2, '0'), 84, y + 48, 24, colors.accent, 700);
    lines(ctx, p.title, 142, y + 46, 490, 25, 1);
    label(ctx, profit ? `${profit.margin.toFixed(1)}%` : '待补费用', 798, y + 36, 26, profit ? colors.accent : colors.muted, 600);
    label(ctx, '估算利润率', 798, y + 62, 15, colors.muted);
  });
  footer(ctx, date); return canvas;
}
export function canvasBlob(canvas) { return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败。')), 'image/png')); }
