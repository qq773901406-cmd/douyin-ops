import { copyFile, mkdir, readFile, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { JsonStore } from './workbuddy/connector/lib/json-store.mjs';

const statuses = new Set(['prepared', 'submitting', 'submitted', 'published', 'uncertain', 'abandoned', 'not_submitted']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
const fail = message => { throw new Error(message); };
const text = (value, label, max, optional = false) => {
  if (typeof value !== 'string' || (!optional && !value.trim()) || [...value.trim()].length > max) fail(`${label}格式不正确。`);
  return value.trim().normalize('NFC');
};
const shaPattern = /^[a-f0-9]{64}$/;
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function readJson(path) {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}
function videoUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('请填写 B 站视频链接。'); }
  const match = url.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10})\/?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'www.bilibili.com' || url.port || url.username || url.password || !match) fail('请填写 https://www.bilibili.com/video/BV…/ 形式的作品链接。');
  return { bvid: match[1], url: `https://www.bilibili.com/video/${match[1]}/` };
}
function validateLedger(value) {
  if (value?.version !== 1 || !Array.isArray(value.jobs)) fail('B 站流程记录格式错误，请检查备份。');
  const ids = new Set();
  for (const job of value.jobs) {
    if (!job || !/^[a-f0-9-]{36}$/.test(job.id) || ids.has(job.id) || job.platform !== 'bilibili' || !statuses.has(job.status) || !shaPattern.test(job.video?.sha256) || !Array.isArray(job.history)) fail('B 站流程条目格式错误。');
    ids.add(job.id);
    text(job.account?.name, '账号名称', 100);
    if (typeof job.account.uid !== 'string' || !/^(?:[1-9]\d{0,19})?$/.test(job.account.uid)) fail('账号 UID 格式错误。');
    text(job.title, '标题', 80);
    if (job.plan && (digest(job.plan) !== job.planHash || job.plan.title !== job.title)) fail('发布清单已变化，请保留原记录并重新准备。');
    if (['prepared', 'submitting'].includes(job.status) && (!job.plan || !isAbsolute(job.video.path || ''))) fail('发布条目缺少素材副本。');
    if (['published', 'submitted'].includes(job.status)) videoUrl(job.receipt?.url);
  }
  return value;
}
function sameAccount(a, b) {
  return a.uid && b.uid ? a.uid === b.uid : a.name === b.name;
}
function duplicate(jobs, candidate) {
  return jobs.find(j => j.id !== candidate.id && !['abandoned', 'not_submitted'].includes(j.status) && j.video.sha256 === candidate.video.sha256 && sameAccount(j.account, candidate.account));
}
function rejectDuplicate(job) {
  if (job) fail(`同账号的相同视频已有记录：${job.id}（${job.status}）${job.receipt?.url ? ' ' + job.receipt.url : ''}。先核对该记录，不要重复上传或提交。`);
}
function event(job, action, detail) {
  job.updatedAt = now();
  job.history.push({ at: job.updatedAt, action, detail });
}
async function localFile(path, extensions) {
  if (typeof path !== 'string' || !isAbsolute(path) || /^\\\\/.test(path)) fail('素材与截图必须使用本机文件的完整路径。');
  const actual = await realpath(path);
  if (/^\\\\/.test(actual)) fail('不支持网络共享路径，请先保存到本机。');
  const info = await stat(actual);
  if (!info.isFile() || !info.size || !extensions.has(extname(actual).toLowerCase())) fail(`文件为空或格式不支持：${basename(path)}`);
  return { path: actual, size: info.size, sha256: await hashFile(actual) };
}
const images = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const videos = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);

