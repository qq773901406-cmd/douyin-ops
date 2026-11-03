import { REPOSITORY } from './policy.mjs';
import { createHash } from 'node:crypto';

const fail = (message, code = 'github_error', extra = {}) => Object.assign(new Error(message), { code, status: 503, ...extra });
const number = value => { if (!Number.isSafeInteger(value) || value < 1) throw fail('GitHub 编号无效。', 'invalid_input', { status: 400 }); return value; };
const ref = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.lock');

export class GitHubClient {
  constructor({ repository = REPOSITORY, fetchImpl = fetch, token = process.env.SUPERAGENT_GITHUB_TOKEN || '', beforeWrite, signal } = {}) {
    if (repository !== REPOSITORY) throw fail('GitHub 只允许已授权仓库。', 'repository_not_allowed', { status: 400 });
    this.repository = repository; this.fetchImpl = fetchImpl; this.token = token; this.beforeWrite = beforeWrite; this.signal = signal;
  }
  async request(path, { method = 'GET', body } = {}) {
    if (!path.startsWith('/') || path.includes('..') || path.includes('://')) throw fail('GitHub API 路径无效。', 'invalid_input', { status: 400 });
    const refPatch = /^\/git\/refs\/heads\/codex\/ticket-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
    if (!['GET', 'POST', 'PATCH'].includes(method) || method === 'POST' && !['/pulls', '/git/blobs', '/git/trees', '/git/commits', '/git/refs'].includes(path) && !/^\/issues\/[1-9]\d*\/comments$/.test(path)
      || method === 'PATCH' && (!refPatch.test(path) || body?.force !== false || !/^[a-f0-9]{40}$/.test(body?.sha || ''))) throw fail('GitHub 写入操作不允许。', 'operation_not_allowed', { status: 403 });
    if (method !== 'GET' && !this.token) throw fail('缺少本机 SUPERAGENT_GITHUB_TOKEN。', 'credentials_missing');
    if (this.signal?.aborted) throw fail('GitHub 交付已停止。', 'delivery_cancelled', { status: 409 });
    if (method !== 'GET') await this.beforeWrite?.({ method, path });
    if (this.signal?.aborted) throw fail('GitHub 交付已停止。', 'delivery_cancelled', { status: 409 });
    let response;
    try {
      response = await this.fetchImpl(`https://api.github.com/repos/${this.repository}${path}`, {
        method, redirect: 'error', signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), headers: {
          Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'doufeng-superagent',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
        }, ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw fail(method === 'GET' ? 'GitHub 读取暂不可用。' : 'GitHub 创建 PR 结果未知，请先核对已有 PR。', method === 'GET' ? 'read_failed' : 'delivery_uncertain', { retryable: method === 'GET', uncertain: method !== 'GET' }); }
    if (!response.ok) throw fail(`GitHub API 返回 HTTP ${response.status}。`, response.status === 429 || response.status === 403 && response.headers?.get('x-ratelimit-remaining') === '0' ? 'rate_limited' : 'github_rejected', { httpStatus: response.status, retryable: method === 'GET' && (response.status === 429 || response.status >= 500), uncertain: method !== 'GET' && response.status >= 500 });
    try { return { data: await response.json(), headers: response.headers }; }
    catch { throw fail('GitHub 响应无法读取。', method === 'GET' ? 'invalid_response' : 'delivery_uncertain', { uncertain: method !== 'GET' }); }
  }
  async list(path, { field, maxPages = 20 } = {}) {
    const result = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data, headers } = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = field ? data?.[field] : data;
      if (!Array.isArray(rows)) throw fail('GitHub 列表格式无效。', 'invalid_response');
      result.push(...rows);
      if (!/rel="next"/.test(headers?.get('link') || '')) return result;
    }
    throw fail('GitHub 列表超过本轮读取上限，游标未推进。', 'pagination_limit');
  }
}

