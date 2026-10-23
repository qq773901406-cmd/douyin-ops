export function isDouyinVideoDraft(draft) {
  return !!draft && (draft.platform || 'douyin') === 'douyin' && (draft.format || '视频') === '视频';
}

export function assertDouyinVideoDraft(draft) {
  if (!isDouyinVideoDraft(draft)) throw Object.assign(new Error('自动发布队列只支持抖音视频；其他平台或图文请使用对应发布流程。'), { status: 400 });
}
