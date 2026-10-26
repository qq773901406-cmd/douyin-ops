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
  globalThis.fetch = async (path, options) => { calls.push({ path, options }); return { ok: true, json: async () => structuredClone(snapshot) }; };
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');

  listeners.input({ target: { id: 'daily-pet-model', value: 'another-local' } });
  assert.equal(calls.length, 1, 'editing a model must not save, generate or publish');
  const button = { dataset: { daily: 'production-settings' }, disabled: false };
  await listeners.click({ target: { closest: selector => selector === '[data-daily]' ? button : null } });
  const saved = calls.find(call => call.path.endsWith('/production-settings'));
  assert.ok(saved);
  assert.equal(JSON.parse(saved.options.body).petSettings.model, 'another-local');
  assert.equal(saved.options.headers['If-Match'], 'v1');
  assert.equal(calls.some(call => /\/preview|\/toggle/.test(call.path)), false);
});
