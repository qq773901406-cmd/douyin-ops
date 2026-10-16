import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { extname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { receiveMedia, serveMedia } from './media-service.mjs';
import { browserSkillStatus, executeBrowserSkill } from './browser-skill-adapter.mjs';
import { JsonStore } from './workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from './workbuddy/connector/lib/workspace-model.mjs';
import { BackupStore } from './workbuddy/connector/lib/backup-store.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeDir = resolve(process.env.DOUFENG_DATA_DIR || join(root, 'runtime'));
const uploadDir = join(runtimeDir, 'uploads');
const stateFile = join(runtimeDir, 'workbench.json');
const jobsFile = join(runtimeDir, 'jobs.json');
const activityFile = join(runtimeDir, 'activity.json');
const workbuddyConfig = join(root, 'workbuddy', 'connector', 'connector-meta.json');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4174);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('个人版本仅支持本机地址，PORT 必须是 1–65535 的整数。');
const address = `http://${host === '::1' ? '[::1]' : host}:${port}`;
const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
const localOrigins = new Set([...localHosts].map(value => `http://${value}`));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const stateStore = new JsonStore(stateFile, normalizeState(), normalizeState, { snapshots: true });
const backups = new BackupStore(join(runtimeDir, 'backups'));
const validateList = value => { if (!Array.isArray(value)) throw new Error('数据文件必须是列表。'); return value; };
const jobsStore = new JsonStore(jobsFile, [], validateList);
const activityStore = new JsonStore(activityFile, [], validateList);
const publicFiles = new Set(['index.html', 'app.css', 'app.js', 'state-sync.js', 'video-studio.js', 'workbuddy/connector/lib/workspace-model.mjs', 'workbuddy/connector/lib/video-projects.mjs']);
for (const file of ['product.css', 'workspace-ui.js', 'content-library.js', 'publish-planner.js', 'data-center.js', 'dashboard.js', 'legacy-pages.js', 'workbuddy/connector/lib/workspace-actions.mjs']) publicFiles.add(file);
for (const file of ['shop-workspace.js', 'shop-import.js', 'shop-cards.js', 'shop.css', 'workbuddy/connector/lib/shop-products.mjs']) publicFiles.add(file);

await mkdir(uploadDir, { recursive: true });

async function exists(path) { try { await access(path); return true; } catch { return false; } }
function sendJson(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
async function bodyJson(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw Object.assign(new Error('请求内容过大。'), { status: 413 }); chunks.push(chunk); }
  const value = Buffer.concat(chunks).toString('utf8');
  try { return value ? JSON.parse(value) : {}; }
  catch { throw Object.assign(new Error('JSON 格式不正确。'), { status: 400 }); }
}
function sameOrigin(req) { return !req.headers.origin || localOrigins.has(req.headers.origin); }
async function addActivity(entry) {
  await activityStore.update(activity => {
    activity.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), ...entry });
    if (activity.length > 200) activity.splice(0, activity.length - 200);
  });
}

