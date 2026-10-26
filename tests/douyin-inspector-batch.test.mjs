import test from 'node:test';
import assert from 'node:assert/strict';
import { DouyinInspector } from '../server/douyin-inspector.mjs';

const accountId = 'batch-account';
const browserId = 'batch-browser';
const manageUrl = 'https://creator.douyin.com/creator-micro/content/manage';
const targets = [0, 1].map(index => ({
  ref: `queue:batch-${index}`, browserId, accountId, sha256: String(index).repeat(64),
  title: `批量测试${index}`, caption: '完整说明', submitStartedAt: '2026-10-26T02:00:30.000Z',
  ...(index === 0 ? { boundWorkId: '1234567890000000000', boundUrl: 'https://www.douyin.com/video/1234567890000000000' } : {}),
}));

function fixture({ accounts = [], failPreview = [], wrongPreview = [], wrongCaption = [], failClose = false } = {}) {
  let sessions = 0, stopped = 0, current = -1, nextTabId = 2;
  const calls = [];
  const tabs = new Map([
    [1, { tab_id: 1, active: true, scope: 'agent', url: 'about:blank' }],
    [900, { tab_id: 900, active: false, scope: 'user', url: 'https://example.com/' }],
  ]);
  const card = () => ({
    title: targets[current].title + (wrongCaption.includes(current) ? '其他说明' : targets[current].caption),
    time: '2026年10月26日 10:00', status: '已发布', cover: '#cover', metrics: { 播放: String(10 + current) },
  });
  const select = id => {
    assert.equal(tabs.get(id)?.scope, 'agent');
    for (const tab of tabs.values()) tab.active = tab.tab_id === id;
  };
  const publisher = {
    session: async (id, action) => {
      assert.equal(id, browserId);
      sessions++;
      try { return await action('owned-batch-session'); } finally { stopped++; }
    },
    accountInSession: async session => {
      assert.equal(session, 'owned-batch-session');
      current++;
      return { accountId: accounts[current] || accountId };
    },
    command: async args => {
      calls.push(args);
      assert.equal(args[args.indexOf('--session') + 1], 'owned-batch-session');
      if (args[0] === 'navigate') {
        const active = [...tabs.values()].find(tab => tab.active);
        active.url = args[1];
        return {};
      }
      if (args[0] === 'evaluate') return { value: { url: manageUrl, accountIds: [accountId], cards: [card()] } };
      if (args[0] === 'click') {
        const id = nextTabId++;
        tabs.set(id, { tab_id: id, active: false, scope: 'agent', url: 'https://www.douyin.com/user/self' });
        select(id);
        return {};
      }
      if (args[0] === 'tab' && args[1] === 'list') return { tabs: [...tabs.values()].map(tab => ({ ...tab })) };
      if (args[0] === 'tab' && args[1] === 'select') { select(Number(args[2])); return {}; }
      if (args[0] === 'tab' && args[1] === 'close') {
        const id = Number(args[2]);
        assert.ok(id > 1 && id < 900, 'close only preview tabs created by this batch');
        if (failClose) throw new Error('disconnected');
        tabs.delete(id);
        return {};
      }
      throw new Error(`Unexpected command ${args[0]}`);
    },
  };
  const inspector = new DouyinInspector({
    publisher, pause: async () => {}, pageAttempts: 1, stableSamples: 2,
    previewReader: async () => {
      if (failPreview.includes(current)) throw new Error('preview timed out');
      return {
        url: 'https://www.douyin.com/user/self', accountIds: [accountId],
        items: [{ title: card().title, url: `https://www.douyin.com/video/${wrongPreview.includes(current) ? '999999' : `123456789000000000${current}`}` }],
      };
    },
  });
  // Bound fake clock keeps missing-card failures deterministic and immediate.
  let elapsed = 0;
  inspector.now = () => elapsed;
  inspector.pause = async ms => { elapsed += ms; };
  inspector.manageTimeoutMs = 2;
  return { inspector, calls, tabs, sessions: () => sessions, stopped: () => stopped };
}

