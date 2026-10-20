import { mkdir, readdir, readFile, stat, realpath, copyFile, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { defaultAutomation, normalizeAutomation, nextSlot, shanghaiDay, validatePublishText, editableStatuses } from '../shared/automation-model.mjs';
import { DouyinPublisher } from './douyin-publisher.mjs';
import { hashFile, isInside } from '../lib/fs-utils.mjs';

const error = (message, status = 400) => Object.assign(new Error(message), { status });
const videoExtensions = new Set(['.mp4', '.mov', '.webm']);
const stamp = () => new Date().toISOString();
const TICK_INTERVAL_MS = 15000;
function log(state, id, message) { state.events.push({ id: randomUUID(), itemId: id || '', at: stamp(), message }); state.events = state.events.slice(-300); }

export class AutomationService {
  constructor(runtimeDir) {
    this.directory = join(runtimeDir, 'automation'); this.mediaDir = join(this.directory, 'media');
    this.store = new JsonStore(join(this.directory, 'queue.json'), defaultAutomation(), normalizeAutomation);
    this.publisher = new DouyinPublisher(); this.timer = null; this.busy = false; this.lastError = ''; this.stopping = false;
  }
  async snapshot() {
    const current = await this.store.read();
    return { ...current.value, revision: current.revision, suggestedAt: nextSlot(current.value.items, current.value.config.dailyTime), scheduler: { running: !!this.timer && !this.lastError, busy: this.busy, error: this.lastError, checkSeconds: 15, lateMinutes: 10 } };
  }
  async update(revision, change) {
    if (typeof revision !== 'string') throw error('请先刷新自动发布页面，再执行操作。', 428);
    return this.store.update(change, revision);
  }
  async settings(input, revision) {
    let folder = String(input.folder || '').trim();
    if (folder) {
      if (!isAbsolute(folder) || /^\\\\/.test(folder)) throw error('请填写本机磁盘上的文件夹完整路径。');
      folder = await realpath(folder).catch(() => { throw error('视频文件夹不存在或无法读取。'); });
      if (!(await stat(folder)).isDirectory()) throw error('请选择文件夹。');
      if (resolve(folder) === resolve(this.directory) || isInside(this.directory, folder)) throw error('请选择原始视频目录，不要选择自动发布数据目录。');
    }
    const dailyTime = String(input.dailyTime || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) throw error('请选择有效的每日时间。');
    const browserId = String(input.browserId || '').trim().slice(0, 200);
    await this.update(revision, state => {
      if (state.items.some(i => i.status === 'running')) throw error('有视频正在执行，请完成或暂停后再更改设置。', 409);
      const changed = state.config.folder !== folder || state.config.dailyTime !== dailyTime || state.config.browserId !== browserId;
      if (changed) {
        state.config.enabled = false;
        for (const item of state.items.filter(i => i.status === 'approved')) { item.status = 'pending'; item.approval = null; item.scheduledAt = ''; item.message = '设置已变更，请重新审批。'; }
        if (state.config.browserId !== browserId) { state.config.accountId = ''; state.config.verifiedAt = ''; }
      }
      Object.assign(state.config, { folder, dailyTime, browserId }); log(state, '', '已保存自动发布设置；变更后的内容需重新审批。');
    });
  }
  async browsers() { return this.publisher.browsers(); }
  async connect(revision) {
    const { value, revision: actual } = await this.store.read();
    if (revision !== actual) throw error('设置已有更新，请刷新。', 409);
    if (!value.config.browserId) throw error('请先选择并保存用于发布的浏览器。');
    const account = await this.publisher.inspectAccount(value.config.browserId);
    await this.update(revision, state => {
      if (state.items.some(i => i.status === 'running')) throw error('正在发布时不能重新绑定账号。', 409);
      if (state.config.accountId && state.config.accountId !== account.accountId) {
        state.config.enabled = false;
        for (const item of state.items.filter(i => i.status === 'approved')) { item.status = 'pending'; item.approval = null; item.scheduledAt = ''; item.message = '账号已变更，请重新审批。'; }
      }
      state.config.accountId = account.accountId; state.config.verifiedAt = stamp();
      log(state, '', `已识别抖音号 ${account.accountId}，审批时请确认此账号。`);
    });
    return account;
  }
  async scan(revision) {
    const { value, revision: actual } = await this.store.read();
    if (revision !== actual) throw error('设置已有更新，请刷新。', 409);
    if (!value.config.folder) throw error('请先设置视频文件夹。');
    const folder = await realpath(value.config.folder);
    const entries = (await readdir(folder, { withFileTypes: true })).filter(e => e.isFile() && videoExtensions.has(extname(e.name).toLowerCase())).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    if (entries.length > 500) throw error('文件夹视频超过 500 个，请分成较小的目录。');
    const incoming = [];
    for (const entry of entries) {
      const sourcePath = await realpath(join(folder, entry.name)); if (!isInside(folder, sourcePath)) continue;
      const info = await stat(sourcePath);
      if (!info.size || info.size > 4 * 1024 ** 3) continue;
      incoming.push({ id: randomUUID(), sourcePath, fileName: entry.name, sourceSize: info.size, sourceMtime: info.mtimeMs, title: [...basename(entry.name, extname(entry.name))].slice(0, 30).join(''), caption: '', status: 'pending', scheduledAt: '', approval: null, createdAt: stamp(), message: '' });
    }
    let added = 0;
    await this.update(revision, state => {
      for (const item of incoming) if (!state.items.some(i => i.sourcePath === item.sourcePath && i.sourceSize === item.sourceSize && i.sourceMtime === item.sourceMtime)) { state.items.push(item); added++; }
      if (state.items.length > 2000) throw error('队列已达到 2000 条，请使用新的数据目录或先归档历史记录。');
      log(state, '', `扫描完成，新增 ${added} 条待审批视频。`);
    });
    return { added, found: entries.length };
  }
  async importDraft(input, revision) {
    const { value, revision: actual } = await this.store.read();
    if (revision !== actual) throw error('队列已有更新，请刷新后导入。', 409);
    if (!value.config.folder) throw error('请先在自动发布中设置视频文件夹。');
    const draftId = String(input?.draftId || '');
    const asset = String(input?.asset || '').trim();
    if (!asset || !isAbsolute(asset)) throw error('草稿缺少有效的素材路径。');
    const ext = extname(asset).toLowerCase();
    if (!videoExtensions.has(ext)) throw error('草稿素材不是受支持的视频文件（MP4 / MOV / WebM）。');
    const source = await realpath(asset).catch(() => { throw error('草稿素材不存在或无法读取。'); });
    const info = await stat(source).catch(() => { throw error('草稿素材不存在或无法读取。'); });
    if (!info.isFile() || !info.size || info.size > 4 * 1024 ** 3) throw error('草稿素材无效或过大。');
    const title = String(input?.title || '').trim().slice(0, 30) || basename(source, ext).slice(0, 30);
    const captionRaw = String(input?.caption || '').trim();
    const tags = String(input?.tags || '').trim();
    const caption = captionRaw && tags && !captionRaw.includes(tags) ? `${captionRaw}\n\n${tags}` : (captionRaw || tags);
    const content = validatePublishText(title, caption);
    const folder = await realpath(value.config.folder);
    const target = join(folder, `${randomUUID()}${ext}`);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    try {
      const copied = await stat(target);
      const incoming = { id: randomUUID(), sourceDraftId: draftId, sourcePath: target, fileName: basename(target), sourceSize: copied.size, sourceMtime: copied.mtimeMs, title: content.title, caption: content.caption, status: 'pending', scheduledAt: '', approval: null, createdAt: stamp(), message: '已从工作台草稿导入，请预览并审批。' };
      await this.update(revision, state => {
        if (draftId && state.items.some(i => i.sourceDraftId === draftId)) throw error('该草稿已在自动发布队列中。', 409);
        if (state.items.length >= 2000) throw error('队列已达到 2000 条，请先归档历史记录。');
        state.items.push(incoming);
        log(state, incoming.id, `已从工作台草稿导入「${content.title}」，请在每日自动发布中预览并审批。`);
      });
      return { added: true, id: incoming.id };
    } catch (problem) {
      // A write can commit before lock cleanup reports an error. Preserve any
      // copy referenced by the saved queue, including entries from a scan.
      try {
        await this.store.update(async state => {
          if (state.items.some(item => item.sourcePath === target || item.approval?.asset === target)) return;
          await unlink(target);
        });
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') console.warn('草稿导入副本清理未完成：', cleanupError?.message || cleanupError);
      }
      throw problem;
    }
  }
  async sourceFile(item, folder) {
    if (!folder) throw error('请先设置视频文件夹。');
    const root = await realpath(folder), file = await realpath(item.sourcePath).catch(() => { throw error('原视频已移动或删除，请重新扫描。'); });
    if (!isInside(root, file) || !videoExtensions.has(extname(file).toLowerCase())) throw error('视频不在当前选定文件夹内。');
    const info = await stat(file);
    if (!info.isFile() || info.size !== item.sourceSize || info.mtimeMs !== item.sourceMtime) throw error('视频文件已变化，请重新扫描并审批新版本。');
    return file;
  }
  async edit(id, input, revision) {
    const content = validatePublishText(input.title, input.caption);
    await this.update(revision, state => {
      const item = state.items.find(i => i.id === id);
      if (!item || !editableStatuses.includes(item.status)) throw error('请先撤销批准，或选择待审批条目。', 409);
      Object.assign(item, content, { status: 'pending', approval: null, scheduledAt: '', message: '' }); log(state, id, '已保存待审批内容。');
    });
  }
  async approve(id, input, revision) {
    if (input.reviewed !== true) throw error('请先确认视频、文案、账号和排期。');
    const current = await this.store.read(); if (current.revision !== revision) throw error('队列已有更新，请刷新后审批。', 409);
    const { config, items } = current.value, item = items.find(i => i.id === id);
    if (!item || !editableStatuses.includes(item.status)) throw error('此条目不能再次批准。', 409);
    if (!config.accountId || !config.verifiedAt || !config.browserId) throw error('请先检查浏览器并识别目标抖音号。');
    const content = validatePublishText(input.title, input.caption);
    const scheduledAt = nextSlot(items, config.dailyTime);
    if (input.scheduledAt !== scheduledAt || input.accountId !== config.accountId) throw error('账号或建议排期已变化，请重新查看审批内容。', 409);
    const file = await this.sourceFile(item, config.folder);
    await mkdir(this.mediaDir, { recursive: true });
    const asset = join(this.mediaDir, randomUUID() + extname(file).toLowerCase());
    let committed = false;
    try {
      await copyFile(file, asset, constants.COPYFILE_EXCL);
      await this.sourceFile(item, config.folder);
      const sha256 = await hashFile(asset);
      if (sha256 !== await hashFile(file)) throw error('复制期间视频发生变化，请重新扫描。');
      await this.update(revision, state => {
        if (Date.parse(scheduledAt) <= Date.now() + 15000) throw error('距离排期太近，请刷新后重新安排。');
        if (state.items.some(i => i.id !== id && ['approved', 'running', 'submitted', 'published', 'uncertain'].includes(i.status) && i.approval?.sha256 === sha256 && i.approval?.accountId === config.accountId)) throw error('相同视频已在该账号的队列或发布记录中，已阻止重复发布。');
        const target = state.items.find(i => i.id === id);
        for (const key of ['startedAt', 'submitStartedAt', 'finishedAt', 'evidence', 'publishedUrl']) delete target[key];
        Object.assign(target, content, { status: 'approved', scheduledAt, approvedAt: stamp(), message: '', approval: { sha256, asset, accountId: config.accountId, browserId: config.browserId, title: content.title, caption: content.caption, scheduledAt } });
        log(state, id, `已批准，计划 ${scheduledAt} 发布到抖音号 ${config.accountId}。`);
      });
      committed = true;
    } finally { if (!committed) await unlink(asset).catch(() => {}); }
  }
  async cancel(id, revision) {
    await this.update(revision, state => {
      const item = state.items.find(i => i.id === id);
      if (!item || !['pending', 'approved', 'failed', 'missed', 'cancelled'].includes(item.status)) throw error('正在执行或已有发布结果的记录不能撤销，请先核实结果。', 409);
      item.status = 'pending'; item.approval = null; item.scheduledAt = ''; item.message = '已撤销批准，可重新编辑。'; log(state, id, item.message);
    });
  }
  async reconcile(id, input, revision) {
    if (!['published', 'not-published'].includes(input.result) || input.confirmed !== true) throw error('请先到抖音核实后选择结果。');
    const url = String(input.url || '').trim();
    if (input.result === 'published') {
      let parsed; try { parsed = new URL(url); } catch {}
      if (!parsed || parsed.protocol !== 'https:' || !['www.douyin.com', 'douyin.com', 'v.douyin.com'].includes(parsed.hostname)) throw error('请填写核实后的抖音作品链接。');
    }
    await this.update(revision, state => {
      const item = state.items.find(i => i.id === id);
      if (!item || !['uncertain', 'submitted'].includes(item.status)) throw error('此记录不需要人工核实。', 409);
      if (input.result === 'published') { item.status = 'published'; item.publishedUrl = url; item.message = '用户已核实发布结果。'; }
      else { item.status = 'pending'; item.approval = null; item.scheduledAt = ''; item.message = '用户确认未发布，需重新审批后执行。'; }
      log(state, id, item.message);
    });
  }
  async toggle(enabled, revision) {
    if (typeof enabled !== 'boolean') throw error('开关值无效。');
    if (enabled && (!this.timer || this.stopping)) throw error('本地调度服务尚未就绪，请先处理页面错误并重新启动豆蜂。', 503);
    if (enabled) await this.checkDailyProduction();
    await this.update(revision, state => {
      if (enabled && (!state.config.accountId || !state.config.browserId || !state.items.some(i => i.status === 'approved' && Date.parse(i.scheduledAt) > Date.now()))) throw error('请先识别账号，并批准至少一条未来的视频排期。');
      if (enabled && state.items.some(i => ['running', 'uncertain'].includes(i.status))) throw error('请先处理正在执行或结果待核实的任务。');
      state.config.enabled = enabled; log(state, '', enabled ? '每日自动发布已开启。' : '已暂停；若已点击发布，仍会保存该次结果。');
    });
    if (enabled) this.lastError = '';
  }
  async preview(id) {
    const { value } = await this.store.read(), item = value.items.find(i => i.id === id);
    if (!item) throw error('视频条目不存在。', 404);
    if (item.approval?.asset) {
      const file = await realpath(item.approval.asset); if (!isInside(await realpath(this.mediaDir), file)) throw error('审批素材路径无效。');
      return { directory: this.mediaDir, path: file };
    }
    return { directory: await realpath(value.config.folder), path: await this.sourceFile(item, value.config.folder) };
  }
  async lease() {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, 'runner.lock');
    let file;
    // Serialize lock recovery across server processes using the queue's write lock.
    await this.store.update(async () => {
      let previous;
      try { previous = await readFile(path, 'utf8'); } catch (problem) { if (problem.code !== 'ENOENT') throw problem; }
      if (previous !== undefined) {
        let owner; try { owner = JSON.parse(previous); } catch {}
        let exited = false;
        if (Number.isInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (problem) { exited = problem.code === 'ESRCH'; }
        }
        if (!exited) throw error('另一个发布进程仍在使用队列，或执行锁无法识别。请关闭其他豆蜂服务后重试；持续出现时按使用说明处理。', 503);
        await unlink(path);
      }
      file = await open(path, 'wx');
      try { await file.writeFile(JSON.stringify({ pid: process.pid, at: stamp() })); await file.sync(); }
      catch (problem) { await file.close(); file = null; await unlink(path); throw problem; }
    }).catch(async problem => { if (file) { await file.close(); await unlink(path); } throw problem; });
    return async () => { await file.close(); await unlink(path); };
  }
  async checkDailyProduction(accountId = '') {
    let daily;
    try { daily = JSON.parse(await readFile(join(this.directory, '..', 'daily-production', 'state.json'), 'utf8')); }
    catch (problem) { if (problem.code === 'ENOENT') return; throw error('每日生产记录无法读取，请检查后再发布。'); }
    if (daily?.version !== 1 || !Array.isArray(daily.runs)) throw error('每日生产记录格式异常，已停止发布。');
    if (daily.config?.enabled || daily.runs.some(run => !run.previewOnly && (!accountId || run.binding?.accountId === accountId) && (['selecting', 'rendering', 'publishing', 'uncertain'].includes(run.status) || ['submitted', 'published'].includes(run.status) && run.day === shanghaiDay(Date.now())))) throw error('每日生产正在启用、结果待核实，或今天已提交视频，请先在每日生产页面查看。');
  }
  async start() {
    if (this.timer) return;
    this.stopping = false;
    const { value } = await this.store.read();
    if (value.items.some(i => i.status === 'running')) {
      // Hold the same lease as tick(); a separate check followed by a write can
      // otherwise mark another server's newly started publication as interrupted.
      const release = await this.lease();
      try {
        await this.store.update(state => {
          if (!state.items.some(i => i.status === 'running')) return;
          state.config.enabled = false;
          for (const item of state.items.filter(i => i.status === 'running')) { item.status = 'uncertain'; item.message = '上次服务在执行期间中断，请到抖音核实，系统不会重复提交。'; log(state, item.id, item.message); }
        });
      } finally {
        await release();
      }
    }
    this.timer = setInterval(() => { void this.tick().catch(problem => { this.lastError = problem.message; }); }, TICK_INTERVAL_MS);
    this.timer.unref();
  }
  stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true; let release, target;
    try {
      const read = await this.store.read(), now = Date.now();
      if (!read.value.config.enabled || !read.value.items.some(i => i.status === 'approved' && Date.parse(i.scheduledAt) <= now)) return;
      release = await this.lease();
      await this.checkDailyProduction(read.value.config.accountId);
      await this.store.update(state => {
        if (!state.config.enabled) return;
        for (const item of state.items.filter(i => i.status === 'approved' && now - Date.parse(i.scheduledAt) > 10 * 60000)) { item.status = 'missed'; item.message = '超过排期 10 分钟，已跳过。请重新审批安排下次时间。'; log(state, item.id, item.message); }
        if (state.items.some(i => ['running', 'uncertain'].includes(i.status))) { state.config.enabled = false; return; }
        const item = state.items.find(i => i.status === 'approved' && Date.parse(i.scheduledAt) <= now);
        if (!item) return;
        if (state.items.some(i => i.id !== item.id && ['submitted', 'published'].includes(i.status) && i.approval.accountId === item.approval.accountId && shanghaiDay(Date.parse(i.startedAt || i.scheduledAt)) === shanghaiDay(now))) { item.status = 'missed'; item.message = '该账号今天已有自动发布记录，请重新排期。'; return; }
        item.status = 'running'; item.startedAt = stamp(); item.message = '正在检查账号和视频。'; target = structuredClone(item); log(state, item.id, item.message);
      });
      if (!target) return;
      const asset = await realpath(target.approval.asset);
      if (!isInside(await realpath(this.mediaDir), asset) || await hashFile(asset) !== target.approval.sha256) throw error('已批准的视频副本发生变化，已停止。');
      const guard = async () => {
        await this.checkDailyProduction(target.approval.accountId);
        const { value } = await this.store.read(), item = value.items.find(i => i.id === target.id);
        if (this.stopping || !value.config.enabled || item?.status !== 'running' || JSON.stringify(item.approval) !== JSON.stringify(target.approval) || value.config.accountId !== target.approval.accountId || value.config.browserId !== target.approval.browserId) throw error('自动发布已暂停或审批内容变化。');
        const scheduled = Date.parse(target.scheduledAt);
        if (Date.now() - scheduled > 10 * 60000 || shanghaiDay(Date.now()) !== shanghaiDay(scheduled)) throw error('已超过本次排期的提交窗口，请重新审批安排下次时间。');
      };
      const beforeSubmit = async () => {
        await guard();
        if (await hashFile(asset) !== target.approval.sha256) throw error('视频副本发生变化，已停止。');
        await guard();
        await this.store.update(state => { const item = state.items.find(i => i.id === target.id); if (!state.config.enabled || item?.status !== 'running') throw error('发布已暂停。'); item.submitStartedAt = stamp(); item.message = '已进入提交步骤；结果不明确时不会重试。'; });
      };
      const outcome = await this.publisher.publish(target, { guard, beforeSubmit });
      await this.store.update(state => { const item = state.items.find(i => i.id === target.id); item.status = 'submitted'; item.finishedAt = stamp(); item.message = outcome.message; item.evidence = outcome.evidence; log(state, item.id, item.message); });
      this.lastError = '';
    } catch (problem) {
      this.lastError = problem.message;
      if (target) await this.store.update(state => { const item = state.items.find(i => i.id === target.id); if (!item) return; item.status = item.submitStartedAt ? 'uncertain' : 'failed'; item.message = problem.message; item.finishedAt = stamp(); state.config.enabled = false; log(state, item.id, item.message); });
    } finally { try { if (release) await release(); } finally { this.busy = false; } }
  }
}
