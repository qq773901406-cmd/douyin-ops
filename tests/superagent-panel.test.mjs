import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuperagentPanel, safePullRequestUrl, settingsFormValues, settingsFromForm } from '../public/superagent-panel.js';

const settings = () => ({ mode: 'observe', acceptMode: 'observe', paused: false, repository: 'qq773901406-cmd/douyin-ops', concurrency: 1, source: { enabled: false, corpId: '', clientId: '', allowedUserIds: [], allowedConversationIds: [] }, model: { enabled: false, endpoint: 'http://127.0.0.1:11434', name: '' }, worker: { enabled: false, endpoint: '', isolated: false }, github: { enabled: false, baseBranch: 'main' }, prompts: { router: '', worker: '' }, rules: [] });
const snapshot = () => ({ revision: 'r1', settingsRevision: 's1', settings: settings(), tickets: [], events: [], decisions: [], outbox: [], health: {}, worker: { ready: false, message: '未配置 Worker' }, settingsHistory: [] });
const ticket = () => ({ id: 'ticket-1', title: '<img src=x onerror=alert(1)>', status: 'observed', source: 'local', conversationId: 'local-console', inputs: [{ text: '</textarea><script>alert(1)</script>', senderId: 'local', at: '2026-11-02T00:00:00.000Z' }], createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' });

class Node {
  constructor() { this.innerHTML = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.dataset = {}; this.attributes = new Map(); }
  hasChildNodes() { return !!this.innerHTML; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, value); }
}
async function fixture(t) {
  const old = { document: globalThis.document, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const elements = new Map(), listeners = new Map(), requests = [], notifications = [];
  const selectors = ['[data-sg-error]', '[data-sg-mode]', '[data-sg-updated]', '[data-sg-stats]', '[data-sg-content]', '[data-sg-tickets]', '[data-sg-ticket-count]', '[data-sg-events]', '[data-sg-decisions]', '[data-sg-health]', '[data-sg-outbox]', '[data-sg-settings-error]', '[data-sg-settings-revision]', '[data-sg-settings-history]', '[data-sg-legacy]', '[data-superagent="pause"]', '[data-superagent="refresh"]', '[data-superagent="more"]'];
  for (const selector of selectors) elements.set(selector, new Node());
  const root = { querySelector: selector => elements.get(selector) || null, querySelectorAll: () => [] };
  let current = snapshot(), apiError, mutate;
  globalThis.document = { getElementById: id => id === 'superagent-root' ? root : null, addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } };
  globalThis.setTimeout = () => 1; globalThis.clearTimeout = () => {};
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, options, body: options.body ? JSON.parse(options.body) : undefined }; requests.push(call);
    if (apiError && (!options.method || options.method === 'GET')) throw new Error(apiError);
    if (mutate && options.method && options.method !== 'GET') return mutate(call);
    return new Response(JSON.stringify(current), { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { Object.assign(globalThis, old); });
  const panel = createSuperagentPanel({ notify: message => notifications.push(message) });
  const click = async (action, extra = {}) => panel.handleClick({ target: { closest: () => ({ dataset: { superagent: action, ...extra } }) } });
  return { panel, click, requests, elements, listeners, notifications, setState: value => { current = value; }, setError: value => { apiError = value; }, setMutation: value => { mutate = value; }, root };
}

// These checks guard trust boundaries and revision/draft behavior, not CSS markup.
test('PR links are restricted to the configured repository and canonicalized', () => {
  assert.equal(safePullRequestUrl('https://github.com/qq773901406-cmd/douyin-ops/pull/12?token=hidden#fragment'), 'https://github.com/qq773901406-cmd/douyin-ops/pull/12');
  for (const url of ['javascript:alert(1)', 'https://github.com.evil.test/qq773901406-cmd/douyin-ops/pull/12', 'https://github.com/other/repo/pull/12', 'https://user:pass@github.com/qq773901406-cmd/douyin-ops/pull/12', 'http://github.com/qq773901406-cmd/douyin-ops/pull/12', 'https://github.com/qq773901406-cmd/douyin-ops/pull/12/files']) assert.equal(safePullRequestUrl(url), null);
});

test('settings form preserves deployment fields and rejects invalid rules/concurrency', () => {
  const base = settings(); base.worker.timeoutMs = 90000; base.worker.tokenEnv = 'WORKER_TOKEN'; base.prompts.router = '<script>text</script>';
  const values = settingsFormValues(base); values.allowedUserIds = 'u1\nu2，u3'; values.workerEnabled = true;
  const result = settingsFromForm(values, base);
  assert.deepEqual(result.source.allowedUserIds, ['u1', 'u2', 'u3']); assert.equal(result.worker.timeoutMs, 90000); assert.equal(result.worker.tokenEnv, 'WORKER_TOKEN');
  assert.equal(result.worker.enabled, true); assert.equal(result.prompts.router, base.prompts.router); assert.equal(base.worker.enabled, false);
  assert.throws(() => settingsFromForm({ ...values, rules: '{}' }, base), /JSON 数组/);
  assert.throws(() => settingsFromForm({ ...values, concurrency: '1.5' }, base), /整数/);
  assert.throws(() => settingsFromForm({ ...values, concurrency: '5' }, base), /1–4/);
});

test('task content is escaped and execution is unavailable until worker and mode are ready', async t => {
  const f = await fixture(t), state = snapshot(); state.tickets = [ticket()]; f.setState(state); await f.panel.mount();
  let html = f.elements.get('[data-sg-tickets]').innerHTML;
  assert.ok(html.includes('&lt;img')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.match(html, /data-superagent="queue"[^>]*disabled/);
  state.settings.mode = 'manual'; state.worker.ready = true; state.revision = 'r2'; f.setState(state); await f.click('refresh');
  html = f.elements.get('[data-sg-tickets]').innerHTML; assert.doesNotMatch(html, /data-superagent="queue"[^>]*disabled/);
  await f.click('queue', { id: 'ticket-1' });
  const queued = f.requests.find(call => call.url.endsWith('/ticket-1/queue'));
  assert.equal(queued.options.headers['If-Match'], 'r2'); assert.deepEqual(queued.body, {});
});

test('settings edits survive polling and retain their original conflict revision', async t => {
  const f = await fixture(t), state = snapshot(); f.setState(state); await f.panel.mount(); await f.click('tab', { tab: 'settings' });
  const values = settingsFormValues(state.settings); values.modelName = 'my-unsaved-model';
  const form = { id: 'sg-settings-form', elements: Object.entries(values).map(([name, value]) => ({ name, type: typeof value === 'boolean' ? 'checkbox' : 'text', checked: value, value })), querySelector: () => null };
  f.elements.set('#sg-settings-form', form);
  for (const handler of f.listeners.get('input')) handler({ target: { closest: () => form } });
  const updated = snapshot(); updated.settingsRevision = 's2'; updated.settings.model.name = 'another-editor-model'; f.setState(updated); await f.click('refresh');
  assert.match(f.elements.get('[data-sg-settings-revision]').textContent, /新版本/);
  f.setMutation(call => { assert.equal(call.options.headers['If-Match'], 's1'); assert.equal(call.body.model.name, 'my-unsaved-model'); return new Response(JSON.stringify({ message: '版本冲突' }), { status: 409 }); });
  for (const handler of f.listeners.get('submit')) await handler({ target: form, preventDefault() {}, stopImmediatePropagation() {} });
  assert.match(f.elements.get('[data-sg-settings-error]').textContent, /草稿已保留/);
  assert.equal(form.elements.find(item => item.name === 'modelName').value, 'my-unsaved-model');
});

test('request retries reuse an idempotency key after uncertain delivery', async t => {
  const f = await fixture(t); await f.panel.mount();
  const field = { value: '检查工作台空状态' }, error = new Node();
  const form = { id: 'sg-request-form', elements: [], querySelector: selector => selector.includes('requestText') ? field : error };
  f.elements.set('[name="requestText"]', field);
  f.setMutation(() => { throw new Error('连接中断'); });
  const submit = f.listeners.get('submit')[0], event = { target: form, preventDefault() {}, stopImmediatePropagation() {} };
  await submit(event); await submit(event);
  const requests = f.requests.filter(call => call.url.endsWith('/requests'));
  assert.equal(requests.length, 2); assert.equal(requests[0].body.idempotencyKey, requests[1].body.idempotencyKey);
  assert.equal(field.value, '检查工作台空状态'); assert.match(error.textContent, /内容已保留/);
});

test('a settings tab opened before the first response can initialize safely', async t => {
  const f = await fixture(t); await f.click('tab', { tab: 'settings' }); await f.panel.mount();
  assert.ok(f.elements.get('[data-sg-content]').innerHTML.includes('sg-settings-form'));
});

test('assessment suggestions are shown as suggestions and cannot evaluate a failed task', async t => {
  const f = await fixture(t), state = snapshot(); state.tickets = [{ ...ticket(), status: 'failed' }]; state.settings.model.enabled = true;
  state.decisions = [{ ticketId: 'ticket-1', action: 'accept', outcome: 'would_accept', reason: '范围明确', matchedRules: [] }];
  f.setState(state); await f.panel.mount();
  assert.doesNotMatch(f.elements.get('[data-sg-tickets]').innerHTML, /data-superagent="evaluate"/);
  assert.match(f.elements.get('[data-sg-tickets]').innerHTML, /data-superagent="complete"/);
  await f.click('tab', { tab: 'events' });
  assert.match(f.elements.get('[data-sg-decisions]').innerHTML, /观察建议：可接单/);
});

test('outbox reconciliation allows retries only for known failures and uses current revision', async t => {
  const f = await fixture(t), state = snapshot(); state.revision = 'delivery-r2';
  state.outbox = [{ id: 'uncertain-1', status: 'uncertain', text: '结果未知' }, { id: 'failed-1', status: 'failed', text: '已确认失败' }, { id: 'withdrawn-1', status: 'withdrawn', text: '旧消息' }];
  f.setState(state); await f.panel.mount(); await f.click('tab', { tab: 'health' });
  const html = f.elements.get('[data-sg-outbox]').innerHTML;
  assert.match(html, /已撤销/); assert.match(html, /请先核对原会话/);
  assert.doesNotMatch(html, /data-superagent="delivery-retry"[^>]*data-id="uncertain-1"/);
  assert.match(html, /data-superagent="delivery-retry"[^>]*data-id="failed-1"/);
  await f.click('delivery-retry', { id: 'uncertain-1' });
  assert.equal(f.requests.filter(call => call.url.endsWith('/reconcile')).length, 0);
  assert.match(f.notifications.at(-1), /不能重发/);
  for (const [action, id, resolution] of [['delivery-sent', 'uncertain-1', 'sent'], ['delivery-withdrawn', 'uncertain-1', 'withdrawn'], ['delivery-retry', 'failed-1', 'retry']]) {
    await f.click(action, { id });
    const call = f.requests.filter(item => item.url.endsWith('/reconcile')).at(-1);
    assert.equal(call.url, `/api/superagent/workflow/outbox/${id}/reconcile`);
    assert.equal(call.options.headers['If-Match'], 'delivery-r2');
    assert.deepEqual(call.body, { resolution });
  }
});
