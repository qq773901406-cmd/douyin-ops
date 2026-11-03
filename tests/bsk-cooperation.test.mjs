import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DouyinPublisher } from '../server/douyin-publisher.mjs';

const home = 'https://creator.douyin.com/creator-micro/home';
const editor = 'https://creator.douyin.com/creator-micro/content/post/video';
const opt = (args, name) => args[args.indexOf(name) + 1];
const inspection = session => ['evaluate', '({url:location.href})', '--session', session];

async function fixture(t, { syncPatch = () => ({}), evaluate, evaluateFailure, waitReply, actionFailure } = {}) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'doufeng-cooperation-test-'));
  const calls = [], used = new Set(), counts = new Map();
  const urls = new Map(), titles = new Map(), captions = new Map(), submitted = new Set();
  let serial = 0;
  const tabs = new Map([['1', { tab_id: 1, scope: 'agent', active: true, url: home }], ['2', { tab_id: 2, scope: 'agent', active: false, url: 'https://www.douyin.com/user/self' }]]);
  const ok = value => ({ ok: true, stdout: JSON.stringify(value) });
  const run = async args => {
    calls.push([...args]);
    const session = args.includes('--session') ? opt(args, '--session') : null;
    const context = args.includes('--context') ? opt(args, '--context') : null;
    if (context) {
      assert.ok(context.startsWith(`${session}-`), 'contexts must not cross sessions');
      assert.ok(!used.has(context), 'context must never be reused');
      used.add(context);
    }
    if (args[0] === 'session') {
      if (args[1] === 'start') return ok({ session_id: 'owned', browser_instance_id: 'browser' });
      if (args.includes('--claim')) return ok({ state: 'active', session: { session_id: 'owned' } });
      return ok({});
    }
    if (args[0] === 'cooperate' && args[1] === 'wait') return ok(waitReply || { ready: true });
    if (args[0] === 'cooperate') {
      const n = (counts.get(session) || 0) + 1; counts.set(session, n);
      const baselineFile = args.includes('--baseline') ? opt(args, '--baseline') : null;
      const previous = baselineFile ? JSON.parse(await readFile(baselineFile, 'utf8')) : null;
      if (baselineFile) assert.equal(previous.observation_origin.session_id, session);
      const result = {
        context_id: `${session}-${++serial}`, tab_id: args.includes('--tab-id') ? Number(opt(args, '--tab-id')) : previous?.tab_id || 1,
        state: { mode: 'ready', editing: false }, activity: [],
        kind: previous ? 'unchanged' : 'baseline', previous_context_id: previous?.context_id,
        history_complete: !!previous, changes: [],
        observation_origin: { session_id: session }, observation: { text: 'fixture visible DOM' },
        ...syncPatch({ n, session, previous }),
      };
      await writeFile(opt(args, '--save-full'), JSON.stringify(result));
      return ok(result);
    }
    if (args[0] === 'evaluate') {
      const readFailure = typeof evaluateFailure === 'function' ? evaluateFailure({ args, session, calls }) : evaluateFailure;
      if (readFailure) return { ok: false, stdout: JSON.stringify(readFailure) };
      if (evaluate) return ok({ value: await evaluate({ args, session, calls }) });
      const url = urls.get(session) || home;
      return ok({ value: { url, accountIds: ['account'], upload: '#upload', uploaded: true, uploading: false,
        title: { selector: '#title', value: titles.get(session) || '' }, caption: { selector: '#caption', value: captions.get(session) || '' },
        publish: '#publish', publicVisible: true, immediateVisible: true, success: submitted.has(session) ? '提交成功' : '',
        settings: { covers: { vertical: { saved: true }, horizontal: { saved: true } }, noCrosspost: true, declaration: { open: false } },
      } });
    }
    if (args[0] === 'tab') {
      if (args[1] === 'list') return ok({ tabs: [...tabs.values()].map(tab => ({ ...tab })) });
      assert.equal(args.includes('--context'), false, '0.4 tab API has no context flag');
      if (args[1] === 'select') for (const tab of tabs.values()) tab.active = String(tab.tab_id) === args[2];
      if (args[1] === 'close') tabs.delete(args[2]);
      return ok({});
    }
    const failure = actionFailure?.(args);
    if (failure) return { ok: false, stdout: JSON.stringify(failure), stderr: 'private command line' };
    if (args[0] === 'navigate') urls.set(session, args[1]);
    if (args[0] === 'upload') urls.set(session, editor);
    if (args[0] === 'fill') (opt(args, '--selector') === '#title' ? titles : captions).set(session, opt(args, '--value'));
    if (args[0] === 'click' && opt(args, '--selector') === '#publish') submitted.add(session);
    return ok({});
  };
  const publisher = new DouyinPublisher({ run, cooperationOptions: { tempRoot } });
  const open = async session => { await publisher.cooperation.open(session); return session; };
  t.after(async () => {
    for (const session of [...publisher.cooperation.sessions.keys()]) await publisher.cooperation.close(session);
    assert.deepEqual(await readdir(tempRoot), []);
    await rm(tempRoot, { recursive: true, force: true });
  });
  return { publisher, open, calls, counts, tabs, tempRoot };
}

