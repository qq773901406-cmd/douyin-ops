import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { DouyinPublisher, inspectCreatorDOM } from '../server/douyin-publisher.mjs';

function publisherWith(commands, fail = '') {
  const publisher = new DouyinPublisher();
  publisher.command = async args => {
    commands.push(args);
    if (args.includes(fail) && fail) throw new Error('simulated failure');
    if (args[1] === 'start') return { session_id: 'owned', browser_instance_id: 'selected' };
    if (args.includes('--claim')) return { state: 'active', session: { session_id: 'owned' } };
    return { state: 'prepared' };
  };
  return publisher;
}

test('publisher prepares and claims its selected browser session before acting', async () => {
  const calls = [], publisher = publisherWith(calls);
  const result = await publisher.session('selected', async id => { calls.push(['action', id]); return 'ready'; });
  assert.equal(result, 'ready');
  assert.ok(calls[0].includes('--prepare'));
  assert.equal(calls[1][1], 'start');
  assert.equal(calls[1][calls[1].indexOf('--browser') + 1], 'selected');
  assert.ok(calls[2].includes('--claim'));
  assert.deepEqual(calls[3], ['action', 'owned']);
  assert.deepEqual(calls[4], ['session', 'stop', 'owned']);
});

test('failed claim never runs browser actions and closes the owned session', async () => {
  const calls = [], publisher = publisherWith(calls, '--claim');
  let acted = false;
  await assert.rejects(publisher.session('selected', async () => { acted = true; }), /simulated failure/);
  assert.equal(acted, false);
  assert.deepEqual(calls.at(-1), ['session', 'stop', 'owned']);
});

test('failed start cancels its recoverable request', async () => {
  const calls = [], publisher = publisherWith(calls, 'start');
  await assert.rejects(publisher.session('selected', async () => assert.fail('must not act')), /simulated failure/);
  assert.equal(calls.at(-1)[1], 'request');
  assert.ok(calls.at(-1).includes('--cancel'));
  assert.equal(calls.at(-1)[2], calls[1][calls[1].indexOf('--request-id') + 1]);
});

test('导航超时同时传给 BrowserSkill CLI，外层超时留出收尾时间', async () => {
  const publisher = new DouyinPublisher(), calls = [];
  publisher.session = async (_browser, action) => action('fake-session');
  publisher.command = async (args, timeout) => { calls.push({ args, timeout }); return {}; };
  publisher.waitPage = async () => ({ accountIds: ['test-account'], upload: 'button' });
  await publisher.inspectAccount('fake-browser');
  const navigations = calls.filter(c => c.args[0] === 'navigate');
  assert.equal(navigations.length, 2);
  for (const call of navigations) {
    assert.equal(call.args[call.args.indexOf('--timeout') + 1], '60s');
    assert.ok(call.timeout > 60000);
  }
});

test('checked checkbox labels identify visibility and publish timing; hidden or unchecked labels do not', () => {
  const choice = (name, checked = true, hidden = false) => ({
    tagName: 'LABEL', innerText: name, textContent: name, children: [], checked, hidden,
    getClientRects() { return hidden ? [] : [{}]; }, closest() { return null; }
  });
  const observe = labels => runInNewContext(`(${inspectCreatorDOM.toString()})()`, {
    document: {
      body: { innerText: '' },
      querySelector: () => null,
      querySelectorAll: selector => selector.includes('label:has(input[type="checkbox"]:checked)') ? labels.filter(label => label.checked) : []
    },
    location: { href: 'https://creator.douyin.com/creator-micro/content/post/video' },
    getComputedStyle: el => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible' })
  });
  let page = observe([choice('公开'), choice('立即发布')]);
  assert.equal(page.publicVisible, true);
  assert.equal(page.immediateVisible, true);
  page = observe([choice('公开', false), choice('立即发布', true, true)]);
  assert.equal(page.publicVisible, false);
  assert.equal(page.immediateVisible, false);
  page = observe([choice('公开'), choice('立即发布'), choice('定时发布')]);
  assert.equal(page.immediateVisible, false);
});