test('集中回采复用一个会话，保留逐作品绑定证明并清理自己的预览标签', async () => {
  const f = fixture();
  const results = await f.inspector.collectBatch(targets);
  assert.equal(f.sessions(), 1);
  assert.equal(f.stopped(), 1);
  assert.equal(results[0].observation.workId, targets[0].boundWorkId);
  assert.equal(results[0].observation.metrics.plays, 10);
  assert.equal(results[1].proposal.requiresExplicitBinding, true);
  assert.equal(results[1].proposal.candidate.metrics.plays, 11);
  const proofs = [JSON.parse(results[0].observation.evidence.text).bindingProof, results[1].proposal.bindingProof];
  for (let index = 0; index < proofs.length; index++) {
    assert.equal(proofs[index].targetRef, targets[index].ref);
    assert.equal(proofs[index].assetSha256, targets[index].sha256);
    assert.equal(proofs[index].cardTitle, targets[index].title + targets[index].caption);
    assert.equal(proofs[index].accountId, accountId);
    assert.equal(proofs[index].browserId, browserId);
    assert.equal(proofs[index].stableSamples, 2);
  }
  assert.deepEqual([...f.tabs.keys()], [1, 900]);
  assert.equal(f.tabs.get(900).url, 'https://example.com/');
  assert.deepEqual(f.calls.filter(args => args[1] === 'close').map(args => args[2]), ['2', '3']);
});

test('跨账号或跨浏览器批次在开窗前拒绝，空批次不创建会话', async () => {
  const f = fixture();
  assert.deepEqual(await f.inspector.collectBatch([]), []);
  for (const field of ['browserId', 'accountId']) {
    await assert.rejects(f.inspector.collectBatch([targets[0], { ...targets[1], [field]: 'different' }]), /同一浏览器和抖音账号/);
  }
  assert.equal(f.sessions(), 0);
  assert.equal(f.calls.length, 0);
});

test('目标预览失败后同一窗口继续后续作品，不重建会话或混入前一条证据', async () => {
  const f = fixture({ failPreview: [0] });
  const results = await f.inspector.collectBatch(targets);
  assert.match(results[0].error, /preview timed out/);
  assert.equal(results[0].observation, undefined);
  assert.equal(results[1].proposal.bindingProof.targetRef, targets[1].ref);
  assert.equal(results[1].proposal.candidate.workId, '1234567890000000001');
  assert.equal(f.sessions(), 1);
  assert.equal(f.stopped(), 1);
  assert.deepEqual([...f.tabs.keys()], [1, 900]);
});

test('每个目标重新核验账号，账号变化不能产生观察或候选', async () => {
  const f = fixture({ accounts: [accountId, 'other-account'] });
  const results = await f.inspector.collectBatch(targets);
  assert.ok(results[0].observation);
  assert.match(results[1].error, /账号/);
  assert.equal(results[1].proposal, undefined);
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 1);
  assert.equal(f.sessions(), 1);
  assert.equal(f.stopped(), 1);
});

test('集中回采仍拒绝已绑定 ID 不符及完整说明不符', async () => {
  const wrongId = fixture({ wrongPreview: [0] });
  const idResults = await wrongId.inspector.collectBatch(targets);
  assert.equal(idResults[0].observation, null);
  assert.ok(idResults[1].proposal);
  const caption = fixture({ wrongCaption: [0] });
  const captionResults = await caption.inspector.collectBatch(targets);
  assert.match(captionResults[0].error, /超时/);
  assert.ok(captionResults[1].proposal);
  assert.equal(caption.calls.filter(args => args[0] === 'click').length, 1);
});

test('会话清理断线时结束本轮，不为剩余目标另开窗口', async () => {
  const f = fixture({ failClose: true });
  const results = await f.inspector.collectBatch(targets);
  assert.match(results[0].error, /清理失败/);
  assert.match(results[1].error, /本轮未检查/);
  assert.equal(results[1].proposal, undefined);
  assert.equal(f.sessions(), 1);
  assert.equal(f.stopped(), 1);
  assert.equal(f.calls.filter(args => args[0] === 'click').length, 1);
});
