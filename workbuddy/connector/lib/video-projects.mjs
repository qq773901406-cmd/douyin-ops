export const videoStatuses = { planned: '构思中', ready: '待制作', producing: '制作中', blocked: '遇到问题', completed: '已完成' };
export const videoRatios = ['9:16', '16:9', '1:1'];
export const videoReviewStatuses = { pending: '待验收', approved: '已通过', rejected: '需返工' };
const short = (value, max = 5000) => String(value ?? '').trim().slice(0, max);

function optionalText(value, maximum, label, singleLine = false) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${label}必须是文本。`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${label}不能超过 ${maximum} 字符。`);
  if (/\u0000/u.test(normalized) || singleLine && /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(`${label}含不支持的控制字符。`);
  return normalized;
}

export function newShot(overrides = {}) {
  return {
    seconds: 5, action: '', camera: '中景，固定机位。',
    referenceImage: '', startState: '', endState: '', asset: '', reviewStatus: 'pending', reviewNotes: '',
    ...overrides,
    id: typeof overrides.id === 'string' && overrides.id.trim() ? overrides.id.trim() : `shot-${globalThis.crypto.randomUUID()}`
  };
}

export function newVideo(template = 'blank') {
  const kitten = template === 'kitten';
  const states = [
    '同一客厅木地板上，小猫坐着，粉色蝴蝶结发夹在前爪旁的地上。',
    '同一客厅木地板上，小猫坐着低头看向前爪旁的粉色蝴蝶结发夹。',
    '同一客厅木地板上，小猫坐着，左前爪触到地上的粉色蝴蝶结发夹。',
    '同一客厅木地板上，小猫坐着，左前爪将粉色蝴蝶结发夹举在胸前。',
    '同一客厅木地板上，小猫坐着，粉色蝴蝶结发夹固定在左耳外侧，双前爪自然垂下。',
    '同一客厅木地板上，小猫坐着向右轻摆上身，粉色蝴蝶结发夹仍固定在左耳外侧。'
  ];
  return {
    title: kitten ? '小猫捡到发夹后跳舞' : '',
    subject: kitten ? '一只圆脸橘白小猫，白色口鼻、胸口和前爪，橘色额头与背部，全程使用同一角色参考。' : '',
    setting: kitten ? '温暖明亮的客厅，木地板，柔和日光，背景简洁。' : '',
    style: kitten ? '可爱写实，轻松搞笑，动作连贯，自然毛发质感。' : '',
    referenceVideo: '', characterReference: '',
    visualIdentity: kitten ? '圆脸、短耳、橘白毛色及胖瘦比例与角色参考一致；不添加墨镜、衣服或嘴叼物。唯一道具是同一枚粉色蝴蝶结发夹；戴好后始终在左耳外侧。背景与光线保持一致。' : '',
    ratio: '9:16', budget: 'free', provider: '', cost: '', status: 'planned',
    asset: '', blocker: '', notes: '',
    shots: kitten ? [
      newShot({ seconds: 3, action: '小猫低头看向地上的粉色蝴蝶结发夹。', camera: '中景，固定机位，猫与发夹同时入镜。', startState: states[0], endState: states[1] }),
      newShot({ seconds: 3, action: '小猫用左前爪轻触发夹。', camera: '前爪和发夹特写，固定机位。', startState: states[1], endState: states[2] }),
      newShot({ seconds: 4, action: '小猫将发夹举到胸前。', camera: '中近景，完整保留左前爪与发夹。', startState: states[2], endState: states[3] }),
      newShot({ seconds: 4, action: '小猫把发夹戴到左耳外侧。', camera: '头部与左前爪近景，动作过程不遮挡发夹。', startState: states[3], endState: states[4] }),
      newShot({ seconds: 4, action: '小猫向右轻摆一次上身。', camera: '全身固定镜头，留足头顶和脚下空间。', startState: states[4], endState: states[5] })
    ] : [newShot()]
  };
}

export function copyVideo(input) {
  const copy = structuredClone(input);
  delete copy.id; delete copy.createdAt; delete copy.updatedAt;
  copy.title = `${short(input.title, 114) || '视频项目'}（副本）`;
  copy.status = 'planned'; copy.asset = ''; copy.blocker = ''; copy.cost = '';
  copy.shots = (copy.shots || []).map(shot => newShot({ ...shot, id: undefined, asset: '', reviewStatus: 'pending', reviewNotes: '' }));
  return copy;
}