test('0.4 inspection uses exact saved predecessor; every action consumes one context', async t => {
  const f = await fixture(t); await f.open('a');
  await f.publisher.command(['navigate', home, '--session', 'a']);
  await f.publisher.page('a');
  await f.publisher.command(['fill', '--selector', '#title', '--value', 'title', '--session', 'a']);
  await assert.rejects(f.publisher.command(['click', '--selector', '#publish', '--session', 'a']), error => error.code === 'cooperation_fresh_inspection_required');
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 0);
  const commands = f.calls.filter(args => args[0] === 'fill' || args[0] === 'evaluate');
  assert.ok(commands.every(args => args.includes('--context') && args.includes('--tab-id')));
  const syncs = f.calls.filter(args => args[0] === 'cooperate');
  assert.ok(syncs.slice(1).every(args => args.includes('--baseline')));
  assert.equal(opt(syncs[2], '--baseline'), opt(syncs[1], '--save-full'));
});

test('DOM delta discards stale selectors and repeats only the fixed read, never a mutation', async t => {
  let reads = 0;
  const f = await fixture(t, {
    syncPatch: ({ n }) => n === 2 ? { kind: 'delta', changes: [{ type: 'changed' }] } : {},
    evaluate: () => ({ url: home, publish: ++reads === 1 ? '#old' : '#new' }),
  });
  await f.open('a');
  const result = await f.publisher.inspectDOM(inspection('a'));
  assert.equal(result.value.publish, '#new');
  await f.publisher.command(['click', '--selector', result.value.publish, '--session', 'a']);
  assert.equal(reads, 2);
  assert.deepEqual(f.calls.filter(args => args[0] === 'click').map(args => opt(args, '--selector')), ['#new']);
});

test('arbitrary evaluate is dispatched once; changed post-state cannot authorize an old action', async t => {
  const f = await fixture(t, { syncPatch: ({ n }) => n === 2 ? { kind: 'delta', changes: ['change'] } : {} });
  await f.open('a');
  await assert.rejects(f.publisher.command(inspection('a')), error => error.code === 'cooperation_page_changed');
  await assert.rejects(f.publisher.command(['click', '--selector', '#old', '--session', 'a']), error => error.code === 'cooperation_fresh_inspection_required');
  assert.equal(f.calls.filter(args => args[0] === 'evaluate').length, 1);
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 0);
});

for (const bad of [
  { history_complete: false }, { previous_context_id: 'wrong' },
  { kind: 'baseline' }, { changes: ['changed'] },
]) test(`unproven post-inspection state fails closed: ${JSON.stringify(bad)}`, async t => {
  const f = await fixture(t, { syncPatch: ({ n }) => n % 2 === 0 ? bad : {} });
  await f.open('a');
  await assert.rejects(f.publisher.page('a'), error => error.code === 'cooperation_page_changed');
  assert.equal(f.calls.filter(args => args[0] === 'evaluate').length, 3);
  await assert.rejects(f.publisher.command(['click', '--selector', '#old', '--session', 'a']));
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 0);
});

