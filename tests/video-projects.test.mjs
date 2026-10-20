import test from 'node:test';
import assert from 'node:assert/strict';
import { newVideo, newShot, copyVideo, validateVideo, videoPrompt, videoQuality } from '../workbuddy/connector/lib/video-projects.mjs';

const legacyVideo = () => ({
  id: 'existing-video', title: '已经完成的小猫视频', subject: '橘白小猫', setting: '客厅',
  style: '写实', ratio: '9:16', budget: 'free', provider: '外部生成工具', cost: '0',
  status: 'completed', asset: 'D:/existing/cat.mp4', blocker: '', notes: '保留原制作说明',
  sourceProductId: 'product-1', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z',
  shots: [
    { seconds: 3, action: '低头看发夹', camera: '中景' },
    { seconds: 5, action: '抬起前爪', camera: '近景' }
  ]
});

function readyVideo() {
  const project = newVideo('kitten');
  project.characterReference = 'D:/references/cat.png';
  project.referenceVideo = 'https://example.com/reference?clip=1';
  project.shots = project.shots.map((shot, index) => ({
    ...shot, referenceImage: `D:/references/shot-${index}.png`,
    asset: `D:/renders/shot-${index}.mp4`, reviewStatus: 'approved', reviewNotes: '角色、发夹和动作已人工核对'
  }));
  return project;
}

test('legacy completed projects retain all existing fields and receive stable optional defaults', () => {
  const original = legacyVideo();
  const before = structuredClone(original);
  const normalized = validateVideo(original);
  for (const [key, value] of Object.entries(original)) {
    if (key !== 'shots') assert.deepEqual(normalized[key], value);
  }
  original.shots.forEach((shot, index) => {
    for (const [key, value] of Object.entries(shot)) assert.deepEqual(normalized.shots[index][key], value);
    assert.equal(normalized.shots[index].id, `legacy-shot-${index + 1}`);
    assert.equal(normalized.shots[index].asset, '');
    assert.equal(normalized.shots[index].reviewStatus, 'pending');
  });
  assert.equal(normalized.referenceVideo, '');
  assert.equal(normalized.characterReference, '');
  assert.equal(normalized.visualIdentity, '');
  assert.deepEqual(validateVideo(normalized), normalized);
  assert.deepEqual(original, before);
  assert.equal(normalized.status, 'completed');
  assert.equal(videoQuality(normalized).readyForAssembly, false);
});

test('kitten template binds five separate actions to continuous explicit states', () => {
  const project = validateVideo(newVideo('kitten'));
  assert.equal(project.shots.length, 5);
  assert.equal(new Set(project.shots.map(shot => shot.id)).size, 5);
  assert.ok(project.visualIdentity.includes('左耳外侧'));
  assert.ok(project.shots.every(shot => shot.startState && shot.endState && shot.reviewStatus === 'pending'));
  for (let index = 1; index < project.shots.length; index++) {
    assert.equal(project.shots[index].startState, project.shots[index - 1].endState);
  }
  const copiedShot = newShot({ ...project.shots[0], id: undefined });
  assert.notEqual(copiedShot.id, project.shots[0].id);
  assert.equal(copiedShot.action, project.shots[0].action);
});

test('legacy id migration avoids identifiers already used by a newer shot', () => {
  const project = legacyVideo();
  project.shots[0].id = 'legacy-shot-2';
  const normalized = validateVideo(project);
  assert.equal(normalized.shots[0].id, 'legacy-shot-2');
  assert.notEqual(normalized.shots[1].id, normalized.shots[0].id);
  assert.deepEqual(validateVideo(normalized), normalized);
});

test('copying a project keeps references and planned states while resetting every generated result', () => {
  const original = { ...readyVideo(), id: 'finished', status: 'completed', asset: 'D:/renders/final.mp4', cost: '42', budget: 'confirm' };
  const before = structuredClone(original);
  const copy = validateVideo(copyVideo(original));
  assert.equal(copy.id, undefined);
  assert.equal(copy.status, 'planned');
  assert.equal(copy.asset, '');
  assert.equal(copy.cost, '');
  assert.equal(copy.characterReference, original.characterReference);
  assert.equal(copy.referenceVideo, original.referenceVideo);
  assert.equal(copy.visualIdentity, original.visualIdentity);
  copy.shots.forEach((shot, index) => {
    assert.notEqual(shot.id, original.shots[index].id);
    for (const field of ['referenceImage', 'startState', 'endState', 'seconds', 'action', 'camera']) assert.equal(shot[field], original.shots[index][field]);
    assert.equal(shot.asset, '');
    assert.equal(shot.reviewStatus, 'pending');
    assert.equal(shot.reviewNotes, '');
  });
  assert.deepEqual(original, before);
});