// Local workflow state only. This class never opens a browser or submits a video.
export class BilibiliWorkflow {
  constructor(directory) {
    this.directory = resolve(directory);
    this.store = new JsonStore(join(this.directory, 'jobs.json'), { version: 1, jobs: [] }, validateLedger);
  }
  async list() { return (await this.store.read()).value.jobs; }
  async show(id) {
    const job = (await this.list()).find(j => j.id === id);
    if (!job) fail('未找到这条 B 站流程记录。');
    return job;
  }
  async evidence(path) {
    const source = await localFile(path, images);
    const directory = join(this.directory, 'evidence');
    await mkdir(directory, { recursive: true });
    const saved = join(directory, `${randomUUID()}${extname(source.path).toLowerCase()}`);
    await copyFile(source.path, saved, constants.COPYFILE_EXCL);
    if (await hashFile(saved) !== source.sha256) { await unlink(saved); fail('截图复制期间发生变化，请重新保存。'); }
    return { path: saved, sha256: source.sha256 };
  }
  async prepare(input) {
    const allowed = new Set(['videoPath', 'accountName', 'accountUid', 'browserId', 'title', 'description', 'tags', 'aiGenerated', 'category', 'coverFrameSeconds', 'cover43Path', 'cover169Path']);
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(k => !allowed.has(k))) fail('发布清单包含不支持的字段，请使用项目中的示例清单。');
    const account = { name: text(input.accountName, '目标账号', 100), uid: input.accountUid === undefined ? '' : text(input.accountUid, '账号 UID', 20, true) };
    if (!/^(?:[1-9]\d{0,19})?$/.test(account.uid)) fail('账号 UID 必须为数字，未知时留空。');
    if (typeof input.aiGenerated !== 'boolean') fail('请明确 aiGenerated 为 true 或 false。');
    if (!Array.isArray(input.tags) || input.tags.length < 1 || input.tags.length > 10) fail('请填写 1–10 个相关标签。');
    const tags = input.tags.map(tag => text(tag, '标签', 20));
    if (new Set(tags).size !== tags.length) fail('标签不能重复。');
    const plan = {
      title: text(input.title, '标题', 80), description: text(input.description, '简介', 2000, true), tags,
      aiGenerated: input.aiGenerated, category: text(input.category, '分区', 40),
      coverFrameSeconds: input.coverFrameSeconds ?? null, covers: {},
    };
    if (plan.coverFrameSeconds !== null && (!Number.isFinite(plan.coverFrameSeconds) || plan.coverFrameSeconds < 0)) fail('封面取帧时间必须是非负秒数。');
    const source = await localFile(input.videoPath, videos);
    const job = { id: randomUUID(), platform: 'bilibili', account, browserId: text(input.browserId, '浏览器实例', 200), title: plan.title, video: { ...source, sourcePath: source.path }, plan, status: 'prepared', createdAt: now(), updatedAt: now(), history: [] };
    rejectDuplicate(duplicate(await this.list(), job));
    const assets = join(this.directory, 'assets', job.id), created = [];
    await mkdir(assets, { recursive: true });
    try {
      const snapshot = async (asset, name) => {
        const path = join(assets, name + extname(asset.path).toLowerCase());
        await copyFile(asset.path, path, constants.COPYFILE_EXCL); created.push(path);
        if (await hashFile(path) !== asset.sha256) fail('素材在复制时变化，请重新准备。');
        return { path, sha256: asset.sha256, size: asset.size };
      };
      job.video = { ...(await snapshot(source, 'video')), sourcePath: source.path };
      for (const [field, key] of [['cover43Path', '4:3'], ['cover169Path', '16:9']]) {
        if (input[field]) plan.covers[key] = await snapshot(await localFile(input[field], images), field);
      }
      job.planHash = digest(plan);
      event(job, 'prepare', '保存视频副本和清单，尚未取得提交许可。');
      await this.store.update(state => { rejectDuplicate(duplicate(state.jobs, job)); state.jobs.push(job); });
      return job;
    } catch (error) {
      // Only remove files created by this attempt; never recursively remove user paths.
      // If storage cannot be read after a write error, retain the files for recovery.
      const saved = await this.list().then(jobs => jobs.some(j => j.id === job.id)).catch(() => true);
      if (!saved) {
        for (const path of created) await unlink(path).catch(() => {});
        await rmdir(assets).catch(() => {});
      }
      throw error;
    }
  }
  async beginSubmit(id, { accountName, accountUid = '', browserId, authorization, evidence }) {
    const permission = text(authorization, '用户授权原文或明确的授权说明', 2000);
    const snapshot = await this.show(id);
    if (snapshot.status !== 'prepared') fail(`当前状态 ${snapshot.status} 禁止再次提交；先到平台核实。`);
    if (snapshot.account.name !== accountName?.trim().normalize('NFC') || (snapshot.account.uid && snapshot.account.uid !== accountUid) || snapshot.browserId !== browserId) fail('当前可见账号或浏览器与准备记录不一致。');
    for (const asset of [snapshot.video, ...Object.values(snapshot.plan.covers)]) {
      if (await hashFile(asset.path) !== asset.sha256) fail('已准备的素材副本发生变化，禁止提交。');
    }
    const proof = await this.evidence(evidence);
    const result = await this.store.update(state => {
      const job = state.jobs.find(j => j.id === id);
      if (!job || job.status !== 'prepared' || job.planHash !== snapshot.planHash) fail('条目已由另一个执行进程更改，禁止提交。');
      rejectDuplicate(duplicate(state.jobs, job));
      // One attempt per browser at a time, including different videos/accounts.
      if (state.jobs.some(j => j.id !== id && (j.browserId === browserId || sameAccount(j.account, job.account)) && ['submitting', 'uncertain'].includes(j.status))) fail('这个浏览器或账号还有提交中或结果不明的任务，先核实后再发布。');
      job.status = 'submitting';
      job.attempt = { id: randomUUID(), startedAt: now(), authorization: permission, accountObserved: { name: accountName, uid: accountUid }, evidence: proof };
      event(job, 'begin-submit', '已记录单次提交意图。接下来最多点击一次立即投稿；重启后不自动重试。');
      return job;
    });
    return result.result;
  }
  async finish(id, { status, url, evidence, note }) {
    if (!['submitted', 'published', 'uncertain'].includes(status)) fail('结果只能是 submitted、published 或 uncertain。');
    const detail = text(note, '页面结果说明', 2000);
    const link = status === 'uncertain' ? null : videoUrl(url);
    const proof = await this.evidence(evidence);
    const result = await this.store.update(state => {
      const job = state.jobs.find(j => j.id === id);
      if (!job || !['submitting', 'submitted', 'uncertain'].includes(job.status)) fail('只有已开始提交的条目才能记录平台结果。');
      if (job.receipt?.bvid && link && job.receipt.bvid !== link.bvid) fail('作品编号与已保存的投稿回执不一致。');
      job.status = status;
      job.receipt = { ...job.receipt, ...(link || {}), observedAt: now(), evidence: proof, note: detail };
      event(job, status, detail);
      return job;
    });
    return result.result;
  }
  async abandon(id, note) {
    const detail = text(note, '放弃原因', 2000);
    const result = await this.store.update(state => {
      const job = state.jobs.find(j => j.id === id);
      if (!job || job.status !== 'prepared') fail('只能放弃尚未开始提交的准备记录。已点击或结果不明的条目必须先核实，不能解除重复保护。');
      job.status = 'abandoned'; event(job, 'abandon', detail); return job;
    });
    return result.result;
  }
  async confirmNotSubmitted(id, { authorization, evidence, note }) {
    const confirmation = text(authorization, '用户确认完全未投稿的说明', 2000);
    const detail = text(note, '平台核实结果', 2000);
    const proof = await this.evidence(evidence);
    const result = await this.store.update(state => {
      const job = state.jobs.find(j => j.id === id);
      if (!job || !['submitting', 'uncertain'].includes(job.status) || job.receipt?.bvid) fail('已取得作品编号的条目不能回退。请保留平台结果。');
      job.status = 'not_submitted';
      job.resolution = { authorization: confirmation, evidence: proof, note: detail, at: now() };
      event(job, 'confirm-not-submitted', detail);
      return job;
    });
    return result.result;
  }
  async importReceipt(input) {
    if (input?.platform !== 'bilibili' || !['published', 'submitted'].includes(input.status)) fail('只能归档已核实的 B 站投稿回执。');
    const link = videoUrl(input.videoUrl);
    if (input.bvid && input.bvid !== link.bvid) fail('回执中的作品编号与链接不符。');
    const sha256 = String(input.sha256 || '').toLowerCase();
    if (!shaPattern.test(sha256)) fail('回执缺少视频 SHA-256。');
    const account = { name: text(input.accountName, '账号名称', 100), uid: input.accountUid === undefined ? '' : text(input.accountUid, '账号 UID', 20, true) };
    if (!/^(?:[1-9]\d{0,19})?$/.test(account.uid)) fail('账号 UID 格式错误。');
    const job = { id: randomUUID(), platform: 'bilibili', account, browserId: '', title: text(input.title, '标题', 80), video: { sha256, sourcePath: input.sourcePath || '', path: null }, status: input.status, createdAt: now(), updatedAt: now(), history: [] };
    const existing = duplicate(await this.list(), job);
    if (existing?.receipt?.bvid === link.bvid) return existing;
    rejectDuplicate(existing);
    const proof = await this.evidence(input.screenshot);
    job.receipt = { ...link, observedAt: now(), evidence: proof, note: text(input.evidence, '回执中的页面证据说明', 2000), imported: true };
    event(job, 'import-receipt', '归档既有发布结果，用于后续重复检查；未执行上传或发布。');
    const result = await this.store.update(state => {
      const other = duplicate(state.jobs, job);
      if (other?.receipt?.bvid === link.bvid) return other;
      rejectDuplicate(other); state.jobs.push(job); return job;
    });
    return result.result;
  }
}