for (const state of [
  { state: { mode: 'manual_hold' }, ready: false },
  { state: { mode: 'ready', editing: true } },
  { state: { mode: 'user_aborted' }, stopped: true },
  { activity: [{ type: 'human_input' }] },
]) test(`human control stops this session before any script/action: ${JSON.stringify(state)}`, async t => {
  const f = await fixture(t, { syncPatch: () => state }); await f.open('a');
  await assert.rejects(f.publisher.page('a'));
  await assert.rejects(f.publisher.page('a'));
  assert.ok(f.calls.every(args => args[0] === 'cooperate'), 'only read-only coordination; no automatic page resume');
  if (state.stopped) assert.equal(f.calls.length, 1);
});

test('human activity between DOM read and post-sync rejects the observed value', async t => {
  const f = await fixture(t, { syncPatch: ({ n }) => n === 2 ? { activity: [{ type: 'human_input' }] } : {} }); await f.open('a');
  await assert.rejects(f.publisher.page('a'), error => error.code === 'cooperation_human_activity');
  await assert.rejects(f.publisher.command(['click', '--selector', '#publish', '--session', 'a']));
  assert.equal(f.calls.filter(args => args[0] === 'evaluate').length, 1);
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 0);
});

for (const reason of ['cooperation_sync_required', 'user_aborted']) test(`${reason} from dispatched action is not retried with a new context`, async t => {
  const f = await fixture(t, { actionFailure: args => args[0] === 'click' ? { code: 'permission_denied', data: { reason, effect_state: 'unknown' }, message: 'private caption' } : null });
  await f.open('a'); await f.publisher.page('a');
  await assert.rejects(f.publisher.command(['click', '--selector', '#publish', '--session', 'a']), error => error.code === 'permission_denied' && error.reason === reason && error.effectState === 'unknown' && !JSON.stringify(error).includes('private'));
  await assert.rejects(f.publisher.page('a'));
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 1);
});

test('separate sessions keep isolated contexts/baselines; concurrent same-session dispatch is refused', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { evaluate: async ({ session }) => { if (session === 'a') { entered(); await gate; } return { url: home }; } });
  await f.open('a'); await f.open('b');
  const pending = f.publisher.page('a'); await ready;
  await assert.rejects(f.publisher.page('a'), error => error.code === 'cooperation_session_busy');
  await f.publisher.page('b');
  release(); await pending;
  await f.publisher.command(['click', '--selector', '#b', '--session', 'b']);
  await f.publisher.command(['click', '--selector', '#a', '--session', 'a']);
  const files = f.calls.filter(args => args[0] === 'cooperate').map(args => [opt(args, '--session'), path.dirname(opt(args, '--save-full'))]);
  assert.notEqual(files.find(([id]) => id === 'a')[1], files.find(([id]) => id === 'b')[1]);
});

test('subsequent navigation checks current location and uses the new inspection once', async t => {
  const f = await fixture(t, { evaluate: () => ({ url: 'https://example.com/unrelated' }) }); await f.open('a');
  await f.publisher.command(['navigate', home, '--session', 'a']);
  await assert.rejects(f.publisher.command(['navigate', home, '--session', 'a']), error => error.code === 'cooperation_location_changed');
  assert.equal(f.calls.filter(args => args[0] === 'navigate').length, 1);
});

test('tab interface checks observed Agent target and human state; never appends unsupported context', async t => {
  const f = await fixture(t); await f.open('a');
  await assert.rejects(f.publisher.command(['tab', 'select', '900', '--session', 'a']));
  await f.publisher.command(['tab', 'list', '--scope', 'agent', '--session', 'a']);
  await f.publisher.command(['tab', 'select', '2', '--session', 'a']);
  assert.equal(f.tabs.get('2').active, true);
  await f.publisher.command(['tab', 'close', '2', '--session', 'a']);
  assert.equal(f.tabs.has('2'), false);
  assert.ok(f.calls.filter(args => args[0] === 'tab').every(args => !args.includes('--context')));
});

