export const videoStatuses = { planned: '构思中', ready: '待制作', producing: '制作中', blocked: '遇到问题', completed: '已完成' };
export const videoRatios = ['9:16', '16:9', '1:1'];
const short = (value, max = 5000) => String(value ?? '').trim().slice(0, max);

export function newVideo(template = 'blank') {
  const kitten = template === 'kitten';
  return {
    title: kitten ? '小猫捡到发夹后跳舞' : '',
    subject: kitten ? '一只圆脸橘白小猫，粉色蝴蝶结发夹，全程保持毛色、脸型和体型一致。' : '',
    setting: kitten ? '温暖明亮的客厅，木地板，柔和日光，背景简洁。' : '',
    style: kitten ? '可爱写实，轻松搞笑，动作连贯，自然毛发质感。' : '',
    ratio: '9:16', budget: 'free', provider: '', cost: '', status: 'planned',
    asset: '', blocker: '', notes: '',
    shots: kitten ? [
      { seconds: 3, action: '小猫低头发现地上的粉色发夹，停下脚步，歪头好奇地看。', camera: '中景，固定机位，小猫全身入镜。' },
      { seconds: 3, action: '小猫伸爪捡起发夹，抬头露出惊喜表情；通过切镜让发夹出现在耳边。', camera: '爪子和发夹特写，再切回全身。' },
      { seconds: 9, action: '戴着发夹的小猫站起，左右摆爪、扭腰、踏步，跳一段俏皮的小舞，最后摆出可爱的定格姿势。', camera: '全身固定镜头，留足头顶和脚下空间。' }
    ] : [{ seconds: 5, action: '', camera: '中景，固定机位。' }]
  };
}

export function copyVideo(input) {
  const copy = structuredClone(input);
  delete copy.id; delete copy.createdAt; delete copy.updatedAt;
  copy.title = `${short(input.title, 114) || '视频项目'}（副本）`;
  copy.status = 'planned'; copy.asset = ''; copy.blocker = ''; copy.cost = '';
  return copy;
}

export function validateVideo(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('视频项目格式不正确。');
  const project = { ...newVideo() };
  for (const key of ['title', 'subject', 'setting', 'style', 'provider', 'asset', 'blocker', 'notes']) project[key] = short(input[key], key === 'title' ? 120 : 5000);
  if (!project.title) throw new Error('请填写视频名称。');
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
  project.shots = input.shots.map((shot, index) => {
    const seconds = Number(shot?.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw new Error(`分镜 ${index + 1} 的时长应为 1–120 秒的整数。`);
    const action = short(shot?.action);
    if (!action) throw new Error(`请描述分镜 ${index + 1} 的画面。`);
    return { seconds, action, camera: short(shot?.camera, 1000) };
  });
  if (project.status === 'blocked' && !project.blocker) throw new Error('请记录遇到的问题，方便下次继续。');
  if (project.status === 'completed' && !project.asset) throw new Error('标记完成前，请填写成片文件路径或链接。');
  for (const key of ['id', 'createdAt', 'updatedAt', 'sourceProductId']) if (input[key]) project[key] = short(input[key], 100);
  return project;
}

export function videoPrompt(input) {
  const p = validateVideo(input);
  let elapsed = 0;
  const shots = p.shots.map((shot, index) => {
    const start = elapsed; elapsed += shot.seconds;
    return `分镜 ${index + 1}｜${start}–${elapsed} 秒\n画面：${shot.action}\n镜头：${shot.camera || '自然构图，动作清晰'}`;
  });
  return [
    `视频制作任务：${p.title}`, `画幅：${p.ratio}；目标总时长：${elapsed} 秒。`,
    `主角：${p.subject || '按分镜设定保持一致'}`, `场景：${p.setting || '按分镜设定'}`, `风格：${p.style || '自然连贯'}`,
    '', ...shots.flatMap(shot => [shot, '']),
    '一致性要求：角色外观和道具保持一致，避免多余肢体、身体变形、道具闪现、画面闪烁和无意生成的文字。',
    '制作建议：复杂动作可分镜生成后剪辑；需要精确舞步时使用本人制作或获授权的动作参考。音乐单独添加，使用可用的授权音源。',
    `费用约束：${p.budget === 'free' ? '仅使用已核实为免费的方案；遇到付费、额度不足或无法确认价格时先停止并说明。' : '执行前说明实际报价并取得确认。'}`,
    `计划工具：${p.provider || '待选择'}；预计费用（人民币）：${p.cost === '' ? '待核实' : p.cost + ' 元'}。`,
    p.notes ? `补充要求：${p.notes}` : '',
    '完成后返回真实成片路径或可访问链接；失败时记录原因。此文本是制作说明，不代表已经生成视频。'
  ].filter((line, index, all) => line || all[index - 1]).join('\n');
}
