import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDouyinVideoDraft, assertDouyinVideoDraft } from '../shared/publish-target.mjs';

test('自动发布拒绝非抖音和图文，保留缺省平台的历史视频兼容', () => {
  for (const platform of ['bilibili', 'xiaohongshu', 'youtube', 'instagram']) {
    assert.throws(() => assertDouyinVideoDraft({ platform, format: '视频' }), { status: 400 });
  }
  assert.equal(isDouyinVideoDraft({ platform: 'douyin', format: '图文' }), false);
  assert.equal(isDouyinVideoDraft({ platform: 'douyin', format: '视频' }), true);
  assert.equal(isDouyinVideoDraft({ asset: 'legacy.mp4' }), true);
});
