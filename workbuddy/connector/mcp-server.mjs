import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRuntime = resolve(here, '..', '..', 'runtime');
async function exists(path) { try { await access(path); return true; } catch { return false; } }
const dataDir = process.env.DOUFENG_DATA_DIR || (await exists(projectRuntime) ? projectRuntime : join(homedir(), '.doufeng-workbuddy'));
const stateFile = join(dataDir, 'workbench.json');
const jobsFile = join(dataDir, 'jobs.json');
await mkdir(dataDir, { recursive: true });

const blank = { account: '我的账号', persona: '', audience: '', pillars: '', records: [], drafts: [], metrics: [], ideas: [], research: [], comments: [], diagnosis: null };
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return structuredClone(fallback); } }
async function writeJson(path, value) { await writeFile(path, JSON.stringify(value, null, 2), 'utf8'); }
async function loadState() { return { ...blank, ...(await readJson(stateFile, blank)) }; }
function id() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }
function today() { return new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
function text(value, max = 30000) { return String(value ?? '').trim().slice(0, max); }
function result(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value }; }

const tools = [
  { name: 'workspace_summary', description: '读取豆蜂工作区概览、账号设置和各类记录数量。', inputSchema: { type: 'object', properties: {} } },
  { name: 'workspace_get', description: '读取指定业务集合。', inputSchema: { type: 'object', required: ['collection'], properties: { collection: { type: 'string', enum: ['records', 'drafts', 'metrics', 'ideas', 'research', 'comments', 'diagnosis', 'settings'] }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } },
  { name: 'workspace_settings_update', description: '更新账号名称、受众、内容支柱和表达风格。', inputSchema: { type: 'object', properties: { account: { type: 'string' }, audience: { type: 'string' }, pillars: { type: 'string' }, persona: { type: 'string' } } } },
  { name: 'diagnosis_save', description: '保存账号五维诊断和下一步建议。', inputSchema: { type: 'object', required: ['scores', 'strength', 'weakness', 'next'], properties: { scores: { type: 'array', minItems: 5, maxItems: 5, items: { type: 'number', minimum: 1, maximum: 5 } }, strength: { type: 'string' }, weakness: { type: 'string' }, next: { type: 'string' }, sample: { type: 'string' } } } },
  { name: 'research_add', description: '保存一条推荐流或对标内容观察。', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, author: { type: 'string' }, url: { type: 'string' }, hook: { type: 'string' }, structure: { type: 'string' }, takeaway: { type: 'string' }, metrics: { type: 'string' } } } },
  { name: 'idea_add', description: '保存原创选题与脚本。', inputSchema: { type: 'object', required: ['title', 'hook', 'script'], properties: { title: { type: 'string' }, angle: { type: 'string' }, hook: { type: 'string' }, script: { type: 'string' }, cta: { type: 'string' }, duration: { type: 'string' }, bgm: { type: 'string' } } } },
  { name: 'draft_add', description: '创建发布准备清单。只保存草稿，不执行发布。', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, format: { type: 'string' }, asset: { type: 'string' }, cover: { type: 'string' }, caption: { type: 'string' }, topics: { type: 'string' }, scheduledAt: { type: 'string' }, status: { type: 'string' } } } },
  { name: 'comment_draft_add', description: '保存评论回复草稿。只保存草稿，不发送。', inputSchema: { type: 'object', required: ['comment', 'reply'], properties: { comment: { type: 'string' }, context: { type: 'string' }, replyType: { type: 'string' }, reply: { type: 'string' } } } },
  { name: 'metric_add', description: '保存视频表现和复盘结论。', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, plays: { type: 'number' }, completion: { type: 'number' }, likes: { type: 'number' }, comments: { type: 'number' }, shares: { type: 'number' }, followers: { type: 'number' }, reflection: { type: 'string' } } } },
  { name: 'knowledge_search', description: '在工作区记录中按关键词检索。', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } } },
  { name: 'job_list', description: '列出计划交给 WorkBuddy 执行的数据回采任务。', inputSchema: { type: 'object', properties: {} } },
  { name: 'job_create', description: '创建数据回采计划。执行时由 WorkBuddy 调用 BrowserSkill；本工具只保存任务。', inputSchema: { type: 'object', required: ['label', 'url', 'extractor', 'nextRunAt'], properties: { label: { type: 'string' }, url: { type: 'string' }, extractor: { type: 'string', enum: ['currentVideo', 'creatorMetrics', 'account'] }, nextRunAt: { type: 'string' }, repeat: { type: 'string', enum: ['once', 'daily', 'weekly'], default: 'once' } } } },
  { name: 'job_delete', description: '删除一个数据回采计划。', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
];

async function add(collection, item, record) {
  const state = await loadState(); const saved = { id: id(), date: today(), ...item }; state[collection].push(saved);
  if (record) state.records.push({ id: id(), date: today(), ...record(saved) });
  await writeJson(stateFile, state); return saved;
}

