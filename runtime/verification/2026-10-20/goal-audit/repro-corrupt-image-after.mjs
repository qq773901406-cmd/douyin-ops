import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DailyProduction } from '../../../../server/daily-production.mjs';
import { usableProductImages, inspectProductVideoEnvironment } from '../../../../server/product-video.mjs';
import { syncProductReports } from '../../../../server/product-source.mjs';
import { shanghaiDay } from '../../../../shared/automation-model.mjs';

const root = fileURLToPath(new URL(`./corrupt-image-after-${Date.now()}/`, import.meta.url));
await mkdir(root, { recursive: true });
const source = join(root, 'source', '2026-10-20', 'bad-product');
const images = join(source, '06_素材', 'images');
await mkdir(images, { recursive: true });
await writeFile(join(source, '01_全链路分析.md'), '# bad-product');
await writeFile(join(images, 'bad.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const valid = join(root, 'valid.png');
await writeFile(valid, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
let data = { products: [], trash: [], videos: [], drafts: [] };
const workspace = {
  async read() { return { value: structuredClone(data) }; },
  async update(change) {
    const next = structuredClone(data);
    const result = await change(next);
    data = next;
    return { value: structuredClone(data), result };
  }
};
const imported = await syncProductReports(join(root, 'source'), join(root, 'uploads'), workspace);
assert.equal(imported.added, 1);
data.products[0].id = 'a-corrupt';
data.products.push({ id: 'z-valid', title: 'valid-product', status: 'research', sourceDate: '2026-10-20', images: [{ name: 'valid.png', path: valid }] });
const validation = await usableProductImages(data.products[0]);
assert.equal(validation.images.length, 0);
assert.equal(validation.warnings.length, 1);
const environment = await inspectProductVideoEnvironment();
assert.equal(environment.ok, true);
let simulatedPublishCalls = 0;
const queue = { config: { enabled: false, accountId: 'fixture-account', browserId: 'fixture-browser', verifiedAt: new Date().toISOString() }, items: [] };
const automation = {
  store: { async read() { return { value: structuredClone(queue) }; } },
  async lease() { return async () => {}; },
  publisher: {
    async publish(_item, { guard, beforeSubmit }) {
      simulatedPublishCalls++;
      await guard();
      await beforeSubmit();
      return { message: 'SIMULATED success; no network or real publication', evidence: { kind: 'offline-stub' } };
    }
  }
};
const daily = new DailyProduction(root, workspace, automation);
const now = Date.now(), day = shanghaiDay(now);
const shanghaiHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(now));
await daily.store.update(state => Object.assign(state.config, {
  enabled: true, startTime: `${String(shanghaiHour).padStart(2, '0')}:00`, firstDay: day, sourceFolder: join(root, 'source'),
  authorizedAt: new Date(now).toISOString(), accountId: 'fixture-account', browserId: 'fixture-browser'
}));
await daily.run(false);
const after = (await daily.store.read()).value;
const result = {
  checkedAt: new Date().toISOString(),
  importAcceptedCorruptImage: imported.added === 1,
  validationAcceptedCorruptImage: validation.images.length === 1,
  validationWarnings: validation.warnings,
  environment,
  firstRun: after.runs[0],
  scheduleStillEnabled: after.config.enabled,
  simulatedPublishCalls,
  realPublishCalls: 0
};
assert.equal(after.runs[0].title, 'valid-product');
assert.equal(after.runs[0].status, 'submitted');
assert.equal(after.config.enabled, true);
assert.equal(simulatedPublishCalls, 1);
assert.ok(after.runs[0].warnings.some(message => message.includes('bad-product') && message.includes('图片无法解码')));
await writeFile(join(root, '..', 'corrupt-image-result-after.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  confirmed: true,
  status: after.runs[0].status,
  selectedProduct: after.runs[0].title,
  scheduleStillEnabled: after.config.enabled,
  simulatedPublishCalls,
  realPublishCalls: 0
}, null, 2));
