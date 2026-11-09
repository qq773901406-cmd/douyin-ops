import { setTimeout as delay } from 'node:timers/promises';

export const WORKER_PROTOCOL = 'doufeng-dsh-worker-v1';
export const WORKER_REPOSITORY = 'qq773901406-cmd/douyin-ops';
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const steeringStates = new Set(['delivered', 'queued', 'unavailable', 'uncertain']);

export function validateSteeringInput({ ticketId, assignmentId, inputId, text } = {}) {
  if (![ticketId, assignmentId, inputId].every(id) || typeof text !== 'string' || !text.trim() || text.length > 16000) throw fault('Worker 追加消息的身份或正文无效。');
  return { ticketId, assignmentId, inputId, text };
}

export function workerEndpoint(value) {
  let url; try { url = new URL(value); } catch { throw fault('Worker 地址无效。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fault('Worker 仅接受明确的本机回环 HTTP 根地址。');
  return url.origin;
}

export function validateWorkerRequest({ ticket, assignmentId }) {
  if (!id(ticket?.id) || !id(assignmentId)) throw fault('Worker 任务或派工编号无效。');
  if (ticket.repository !== WORKER_REPOSITORY || ticket.mandate?.repository !== WORKER_REPOSITORY) throw fault('Worker 仓库不在允许范围内。', 403);
  if (ticket.mandate.executionAllowed !== true && ticket.mandate.allowExecution !== true && ticket.mandate.allowed?.execute !== true) throw fault('此任务未获代码执行授权。', 403);
  if (ticket.mandate.allowMerge === true || ticket.mandate.autoMerge === true || ticket.mandate.allowed?.merge === true || ticket.mode === 'observe') throw fault('观察任务或自动合并授权不能交给 Worker。', 403);
  const scope = ticket.mandate.scope;
  if (typeof scope !== 'string' || !scope.trim() || scope.length > 16000) throw fault('Worker 需要明确且有界的任务范围。');
  if (ticket.executionPrompt !== undefined && (typeof ticket.executionPrompt !== 'string' || ticket.executionPrompt.length > 12000)) throw fault('Worker 团队约束提示词无效。');
  const inputs = ticket.inputs || ticket.messages || [];
  if (!Array.isArray(inputs) || inputs.length > 100 || inputs.some(input => typeof input.text !== 'string' || input.text.length > 16000)) throw fault('Worker 输入格式无效。');
  return { assignmentId, ticket: { id: ticket.id, repository: WORKER_REPOSITORY,
    mandate: { repository: WORKER_REPOSITORY, scope, executionAllowed: true, allowMerge: false },
    inputs: inputs.map(input => ({ text: input.text })), ...(ticket.executionPrompt ? { executionPrompt: ticket.executionPrompt } : {}) } };
}

export function validateWorkerReport(value) {
  if (!value || !['ready', 'waiting_answer', 'blocked', 'failed'].includes(value.status)
    || typeof value.summary !== 'string' || value.summary.length > 32000
    || value.question !== undefined && (typeof value.question !== 'string' || value.question.length > 4000)
    || value.status === 'waiting_answer' && !value.question?.trim()
    || value.sessionId !== undefined && !id(value.sessionId)) throw fault('Worker 返回了无效的结构化报告。', 502);
  // Publication is a separate supervisor operation. A model-provided URL is
  // never evidence that a PR was opened, and is deliberately not propagated.
  if (value.changes !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(value.baseCommit || '') || !Array.isArray(value.changes) || value.changes.length > 100) throw fault('Worker 文件变更回执无效。', 502);
    let total = 0; const seen = new Set();
    for (const change of value.changes) {
      if (!safeSourcePath(change.path) || seen.has(change.path) || change.content !== null && typeof change.content !== 'string') throw fault('Worker 包含禁止交付的路径或内容。', 502);
      seen.add(change.path); total += Buffer.byteLength(change.content || '');
    }
    if (total > 1024 * 1024) throw fault('Worker 变更超过 1 MiB 交付上限。', 502);
  }
  return { status: value.status, summary: value.summary, ...(value.question ? { question: value.question } : {}),
    ...(value.sessionId ? { sessionId: value.sessionId } : {}), ...(value.assignmentId ? { assignmentId: value.assignmentId } : {}),
    ...(value.changes ? { baseCommit: value.baseCommit, changes: value.changes.map(change => ({ path: change.path, content: change.content })) } : {}) };
}

const sourceDirectories = new Set(['public', 'src', 'server', 'shared', 'lib', 'scripts', 'tests', 'integrations', 'workbuddy', 'tools', 'references', 'docs']);
export function safeSourcePath(path) {
  if (typeof path !== 'string' || !path || path.length > 300 || /[\\:\x00-\x1f]/.test(path) || path.startsWith('/') || path.endsWith('/') || path.includes('//')) return false;
  const parts = path.split('/');
  if (parts.some(part => part === '.' || part === '..' || /^(?:runtime|node_modules|output|\.git|\.aws|\.ssh|\.codex|\.agents|\.runtime-backups|\.env(?:\..*)?)$/i.test(part)
    || /(?:credential|secret|browser.?state|cookies|token|\.pem$|\.key$)/i.test(part))) return false;
  return (parts.length === 1 || sourceDirectories.has(parts[0])) && /\.(?:m?js|cjs|ts|tsx|jsx|json|md|css|html|svg|py|yml|yaml|txt)$/.test(path);
}

export class DshExecutor {
  constructor({ settings = {}, fetchImpl = fetch, env = process.env, pollMs = 1000 } = {}) {
    this.settings = settings; this.fetch = fetchImpl; this.env = env; this.pollMs = pollMs;
  }
  config() {
    const all = typeof this.settings === 'function' ? this.settings() : this.settings;
    const config = all.worker || {};
    if (!config.enabled) throw fault('独立 DSH Worker 尚未启用。', 503);
    if (all.repository !== WORKER_REPOSITORY || config.isolated !== true) throw fault('请先配置固定仓库和独立 Worker 隔离部署。', 503);
    const name = config.tokenEnv || 'SUPERAGENT_WORKER_TOKEN';
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw fault('Worker 令牌环境变量名无效。', 503);
    const token = this.env[name];
    if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw fault('Worker 身份令牌未配置。', 503);
    const timeoutMs = config.timeoutMs ?? 600000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw fault('Worker 超时配置无效。', 503);
    return { endpoint: workerEndpoint(config.endpoint), token, timeoutMs };
  }
  async call(path, { method = 'GET', body, signal, timeoutMs = 10000 } = {}) {
    const config = this.config();
    let response;
    try { response = await this.fetch(config.endpoint + path, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers: { Authorization: `Bearer ${config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw fault('无法访问独立 Worker；结果可能尚未确认，请先核对派工状态。', 503); }
    if (!response.ok) throw Object.assign(fault(`Worker 请求未完成（HTTP ${response.status}）。`, response.status === 409 ? 409 : 502), { httpStatus: response.status });
    let data; try { data = await response.json(); } catch { throw fault('Worker 响应无法读取。', 502); }
    if (data.protocol !== WORKER_PROTOCOL) throw fault('Worker 协议不兼容。', 502);
    return data;
  }
  async health() {
    try {
      const data = await this.call('/v1/health');
      return { ready: data.ready === true, steering: data.steering === true, state: data.ready ? 'ready' : 'unavailable', message: data.ready ? '独立 DSH Worker 已就绪。' : 'Worker 部署检查未通过。', protocol: WORKER_PROTOCOL };
    } catch (error) { return { ready: false, state: 'unavailable', message: error.message }; }
  }
  async execute({ ticket, assignmentId, signal, onProgress } = {}) {
    const input = validateWorkerRequest({ ticket, assignmentId });
    const config = this.config(), deadline = Date.now() + config.timeoutMs;
    const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) : AbortSignal.timeout(config.timeoutMs);
    try {
      let result = await this.call('/v1/assignments', { method: 'POST', body: input, signal: lifetime });
      while (result.state === 'running') {
        onProgress?.({ message: '独立 DSH Session 正在处理任务。', sessionId: result.sessionId });
        if (Date.now() >= deadline) throw fault('Worker 执行超时。', 504);
        await delay(this.pollMs, undefined, { signal: lifetime });
        result = await this.call(`/v1/assignments/${encodeURIComponent(assignmentId)}`, { signal: lifetime });
      }
      if (result.assignmentId !== assignmentId || result.ticketId !== ticket.id) throw fault('Worker 回执不属于当前派工。', 502);
      const report = validateWorkerReport({ ...result.report, assignmentId, sessionId: result.sessionId });
      if (result.deliveredInputIds !== undefined) {
        if (!Array.isArray(result.deliveredInputIds) || result.deliveredInputIds.length > 100 || !result.deliveredInputIds.every(id)) throw fault('Worker 追加消息回执无效。', 502);
        report.deliveredInputIds = [...new Set(result.deliveredInputIds)];
      }
      return report;
    } catch (error) {
      // Either POST or a subsequent poll may fail after a process started.
      // A stop keyed to this exact assignment also fences a delayed launch.
      if (lifetime.aborted || ![400, 403, 404, 409, 413].includes(error.httpStatus)) {
        await this.stop({ ticketId: ticket.id, assignmentId }).catch(() => {});
        if (lifetime.aborted) throw fault('Worker 已请求停止；请以持久化派工回执确认最终状态。', 503);
      }
      throw error;
    }
  }
  async steer({ signal, ...raw }) {
    const { ticketId, assignmentId, inputId, text } = validateSteeringInput(raw);
    const identity = { ticketId, assignmentId, inputId };
    if (signal?.aborted) return { ...identity, status: 'unavailable' };
    this.config();
    try {
      const response = await this.call(`/v1/assignments/${assignmentId}/inputs`, { method: 'POST', body: { ticketId, inputId, text }, signal });
      if (!steeringStates.has(response.status) || Object.entries(identity).some(([key, value]) => response[key] !== value)) return { ...identity, status: 'uncertain' };
      return { ...identity, status: response.status };
    } catch (error) {
      if (error.httpStatus === 409) throw error;
      return { ...identity, status: [400, 403, 404, 405, 413].includes(error.httpStatus) ? 'unavailable' : 'uncertain' };
    }
  }
  async stop({ ticketId, assignmentId }) {
    if (!id(ticketId) || !id(assignmentId)) throw fault('Worker 任务编号无效。');
    const receipt = await this.call(`/v1/assignments/${encodeURIComponent(assignmentId)}/stop`, { method: 'POST', body: { ticketId } });
    if (receipt.ticketId !== ticketId || receipt.assignmentId !== assignmentId || receipt.state !== 'done') throw fault('Worker 尚未确认目标派工已经结束。', 503);
    return receipt;
  }
}