test('only structured fill_value_mismatch is recoverable and raw CLI errors never reveal captions', async () => {
  const secret = '不应出现在错误中的测试文案';
  const result = {
    ok: false, code: 3, message: `Command failed: bsk fill --value ${secret}`,
    stdout: JSON.stringify({ code: 'cdp_failed', data: { reason: 'fill_value_mismatch' } }), stderr: secret
  };
  const publisher = new DouyinPublisher({ run: async () => result });
  await assert.rejects(publisher.command(['fill', '--value', secret]), error => error.code === 'fill_value_mismatch' && !error.message.includes(secret));
  result.stdout = JSON.stringify({ code: 'cdp_failed', message: 'fill_value_mismatch', data: { reason: 'not_found' } });
  await assert.rejects(publisher.command(['fill', '--value', secret]), error => error.code !== 'fill_value_mismatch' && !error.message.includes(secret));
  result.stdout = JSON.stringify({ data: { reason: 'fill_value_mismatch' } });
  await assert.rejects(publisher.command(['click', '--selector', '#publish']), error => error.code !== 'fill_value_mismatch');
});

test('fill mismatch reads once without rewriting and accepts only editor whitespace normalization', async () => {
  const publisher = new DouyinPublisher();
  let writes = 0, reads = 0;
  publisher.command = async () => { writes++; throw Object.assign(new Error('mismatch'), { code: 'fill_value_mismatch' }); };
  let visible = '第一行\u200b\n第二行\u200b\n来源：https://example.com/a\u200b';
  publisher.page = async () => {
    reads++;
    return { url: 'https://creator.douyin.com/creator-micro/content/post/video', caption: { selector: '#caption', value: visible } };
  };
  const expected = '第一行\n\n第二行\n\n来源：https://example.com/a';
  await publisher.fill('test-session', 'caption', '#caption', expected);
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  visible = '第一行\n第二行\n来源：https://example.com/b';
  await assert.rejects(publisher.fill('test-session', 'caption', '#caption', expected), /不一致/);
  visible = '第一行第二行\n来源：https://example.com/a';
  await assert.rejects(publisher.fill('test-session', 'caption', '#caption', expected), /不一致/);
  const before = reads;
  publisher.command = async () => { throw Object.assign(new Error('timeout'), { code: 'timeout' }); };
  await assert.rejects(publisher.fill('test-session', 'caption', '#caption', expected), /timeout/);
  assert.equal(reads, before);
});

test('publish revalidates the normalized full caption before its single submit click', async () => {
  const publisher = new DouyinPublisher(), calls = [];
  const approval = { browserId: 'browser', accountId: 'account', asset: 'fixture.mp4', title: '资讯标题', caption: '第一条\n\n第二条\n\n来源完整保留' };
  const page = {
    url: 'https://creator.douyin.com/creator-micro/content/post/video', accountIds: ['account'],
    title: { selector: '#title', value: approval.title },
    caption: { selector: '#caption', value: '第一条\u200b\n第二条\u200b\n来源完整保留\u200b' },
    upload: '#upload', uploaded: true, uploading: false, publish: '#publish',
    publicVisible: true, immediateVisible: true, success: ''
  };
  publisher.session = async (_browser, action) => action('test-session');
  publisher.accountInSession = async () => ({ accountId: 'account' });
  publisher.page = async () => structuredClone(page);
  publisher.waitPage = async (_session, condition) => { assert.ok(condition(page)); return structuredClone(page); };
  publisher.command = async args => {
    calls.push(args);
    if (args[0] === 'fill' && args.includes('#caption')) throw Object.assign(new Error('mismatch'), { code: 'fill_value_mismatch' });
    if (args[0] === 'click') page.success = '提交成功';
    return {};
  };
  let beforeSubmit = 0;
  const result = await publisher.publish({ approval }, { guard: async () => {}, beforeSubmit: async () => { beforeSubmit++; } });
  assert.equal(beforeSubmit, 1);
  assert.equal(calls.filter(args => args[0] === 'click').length, 1);
  assert.equal(calls.filter(args => args[0] === 'fill' && args.includes('#caption')).length, 1);
  assert.equal(result.evidence.text, '提交成功');
});
