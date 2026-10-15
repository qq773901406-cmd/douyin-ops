import { mkdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { JsonStore } from './lib/json-store.mjs';
import { normalizeState } from './lib/workspace-model.mjs';
import { validateVideo, videoPrompt, videoStatuses } from './lib/video-projects.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRuntime = resolve(here, '..', '..', 'runtime');
async function exists(path) { try { await access(path); return true; } catch { return false; } }
const dataDir = process.env.DOUFENG_DATA_DIR || (await exists(projectRuntime) ? projectRuntime : join(homedir(), '.doufeng-workbuddy'));
const stateFile = join(dataDir, 'workbench.json');
const jobsFile = join(dataDir, 'jobs.json');
await mkdir(dataDir, { recursive: true });

const stateStore = new JsonStore(stateFile, normalizeState(), normalizeState, { snapshots: true });
const jobsStore = new JsonStore(jobsFile, [], value => { if (!Array.isArray(value)) throw new Error('回采数据必须是列表。'); return value; });
async function loadState() { return (await stateStore.read()).value; }
function id() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }
function today() { return new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
function text(value, max = 30000) { return String(value ?? '').trim().slice(0, max); }
function result(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value }; }

const videoSchema = { type: 'object', required: ['title', 'shots'], properties: {
  id: { type: 'string' }, title: { type: 'string' }, subject: { type: 'string' }, setting: { type: 'string' }, style: { type: 'string' },
  ratio: { type: 'string', enum: ['9:16', '16:9', '1:1'] }, budget: { type: 'string', enum: ['free', 'confirm'] },
  provider: { type: 'string' }, cost: { type: 'string', description: '预计人民币费用，未知时为空字符串。' },
  status: { type: 'string', enum: Object.keys(videoStatuses) }, asset: { type: 'string' }, blocker: { type: 'string' }, notes: { type: 'string' },
  shots: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['seconds', 'action'], properties: { seconds: { type: 'integer', minimum: 1, maximum: 120 }, action: { type: 'string' }, camera: { type: 'string' } } } }
} };
const tools = [
  { name: 'video_project_save', description: '保存视频分镜、费用约束、状态和成片位置。只管理制作计划，不生成视频。更新现有项目须提供 expectedUpdatedAt，先用 workspace_get 的 videos 集合读取。', inputSchema: { type: 'object', required: ['project'], properties: { project: videoSchema, expectedUpdatedAt: { type: 'string' } } } },
  { name: 'video_project_prompt', description: '读取已保存视频项目的完整制作提示词，不执行生成。', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'workspace_summary', description: '读取豆蜂工作区概览、账号设置和各类记录数量。', inputSchema: { type: 'object', properties: {} } },
  { name: 'workspace_get', description: '读取指定业务集合。', inputSchema: { type: 'object', required: ['collection'], properties: { collection: { type: 'string', enum: ['records', 'drafts', 'metrics', 'ideas', 'research', 'comments', 'videos', 'diagnosis', 'settings'] }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } },
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

async function add(state, collection, item, record) {
  const saved = { id: id(), date: today(), ...item }; state[collection].push(saved);
  if (record) state.records.push({ id: id(), date: today(), ...record(saved) });
  return saved;
}

async function callToolWithState(name, args, state) {
  if (name === 'video_project_save') {
    const input = args.project;
    const existing = input.id ? state.videos.find(p => p.id === input.id) : null;
    if (input.id && !existing) throw new Error('视频项目不存在，请重新读取。');
    if (existing && existing.updatedAt !== args.expectedUpdatedAt) throw new Error('视频项目已更新，请重新读取并提供 expectedUpdatedAt。');
    const now = new Date().toISOString();
    const project = validateVideo({ ...existing, ...input, id: existing?.id || id(), createdAt: existing?.createdAt || now, updatedAt: now });
    if (existing) state.videos[state.videos.indexOf(existing)] = project; else state.videos.push(project);
    return result(project);
  }
  if (name === 'video_project_prompt') { const project = state.videos.find(p => p.id === args.id); if (!project) throw new Error('视频项目不存在。'); return result({ id: project.id, prompt: videoPrompt(project) }); }
  if (name === 'workspace_summary') return result({ account: state.account, audience: state.audience, pillars: state.pillars, persona: state.persona, counts: Object.fromEntries(['records', 'drafts', 'metrics', 'ideas', 'research', 'comments', 'videos'].map(key => [key, state[key].length])), dataDir });
  if (name === 'workspace_get') { if (args.collection === 'settings') return result({ account: state.account, audience: state.audience, pillars: state.pillars, persona: state.persona }); const value = args.collection === 'diagnosis' ? state.diagnosis : (state[args.collection] || []).slice(-Number(args.limit || 50)).reverse(); return result(value); }
  if (name === 'workspace_settings_update') { for (const key of ['account', 'audience', 'pillars', 'persona']) if (args[key] !== undefined) state[key] = text(args[key], 5000); return result({ ok: true, settings: { account: state.account, audience: state.audience, pillars: state.pillars, persona: state.persona } }); }
  if (name === 'diagnosis_save') { state.diagnosis = { scores: args.scores.map(Number), strength: text(args.strength), weakness: text(args.weakness), next: text(args.next), sample: text(args.sample), date: today() }; state.records.push({ id: id(), date: today(), type: '诊断', category: '账号', title: '账号五维诊断', summary: `优势：${state.diagnosis.strength}\n短板：${state.diagnosis.weakness}\n下一步：${state.diagnosis.next}` }); return result(state.diagnosis); }
  if (name === 'research_add') return result(await add(state, 'research', Object.fromEntries(Object.entries(args).map(([k, v]) => [k, text(v)])), value => ({ type: '观察', category: '模式', title: value.title, summary: `钩子：${value.hook || '—'}\n结构：${value.structure || '—'}\n可借鉴：${value.takeaway || '—'}` })));
  if (name === 'idea_add') return result(await add(state, 'ideas', Object.fromEntries(Object.entries(args).map(([k, v]) => [k, text(v)]))));
  if (name === 'draft_add') return result(await add(state, 'drafts', { pubTitle: text(args.title), format: text(args.format), asset: text(args.asset), cover: text(args.cover), caption: text(args.caption), hashtags: text(args.topics), scheduledAt: text(args.scheduledAt), status: text(args.status || '待人工准备') }, value => ({ type: '发布准备', category: '动作', title: value.pubTitle, summary: `形式：${value.format || '—'}\n素材：${value.asset || '待补'}\n封面：${value.cover || '待补'}` })));
  if (name === 'comment_draft_add') return result(await add(state, 'comments', { comment: text(args.comment), context: text(args.context), replyType: text(args.replyType), reply: text(args.reply) }));
  if (name === 'metric_add') return result(await add(state, 'metrics', { mTitle: text(args.title), plays: Number(args.plays || 0), completion: Number(args.completion || 0), likes: Number(args.likes || 0), mComments: Number(args.comments || 0), shares: Number(args.shares || 0), followers: Number(args.followers || 0), reflection: text(args.reflection) }, value => ({ type: '复盘', category: '复盘', title: value.mTitle, summary: `播放 ${value.plays}；完播 ${value.completion}%；互动 ${value.likes} 赞 / ${value.mComments} 评 / ${value.shares} 分享。\n下一步：${value.reflection || '待补'}` })));
  if (name === 'knowledge_search') { const query = text(args.query, 200).toLowerCase(); const limit = Number(args.limit || 20); return result(state.records.filter(item => JSON.stringify(item).toLowerCase().includes(query)).slice(-limit).reverse()); }
  if (name === 'job_list') return result((await jobsStore.read()).value.slice().reverse());
  if (name === 'job_create') { const url = new URL(text(args.url)); if (url.protocol !== 'https:' || !['douyin.com', 'www.douyin.com', 'creator.douyin.com'].includes(url.hostname)) throw new Error('任务只允许使用抖音 HTTPS 地址。'); const when = new Date(args.nextRunAt); if (Number.isNaN(when.getTime())) throw new Error('nextRunAt 不是有效时间。'); const job = { id: id(), label: text(args.label, 100), url: url.href, extractor: args.extractor, nextRunAt: when.toISOString(), repeat: args.repeat || 'once', enabled: true, runner: 'workbuddy', createdAt: new Date().toISOString(), lastResult: null }; await jobsStore.update(jobs => jobs.push(job)); return result(job); }
  if (name === 'job_delete') { const saved = await jobsStore.update(jobs => { const index = jobs.findIndex(item => item.id === args.id); if (index < 0) return false; jobs.splice(index, 1); return true; }); return result({ ok: true, removed: saved.result }); }
  throw new Error(`未知工具：${name}`);
}

const stateWrites = new Set(['workspace_settings_update', 'diagnosis_save', 'research_add', 'idea_add', 'draft_add', 'comment_draft_add', 'metric_add', 'video_project_save']);
function validateArgs(value, schema, path = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(path + ' 必须是对象。');
    for (const key of schema.required || []) if (value[key] === undefined) throw new Error(path + '.' + key + ' 必填。');
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) throw new Error(path + '.' + key + ' 不是支持的参数。');
      validateArgs(item, schema.properties[key], path + '.' + key);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(path + ' 列表长度无效。');
    value.forEach((item, i) => validateArgs(item, schema.items, path + '[' + i + ']'));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > 30000) throw new Error(path + ' 必须是 30000 字以内的文本。');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(path + ' 数值无效。');
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(path + ' 的选项无效。');
}
async function callTool(name, args = {}) {
  const tool = tools.find(tool => tool.name === name);
  if (!tool) throw new Error('未知工具：' + name);
  validateArgs(args, tool.inputSchema);
  if (stateWrites.has(name)) return (await stateStore.update(state => callToolWithState(name, args, state))).result;
  return callToolWithState(name, args, name.startsWith('job_') ? null : await loadState());
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
      if (request.method === 'initialize') return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'doufeng-douyin-ops', version: '1.1.0' } } });
      if (request.method === 'ping') return send({ jsonrpc: '2.0', id: request.id, result: {} });
      if (request.method === 'tools/list') return send({ jsonrpc: '2.0', id: request.id, result: { tools } });
      if (request.method === 'tools/call') return send({ jsonrpc: '2.0', id: request.id, result: await callTool(request.params?.name, request.params?.arguments || {}) });
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
    }).catch(error => { try { const request = JSON.parse(line); send({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: error.message } }); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); } });
  }
});
