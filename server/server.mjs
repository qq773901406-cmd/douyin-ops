import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { extname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { receiveMedia, serveMedia } from './media-service.mjs';
import { browserSkillStatus, executeBrowserSkill } from './browser-skill-adapter.mjs';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { normalizeState } from '../workbuddy/connector/lib/workspace-model.mjs';
import { BackupStore } from '../workbuddy/connector/lib/backup-store.mjs';
import { AutomationService } from './automation-service.mjs';
import { DailyProduction } from './daily-production.mjs';
import { DouyinInspector } from './douyin-inspector.mjs';
import { DouyinTracking } from './douyin-tracking.mjs';
import { assertDouyinVideoDraft } from '../shared/publish-target.mjs';
import { OperationsService } from './operations-service.mjs';
import { PetVideoPipeline } from './pet-video-pipeline.mjs';
import { ensureProjectLocalModel } from '../lib/local-model-runtime.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
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
const automation = new AutomationService(runtimeDir);
const dailyProduction = new DailyProduction(runtimeDir, stateStore, automation);
const douyinInspector = new DouyinInspector({ publisher: automation.publisher });
const douyinTracking = new DouyinTracking(runtimeDir, {
  workspace: stateStore, automation, dailyProduction,
  inspect: target => douyinInspector.inspect(target),
  discover: target => douyinInspector.discover(target),
  collectBatch: targets => douyinInspector.collectBatch(targets),
});
const operations = new OperationsService(runtimeDir, { workspace: stateStore, automation, dailyProduction, tracking: douyinTracking, jobsStore });
dailyProduction.petPipeline = new PetVideoPipeline(runtimeDir, { workspace: stateStore, content: operations.content, text: operations.text, media: operations.media });
const publicFiles = new Set(['index.html', 'app.css', 'app.js', 'state-sync.js', 'video-studio.js', 'workbuddy/connector/lib/workspace-model.mjs', 'workbuddy/connector/lib/video-projects.mjs']);
for (const file of ['product.css', 'workspace-ui.js', 'content-library.js', 'publish-planner.js', 'data-center.js', 'dashboard.js', 'legacy-pages.js', 'workbuddy/connector/lib/workspace-actions.mjs']) publicFiles.add(file);
for (const file of ['shop-workspace.js', 'shop-import.js', 'shop-cards.js', 'shop.css', 'workbuddy/connector/lib/shop-products.mjs']) publicFiles.add(file);
for (const file of ['automation.js', 'automation.css', 'automation-model.mjs']) publicFiles.add(file);
publicFiles.add('daily-production.js');
publicFiles.add('douyin-tracking.js');
publicFiles.add('shared/automation-model.mjs');
publicFiles.add('shared/publish-target.mjs');
publicFiles.add('operations.js');
publicFiles.add('operations-form.js');
// Keep browser URLs stable while serving only explicitly allowed source files.
const publicPaths = new Map([...publicFiles].map(file => [file, resolve(root,
  file.startsWith('workbuddy/') || file.startsWith('shared/') ? file
    : file === 'automation-model.mjs' ? 'shared/automation-model.mjs'
    : join('public', file))]));

await mkdir(uploadDir, { recursive: true });

async function exists(path) { try { await access(path); return true; } catch { return false; } }
function sendJson(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
async function bodyJson(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw Object.assign(new Error('请求内容过大。'), { status: 413 }); chunks.push(chunk); }
  const value = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try { parsed = value ? JSON.parse(value) : {}; }
  catch { throw Object.assign(new Error('JSON 格式不正确。'), { status: 400 }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error('请求必须是 JSON 对象。'), { status: 400 });
  return parsed;
}
function sameOrigin(req) { return !req.headers.origin || localOrigins.has(req.headers.origin); }
async function trackingSnapshot() {
  return { ...(await douyinTracking.snapshot()), targets: await douyinTracking.targets() };
}
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
      if (url.pathname === '/api/operations' || url.pathname.startsWith('/api/operations/')) {
        const route = url.pathname.slice('/api/operations'.length);
        if (req.method === 'GET' && route === '') { sendJson(res, 200, { ok: true, ...(await operations.snapshot()) }); return; }
        if (req.method === 'GET' && route === '/environment') { sendJson(res, 200, { ok: true, environment: await operations.environment() }); return; }
        if (req.method === 'POST' || req.method === 'PATCH') {
          const input = await bodyJson(req, 64 * 1024), revision = req.headers['if-match'];
          if (typeof revision !== 'string') throw Object.assign(new Error('请刷新任务状态后再操作。'), { status: 428 });
          if (req.method === 'POST' && route === '/settings') { sendJson(res, 200, { ok: true, ...(await operations.configure(input, revision)) }); return; }
          if (req.method === 'POST' && route === '/tasks') {
            await operations.runner.create(input, revision);
            sendJson(res, 201, { ok: true, ...(await operations.snapshot()) }); return;
          }
          const match = /^\/tasks\/([a-f0-9-]{36})(?:\/(run|cancel|resume))?$/.exec(route);
          if (match) {
            if (req.method === 'PATCH' && !match[2]) await operations.runner.update(match[1], input, revision);
            else if (req.method === 'POST' && match[2] === 'run') {
              const run = await operations.runner.enqueue(match[1], revision);
              sendJson(res, 202, { ok: true, run, ...(await operations.snapshot()) }); return;
            } else if (req.method === 'POST' && ['cancel', 'resume'].includes(match[2])) await operations.runner[match[2]](match[1], revision);
            else throw Object.assign(new Error('不支持此任务操作。'), { status: 404 });
            sendJson(res, 200, { ok: true, ...(await operations.snapshot()) }); return;
          }
        }
        sendJson(res, 404, { ok: false, message: '任务接口不存在。' }); return;
      }
      if (url.pathname === '/api/douyin-tracking' || url.pathname.startsWith('/api/douyin-tracking/')) {
        const route = url.pathname.slice('/api/douyin-tracking'.length);
        if (req.method === 'GET' && route === '') { sendJson(res, 200, { ok: true, ...(await trackingSnapshot()) }); return; }
        if (req.method === 'POST' && route === '/settings') {
          const input = await bodyJson(req, 4096), revision = req.headers['if-match'];
          if (typeof revision !== 'string') throw Object.assign(new Error('请刷新回采状态后再保存。'), { status: 428 });
          if (Object.keys(input).some(key => !['enabled', 'dailyTime'].includes(key))) throw Object.assign(new Error('回采设置仅接受开关和每日时间。'), { status: 400 });
          await douyinTracking.configure(input, revision);
          sendJson(res, 200, { ok: true, ...(await trackingSnapshot()) }); return;
        }
        if (req.method === 'POST' && ['/check', '/bind'].includes(route)) {
          const input = await bodyJson(req, 4096);
          const allowed = route === '/bind' ? ['targetRef', 'workURL'] : ['targetRef'];
          if (Object.keys(input).some(key => !allowed.includes(key))
            || input.targetRef !== undefined && (typeof input.targetRef !== 'string' || !/^(?:daily|queue):[A-Za-z0-9_-]{1,160}$/.test(input.targetRef))) {
            throw Object.assign(new Error('回采请求只接受提交记录编号和作品链接。'), { status: 400 });
          }
          if (route === '/bind' && (!input.targetRef || typeof input.workURL !== 'string' || !input.workURL.trim())) {
            throw Object.assign(new Error('绑定需要提交记录编号和完整作品链接。'), { status: 400 });
          }
          const result = route === '/bind'
            ? await douyinTracking.bind(input.targetRef, input.workURL)
            : await douyinTracking.checkNow(input.targetRef);
          sendJson(res, 200, { ok: true, result, ...(await trackingSnapshot()) }); return;
        }
        sendJson(res, 404, { ok: false, message: '抖音回采接口不存在。' }); return;
      }
      if (url.pathname.startsWith('/api/daily-production')) {
        const route = url.pathname.slice('/api/daily-production'.length);
        if (req.method === 'GET' && route === '') { sendJson(res, 200, { ok: true, ...(await dailyProduction.snapshot()) }); return; }
        if (req.method === 'GET' && route === '/browsers') { sendJson(res, 200, { browsers: await automation.browsers() }); return; }
        if (['GET', 'HEAD'].includes(req.method) && route === '/media') { const media = await dailyProduction.media(String(url.searchParams.get('id') || '')); await serveMedia(req, res, media.directory, media.path); return; }
        if (req.method === 'POST' && ['/toggle', '/preview', '/source', '/sync', '/connect', '/reconcile', '/check', '/schedule', '/content-source', '/production-settings'].includes(route)) {
          const input = await bodyJson(req, route === '/production-settings' ? 16 * 1024 : 4096), revision = req.headers['if-match'];
          if (route === '/production-settings' && typeof revision !== 'string') throw Object.assign(new Error('请刷新生产状态后再保存成片方式。'), { status: 428 });
          if (['/preview', '/sync', '/check'].includes(route)) await dailyProduction[route.slice(1)](revision);
          else await dailyProduction[route === '/content-source' ? 'contentSource' : route === '/production-settings' ? 'productionSettings' : route.slice(1)](input, revision);
          sendJson(res, 200, { ok: true, ...(await dailyProduction.snapshot()) }); return;
        }
        sendJson(res, 404, { ok: false, message: '每日生产接口不存在。' }); return;
      }
      if (url.pathname.startsWith('/api/automation')) {
        const route = url.pathname.slice('/api/automation'.length);
        if (req.method === 'GET' && route === '') { sendJson(res, 200, { ok: true, ...(await automation.snapshot()) }); return; }
        if (req.method === 'GET' && route === '/browsers') { sendJson(res, 200, { ok: true, browsers: await automation.browsers() }); return; }
        if (['GET', 'HEAD'].includes(req.method) && route === '/media') {
          const file = await automation.preview(String(url.searchParams.get('id') || '')); await serveMedia(req, res, file.directory, file.path); return;
        }
        if (req.method === 'POST') {
          const input = await bodyJson(req, 32 * 1024), revision = req.headers['if-match'];
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('请求必须是 JSON 对象。'), { status: 400 });
          let result;
            if (route === '/settings') await automation.settings(input, revision);
            else if (route === '/scan') result = await automation.scan(revision);
            else if (route === '/connect') await automation.connect(revision);
            else if (route === '/toggle') await automation.toggle(input.enabled, revision);
            else if (route === '/import-draft') {
              const draftId = String(input.draftId || '');
              const wb = await stateStore.read();
              const draft = wb.value?.drafts?.find(d => d.id === draftId);
              if (!draft) throw Object.assign(new Error('工作台草稿不存在。'), { status: 404 });
              assertDouyinVideoDraft(draft);
              if (draft.sourceProductionId) throw Object.assign(new Error('此成片由每日生产管理，请到每日自动生产查看，不能重复加入另一条发布队列。'), { status: 409 });
              result = await automation.importDraft({ draftId, asset: draft.asset, title: draft.pubTitle || draft.title, caption: draft.caption, tags: draft.hashtags || draft.topics }, revision);
            }
            else {
            const match = /^\/items\/([a-f0-9-]{36})\/(edit|approve|cancel|reconcile)$/.exec(route);
            if (!match) { sendJson(res, 404, { ok: false, message: '自动发布接口不存在。' }); return; }
            if (match[2] === 'cancel') await automation.cancel(match[1], revision);
            else await automation[match[2]](match[1], input, revision);
          }
          sendJson(res, 200, { ok: true, result, ...(await automation.snapshot()) }); return;
        }
      }
      if (req.method === 'GET' && ['/api/health', '/api/system'].includes(url.pathname)) {
        sendJson(res, 200, { ok: true, service: 'douyin-ops-workbuddy-workbench', version, root, dataDir: runtimeDir, node: process.version, pid: process.pid, uptime: Math.floor(process.uptime()), workbuddy: { packageReady: await exists(workbuddyConfig), connectorPath: 'workbuddy/connector', skillPath: 'SKILL.md' }, now: new Date().toISOString() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/browser-skill/status') { sendJson(res, 200, await browserSkillStatus()); return; }
      if (req.method === 'GET' && url.pathname === '/api/background-services') {
        let state;
        try { state = JSON.parse(await readFile(join(runtimeDir, 'background-services', 'state.json'), 'utf8')); }
        catch (error) {
          sendJson(res, error.code === 'ENOENT' ? 200 : 503, { ok: false, status: 'unavailable', message: '后台恢复状态暂不可用。' }); return;
        }
        const stale = !Number.isFinite(Date.parse(state.at)) || Date.now() - Date.parse(state.at) > 120_000;
        sendJson(res, 200, { ok: !stale && !state.stopping, stale, ...state }); return;
      }
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
        catch (error) { warning = '素材已上传，但活动日志未写入。'; console.warn('活动日志写入失败：', error?.message || error); }
        sendJson(res, 201, { ok: true, ...uploaded, ...(warning ? { warning } : {}) }); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/api/media') {
        const prepared = await operations.media.mediaByPath(url.searchParams.get('path'));
        if (prepared) { await serveMedia(req, res, prepared.directory, prepared.path); return; }
        const generated = await dailyProduction.mediaByPath(url.searchParams.get('path'));
        if (generated) { await serveMedia(req, res, generated.directory, generated.path); return; }
        await serveMedia(req, res, uploadDir, url.searchParams.get('path')); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') { sendJson(res, 200, { ok: true, jobs: (await jobsStore.read()).value }); return; }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const input = await bodyJson(req, 128 * 1024); const next = new Date(input.nextRunAt);
        let target;
        try { target = new URL(String(input.url || '')); }
        catch { throw Object.assign(new Error('请填写有效的抖音 HTTPS 链接。'), { status: 400 }); }
        if (!['www.douyin.com', 'douyin.com', 'creator.douyin.com'].includes(target.hostname) || target.protocol !== 'https:') throw Object.assign(new Error('任务只允许读取抖音页面。'), { status: 400 });
        if (!['currentVideo', 'creatorMetrics', 'account'].includes(input.extractor)) throw Object.assign(new Error('不支持该回采类型。'), { status: 400 });
        if (Number.isNaN(next.getTime())) throw Object.assign(new Error('执行时间无效。'), { status: 400 });
        const job = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label: String(input.label || '效果回采').slice(0, 100), url: target.href, extractor: input.extractor, repeat: ['once', 'daily', 'weekly'].includes(input.repeat) ? input.repeat : 'once', nextRunAt: next.toISOString(), enabled: true, createdAt: new Date().toISOString(), runner: 'workbuddy', lastResult: null };
        await jobsStore.update(jobs => jobs.push(job));
        await operations.legacy.sync();
        sendJson(res, 201, { ok: true, job: (await jobsStore.read()).value.find(item => item.id === job.id) }); return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/jobs/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
        const saved = await jobsStore.update(jobs => { const index = jobs.findIndex(job => job.id === id); if (index < 0) return false; jobs.splice(index, 1); return true; });
        await operations.legacy.sync();
        sendJson(res, 200, { ok: true, removed: saved.result }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/activity') { sendJson(res, 200, { ok: true, activity: (await activityStore.read()).value.slice(-100).reverse() }); return; }
      sendJson(res, 404, { ok: false, message: 'API 不存在。' });
    } catch (error) { if (res.headersSent || res.destroyed) { res.destroy(); return; } sendJson(res, error.status || 500, { ok: false, message: error instanceof SyntaxError ? 'JSON 格式不正确。' : error.message }); }
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('Invalid URL'); return; }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const target = publicPaths.get(relative);
  if (!target) { res.writeHead(404).end('Not found'); return; }
  if (target !== root && !target.startsWith(root + sep)) { res.writeHead(403).end('Forbidden'); return; }
  try { const body = await readFile(target); res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(body); }
  catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); }
});

server.on('error', error => { if (error.code === 'EADDRINUSE') { console.error(`端口 ${port} 已被占用。请关闭旧服务，或设置其他端口后重新运行。`); process.exitCode = 1; return; } throw error; });
server.listen(port, host, () => {
  void ensureProjectLocalModel(runtimeDir).catch(error => console.error('项目本地模型未就绪：' + error.message));
  console.log(`豆蜂 WorkBuddy 运营工作台已就绪：${address}`);
  void Promise.all([
    automation.start().catch(error => { automation.lastError = error.message; console.error('自动发布调度未启动：' + error.message); }),
    dailyProduction.start().catch(error => { dailyProduction.error = error.message; console.error('每日生产调度未启动：' + error.message); }),
  ]).then(() => douyinTracking.start()).catch(error => { douyinTracking.error = error.message; console.error('抖音回采调度未启动：' + error.message); });
  void operations.start().catch(error => { operations.runner.lastError = error.message; console.error('运营任务调度未启动：' + error.message); });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  automation.stop();
  dailyProduction.stop();
  douyinTracking.stop();
  void operations.stop().catch(error => console.error('运营任务收尾失败：' + error.message));
  server.close(() => { process.exitCode = 0; });
  server.closeIdleConnections();
});
