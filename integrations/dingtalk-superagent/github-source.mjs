import { GitHubClient } from './github-delivery.mjs';

const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const bounded = value => typeof value === 'string' ? value.slice(0, 12000) : '';
const positive = value => Number.isSafeInteger(value) && value > 0;

export class GitHubSource extends GitHubClient {
  constructor({ onEvent, now = () => new Date(), ...options } = {}) { super(options); this.onEvent = onEvent; this.now = now; }
  async poll({ cursor, pullNumbers = [], baseBranch = 'main' } = {}) {
    if (cursor && !instant(cursor) || !Array.isArray(pullNumbers) || pullNumbers.length > 100 || pullNumbers.some(n => !positive(n))
      || typeof baseBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(baseBranch) || baseBranch.includes('..') || baseBranch.includes('//') || baseBranch.endsWith('/')) throw new Error('GitHub 轮询游标、分支或订阅列表无效。');
    const started = new Date(this.now()).toISOString();
    // Replay one minute across boundaries; stable IDs make overlap harmless.
    const since = cursor ? new Date(Date.parse(cursor) - 60000).toISOString() : started;
    const events = [], event = (kind, item, number, details = {}) => {
      if (!item || !positive(item.id) || !positive(number) && !(number === null && details.branch)) throw new Error('GitHub 事件结构无效，游标未推进。');
      const at = item.updated_at || item.submitted_at || item.completed_at || item.started_at || item.created_at;
      if (!instant(at)) throw new Error('GitHub 事件时间无效，游标未推进。');
      events.push({ id: `github:${kind}:${item.id}:${at}:${item.state || item.status || ''}:${item.conclusion || ''}`,
        source: 'github', kind, conversationId: `github:${this.repository}#${number}`, number,
        senderId: item.user?.login || item.app?.slug || '', bot: item.user?.type === 'Bot' || !!item.app,
        text: bounded([item.title || item.name, item.body, details.state].filter(Boolean).join('\n')),
        createdAt: at, repository: this.repository, ...details });
    };
    const query = `state=all&sort=updated&direction=asc&since=${encodeURIComponent(since)}`;
    const issues = await this.list(`/issues?${query}`);
    for (const issue of issues) event(issue.pull_request ? 'pull' : 'issue', issue, issue.number, { state: issue.state });
    const comments = await this.list(`/issues/comments?sort=updated&direction=asc&since=${encodeURIComponent(since)}`);
    for (const comment of comments) {
      const prefix = `https://api.github.com/repos/${this.repository}/issues/`;
      if (typeof comment.issue_url !== 'string' || !comment.issue_url.startsWith(prefix)) throw new Error('GitHub 评论目标无效。');
      event('comment', comment, Number(comment.issue_url.slice(prefix.length)));
    }
    const reviewComments = await this.list(`/pulls/comments?sort=updated&direction=asc&since=${encodeURIComponent(since)}`);
    for (const comment of reviewComments) {
      const prefix = `https://api.github.com/repos/${this.repository}/pulls/`;
      if (typeof comment.pull_request_url !== 'string' || !comment.pull_request_url.startsWith(prefix)) throw new Error('GitHub 审查评论目标无效。');
      event('review-comment', comment, Number(comment.pull_request_url.slice(prefix.length)), { commitId: comment.commit_id });
    }
    const tracked = [...new Set([...pullNumbers, ...issues.filter(item => item.pull_request).map(item => item.number)])];
    if (tracked.length > 100) throw new Error('GitHub 本轮 PR 超过上限，游标未推进。');
    for (const n of tracked) {
      const { data: pr } = await this.request(`/pulls/${n}`);
      event('pull-state', pr, n, { state: pr.merged_at ? 'merged' : pr.state, headSha: pr.head?.sha });
      for (const review of await this.list(`/pulls/${n}/reviews`)) if (review.submitted_at) event('review', review, n, { state: review.state });
      if (!/^[a-f0-9]{40,64}$/i.test(pr.head?.sha || '')) throw new Error('GitHub PR 提交无效。');
      for (const check of await this.list(`/commits/${pr.head.sha}/check-runs`, { field: 'check_runs' })) event('check', check, n, { state: check.conclusion || check.status, headSha: pr.head.sha });
    }
    for (const check of await this.list(`/commits/${encodeURIComponent(baseBranch)}/check-runs?filter=all`, { field: 'check_runs' })) {
      event('default-check', check, null, { state: check.conclusion || check.status, headSha: check.head_sha, branch: baseBranch,
        conversationId: `github:${this.repository}#branch:${baseBranch}` });
    }
    events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    // If any receiver fails, this call has no next cursor. Retried prior events
    // retain IDs and the host's durable event store deduplicates them.
    if (this.onEvent) for (const item of events) await this.onEvent(item);
    return { events, cursor: started, complete: true };
  }
}
