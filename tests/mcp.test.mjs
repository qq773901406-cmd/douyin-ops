import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

test('MCP 商品创建、读取、利润、更新冲突和磁盘保存闭环', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url)), temporaryRoot = join(root, '.codex_tmp');
  await mkdir(temporaryRoot, { recursive: true }); const dir = await mkdtemp(join(temporaryRoot, 'mcp-test-'));
  const child = spawn(process.execPath, ['workbuddy/connector/mcp-server.mjs'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DOUFENG_DATA_DIR: dir } });
  let id = 0; const pending = new Map(); const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.kill(); await closed; }
    assert.ok(resolve(dir).startsWith(resolve(temporaryRoot) + sep)); await rm(dir, { recursive: true, force: true });
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id; const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('MCP 响应超时')); }, 5000);
    pending.set(requestId, result => { clearTimeout(timer); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const value = response => { assert.equal(response.error, undefined); return JSON.parse(response.result.content[0].text); };
  assert.ok((await rpc('initialize', { protocolVersion: '2024-11-05' })).result.serverInfo);
  assert.ok((await rpc('tools/list')).result.tools.some(tool => tool.name === 'shop_product_save'));
  const created = value(await call('shop_product_save', { product: { title: 'MCP 测试杯', price: 100, cost: 30, shipping: 10, feeRate: 5, documents: { analysis: '验证报告' } } }));
  assert.equal(value(await call('workspace_get', { collection: 'products' }))[0].id, created.id);
  assert.equal(value(await call('shop_product_brief', { id: created.id })).estimate.profit, 55);
  const updated = value(await call('shop_product_save', { product: { id: created.id, title: 'MCP 更新杯', cost: 35 }, expectedUpdatedAt: created.updatedAt }));
  assert.equal(updated.documents.analysis, '验证报告');
  assert.ok((await call('shop_product_save', { product: { id: created.id, title: '过期覆盖' }, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' })).error);
  assert.ok((await call('shop_product_save', { product: { title: '非法费用', cost: -1 } })).error);
  const state = JSON.parse(await readFile(join(dir, 'workbench.json'), 'utf8'));
  assert.equal(state.products.length, 1); assert.equal(state.products[0].title, 'MCP 更新杯');
});
