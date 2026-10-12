import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, unlink, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { extname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { browserSkillStatus, executeBrowserSkill } from './browser-skill-adapter.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const runtimeDir = join(root, 'runtime');
const uploadDir = join(runtimeDir, 'uploads');
const stateFile = join(runtimeDir, 'workbench.json');
const jobsFile = join(runtimeDir, 'jobs.json');
const activityFile = join(runtimeDir, 'activity.json');
const workbuddyConfig = join(root, 'workbuddy', 'connector', 'connector-meta.json');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4174);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const uploadExtensions = new Set(['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp']);

await mkdir(uploadDir, { recursive: true });

async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }
async function writeJson(path, value) { await writeFile(path, JSON.stringify(value, null, 2), 'utf8'); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function sendJson(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
async function bodyJson(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw Object.assign(new Error('请求内容过大。'), { status: 413 }); chunks.push(chunk); }
  const value = Buffer.concat(chunks).toString('utf8');
  return value ? JSON.parse(value) : {};
}
function sameOrigin(req) { const origin = req.headers.origin; return !origin || origin === `http://${host}:${port}` || origin === `http://localhost:${port}`; }
async function addActivity(entry) {
  const activity = await readJson(activityFile, []);
  activity.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), ...entry });
  await writeJson(activityFile, activity.slice(-200));
}

const server = createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url || '/', `http://${host}:${port}`); } catch { sendJson(res, 400, { ok: false, message: '请求地址无效。' }); return; }
  if (url.pathname.startsWith('/api/')) {
    if (!sameOrigin(req)) { sendJson(res, 403, { ok: false, message: '请求来源不受信任。' }); return; }
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'douyin-ops-workbuddy-workbench', version: 3, workbuddy: { packageReady: await exists(workbuddyConfig), connectorPath: 'workbuddy/connector', skillPath: 'SKILL.md' }, browserSkill: await browserSkillStatus(), now: new Date().toISOString() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') { sendJson(res, 200, { ok: true, state: await readJson(stateFile, null) }); return; }
      if (req.method === 'PUT' && url.pathname === '/api/state') {
        const state = await bodyJson(req);
        if (!state || typeof state !== 'object' || Array.isArray(state)) throw Object.assign(new Error('工作台数据格式不正确。'), { status: 400 });
        await writeJson(stateFile, state); sendJson(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/browser-skill/execute') {
        const input = await bodyJson(req, 64 * 1024);
        const result = await executeBrowserSkill(input);
        await addActivity({ type: 'browser-skill', action: input.action || 'status', ok: !!result.ok, message: result.message || result.stderr || '' });
        sendJson(res, result.ok || result.installed !== undefined ? 200 : 503, result); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/uploads') {
        const original = String(url.searchParams.get('name') || 'upload.bin');
        const extension = extname(original).toLowerCase();
        if (!uploadExtensions.has(extension)) throw Object.assign(new Error('仅支持 MP4、MOV、WebM、PNG、JPG 和 WebP。'), { status: 400 });
        const length = Number(req.headers['content-length'] || 0);
        if (!length || length > 4 * 1024 * 1024 * 1024) throw Object.assign(new Error('文件为空或超过 4GB。'), { status: 413 });
        const base = original.replace(extension, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-').slice(0, 80) || 'upload';
        const target = join(uploadDir, `${Date.now()}-${base}${extension}`);
        try { await pipeline(req, createWriteStream(target, { flags: 'wx' })); } catch (error) { await unlink(target).catch(() => {}); throw error; }
        await addActivity({ type: 'upload-prepared', label: original, path: target, ok: true });
        sendJson(res, 201, { ok: true, path: target, size: length }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') { sendJson(res, 200, { ok: true, jobs: await readJson(jobsFile, []) }); return; }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const input = await bodyJson(req, 128 * 1024); const next = new Date(input.nextRunAt); const target = new URL(String(input.url || ''));
        if (!['www.douyin.com', 'douyin.com', 'creator.douyin.com'].includes(target.hostname) || target.protocol !== 'https:') throw Object.assign(new Error('任务只允许读取抖音页面。'), { status: 400 });
        if (!['currentVideo', 'creatorMetrics', 'account'].includes(input.extractor)) throw Object.assign(new Error('不支持该回采类型。'), { status: 400 });
        if (Number.isNaN(next.getTime())) throw Object.assign(new Error('执行时间无效。'), { status: 400 });
        const jobs = await readJson(jobsFile, []);
        const job = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label: String(input.label || '效果回采').slice(0, 100), url: target.href, extractor: input.extractor, repeat: ['once', 'daily', 'weekly'].includes(input.repeat) ? input.repeat : 'once', nextRunAt: next.toISOString(), enabled: true, createdAt: new Date().toISOString(), runner: 'workbuddy', lastResult: null };
        jobs.push(job); await writeJson(jobsFile, jobs); sendJson(res, 201, { ok: true, job }); return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/jobs/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/jobs/'.length)); const jobs = await readJson(jobsFile, []); const filtered = jobs.filter(job => job.id !== id);
        await writeJson(jobsFile, filtered); sendJson(res, 200, { ok: true, removed: filtered.length !== jobs.length }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/activity') { sendJson(res, 200, { ok: true, activity: (await readJson(activityFile, [])).slice(-100).reverse() }); return; }
      sendJson(res, 404, { ok: false, message: 'API 不存在。' });
    } catch (error) { sendJson(res, error.status || 500, { ok: false, message: error instanceof SyntaxError ? 'JSON 格式不正确。' : error.message }); }
    return;
  }
  const pathname = decodeURIComponent(url.pathname); const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) { res.writeHead(403).end('Forbidden'); return; }
  try { const body = await readFile(target); res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(body); }
  catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); }
});

server.on('error', error => { if (error.code === 'EADDRINUSE') { console.error(`端口 ${port} 已被占用。请关闭旧服务，或设置其他端口后重新运行。`); process.exitCode = 1; return; } throw error; });
server.listen(port, host, () => console.log(`豆蜂 WorkBuddy 运营工作台已就绪：http://${host}:${port}`));