test('full publication preserves beforeSubmit and dispatches exactly one final click on unknown outcome', async t => {
  const f = await fixture(t, { actionFailure: args => args[0] === 'click' ? { code: 'timeout', data: { effect_state: 'unknown' } } : null });
  let beforeSubmit = 0;
  const approval = { browserId: 'browser', accountId: 'account', asset: 'test.mp4', title: 'approved title', caption: 'approved caption' };
  await assert.rejects(f.publisher.publish({ approval }, { guard: async () => {}, beforeSubmit: async () => { beforeSubmit++; } }), error => error.code === 'timeout');
  assert.equal(beforeSubmit, 1);
  assert.equal(f.calls.filter(args => args[0] === 'upload').length, 1);
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 1);
  assert.equal(f.calls.filter(args => args[0] === 'session' && args[1] === 'stop').length, 1);
  assert.equal(f.publisher.cooperation.sessions.size, 0);
  assert.deepEqual(await readdir(f.tempRoot), []);
});


test('tab change during inspection never silently follows a different task tab', async t => {
  const f = await fixture(t, { syncPatch: ({ n }) => n === 2 ? { tab_id: 99 } : {} }); await f.open('a');
  await assert.rejects(f.publisher.page('a'), error => error.code === 'cooperation_tab_changed');
  assert.equal(f.calls.filter(args => args[0] === 'evaluate').length, 1);
  await assert.rejects(f.publisher.page('a'));
});

test('an aborted read stops the session, including later batch cleanup actions', async t => {
  const f = await fixture(t, { evaluate: () => { throw new Error('untrusted private CLI text'); } }); await f.open('a');
  await assert.rejects(f.publisher.page('a'), error => !error.message.includes('private'));
  const count = f.calls.length;
  await assert.rejects(f.publisher.command(['tab', 'list', '--session', 'a', '--scope', 'agent']));
  assert.equal(f.calls.length, count);
});


test('hold release collects a fresh sync but requires reconciliation, not automatic page continuation', async t => {
  const f = await fixture(t, { syncPatch: ({ n }) => n === 1 ? { ready: false, state: { mode: 'manual_hold' } } : {} }); await f.open('a');
  await assert.rejects(f.publisher.page('a'), error => error.code === 'cooperation_requires_reconcile' && error.requiresReconcile);
  assert.deepEqual(f.calls.map(args => args.slice(0, 2)), [['cooperate', 'sync'], ['cooperate', 'wait'], ['cooperate', 'sync']]);
  const count = f.calls.length;
  await assert.rejects(f.publisher.page('a'));
  assert.equal(f.calls.length, count);
});

test('structured user_aborted during evaluate halts even if a later sync could be ready', async t => {
  const f = await fixture(t, { evaluateFailure: { code: 'permission_denied', data: { reason: 'user_aborted', effect_state: 'none' } } }); await f.open('a');
  await assert.rejects(f.publisher.page('a'), error => error.reason === 'user_aborted');
  const count = f.calls.length;
  await assert.rejects(f.publisher.page('a'), error => error.reason === 'user_aborted');
  assert.equal(f.calls.length, count);
});

test('one inspection deadline includes both synchronizations and evaluation', async t => {
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const f = await fixture(t, { syncPatch: () => { clock += 15; return {}; } }); await f.open('a');
  await assert.rejects(f.publisher.inspectDOM(inspection('a'), 25), error => error.code === 'cooperation_deadline');
  await assert.rejects(f.publisher.command(['click', '--selector', '#stale', '--session', 'a']));
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 0);
});


test('all sync calls opt into the official read-only settle policy', async t => {
  const f = await fixture(t); await f.open('a');
  await f.publisher.page('a');
  assert.ok(f.calls.filter(args => args[0] === 'cooperate' && args[1] === 'sync').every(args => args.includes('--settle')));
});