const server = createServer(async (req, res) => {
  if (!localHosts.has(req.headers.host)) { sendJson(res, 403, { ok: false, message: '仅允许通过本机工作台地址访问。' }); return; }
  let url;
  try { url = new URL(req.url || '/', address); } catch { sendJson(res, 400, { ok: false, message: '请求地址无效。' }); return; }
  if (url.pathname.startsWith('/api/')) {
    if (!sameOrigin(req)) { sendJson(res, 403, { ok: false, message: '请求来源不受信任。' }); return; }
    try {
      if (req.method === 'GET' && ['/api/health', '/api/system'].includes(url.pathname)) {
        sendJson(res, 200, { ok: true, service: 'douyin-ops-workbuddy-workbench', version, root, dataDir: runtimeDir, node: process.version, pid: process.pid, uptime: Math.floor(process.uptime()), workbuddy: { packageReady: await exists(workbuddyConfig), connectorPath: 'workbuddy/connector', skillPath: 'SKILL.md' }, now: new Date().toISOString() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/browser-skill/status') { sendJson(res, 200, await browserSkillStatus()); return; }
      if (req.method === 'GET' && url.pathname === '/api/backups') { sendJson(res, 200, { ok: true, backups: await backups.list() }); return; }
      if (req.method === 'POST' && url.pathname === '/api/backups') {
        const input = await bodyJson(req, 4096); const current = await stateStore.read();
        if (current.revision === 'missing') throw Object.assign(new Error('请先保存工作区数据。'), { status: 400 });
        sendJson(res, 201, { ok: true, backup: await backups.create(current.value, 'manual', input.label || '手动备份') }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/backups/restore') {
        const revision = req.headers['if-match'];
        if (typeof revision !== 'string') throw Object.assign(new Error('恢复前需要读取工作区版本。'), { status: 428 });
        const input = await bodyJson(req);
        if (!input.id && (!input.state || typeof input.state !== 'object')) throw Object.assign(new Error('缺少待导入的数据。'), { status: 400 });
        let value;
        if (input.id) value = (await backups.read(String(input.id))).state;
        else { try { value = normalizeState(input.state); } catch (error) { error.status = 400; throw error; } }
        const saved = await stateStore.update(async current => {
          await backups.create(current, 'restore', '恢复或导入前的工作区');
          for (const key of Object.keys(current)) delete current[key];
          Object.assign(current, value);
        }, revision);
        sendJson(res, 200, { ok: true, state: saved.value, revision: saved.revision }); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/backups/')) { sendJson(res, 200, { ok: true, backup: await backups.read(decodeURIComponent(url.pathname.slice(13))) }); return; }
      if (req.method === 'GET' && url.pathname === '/api/state') { const snapshot = await stateStore.read(); sendJson(res, 200, { ok: true, state: snapshot.revision === 'missing' ? null : snapshot.value, revision: snapshot.revision }); return; }
      if (req.method === 'PUT' && url.pathname === '/api/state') {
        if (typeof req.headers['if-match'] !== 'string') throw Object.assign(new Error('保存需要数据版本，请刷新工作台或升级客户端。'), { status: 428 });
        let state;
        try { state = normalizeState(await bodyJson(req)); } catch (error) { error.status ||= 400; throw error; }
        const saved = await stateStore.replace(state, req.headers['if-match']); sendJson(res, 200, { ok: true, revision: saved.revision }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/browser-skill/execute') {
        const input = await bodyJson(req, 64 * 1024);
        const result = await executeBrowserSkill(input);
        await addActivity({ type: 'browser-skill', action: input.action || 'status', ok: !!result.ok, message: result.message || result.stderr || '' });
        sendJson(res, result.ok || result.installed !== undefined ? 200 : 503, result); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/uploads') {
        const original = String(url.searchParams.get('name') || 'upload.bin');
        const uploaded = await receiveMedia(req, uploadDir, original);
        let warning;
        try { await addActivity({ type: 'upload-prepared', label: original, path: uploaded.path, ok: true }); }
        catch { warning = '素材已上传，但活动日志未写入。'; }
        sendJson(res, 201, { ok: true, ...uploaded, ...(warning ? { warning } : {}) }); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/api/media') {
        await serveMedia(req, res, uploadDir, url.searchParams.get('path')); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') { sendJson(res, 200, { ok: true, jobs: (await jobsStore.read()).value }); return; }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const input = await bodyJson(req, 128 * 1024); const next = new Date(input.nextRunAt); const target = new URL(String(input.url || ''));
        if (!['www.douyin.com', 'douyin.com', 'creator.douyin.com'].includes(target.hostname) || target.protocol !== 'https:') throw Object.assign(new Error('任务只允许读取抖音页面。'), { status: 400 });
        if (!['currentVideo', 'creatorMetrics', 'account'].includes(input.extractor)) throw Object.assign(new Error('不支持该回采类型。'), { status: 400 });
        if (Number.isNaN(next.getTime())) throw Object.assign(new Error('执行时间无效。'), { status: 400 });
        const job = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label: String(input.label || '效果回采').slice(0, 100), url: target.href, extractor: input.extractor, repeat: ['once', 'daily', 'weekly'].includes(input.repeat) ? input.repeat : 'once', nextRunAt: next.toISOString(), enabled: true, createdAt: new Date().toISOString(), runner: 'workbuddy', lastResult: null };
        await jobsStore.update(jobs => jobs.push(job)); sendJson(res, 201, { ok: true, job }); return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/jobs/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
        const saved = await jobsStore.update(jobs => { const index = jobs.findIndex(job => job.id === id); if (index < 0) return false; jobs.splice(index, 1); return true; });
        sendJson(res, 200, { ok: true, removed: saved.result }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/activity') { sendJson(res, 200, { ok: true, activity: (await activityStore.read()).value.slice(-100).reverse() }); return; }
      sendJson(res, 404, { ok: false, message: 'API 不存在。' });
    } catch (error) { if (res.headersSent || res.destroyed) { res.destroy(); return; } sendJson(res, error.status || 500, { ok: false, message: error instanceof SyntaxError ? 'JSON 格式不正确。' : error.message }); }
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('Invalid URL'); return; }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const target = resolve(root, relative);
  if (!publicFiles.has(relative)) { res.writeHead(404).end('Not found'); return; }
  if (target !== root && !target.startsWith(root + sep)) { res.writeHead(403).end('Forbidden'); return; }
  try { const body = await readFile(target); res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(body); }
  catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); }
});

server.on('error', error => { if (error.code === 'EADDRINUSE') { console.error(`端口 ${port} 已被占用。请关闭旧服务，或设置其他端口后重新运行。`); process.exitCode = 1; return; } throw error; });
server.listen(port, host, () => console.log(`豆蜂 WorkBuddy 运营工作台已就绪：${address}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => { process.exitCode = 0; });
  server.closeIdleConnections();
});