export function validateVideo(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('视频项目格式不正确。');
  const project = { ...newVideo() };
  for (const key of ['title', 'subject', 'setting', 'style', 'provider', 'asset', 'blocker', 'notes']) project[key] = short(input[key], key === 'title' ? 120 : 5000);
  if (!project.title) throw new Error('请填写视频名称。');
  project.referenceVideo = optionalText(input.referenceVideo, 2000, '参考视频链接', true);
  if (project.referenceVideo) {
    let url;
    try { url = new URL(project.referenceVideo); } catch { throw new Error('参考视频链接须为完整的 HTTP(S) 网址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('参考视频链接须为无账号密码的 HTTP(S) 网址。');
  }
  project.characterReference = optionalText(input.characterReference, 2000, '角色参考图', true);
  project.visualIdentity = optionalText(input.visualIdentity, 5000, '角色视觉约束');
  project.ratio = input.ratio ?? '9:16';
  project.status = input.status ?? 'planned';
  project.budget = input.budget ?? 'free';
  if (!videoRatios.includes(project.ratio)) throw new Error('画幅请选择 9:16、16:9 或 1:1。');
  if (!Object.hasOwn(videoStatuses, project.status)) throw new Error('视频状态无效。');
  if (!['free', 'confirm'].includes(project.budget)) throw new Error('费用策略无效。');
  project.cost = short(input.cost, 30);
  if (project.cost && (!Number.isFinite(Number(project.cost)) || Number(project.cost) < 0)) throw new Error('预计费用应为非负数字，未知时留空。');
  if (project.budget === 'free' && Number(project.cost) > 0) throw new Error('当前要求仅免费，请修改费用策略后再记录付费方案。');
  if (!Array.isArray(input.shots) || !input.shots.length || input.shots.length > 12) throw new Error('请保留 1–12 个分镜。');
  const shotIds = new Set();
  const declaredShotIds = new Set(input.shots.map(shot => typeof shot?.id === 'string' ? shot.id.trim() : '').filter(Boolean));
  project.shots = input.shots.map((shot, index) => {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) throw new Error(`分镜 ${index + 1} 格式不正确。`);
    const seconds = Number(shot?.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw new Error(`分镜 ${index + 1} 的时长应为 1–120 秒的整数。`);
    const action = short(shot?.action);
    if (!action) throw new Error(`请描述分镜 ${index + 1} 的画面。`);
    // Deterministic IDs keep legacy projects stable across reads without touching their files.
    let id = shot.id === undefined ? `legacy-shot-${index + 1}` : optionalText(shot.id, 100, `分镜 ${index + 1} 编号`, true);
    if (shot.id === undefined) while (declaredShotIds.has(id) || shotIds.has(id)) id += '-legacy';
    if (!id || shotIds.has(id)) throw new Error(`分镜 ${index + 1} 编号为空或重复。`);
    shotIds.add(id);
    const reviewStatus = shot.reviewStatus === undefined ? 'pending' : shot.reviewStatus;
    if (typeof reviewStatus !== 'string' || !Object.hasOwn(videoReviewStatuses, reviewStatus)) throw new Error(`分镜 ${index + 1} 验收状态无效。`);
    return {
      id, seconds, action, camera: short(shot.camera, 1000),
      referenceImage: optionalText(shot.referenceImage, 2000, `分镜 ${index + 1} 参考图`, true),
      startState: optionalText(shot.startState, 2000, `分镜 ${index + 1} 起点状态`),
      endState: optionalText(shot.endState, 2000, `分镜 ${index + 1} 终点状态`),
      asset: optionalText(shot.asset, 2000, `分镜 ${index + 1} 素材路径`, true),
      reviewStatus,
      reviewNotes: optionalText(shot.reviewNotes, 5000, `分镜 ${index + 1} 验收备注`)
    };
  });
  if (project.status === 'blocked' && !project.blocker) throw new Error('请记录遇到的问题，方便下次继续。');
  if (project.status === 'completed' && !project.asset) throw new Error('标记完成前，请填写成片文件路径或链接。');
  for (const key of ['id', 'createdAt', 'updatedAt', 'sourceProductId']) if (input[key]) project[key] = short(input[key], 100);
  return project;
}

/** A record checklist, not a filesystem check or an automatic visual quality verdict. */
export function videoQuality(input = {}) {
  const shots = Array.isArray(input?.shots) ? input.shots : [];
  const hasText = value => typeof value === 'string' && !!value.trim();
  const comparable = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  const issues = [];
  if (!hasText(input?.characterReference)) issues.push({ code: 'character-reference', message: '尚未绑定角色参考图。' });
  if (!hasText(input?.visualIdentity)) issues.push({ code: 'visual-identity', message: '尚未填写角色外观与道具的视觉约束。' });
  if (!shots.length) issues.push({ code: 'no-shots', message: '尚未添加分镜。' });
  for (const [shotIndex, value] of shots.entries()) {
    const shot = value || {};
    const add = (code, message) => issues.push({ code, message: `分镜 ${shotIndex + 1}：${message}`, shotId: shot.id, shotIndex });
    if (!hasText(shot.action)) add('shot-action', '单镜动作待补充。');
    if (!Number.isInteger(Number(shot.seconds)) || Number(shot.seconds) < 1 || Number(shot.seconds) > 120) add('shot-duration', '镜头时长须为 1–120 秒的整数。');
    if (!hasText(shot.referenceImage) && !hasText(input?.characterReference)) add('shot-reference', '缺少镜头参考图或可继承的角色参考图。');
    if (!hasText(shot.startState)) add('start-state', '起点状态待补充。');
    if (!hasText(shot.endState)) add('end-state', '终点状态待补充。');
    if (!hasText(shot.asset)) add('missing-asset', '尚未记录镜头素材。');
    if (shot.reviewStatus === 'rejected') add('rejected', `镜头需返工${hasText(shot.reviewNotes) ? `：${shot.reviewNotes.trim()}` : '，请补充问题备注'}。`);
    else if (shot.reviewStatus !== 'approved') add('pending-review', '镜头尚未验收通过。');
    const previous = shots[shotIndex - 1];
    if (previous && hasText(previous.endState) && hasText(shot.startState) && comparable(previous.endState) !== comparable(shot.startState)) {
      add('continuity-review', '起点与上一镜终点的记录不同，请核对动作、道具位置和场景衔接；文字不同不代表画面一定有误。');
    }
  }
  return { shotCount: shots.length, approvedCount: shots.filter(shot => shot?.reviewStatus === 'approved').length, readyForAssembly: issues.length === 0, issues };
}

export function videoPrompt(input) {
  const p = validateVideo(input);
  const quality = videoQuality(p);
  let elapsed = 0;
  const shots = p.shots.map((shot, index) => {
    const start = elapsed; elapsed += shot.seconds;
    return [
      `分镜 ${index + 1}｜${start}–${elapsed} 秒｜编号：${shot.id}`,
      `参考图：${shot.referenceImage || p.characterReference || '待绑定，先确认角色与关键帧'}`,
      `起点状态：${shot.startState || '待补充'}`, `单镜动作：${shot.action}`,
      `镜头：${shot.camera || '自然构图，动作清晰'}`, `终点状态：${shot.endState || '待补充'}`,
      `镜头素材记录：${shot.asset || '缺少素材，尚未记录生成结果'}`,
      `验收记录：${videoReviewStatuses[shot.reviewStatus]}${shot.reviewNotes ? `；${shot.reviewNotes}` : ''}`
    ].join('\n');
  });
  return [
    `视频制作任务：${p.title}`, `画幅：${p.ratio}；目标总时长：${elapsed} 秒。`,
    `主角：${p.subject || '按分镜设定保持一致'}`, `场景：${p.setting || '按分镜设定'}`, `风格：${p.style || '自然连贯'}`,
    `角色参考图：${p.characterReference || '待绑定'}`, `视觉约束：${p.visualIdentity || '待补充角色、服饰与道具的固定特征'}`,
    `参考视频：${p.referenceVideo || '未指定'}`,
    '', ...shots.flatMap(shot => [shot, '']),
    `制作检查：${quality.approvedCount}/${quality.shotCount} 个镜头已登记验收通过。`,
    ...(quality.issues.length ? quality.issues.map(issue => `待处理：${issue.message}`) : ['镜头记录已齐备；进入剪辑前仍需核实每个素材文件、播放效果与使用范围。']),
    '参考图、参考视频和素材路径只是记录，本制作单没有读取文件、调用模型或验证画面。验收通过表示已保存的人工验收记录。',
    '衔接检查：逐镜比较上一镜终点与下一镜起点；主动切换场景或道具状态时，在镜头说明中写明过渡方式。',
    '一致性要求：角色外观和道具保持一致，避免多余肢体、身体变形、道具闪现、画面闪烁和无意生成的文字。',
    '制作建议：每镜只完成一个动作；先确认角色参考与逐镜关键帧，再生成短片并逐镜验收。需返工、缺素材或未验收镜头先处理，再进入成片剪辑。',
    '剪辑建议：按动作选择每镜入出点，检查裁切、字幕位置和声音；不要用统一叠化掩盖角色或道具变化。需要精确舞步时使用本人制作或获授权的动作参考。音乐单独添加，使用可用的授权音源。',
    `费用约束：${p.budget === 'free' ? '仅使用已核实为免费的方案；遇到付费、额度不足或无法确认价格时先停止并说明。' : '执行前说明实际报价并取得确认。'}`,
    `计划工具：${p.provider || '待选择'}；预计费用（人民币）：${p.cost === '' ? '待核实' : p.cost + ' 元'}。`,
    p.notes ? `补充要求：${p.notes}` : '',
    '完成后返回真实成片路径或可访问链接；失败时记录原因。此文本是制作说明，不代表已经生成视频。'
  ].filter((line, index, all) => line || all[index - 1]).join('\n');
}