test('fixed read refused with explicit none waits and recomputes on the original tab', async t => {
  let reads = 0;
  const f = await fixture(t, {
    evaluateFailure: () => ++reads === 1 ? { code: 'permission_denied', data: { reason: 'cooperation_sync_required', effect_state: 'none' } } : null,
    evaluate: () => ({ url: home, publish: '#current' }),
  }); await f.open('a');
  const page = await f.publisher.page('a');
  assert.equal(page.publish, '#current');
  await f.publisher.command(['click', '--selector', page.publish, '--session', 'a']);
  assert.equal(reads, 2);
  assert.equal(f.calls.filter(args => args[0] === 'cooperate' && args[1] === 'wait').length, 1);
  assert.ok(f.calls.filter(args => args[0] === 'evaluate').every(args => opt(args, '--tab-id') === '1'));
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 1);
});

for (const effect of ['unknown', undefined]) test(`read refusal with ${effect} effects never retries`, async t => {
  const f = await fixture(t, { evaluateFailure: { code: 'permission_denied', data: { reason: 'cooperation_sync_required', effect_state: effect } } }); await f.open('a');
  await assert.rejects(f.publisher.page('a'));
  assert.equal(f.calls.filter(args => args[0] === 'evaluate').length, 1);
  assert.equal(f.calls.some(args => args[0] === 'cooperate' && args[1] === 'wait'), false);
});

test('arbitrary evaluate has no stale-read retry even with explicit no effects', async t => {
  const f = await fixture(t, { evaluateFailure: { code: 'permission_denied', data: { reason: 'cooperation_sync_required', effect_state: 'none' } } }); await f.open('a');
  await assert.rejects(f.publisher.command(inspection('a')));
  assert.equal(f.calls.filter(args => args[0] === 'evaluate').length, 1);
  assert.equal(f.calls.some(args => args[0] === 'cooperate' && args[1] === 'wait'), false);
});

test('fixed read stale recovery is bounded to three attempts and two waits', async t => {
  const f = await fixture(t, { evaluateFailure: { code: 'permission_denied', data: { reason: 'cooperation_sync_required', effect_state: 'none' } } }); await f.open('a');
  await assert.rejects(f.publisher.page('a'));
  assert.equal(f.calls.filter(args => args[0] === 'evaluate').length, 3);
  assert.equal(f.calls.filter(args => args[0] === 'cooperate' && args[1] === 'wait').length, 2);
  await assert.rejects(f.publisher.page('a'));
  assert.equal(f.calls.filter(args => args[0] === 'evaluate').length, 3);
});

for (const waitReply of [{ ready: false }, { ready: true, stopped: true }, { ready: true, activity: ['human'] }]) test(`read recovery yields to human ownership: ${JSON.stringify(waitReply)}`, async t => {
  const f = await fixture(t, { waitReply, evaluateFailure: { code: 'permission_denied', data: { reason: 'cooperation_sync_required', effect_state: 'none' } } }); await f.open('a');
  await assert.rejects(f.publisher.page('a'));
  await assert.rejects(f.publisher.command(['click', '--selector', '#old', '--session', 'a']));
  assert.equal(f.calls.filter(args => args[0] === 'evaluate').length, 1);
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 0);
});

test('successful submit is never repeated when its post-sync is not ready', async t => {
  let f;
  f = await fixture(t, { syncPatch: () => f.calls.some(args => args[0] === 'click') ? { ready: false, state: { mode: 'manual_hold' } } : {} });
  let submits = 0;
  const approval = { browserId: 'browser', accountId: 'account', asset: 'test.mp4', title: 'approved', caption: 'approved' };
  await assert.rejects(f.publisher.publish({ approval }, { guard: async () => {}, beforeSubmit: async () => { submits++; } }));
  assert.equal(submits, 1);
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 1);
  assert.equal(f.calls.filter(args => args[0] === 'upload').length, 1);
});