// Delivery deliberately exposes no merge, close or delete operation.
export class GitHubDelivery extends GitHubClient {
  async commentIssue(value, text) {
    const n = number(value);
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw fail('GitHub 回复内容无效。', 'invalid_input', { status: 400 });
    const key = createHash('sha256').update(JSON.stringify([this.repository, n, text])).digest('hex');
    const marker = `<!-- doufeng-superagent:${key} -->`;
    const comments = await this.list(`/issues/${n}/comments`);
    const existing = comments.find(comment => typeof comment.body === 'string' && comment.body.endsWith(marker));
    if (existing) return { sent: true, existing: true, id: existing.id };
    const { data } = await this.request(`/issues/${n}/comments`, { method: 'POST', body: { body: `${text.trim()}\n\n${marker}` } });
    if (!Number.isSafeInteger(data?.id) || data.id < 1) throw fail('GitHub 回复结果无法确认。', 'delivery_uncertain', { uncertain: true });
    return { sent: true, existing: false, id: data.id };
  }
  async publishChanges({ ticketId, baseCommit, changes, title, body, baseBranch = 'main', expectedHead }) {
    if (typeof ticketId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ticketId)
      || !/^[a-f0-9]{40}$/.test(baseCommit || '') || !Array.isArray(changes) || !changes.length || changes.length > 100
      || typeof title !== 'string' || !title.trim() || title.length > 256 || typeof body !== 'string' || body.length > 60000
      || !ref(baseBranch) || expectedHead !== undefined && !/^[a-f0-9]{40}$/.test(expectedHead)) throw fail('代码交付参数无效。', 'invalid_input', { status: 400 });
    let bytes = 0; const seen = new Set();
    for (const change of changes) {
      const path = change?.path;
      if (typeof path !== 'string' || path.length > 240 || !/^[A-Za-z0-9_.\-/]+$/.test(path) || path.startsWith('/')
        || path.split('/').some(part => !part || part === '.' || part === '..' || /^(?:runtime|\.runtime-backups|\.git|\.codex|\.agents|\.aws|\.ssh|node_modules|output|browser|browsers|credentials|secrets|\.env.*)$/i.test(part))
        || /^\.github\/workflows\//i.test(path) || /(?:^|[/_.-])(?:credentials?|secrets?|tokens?|cookies?|storage-?state)(?:[/.\-_]|$)/i.test(path)
        || seen.has(path) || !(change.content === null || typeof change.content === 'string')) throw fail('改动包含禁止交付的路径或内容。', 'path_not_allowed', { status: 400 });
      seen.add(path); bytes += Buffer.byteLength(change.content || '');
      if (bytes > 1024 * 1024 || typeof change.content === 'string' && change.content.includes('\0')) throw fail('代码改动超过 1 MiB 或包含二进制内容。', 'invalid_input', { status: 400 });
    }
    if (!this.token) throw fail('缺少本机 SUPERAGENT_GITHUB_TOKEN。', 'credentials_missing');
    const head = `codex/ticket-${ticketId}`, marker = `${title.trim()}\n\nSuperagent-Ticket: ${ticketId}`;
    const base = (await this.request(`/git/commits/${baseCommit}`)).data;
    if (!/^[a-f0-9]{40}$/.test(base.tree?.sha || '') || base.sha !== baseCommit) throw fail('仓库基线提交无法确认。', 'invalid_response');
    let branch;
    try { branch = (await this.request(`/git/ref/heads/${head}`)).data; }
    catch (error) { if (error.httpStatus !== 404) throw error; }
    if (!branch && expectedHead) throw fail('先前交付分支已不存在，请人工核对后创建新任务。', 'branch_conflict', { status: 409 });
    if (branch && !/^[a-f0-9]{40}$/.test(branch.object?.sha || '')) throw fail('任务分支提交无法确认。', 'invalid_response');
    const entries = [];
    for (const change of changes) {
      let sha = null;
      if (change.content !== null) {
        const content = Buffer.from(change.content, 'utf8');
        const expected = createHash('sha1').update(Buffer.from(`blob ${content.length}\0`)).update(content).digest('hex');
        const blob = (await this.request('/git/blobs', { method: 'POST', body: { content: content.toString('base64'), encoding: 'base64' } })).data;
        if (blob.sha !== expected) throw fail('GitHub 文件对象校验失败。', 'invalid_response');
        sha = blob.sha;
      }
      entries.push({ path: change.path, mode: '100644', type: 'blob', sha });
    }
    const tree = (await this.request('/git/trees', { method: 'POST', body: { base_tree: base.tree.sha, tree: entries } })).data;
    if (!/^[a-f0-9]{40}$/.test(tree.sha || '') || tree.sha === base.tree.sha) throw fail('代码树无改动或响应无效。', 'invalid_response');
    let commitSha;
    if (branch) {
      const previous = (await this.request(`/git/commits/${branch.object?.sha}`)).data;
      if (previous.tree?.sha === tree.sha && previous.message === marker && previous.parents?.length === 1
        && (previous.parents[0].sha === baseCommit || previous.parents[0].sha === expectedHead || previous.sha === expectedHead)) commitSha = previous.sha;
      else {
        if (!expectedHead || branch.object.sha !== expectedHead) throw fail('任务分支已存在且内容不同；保留已有分支，未覆盖。', 'branch_conflict', { status: 409 });
        const commit = (await this.request('/git/commits', { method: 'POST', body: { message: marker, tree: tree.sha, parents: [expectedHead] } })).data;
        if (!/^[a-f0-9]{40}$/.test(commit.sha || '')) throw fail('GitHub 提交响应无效。', 'invalid_response');
        // Check again after object creation. Never overwrite intervening work;
        // force:false also rejects a later concurrent divergent update.
        const latest = (await this.request(`/git/ref/heads/${head}`)).data;
        if (latest.object?.sha !== expectedHead) throw fail('任务分支在交付期间已变化，未更新。', 'branch_conflict', { status: 409 });
        await this.request(`/git/refs/heads/${head}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
        commitSha = commit.sha;
      }
    } else {
      const commit = (await this.request('/git/commits', { method: 'POST', body: { message: marker, tree: tree.sha, parents: [baseCommit] } })).data;
      if (!/^[a-f0-9]{40}$/.test(commit.sha || '')) throw fail('GitHub 提交响应无效。', 'invalid_response');
      commitSha = commit.sha;
      await this.request('/git/refs', { method: 'POST', body: { ref: `refs/heads/${head}`, sha: commitSha } });
    }
    return { ...(await this.createDraftPR({ head, base: baseBranch, title, body })), commitSha, branch: head };
  }
  async createDraftPR({ head, base = 'main', title, body }) {
    if (!ref(head) || !head.startsWith('codex/') || !ref(base) || head === base || typeof title !== 'string' || !title.trim() || title.length > 256 || typeof body !== 'string' || body.length > 60000) throw fail('PR 参数无效；开发分支必须以 codex/ 开头。', 'invalid_input', { status: 400 });
    const owner = this.repository.split('/')[0];
    const existing = await this.list(`/pulls?state=all&head=${encodeURIComponent(owner + ':' + head)}&base=${encodeURIComponent(base)}`);
    const previous = existing.find(pr => pr.head?.ref === head && pr.base?.ref === base && pr.head?.repo?.full_name?.toLowerCase() === this.repository.toLowerCase());
    if (previous) return { ...publicPR(previous), existing: true };
    const { data } = await this.request('/pulls', { method: 'POST', body: { title: title.trim(), head, base, body, draft: true, maintainer_can_modify: false } });
    return { ...publicPR(data), existing: false };
  }
  async getPR(value) { return publicPR((await this.request(`/pulls/${number(value)}`)).data); }
  async reviews(value) { return this.list(`/pulls/${number(value)}/reviews`); }
  async checks(sha) {
    if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(sha)) throw fail('Git 提交 SHA 无效。', 'invalid_input', { status: 400 });
    return this.list(`/commits/${sha}/check-runs`, { field: 'check_runs' });
  }
}
export function publicPR(pr) {
  if (!Number.isSafeInteger(pr?.number) || !['open', 'closed'].includes(pr.state)) throw fail('GitHub PR 响应无效。', 'invalid_response');
  const expected = `https://github.com/${REPOSITORY}/pull/${pr.number}`;
  if (pr.html_url !== expected) throw fail('GitHub PR 不属于已授权仓库。', 'repository_not_allowed');
  return { number: pr.number, url: expected, prUrl: expected, state: pr.state, draft: pr.draft === true, merged: pr.merged === true || !!pr.merged_at,
    head: pr.head?.ref, headSha: pr.head?.sha, base: pr.base?.ref };
}
