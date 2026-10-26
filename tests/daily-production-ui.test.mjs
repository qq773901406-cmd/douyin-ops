import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyProduction } from '../public/daily-production.js';

test('AI萌宠页面正确呈现有声流程和授权，历史图卡不改名且打开页面不生成', async t => {
  const globals = { document: globalThis.document, fetch: globalThis.fetch, setInterval: globalThis.setInterval };
  t.after(() => Object.assign(globalThis, globals));
  const listeners = {}, calls = [];
  globalThis.document = { addEventListener: (name, handler) => { listeners[name] = handler; }, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.setInterval = () => 1;
  const snapshot = { config: { productionMode: 'ai-pet', enabled: false, sourceMode: 'news', startTime: '06:00', executionMode: 'daily', accountId: 'test-account',
    petSettings: { model: 'test-local', referenceUrls: ['https://www.douyin.com/video/123'], firstFrames: ['D:/ai/runtime/pet.png'], duration: 20, audioMode: 'original-music' } },
    runs: [{ id: 'historic-card', title: '原来的资讯图卡', sourceMode: 'news', status: 'preview', previewOnly: true, startedAt: '2026-10-24T00:00:00Z' },
      { id: 'new-pet', title: '新的原创猫咪故事', productionMode: 'ai-pet', sourceMode: 'news', status: 'selecting', startedAt: '2026-10-26T00:00:00Z' }],
    revision: 'v1', scheduleState: 'paused', busy: false, eligible: 1, readiness: { checks: [], canEnable: false }, sourceMessage: '采集萌宠参考。', metricsMessage: '每天集中回采。' };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/production-settings')) { Object.assign(snapshot.config, JSON.parse(options.body)); snapshot.revision = 'v' + calls.length; }
    return { ok: true, json: async () => structuredClone(snapshot) };
  };
  const ui = createDailyProduction({ notify: () => {}, refreshWorkspace: async () => {} });
  await ui.mount();
  const markup = ui.render();
  assert.match(markup, /AI 萌宠有声视频/);
  assert.match(markup, /原创配乐/);
  assert.match(markup, /当前没有启用中文旁白/);
  assert.match(markup, /原来的资讯图卡/);
  assert.match(markup, /采集萌宠参考中/);
  assert.doesNotMatch(markup, /从已保存的公开 RSS 来源选择最近/);
  assert.doesNotMatch(markup, /id="daily-news-feed"/);
  assert.match(markup, /id="daily-pet-visual-brief" type="text" maxlength="1500" value=""/, 'legacy settings without a brief render an empty optional single-line field');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');

  const brief = '两只现有小猫在室内地板上，保留首帧中的外观和背景，不新增道具。';
  listeners.input({ target: { id: 'daily-pet-visual-brief', value: brief } });
  listeners.input({ target: { id: 'daily-pet-model', value: 'another-local' } });
  assert.equal(calls.length, 1, 'editing a model must not save, generate or publish');
  const button = { dataset: { daily: 'production-settings' }, disabled: false };
  await listeners.click({ target: { closest: selector => selector === '[data-daily]' ? button : null } });
  const saved = calls.find(call => call.path.endsWith('/production-settings'));
  assert.ok(saved);
  assert.equal(JSON.parse(saved.options.body).petSettings.model, 'another-local');
  assert.equal(JSON.parse(saved.options.body).petSettings.visualBrief, brief);
  assert.deepEqual(JSON.parse(saved.options.body).petSettings.firstFrames, ['D:/ai/runtime/pet.png']);
  assert.equal(saved.options.headers['If-Match'], 'v1');
  assert.ok(ui.render().includes(brief), 'the server response retains the saved visual brief in the form');
  listeners.input({ target: { id: 'daily-pet-model', value: 'third-local' } });
  await listeners.click({ target: { closest: selector => selector === '[data-daily]' ? button : null } });
  assert.equal(JSON.parse(calls.at(-1).options.body).petSettings.visualBrief, brief, 'editing another setting after save does not drop the brief');
  listeners.input({ target: { id: 'daily-pet-visual-brief', value: '' } });
  await listeners.click({ target: { closest: selector => selector === '[data-daily]' ? button : null } });
  assert.equal(JSON.parse(calls.at(-1).options.body).petSettings.visualBrief, '', 'the optional brief can be explicitly cleared');
  assert.equal(calls.some(call => /\/preview|\/toggle/.test(call.path)), false);
});

