import test from 'node:test';
import assert from 'node:assert/strict';
import { newProduct, validateProduct, productProfit, parseProductReports, findProductImageDraft } from '../workbuddy/connector/lib/shop-products.mjs';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';
import { moveToTrash, restoreTrash } from '../workbuddy/connector/lib/workspace-actions.mjs';

const product = extra => ({ ...newProduct(), id: 'sample', title: '收纳包', price: '100', cost: '30', shipping: '10', feeRate: '5', ...extra });
const report = (price, cost = '$5') => parseProductReports('收纳包', { pricing: `| 建议定价 | ${price} |\n| 货源成本 | ${cost} |` }, '2026-10-15');

test('利润包含固定费用、平台费和退货预留', () => {
  assert.deepEqual(productProfit(product({ packaging: '2', adCost: '8', returnRate: '3' })), { price: 100, fee: 5, reserve: 3, totalCost: 58, profit: 42, margin: 42 });
});
test('未填写必需费用时不显示利润', () => {
  for (const key of ['price', 'cost', 'shipping', 'feeRate']) assert.equal(productProfit(product({ [key]: '' })), null);
  assert.equal(productProfit(product({ price: '0' })), null);
});
test('非法费用和比例不会产生误导性的实时利润', () => {
  for (const extra of [{ adCost: '-10' }, { returnRate: '101' }, { packaging: 'abc' }, { cost: '-1' }, { feeRate: 'NaN' }, { shipping: ' ' }]) assert.equal(productProfit(product(extra)), null, JSON.stringify(extra));
});
test('支持明确的价格及千位分隔符', () => {
  assert.equal(report('$1,299.90').price, '1299.90');
  assert.equal(report('USD 29.90').price, '29.90');
  assert.equal(report('29.90 美元').price, '29.90');
});
test('区间、负数及不明确的价格留空待核实', () => {
  for (const price of ['$10–20', '$10-$20', '-$5', '$-5', '约 $20', '$19.99（原价 $29.99）', '1,99', '12.3.4']) assert.equal(report(price).price, '', price);
  assert.match(report('$10–20').notes, /价格.*留空/);
});
test('表格空白价格列不会误读备注列', () => {
  const p = parseProductReports('收纳包', { pricing: '| 建议定价 | | 参考 $99 |\n| 货源成本 | $5 |' });
  assert.equal(p.price, '');
});
test('不同币种的采购成本留空', () => {
  const p = report('$29.9', 'CNY 10');
  assert.equal(p.currency, 'USD'); assert.equal(p.cost, ''); assert.match(p.notes, /币种不同/);
});
test('日期必须真实存在，允许闰日', () => {
  assert.equal(validateProduct(product({ sourceDate: '2024-02-29' })).sourceDate, '2024-02-29');
  for (const date of ['2025-02-29', '2026-13-01', '2026-02-30']) assert.throws(() => validateProduct(product({ sourceDate: date })), /日期/);
});
test('货源链接必须是可解析的 HTTP 地址', () => {
  assert.equal(validateProduct(product({ supplierUrl: 'https://example.com/product/1' })).supplierUrl, 'https://example.com/product/1');
  for (const url of ['https://', 'http://bad host', 'javascript:alert(1)']) assert.throws(() => validateProduct(product({ supplierUrl: url })), /链接/);
});
test('兼容旧工作区且拒绝更高版本和重复编号', () => {
  assert.equal(normalizeState({ schemaVersion: 4 }).schemaVersion, 5);
  assert.deepEqual(normalizeState({}).products, []);
  assert.throws(() => normalizeState({ schemaVersion: 99 }), /升级/);
  assert.throws(() => normalizeState({ products: [product(), product()] }), /重复/);
});
test('商品回收和恢复保持完整报告与素材引用', () => {
  const state = normalizeState({ products: [product({ documents: { analysis: '原始报告' }, images: [{ name: 'a.png', path: '/uploads/a.png' }] })] });
  const before = structuredClone(state.products[0]);
  const deleted = moveToTrash(state, 'products', 'sample');
  assert.equal(state.products.length, 0);
  restoreTrash(state, deleted.id);
  assert.deepEqual(state.products[0], before); assert.equal(state.trash.length, 0);
});
test('商品图文只复用同平台未发布的图文草稿', () => {
  const draft = { sourceProductId: 'sample', platform: 'douyin', status: '待人工准备', format: '图文' };
  const rows = [{ ...draft, id: 'video', format: '视频', sourceVideoId: 'v' }, { ...draft, id: 'published', status: '已发布' }, { ...draft, id: 'other', platform: 'instagram' }, { ...draft, id: 'image' }];
  assert.equal(findProductImageDraft(rows, 'sample', 'douyin').id, 'image');
  assert.equal(findProductImageDraft(rows, 'sample', 'facebook'), undefined);
});
