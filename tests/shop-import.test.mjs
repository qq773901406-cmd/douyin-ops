import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareShopImport } from '../public/shop-import.js';

const file = (path, content = '', size = new TextEncoder().encode(content).length) => ({ name: path.split('/').at(-1), webkitRelativePath: path, size, text: async () => content });
test('日报导入按商品目录分组，保留报告、日期和中英文文案', async () => {
  const prefix = 'output/2026-10-15/旅行杯/';
  const entries = await prepareShopImport([
    file(prefix + '01_全链路分析.md', '**供应商**：示例货源'),
    file(prefix + '03_价格单.md', '| 建议定价 | $20–30 |\n| 货源成本 | $5 |'),
    file(prefix + '05_发布文案.md', '## 中文\n带上杯子出发。\n## English\nBring a cup.'),
    file('output/2026-10-15/收纳包/04_视频脚本.md', '演示收纳过程'),
    file(prefix + '忽略.txt', '其他文件')
  ]);
  assert.equal(entries.length, 2);
  const p = entries[0].product;
  assert.equal(p.title, '旅行杯'); assert.equal(p.sourceDate, '2026-10-15'); assert.equal(p.sourceKey, '2026-10-15/旅行杯');
  assert.equal(p.price, ''); assert.equal(p.cost, '5'); assert.equal(p.supplier, '示例货源');
  assert.match(p.captionZh, /带上杯子/); assert.match(p.captionEn, /Bring a cup/);
  assert.equal(entries[1].product.documents.script, '演示收纳过程');
});
test('素材只取对应商品目录中按名称排序的前两张图片', async () => {
  const prefix = 'output/2026-10-15/杯子/';
  const entries = await prepareShopImport([
    file(prefix + '01_全链路分析.md', '测试'),
    ...['z.png', 'a.jpg', 'b.webp', 'c.txt'].map(name => file(prefix + '06_素材/images/' + name)),
    file('output/2026-10-15/其他/06_素材/images/0.png')
  ]);
  assert.deepEqual(entries[0].pictures.map(f => f.name), ['a.jpg', 'b.webp']);
});
test('长报告有截断标记，限制文件大小和数量', async () => {
  const path = '商品/01_全链路分析.md';
  const [entry] = await prepareShopImport([file(path, '字'.repeat(13000))]);
  assert.equal(entry.clipped, true); assert.equal(entry.product.documents.analysis.length, 12000);
  await assert.rejects(prepareShopImport([file(path, '', 201 * 1024)]), /200KB/);
  await assert.rejects(prepareShopImport(Array(5001).fill(file(path))), /5000/);
  await assert.rejects(prepareShopImport([file('没有报告.txt')]), /没有找到/);
});
test('不含日期的商品目录仍可导入，兼容 UTF-8 BOM', async () => {
  const [entry] = await prepareShopImport([file('商品/03_价格单.md', '\ufeff| 建议定价 | $25 |')]);
  assert.equal(entry.product.price, '25'); assert.equal(entry.product.sourceKey, 'undated/商品');
});