test('预览生成处置须单独确认，关闭或未勾选不提交，保存只追加处置而不制作发布', async t => {
  const globals = { document: globalThis.document, fetch: globalThis.fetch, setInterval: globalThis.setInterval };
  t.after(() => Object.assign(globalThis, globals));
  const listeners = {}, calls = [], dialogs = [], notices = [];
  globalThis.document = {
    addEventListener: (name, handler) => { listeners[name] = handler; }, querySelector: () => null, querySelectorAll: () => [],
    body: { append: el => { dialogs.push(el); } },
    createElement: type => {
      assert.equal(type, 'dialog');
      const handlers = {}, note = { value: '', disabled: false }, confirmed = { checked: false, disabled: false };
      const form = { elements: { note, confirmed } }, close = { disabled: false }, submit = { disabled: false }, error = { textContent: '' };
      return {
        closed: false, form, error, closeButton: close,
        addEventListener: (name, handler) => { (handlers[name] ||= []).push(handler); },
        querySelector: selector => selector === 'form' ? form : selector === '.form-error' ? error : selector === '[data-dialog-close]' ? close : null,
        querySelectorAll: () => [close, submit, note, confirmed], showModal() {}, remove() {},
        close() { this.closed = true; for (const handler of handlers.close || []) handler(); },
        cancel() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; for (const handler of handlers.cancel || []) handler(event); if (!event.prevented) this.close(); return event; }
      };
    }
  };
  globalThis.setInterval = () => 1;
  const run = { id: 'unknown-preview', title: '<原预览>', previewOnly: true, trigger: 'preview', status: 'failed', productionMode: 'ai-pet', generationState: 'uncertain', finishedAt: '2026-10-26T00:00:00Z' };
  const snapshot = { config: { productionMode: 'ai-pet', enabled: false, startTime: '06:00', executionMode: 'daily', petSettings: {} },
    runs: [run, { ...run, id: 'unknown-publication', previewOnly: false, status: 'uncertain', submitStartedAt: '2026-10-26T00:00:00Z' }],
    generationResolutionStatus: [{ runId: run.id, abandoned: false, canAbandon: true }, { runId: 'unknown-publication', abandoned: false, canAbandon: false }],
    generationResolutions: [], revision: 'v1', busy: false, readiness: { checks: [] } };
  let release, started;
  const postStarted = new Promise(resolve => { started = resolve; });
  const postGate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/resolve-generation')) {
      started(); await postGate;
      snapshot.generationResolutionStatus[0] = { runId: run.id, abandoned: true, canAbandon: false };
      snapshot.generationResolutions.push({ runId: run.id, action: 'abandon-preview', note: JSON.parse(options.body).note });
      snapshot.revision = 'v2';
    }
    return { ok: true, json: async () => structuredClone(snapshot) };
  };
  const ui = createDailyProduction({ notify: value => notices.push(value), refreshWorkspace: async () => {} });
  const click = async (id = run.id) => listeners.click({ target: { closest: selector => selector === '[data-daily]' ? { disabled: false, dataset: { daily: 'resolve-generation', id } } : null } });
  const submit = async el => el.form.onsubmit({ preventDefault() {}, stopPropagation() {} });
  await ui.mount();
  assert.match(ui.render(), /data-daily="resolve-generation" data-id="unknown-preview"/);
  assert.doesNotMatch(ui.render(), /data-daily="resolve-generation" data-id="unknown-publication"/);
  await click('unknown-publication');
  assert.equal(dialogs.length, 0, 'published/unknown submission has no generation abandonment dialog');
  await click();
  assert.match(dialogs[0].innerHTML, /原生成结果仍不确定/);
  assert.match(dialogs[0].innerHTML, /不会立即生成、启用计划或发布/);
  assert.match(dialogs[0].innerHTML, /&lt;原预览&gt;/);
  assert.equal(calls.length, 1, 'opening a dialog sends no request');
  dialogs[0].closeButton.onclick();
  assert.equal(dialogs[0].closed, true);
  assert.equal(calls.length, 1, 'closing is read-only');
  await click(); dialogs[1].cancel();
  assert.equal(dialogs[1].closed, true);
  assert.equal(calls.length, 1, 'Esc before submission is read-only');
  await click(); const el = dialogs[2];
  el.form.elements.note.value = '已核实原任务未取回，决定保留未知回执并放弃取回。';
  await submit(el);
  assert.equal(calls.length, 1, 'unchecked confirmation cannot mutate');
  assert.match(el.error.textContent, /勾选确认/);
  el.form.elements.confirmed.checked = true;
  const pending = submit(el); await postStarted;
  await submit(el);
  assert.equal(calls.filter(call => call.path.endsWith('/resolve-generation')).length, 1, 'double submit is blocked');
  assert.equal(el.cancel().prevented, true, 'pending request cannot be dismissed as unsubmitted');
  release(); await pending;
  const post = calls[1];
  assert.equal(post.path, '/api/daily-production/resolve-generation');
  assert.equal(post.options.headers['If-Match'], 'v1');
  assert.deepEqual(JSON.parse(post.options.body), { id: run.id, action: 'abandon-preview', confirmed: true, note: el.form.elements.note.value });
  assert.equal(calls.length, 2, 'the only mutation is disposition; no generation, plan enabling, publishing or refresh request');
  assert.equal(snapshot.config.enabled, false);
  assert.equal(run.status, 'failed'); assert.equal(run.generationState, 'uncertain');
  assert.match(ui.render(), /已放弃取回此预览/);
  assert.match(ui.render(), /这不是成功成片或发布记录/);
  assert.doesNotMatch(ui.render(), /data-daily="resolve-generation" data-id="unknown-preview"/);
  assert.match(notices.at(-1), /原未知回执保留/);
});