test('new project and shot fields reject incorrect types, excessive lengths and duplicate ids', () => {
  const cases = [
    [project => { project.characterReference = { path: 'cat.png' }; }, /角色参考图必须是文本/],
    [project => { project.characterReference = 'x'.repeat(2001); }, /角色参考图不能超过/],
    [project => { project.visualIdentity = null; }, /角色视觉约束必须是文本/],
    [project => { project.visualIdentity = 'x'.repeat(5001); }, /角色视觉约束不能超过/],
    [project => { project.referenceVideo = 'javascript:alert(1)'; }, /参考视频链接须为/],
    [project => { project.referenceVideo = 'https://user:password@example.com/video'; }, /参考视频链接须为/],
    [project => { project.shots[0].referenceImage = false; }, /参考图必须是文本/],
    [project => { project.shots[0].startState = 'x'.repeat(2001); }, /起点状态不能超过/],
    [project => { project.shots[0].endState = []; }, /终点状态必须是文本/],
    [project => { project.shots[0].asset = 'D:/clip\n.mp4'; }, /素材路径含不支持的控制字符/],
    [project => { project.shots[0].reviewStatus = 'done'; }, /验收状态无效/],
    [project => { project.shots[0].reviewNotes = 'x'.repeat(5001); }, /验收备注不能超过/],
    [project => { project.shots[1].id = project.shots[0].id; }, /编号为空或重复/],
    [project => { project.shots[0].id = ''; }, /编号为空或重复/]
  ];
  for (const [change, expected] of cases) {
    const project = readyVideo();
    change(project);
    assert.throws(() => validateVideo(project), expected);
  }
});

test('quality checklist flags missing assets, rejected shots and uncertain continuity without rewriting review records', () => {
  const project = readyVideo();
  assert.deepEqual(videoQuality(project), { shotCount: 5, approvedCount: 5, readyForAssembly: true, issues: [] });
  project.shots[1].asset = '';
  project.shots[2].reviewStatus = 'rejected';
  project.shots[2].reviewNotes = '发夹消失';
  project.shots[3].startState = '另一间屋子，发夹在右耳';
  const before = structuredClone(project);
  const quality = videoQuality(project);
  assert.equal(quality.readyForAssembly, false);
  assert.equal(quality.approvedCount, 4);
  assert.ok(quality.issues.some(issue => issue.code === 'missing-asset' && issue.shotIndex === 1));
  assert.ok(quality.issues.some(issue => issue.code === 'rejected' && issue.shotId === project.shots[2].id && issue.message.includes('发夹消失')));
  assert.ok(quality.issues.some(issue => issue.code === 'continuity-review' && issue.shotIndex === 3 && issue.message.includes('不代表画面一定有误')));
  assert.deepEqual(project, before);
  assert.equal(videoQuality({ shots: [null] }).readyForAssembly, false);
  assert.equal(videoQuality(null).shotCount, 0);
  const unfinished = readyVideo();
  unfinished.shots[0].action = '';
  unfinished.shots[0].seconds = 0;
  assert.ok(videoQuality(unfinished).issues.some(issue => issue.code === 'shot-action'));
  assert.ok(videoQuality(unfinished).issues.some(issue => issue.code === 'shot-duration'));
});

test('exported production plan carries references, states, rejection notes and honest material status', () => {
  const project = readyVideo();
  project.shots[0].asset = '';
  project.shots[0].reviewStatus = 'pending';
  project.shots[1].reviewStatus = 'rejected';
  project.shots[1].reviewNotes = '左前爪数量异常，重新生成';
  const prompt = videoPrompt(project);
  assert.ok(prompt.includes(`角色参考图：${project.characterReference}`));
  assert.ok(prompt.includes(`参考视频：${project.referenceVideo}`));
  assert.ok(prompt.includes(`参考图：${project.shots[0].referenceImage}`));
  assert.ok(prompt.includes(`起点状态：${project.shots[0].startState}`));
  assert.ok(prompt.includes(`终点状态：${project.shots[0].endState}`));
  assert.ok(prompt.includes('缺少素材，尚未记录生成结果'));
  assert.ok(prompt.includes('需返工；左前爪数量异常，重新生成'));
  assert.ok(prompt.includes('3/5 个镜头已登记验收通过'));
  assert.ok(prompt.includes('没有读取文件、调用模型或验证画面'));
  assert.ok(prompt.includes('不代表已经生成视频'));
  assert.ok(videoPrompt(legacyVideo()).includes('待绑定'));
});