async function callTool(name, args = {}) {
  const state = await loadState();
  if (name === 'workspace_summary') return result({ account: state.account, audience: state.audience, pillars: state.pillars, persona: state.persona, counts: Object.fromEntries(['records', 'drafts', 'metrics', 'ideas', 'research', 'comments'].map(key => [key, state[key].length])), dataDir });
  if (name === 'workspace_get') { if (args.collection === 'settings') return result({ account: state.account, audience: state.audience, pillars: state.pillars, persona: state.persona }); const value = args.collection === 'diagnosis' ? state.diagnosis : (state[args.collection] || []).slice(-Number(args.limit || 50)).reverse(); return result(value); }
  if (name === 'workspace_settings_update') { for (const key of ['account', 'audience', 'pillars', 'persona']) if (args[key] !== undefined) state[key] = text(args[key], 5000); await writeJson(stateFile, state); return result({ ok: true, settings: { account: state.account, audience: state.audience, pillars: state.pillars, persona: state.persona } }); }
  if (name === 'diagnosis_save') { state.diagnosis = { scores: args.scores.map(Number), strength: text(args.strength), weakness: text(args.weakness), next: text(args.next), sample: text(args.sample), date: today() }; state.records.push({ id: id(), date: today(), type: '诊断', category: '账号', title: '账号五维诊断', summary: `优势：${state.diagnosis.strength}\n短板：${state.diagnosis.weakness}\n下一步：${state.diagnosis.next}` }); await writeJson(stateFile, state); return result(state.diagnosis); }
  if (name === 'research_add') return result(await add('research', Object.fromEntries(Object.entries(args).map(([k, v]) => [k, text(v)])), value => ({ type: '观察', category: '模式', title: value.title, summary: `钩子：${value.hook || '—'}\n结构：${value.structure || '—'}\n可借鉴：${value.takeaway || '—'}` })));
  if (name === 'idea_add') return result(await add('ideas', Object.fromEntries(Object.entries(args).map(([k, v]) => [k, text(v)]))));
  if (name === 'draft_add') return result(await add('drafts', { pubTitle: text(args.title), format: text(args.format), asset: text(args.asset), cover: text(args.cover), caption: text(args.caption), topics: text(args.topics), scheduledAt: text(args.scheduledAt), status: text(args.status || '待人工准备') }, value => ({ type: '发布准备', category: '动作', title: value.pubTitle, summary: `形式：${value.format || '—'}\n素材：${value.asset || '待补'}\n封面：${value.cover || '待补'}` })));
  if (name === 'comment_draft_add') return result(await add('comments', { comment: text(args.comment), context: text(args.context), replyType: text(args.replyType), reply: text(args.reply) }));
  if (name === 'metric_add') return result(await add('metrics', { mTitle: text(args.title), plays: Number(args.plays || 0), completion: Number(args.completion || 0), likes: Number(args.likes || 0), mComments: Number(args.comments || 0), shares: Number(args.shares || 0), followers: Number(args.followers || 0), reflection: text(args.reflection) }, value => ({ type: '复盘', category: '复盘', title: value.mTitle, summary: `播放 ${value.plays}；完播 ${value.completion}%；互动 ${value.likes} 赞 / ${value.mComments} 评 / ${value.shares} 分享。\n下一步：${value.reflection || '待补'}` })));
  if (name === 'knowledge_search') { const query = text(args.query, 200).toLowerCase(); const limit = Number(args.limit || 20); return result(state.records.filter(item => JSON.stringify(item).toLowerCase().includes(query)).slice(-limit).reverse()); }
  if (name === 'job_list') return result((await readJson(jobsFile, [])).slice().reverse());
  if (name === 'job_create') { const url = new URL(text(args.url)); if (url.protocol !== 'https:' || !['douyin.com', 'www.douyin.com', 'creator.douyin.com'].includes(url.hostname)) throw new Error('任务只允许使用抖音 HTTPS 地址。'); const when = new Date(args.nextRunAt); if (Number.isNaN(when.getTime())) throw new Error('nextRunAt 不是有效时间。'); const jobs = await readJson(jobsFile, []); const job = { id: id(), label: text(args.label, 100), url: url.href, extractor: args.extractor, nextRunAt: when.toISOString(), repeat: args.repeat || 'once', enabled: true, runner: 'workbuddy', createdAt: new Date().toISOString(), lastResult: null }; jobs.push(job); await writeJson(jobsFile, jobs); return result(job); }
  if (name === 'job_delete') { const jobs = await readJson(jobsFile, []); const next = jobs.filter(item => item.id !== args.id); await writeJson(jobsFile, next); return result({ ok: true, removed: next.length !== jobs.length }); }
  throw new Error(`未知工具：${name}`);
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    Promise.resolve().then(async () => {
      const request = JSON.parse(line);
      if (!('id' in request)) return;
      if (request.method === 'initialize') return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'doufeng-douyin-ops', version: '1.0.0' } } });
      if (request.method === 'ping') return send({ jsonrpc: '2.0', id: request.id, result: {} });
      if (request.method === 'tools/list') return send({ jsonrpc: '2.0', id: request.id, result: { tools } });
      if (request.method === 'tools/call') return send({ jsonrpc: '2.0', id: request.id, result: await callTool(request.params?.name, request.params?.arguments || {}) });
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
    }).catch(error => { try { const request = JSON.parse(line); send({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: error.message } }); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); } });
  }
});
