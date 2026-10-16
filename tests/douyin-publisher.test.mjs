import test from 'node:test';
import assert from 'node:assert/strict';
import { DouyinPublisher } from '../douyin-publisher.mjs';

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
