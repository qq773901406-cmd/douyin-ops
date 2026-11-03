import { readFile, stat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './fs-utils.mjs';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { validatePublishText } from '../shared/automation-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shaPattern = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const blocked = message => Object.assign(new Error(message), { code: 'HANDOFF_BLOCKED' });
const requireValue = (condition, message) => { if (!condition) throw blocked(message); };
const hasExecutionEvidence = item => ['startedAt', 'submitStartedAt', 'finishedAt', 'evidence', 'publishedUrl', 'publishedAt', 'boundWorkId', 'boundUrl', 'platformWorkId', 'platformUrl', 'platformObservedAt', 'reconciledAt', 'reconciledResult'].some(key => item?.[key] != null && item[key] !== '');
const receiptOnly = item => item && (['running', 'submitted', 'published', 'uncertain'].includes(item.status) || hasExecutionEvidence(item));
export async function readJson(path) { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }

function absoluteFile(value, label) {
  requireValue(typeof value === 'string' && isAbsolute(value), `${label}需要完整本地路径。`);
  return value;
}
function expectedHash(value, label) {
  requireValue(typeof value === 'string' && shaPattern.test(value), `${label}尚未记录真实 SHA256，当前不能交接发布。`);
  return value;
}
export function validateManifest(manifest) {
  const m = manifest;
  requireValue(m?.version === 1 && typeof m.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(m.id), '发布清单缺少稳定任务编号。');
  requireValue(typeof m.originalRunId === 'string' && m.originalRunId.length > 0, '发布清单缺少原生成记录。');
  absoluteFile(m.asset, '成片'); expectedHash(m.assetSha256, '成片');
  requireValue(extname(m.asset).toLowerCase() === '.mp4', '只交接已验收的 MP4 成片。');
  requireValue(typeof m.accountId === 'string' && m.accountId.length > 0, '发布清单缺少目标抖音号。');
  requireValue(m.visibility === 'public' && m.contentDeclaration === 'ai-generated', '本流程要求明确授权公开发布并标注 AI 生成。');
  requireValue(m.authorization?.confirmed === true && m.authorization.scope === 'publish-completed-video-once'
    && m.authorization.targetAccountId === m.accountId
    && Number.isFinite(Date.parse(m.authorization.authorizedAt)) && typeof m.authorization.userInstruction === 'string'
    && m.authorization.userInstruction.trim().length >= 10, '缺少用户针对本条完整视频的发布授权。');
  const content = validatePublishText(m.title, m.caption);
  requireValue(typeof m.tags === 'string', '话题必须是文本。');
  const caption = content.caption && m.tags && !content.caption.includes(m.tags) ? `${content.caption}\n\n${m.tags}` : content.caption || m.tags;
  validatePublishText(content.title, caption);
  requireValue(Array.isArray(m.sources) && m.sources.length === 4, '需要四段真实源片。');
  m.sources.forEach((source, index) => {
    requireValue(source.shot === index + 1, '源片必须依照第 1 至 4 镜头排列。');
    absoluteFile(source.path, `镜头 ${source.shot}`); expectedHash(source.sha256, `镜头 ${source.shot}`);
  });
  requireValue(new Set(m.sources.map(source => source.sha256)).size === 4, '不能重复使用相同片段代替四个镜头。');
  for (const key of ['assemblyReport', 'qualityReview']) {
    absoluteFile(m.verification?.[key]?.path, key); expectedHash(m.verification?.[key]?.sha256, key);
  }
  absoluteFile(m.tools?.python, 'Python'); absoluteFile(m.tools?.ffmpeg, 'FFmpeg');
  absoluteFile(m.publicationState, '发布交接状态');
  requireValue(![m.asset, ...m.sources.map(source => source.path), ...Object.values(m.verification).map(report => report.path)].some(path => samePath(path, m.publicationState)), '状态文件不能覆盖成片或验收文件。');
  return { ...m, title: content.title, effectiveCaption: caption, runtimeDir: resolve(m.runtimeDir || resolve(root, 'runtime')),
    draftId: `jimeng-${digest(m.id).slice(0, 32)}`, bindingHash: digest([m.id, m.originalRunId, m.assetSha256, m.accountId, content.title, caption, m.visibility, m.contentDeclaration]) };
}

async function checkedFile(path, expected) {
  const info = await stat(path).catch(() => { throw blocked(`所需文件尚不存在或不可读：${path}`); });
  requireValue(info.isFile() && info.size > 0, `文件为空或不是普通文件：${path}`);
  requireValue(await hashFile(path) === expected, `文件已变化，与验收 SHA256 不符：${path}`);
  return realpath(path);
}

// Read-only media checks reuse the assembler's actual full decode, PCM and
// frame-difference probes. No source file or preview is generated here.
const pythonProbe = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('pet_assembly',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
config=json.loads(sys.stdin.read()); ffmpeg=config['ffmpeg']
result={'video':module.probe_video(ffmpeg,config['asset']),'audio':module.measure_audio(ffmpeg,config['asset']),'sources':[]}
for source in config['sources']:
 result['sources'].append({'video':module.probe_video(ffmpeg,source),'motion':module.measure_motion(ffmpeg,source)})
print(json.dumps(result))
`;
export async function probeMedia(manifest) {
  return new Promise((accept, reject) => {
    const child = spawn(manifest.tools.python, ['-B', '-c', pythonProbe, resolve(root, 'tools/pet_video/assemble.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', settled = false;
    const finish = (problem, result) => { if (settled) return; settled = true; clearTimeout(timer); problem ? reject(problem) : accept(result); };
    const timer = setTimeout(() => { child.kill(); finish(blocked('成片解码验证超时，未进入发布队列。')); }, 240_000);
    child.on('error', problem => finish(blocked(`无法启动媒体验证：${problem.message}`)));
    child.stdout.on('data', data => { output += data; if (output.length > 2_000_000) { child.kill(); finish(blocked('媒体验证输出异常。')); } });
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    child.on('close', code => {
      if (code !== 0) return finish(blocked(`真实媒体解码未通过：${errors.trim()}`));
      try { finish(null, JSON.parse(output)); } catch { finish(blocked('媒体验证没有返回完整结果。')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ffmpeg: manifest.tools.ffmpeg, asset: manifest.asset, sources: manifest.sources.map(source => source.path) }));
  });
}

export async function verifyArtifacts(input, { probe = probeMedia } = {}) {
  const m = validateManifest(input);
  for (const source of m.sources) await checkedFile(source.path, source.sha256);
  await checkedFile(m.asset, m.assetSha256);
  for (const report of Object.values(m.verification)) await checkedFile(report.path, report.sha256);
  const assembly = await readJson(m.verification.assemblyReport.path), review = await readJson(m.verification.qualityReview.path);
  requireValue(assembly.status === 'completed' && assembly.sha256 === m.assetSha256 && samePath(assembly.asset, m.asset), '合成回执未绑定这条成片。');
  requireValue(assembly.fit === 'contain', '本流程要求保留完整画面的 contain 合成，不能裁切即梦水印。');
  requireValue(JSON.stringify(assembly.sourceHashes) === JSON.stringify(m.sources.map(source => source.sha256)), '合成回执与四段真实源片不一致。');
  requireValue(assembly.video?.decoded === true && assembly.video.frames === 320 && Math.abs(assembly.video.seconds - 20) <= .1
    && assembly.audioVerification?.decoded === true && assembly.audioVerification.nonSilent === true
    && assembly.motionVerification?.passed === true && assembly.motionVerification.distinctSourceCount === 4, '合成技术验收不完整。');
  requireValue(review.version === 1 && review.assetSha256 === m.assetSha256 && Number.isFinite(Date.parse(review.reviewedAt))
    && review.visualPassed === true && review.watermarksPreserved === true && review.continuityPassed === true
    && Array.isArray(review.notes) && review.notes.some(note => typeof note === 'string' && note.trim()), '尚未完成本条成片的画面、连续性及水印审查。');
  const measured = await probe(m);
  const v = measured.video, a = measured.audio;
  requireValue(v?.decoded === true && v.frames === 320 && v.fps === 16 && v.width === 468 && v.height === 832 && Math.abs(v.seconds - 20) <= .1, '成片实际解码、20 秒时长或画面规格不合格。');
  requireValue(a?.decoded === true && a.nonSilent === true && a.rmsDb > -45 && a.peakDb > -25 && Math.abs(a.seconds - 20) <= .15, '成片实际音轨未通过非静音检查。');
  requireValue(measured.sources?.length === 4 && measured.sources.every(source => source.video?.decoded === true
    && source.video.seconds >= 5 && source.video.frames / source.video.fps >= 5 && source.video.fps === 16
    && source.video.width >= 468 && source.video.height >= 832 && source.motion?.checked === true && source.motion.passed === true), '实际源片时长、分辨率或运动检查未通过。');
  // Reject a change that happened while FFmpeg was checking the files.
  await checkedFile(m.asset, m.assetSha256);
  for (const source of m.sources) await checkedFile(source.path, source.sha256);
  return { manifest: m, measured };
}

function makeApi(baseURL, fetchImpl) {
  const base = new URL(baseURL);
  requireValue(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, '发布交接只允许本机 HTTP 工作台地址。');
  return async (path, method = 'GET', body, revision) => {
    let response;
    try { response = await fetchImpl(new URL(path, base), { method, headers: { Origin: base.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(revision ? { 'If-Match': revision } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) }); }
    catch (problem) { throw Object.assign(new Error(`工作台请求未取得确定结果：${problem.message}`), { uncertain: method !== 'GET' }); }
    let value; try { value = await response.json(); } catch { throw Object.assign(new Error('工作台返回不可识别的结果。'), { uncertain: method !== 'GET' }); }
    if (!response.ok || value.ok === false) throw Object.assign(new Error(value.message || `工作台请求失败：${response.status}`), { status: response.status, uncertain: method !== 'GET' && response.status >= 500 });
    return value;
  };
}

function assertQueue(queue, m, { allowTerminal = false } = {}) {
  requireValue(queue.capabilities?.contentDeclaration === true && queue.capabilities?.whenReadySchedule === true && queue.capabilities?.expectedAssetHash === true, '当前服务尚未加载 AI 声明、素材哈希校验与成片就绪排期能力，请先升级服务。');
  requireValue(queue.config?.accountId === m.accountId && queue.config.browserId && queue.config.verifiedAt, '正式发布绑定的账号不匹配或尚未识别。');
  requireValue(Array.isArray(queue.items) && typeof queue.revision === 'string', '发布队列快照不完整。');
  const matches = queue.items.filter(item => item.sourceDraftId === m.draftId);
  requireValue(matches.length <= 1, '同一成片出现多个队列记录，需人工核实。');
  const item = matches[0];
  requireValue(!queue.items.some(row => row.id !== item?.id && ['approved', 'running', 'uncertain'].includes(row.status)), '存在其他已批准、执行中或结果不明的条目，不能一起开启发布。');
  requireValue(!queue.items.some(row => row.id !== item?.id && row.approval?.accountId === m.accountId && row.approval?.sha256 === m.assetSha256 && ['approved', 'running', 'submitted', 'published', 'uncertain'].includes(row.status)), '相同成片已经在其他发布记录中，不能重复交接。');
  if (item) {
    requireValue(item.title === m.title && item.caption === m.effectiveCaption && item.contentDeclaration === 'ai-generated', '队列条目内容或 AI 声明与授权不一致。');
    if (item.approval) requireValue(item.approval.sha256 === m.assetSha256 && item.approval.accountId === m.accountId
      && item.approval.contentDeclaration === 'ai-generated' && item.approval.title === m.title && item.approval.caption === m.effectiveCaption, '已保存的批准与本次成片授权不一致。');
    if (!allowTerminal) requireValue(['pending', 'approved', 'missed'].includes(item.status) && !hasExecutionEvidence(item), '该条已有执行或提交结果，不能再次批准或发布。');
  }
  return item;
}

function checkDraft(draft, m) {
  requireValue(draft.id === m.draftId && draft.handoffManifestId === m.id && draft.handoffBindingHash === m.bindingHash
    && samePath(draft.asset, m.asset) && draft.pubTitle === m.title && draft.caption === m.caption && draft.hashtags === m.tags
    && draft.platform === 'douyin' && draft.format === '视频' && draft.contentDeclaration === 'ai-generated' && !draft.sourceProductionId,
  '已有草稿与此成片授权不一致，不能覆盖用户内容。');
}

export async function handoff(input, { command = 'inspect', baseURL = 'http://127.0.0.1:4174', fetchImpl = fetch, probe = probeMedia } = {}) {
  requireValue(['inspect', 'enqueue'].includes(command), '仅支持 inspect 或 enqueue。');
  const { manifest: m, measured } = await verifyArtifacts(input, { probe });
  const api = makeApi(baseURL, fetchImpl);
  const health = await api('/api/health');
  requireValue(typeof health.dataDir === 'string' && samePath(health.dataDir, m.runtimeDir), '工作台连接到了另一个 runtime，不能交接。');
  let queue = await api('/api/automation');
  let item = assertQueue(queue, m, { allowTerminal: true });
  if (receiptOnly(item)) return { ok: true, status: item.status, action: 'existing-receipt-only', draftId: m.draftId, queueItemId: item.id, publishedUrl: item.publishedUrl || '', resubmitted: false, needsUser: !['running', 'submitted', 'published'].includes(item.status) };
  assertQueue(queue, m);
  const browsers = await api('/api/automation/browsers');
  requireValue(Array.isArray(browsers.browsers) && browsers.browsers.some(browser => browser.id === queue.config.browserId), '绑定的发布浏览器当前未连接，不能替换为其他实例。');
  requireValue(queue.scheduler?.running === true && !queue.scheduler.busy, '正式发布调度器未就绪或正在执行。');
  const existingState = await readJson(m.publicationState).catch(problem => { if (problem.code === 'ENOENT') return null; throw problem; });
  if (existingState) requireValue(existingState.version === 1 && existingState.manifestId === m.id && existingState.bindingHash === m.bindingHash, '本地交接记录对应另一份内容，不能重新使用。');
  if (command === 'inspect') return { ok: true, status: 'ready', draftId: m.draftId, queueItemId: item?.id || null, suggestedAt: queue.readySuggestedAt, accountId: m.accountId, measured, writesPerformed: false, pendingOperation: existingState?.pendingOperation || null };
  const store = new JsonStore(m.publicationState, { version: 1, manifestId: m.id, bindingHash: m.bindingHash, draftId: m.draftId, queueItemId: null, status: 'verified', pendingOperation: null, events: [] });
  const persist = async change => store.update(state => {
    requireValue(state.version === 1 && state.manifestId === m.id && state.bindingHash === m.bindingHash, '交接记录已变更。');
    state.updatedAt = stamp(); change(state); state.events = state.events.slice(-100);
  });
  const mutate = async (kind, path, body, revision, method = 'POST') => {
    const operation = { id: randomUUID(), kind, at: stamp(), path, requestHash: digest(body) };
    await persist(state => { requireValue(!state.pendingOperation, '有结果未明的交接操作，必须先核实服务器状态。'); state.pendingOperation = operation; state.events.push({ at: stamp(), kind, operationId: operation.id, state: 'intent' }); });
    let result;
    try {
      result = await api(path, method, body, revision);
    } catch (problem) {
      await persist(state => {
        requireValue(state.pendingOperation?.id === operation.id, '交接操作已由另一进程接管，不覆盖其回执。');
        state.status = problem.uncertain ? 'handoff-uncertain' : 'blocked'; state.lastError = problem.message;
        if (!problem.uncertain) state.pendingOperation = null;
        state.events.push({ at: stamp(), kind, operationId: operation.id, state: problem.uncertain ? 'uncertain' : 'rejected' });
      });
      throw problem;
    }
    await persist(state => {
      requireValue(state.pendingOperation?.id === operation.id, '交接操作已由另一进程接管，不覆盖其回执。');
      state.pendingOperation = null; state.events.push({ at: stamp(), kind, operationId: operation.id, state: 'acknowledged' });
    });
    return result;
  };
  const wb = await api('/api/state');
  requireValue(wb.state && Array.isArray(wb.state.drafts) && typeof wb.revision === 'string', '工作区数据尚未准备好。');
  const draft = wb.state.drafts.find(row => row.id === m.draftId);
  if (draft) checkDraft(draft, m);
  const pending = existingState?.pendingOperation;
  if (pending) {
    const proven = pending.kind === 'create-draft' && draft || pending.kind === 'import-draft' && item
      || pending.kind === 'approve' && item?.status === 'approved' || pending.kind === 'enable' && queue.config.enabled && item?.status === 'approved'
      || pending.kind === 'cancel-expired-schedule' && item?.status === 'pending' && !item.approval && !hasExecutionEvidence(item);
    requireValue(proven, '上次交接请求结果不明，服务器尚未提供已完成证据；不会重复请求。');
    await persist(state => {
      requireValue(JSON.stringify(state.pendingOperation) === JSON.stringify(pending), '交接操作已更新，请重新读取；不能清除另一次请求。');
      state.pendingOperation = null; state.events.push({ at: stamp(), kind: pending.kind, operationId: pending.id, state: 'recovered-from-server' });
    });
  }
  if (!draft) {
    wb.state.drafts.push({ id: m.draftId, handoffManifestId: m.id, handoffBindingHash: m.bindingHash, originalGenerationRunId: m.originalRunId,
      title: m.title, pubTitle: m.title, caption: m.caption, hashtags: m.tags, asset: m.asset, platform: 'douyin', format: '视频', status: '待检查', aiGenerated: true,
      contentDeclaration: 'ai-generated', verificationReport: m.verification.assemblyReport.path, createdAt: stamp(), updatedAt: stamp() });
    await mutate('create-draft', '/api/state', wb.state, wb.revision, 'PUT');
  }
  queue = await api('/api/automation'); item = assertQueue(queue, m, { allowTerminal: true });
  if (receiptOnly(item)) return { ok: true, status: item.status, queueItemId: item.id, resubmitted: false, needsUser: !['running', 'submitted', 'published'].includes(item.status) };
  assertQueue(queue, m);
  if (!item) {
    queue = await mutate('import-draft', '/api/automation/import-draft', { draftId: m.draftId }, queue.revision);
    item = assertQueue(queue, m);
    requireValue(item, '导入返回后未找到确定队列条目，请核实。');
  }
  await persist(state => { state.queueItemId = item.id; state.status = item.status; });
  // Only an expired approval that was never enabled or executed can be moved.
  // Keep the same queue item and use its public cancel/approve APIs, so a crash
  // never leads to a second imported video or a hidden receipt edit.
  if (item.status === 'approved' && !queue.config.enabled && Date.parse(item.scheduledAt) <= Date.now()) {
    requireValue(!hasExecutionEvidence(item) && item.approval.browserId === queue.config.browserId, '旧排期已有执行证据或绑定变化，不能重新排期。');
    await checkedFile(item.approval.asset, m.assetSha256);
    queue = await mutate('cancel-expired-schedule', `/api/automation/items/${item.id}/cancel`, {}, queue.revision);
    item = assertQueue(queue, m);
    requireValue(item?.status === 'pending' && !item.approval, '撤销过期排期的结果未核实。');
  }
  if (item.status !== 'approved') {
    await checkedFile(item.sourcePath, m.assetSha256);
    for (let attempt = 0; ; attempt++) {
      requireValue(Number.isFinite(Date.parse(queue.readySuggestedAt)) && Date.parse(queue.readySuggestedAt) > Date.now(), '成片就绪排期无效或已经过期。');
      try {
        queue = await mutate('approve', `/api/automation/items/${item.id}/approve`, { reviewed: true, accountId: m.accountId, title: m.title, caption: m.effectiveCaption, contentDeclaration: 'ai-generated', expectedSha256: m.assetSha256, scheduleMode: 'when-ready', scheduledAt: queue.readySuggestedAt }, queue.revision);
        item = assertQueue(queue, m); break;
      } catch (problem) {
        if (problem.status !== 409 || attempt !== 0) throw problem;
        queue = await api('/api/automation'); item = assertQueue(queue, m);
        requireValue(item && ['pending', 'missed'].includes(item.status) && !item.submitStartedAt, '审批冲突后状态已变化，不能重复请求。');
      }
    }
  }
  requireValue(item?.status === 'approved' && item.approval.browserId === queue.config.browserId, '成片批准或浏览器绑定未持久保存。');
  await checkedFile(item.approval.asset, m.assetSha256);
  await persist(state => { state.status = 'approved'; state.scheduledAt = item.scheduledAt; state.queueItemId = item.id; });
  if (!queue.config.enabled) {
    requireValue(Date.parse(item.scheduledAt) > Date.now(), '批准的排期已过期，不能直接开启发布。');
    try { queue = await mutate('enable', '/api/automation/toggle', { enabled: true }, queue.revision); }
    catch (problem) {
      // Existing daily-production protections may delay enabling until tomorrow.
      // Keep this same approved item; never create a replacement or alter receipts.
      if (!problem.uncertain && /今天已提交|每日生产正在启用/.test(problem.message)) {
        await persist(state => { state.status = 'approved-waiting-for-daily-limit'; });
        return { ok: true, status: 'approved-waiting-for-daily-limit', queueItemId: item.id, scheduledAt: item.scheduledAt, message: problem.message };
      }
      throw problem;
    }
  }
  const final = assertQueue(queue, m, { allowTerminal: true });
  requireValue(final && queue.config.enabled, '调度启用结果未确认。');
  await persist(state => { state.status = final.status; state.schedulerEnabled = true; state.scheduledAt = final.scheduledAt; state.verifiedAssetSha256 = m.assetSha256; });
  return { ok: true, status: final.status, queueItemId: final.id, draftId: m.draftId, scheduledAt: final.scheduledAt, schedulerEnabled: true, contentDeclaration: 'ai-generated', publicationSubmittedByCommand: false };
}
