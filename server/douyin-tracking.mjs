import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { shanghaiDay } from '../shared/automation-model.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const eligible = new Set(['submitted', 'published', 'uncertain']);
const reviews = new Set(['pending', 'published', 'rejected', 'unknown']);
const counts = ['plays', 'likes', 'mComments', 'shares', 'saves', 'followers'];
const percentages = ['completion', 'retention', 'conversion'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sameOrNewer = (a, b) => validTime(a) && Date.parse(a) >= Date.parse(b);

function workUrl(input, workId) {
  let url;
  try { url = new URL(input); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
    || !['www.douyin.com', 'douyin.com'].includes(url.hostname)
    || url.pathname !== `/video/${workId}`) throw fail('作品链接必须与抖音作品编号一致。', 400);
  return `https://www.douyin.com/video/${workId}`;
}

function metricsFrom(input = {}) {
  if (!object(input)) throw fail('效果指标必须是对象。', 400);
  const metrics = {};
  for (const key of Object.keys(input)) {
    if (![...counts, ...percentages].includes(key)) throw fail(`不支持的效果指标：${key}`, 400);
    const value = input[key];
    // A missing field is unknown; it is never a measured zero.
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || (counts.includes(key) ? !Number.isSafeInteger(value) : value > 100)) throw fail(`效果指标 ${key} 无效。`, 400);
    metrics[key] = value;
  }
  return metrics;
}

function observationFrom(input) {
  if (!object(input) || typeof input.accountId !== 'string' || !input.accountId.trim()
    || typeof input.workId !== 'string' || !/^\d{1,32}$/.test(input.workId)
    || !reviews.has(input.reviewState) || !validTime(input.observedAt)) throw fail('审核观察缺少账号、作品编号、状态或时间。', 400);
  let evidenceUrl;
  try { evidenceUrl = new URL(input.evidence?.url); } catch {}
  if (!evidenceUrl || evidenceUrl.protocol !== 'https:' || evidenceUrl.username || evidenceUrl.password || evidenceUrl.port
    || !['creator.douyin.com', 'www.douyin.com', 'douyin.com'].includes(evidenceUrl.hostname)
    || typeof input.evidence?.text !== 'string' || !input.evidence.text.trim() || input.evidence.text.length > 20000) {
    throw fail('审核观察需要抖音页面地址和可核实的页面文字。', 400);
  }
  const result = {
    accountId: input.accountId, workId: input.workId, url: workUrl(input.url, input.workId),
    reviewState: input.reviewState, observedAt: new Date(input.observedAt).toISOString(),
    evidence: { url: evidenceUrl.href, text: input.evidence.text },
    metrics: metricsFrom(input.metrics)
  };
  if (input.publishedAt !== undefined) {
    if (!validTime(input.publishedAt) || Date.parse(input.publishedAt) > Date.parse(result.observedAt) + 300000) throw fail('平台发布时间无效。', 400);
    result.publishedAt = new Date(input.publishedAt).toISOString();
  }
  return result;
}

function targetFrom(kind, row) {
  const binding = kind === 'daily' ? row.binding : row.approval;
  if (!eligible.has(row.status) || row.previewOnly || !validTime(row.submitStartedAt)
    || !binding?.accountId || !binding.browserId || !/^[a-f0-9]{64}$/.test(kind === 'daily' ? row.sha256 : binding.sha256)) return null;
  return {
    ref: `${kind}:${row.id}`, kind, id: row.id, accountId: binding.accountId, browserId: binding.browserId,
    sha256: kind === 'daily' ? row.sha256 : binding.sha256, submitStartedAt: row.submitStartedAt,
    draftId: (kind === 'daily' ? row.draftId : row.sourceDraftId) || '',
    title: row.title || binding.title || '', caption: row.caption || binding.caption || '',
    status: row.status, publishedUrl: row.publishedUrl || '',
    reconciledAt: row.reconciledAt || '', reconciledResult: row.reconciledResult || ''
  };
}
const identity = target => digest([target.ref, target.accountId, target.browserId, target.sha256, target.submitStartedAt, target.draftId]);
const guardIdentity = target => digest([identity(target), target.status, target.publishedUrl, target.reconciledAt, target.reconciledResult]);
const sampleId = (accountId, workId, day) => `douyin-${digest([accountId, workId, day]).slice(0, 32)}`;

function validate(state) {
  if (state?.version !== 1 || !Array.isArray(state.records)) throw new Error('抖音回采记录格式无效，请保留原文件。');
  const refs = new Set(), works = new Set();
  for (const row of state.records) {
    const target = row?.target;
    if (!target || !['daily', 'queue'].includes(target.kind) || target.ref !== `${target.kind}:${target.id}`
      || typeof target.accountId !== 'string' || !target.accountId || typeof target.browserId !== 'string' || !target.browserId
      || !/^[a-f0-9]{64}$/.test(target.sha256) || !validTime(target.submitStartedAt)
      || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Number.isSafeInteger(row.projectedSequence)
      || row.projectedSequence < 0 || row.projectedSequence > row.sequence
      || !Array.isArray(row.samples) || row.samples.length > 90) throw new Error('抖音回采目标记录无效。');
    const observation = observationFrom(row.observation);
    const workKey = JSON.stringify([observation.accountId, observation.workId]);
    if (observation.accountId !== target.accountId || refs.has(target.ref) || works.has(workKey)) throw new Error('抖音回采作品归属重复或不一致。');
    refs.add(target.ref); works.add(workKey);
    const ids = new Set();
    for (const sample of row.samples) {
      if (!validTime(sample.observedAt) || sample.day !== shanghaiDay(Date.parse(sample.observedAt))
        || sample.id !== sampleId(target.accountId, observation.workId, sample.day) || ids.has(sample.id)) throw new Error('抖音效果样本编号或时间无效。');
      metricsFrom(sample.metrics); ids.add(sample.id);
    }
  }
  return state;
}

/**
 * The injected inspector must uniquely identify the work on the observed account.
 * Titles alone are not proof of ownership. This module never publishes or retries.
 */
export class DouyinTracking {
  constructor(runtimeDir, { workspace, automation, dailyProduction, inspect, discover, intervalMs = 15 * 60000 } = {}) {
    this.store = new JsonStore(join(runtimeDir, 'douyin-tracking', 'state.json'), { version: 1, records: [] }, validate);
    this.workspace = workspace; this.automation = automation; this.dailyProduction = dailyProduction;
    this.inspect = inspect; this.discover = discover; this.intervalMs = intervalMs; this.timer = null; this.busy = false; this.stopping = false; this.error = '';
  }

  async targets() {
    const [daily, queue, saved] = await Promise.all([this.dailyProduction.store.read(), this.automation.store.read(), this.store.read()]);
    return [...daily.value.runs.map(row => targetFrom('daily', row)), ...queue.value.items.map(row => targetFrom('queue', row))].filter(Boolean).map(target => {
      const record = saved.value.records.find(row => row.target.ref === target.ref && identity(row.target) === identity(target));
      return { ...target, boundWorkId: record?.observation.workId || '', boundUrl: record?.observation.url || '' };
    });
  }

  async snapshot() {
    const { value, revision } = await this.store.read();
    return { ...value, revision, scheduler: { running: !!this.timer, busy: this.busy, error: this.error, intervalMs: this.intervalMs } };
  }

  async recordObservation(ref, input, { target: inspectedTarget } = {}) {
    const target = inspectedTarget || (await this.targets()).find(item => item.ref === ref);
    if (!target || target.ref !== ref) throw fail('没有可回采的提交记录。');
    const observation = observationFrom(input);
    if (observation.accountId !== target.accountId) throw fail('观察账号与提交账号不一致。');
    if (Date.parse(observation.observedAt) < Date.parse(target.submitStartedAt)) throw fail('观察时间早于此次提交。');
    if (Date.parse(observation.observedAt) > Date.now() + 300000) throw fail('观察时间不能位于未来。', 400);
    if (target.boundWorkId && target.boundWorkId !== observation.workId) throw fail('观察作品与已绑定作品不一致。');
    // A previously confirmed canonical link is an additional binding, not a title hint.
    const known = /^https:\/\/(?:www\.)?douyin\.com\/video\/(\d+)(?:[?#].*)?$/.exec(target.publishedUrl);
    if (known && known[1] !== observation.workId) throw fail('观察作品与已核实链接不一致。');
    const { result } = await this.store.update(state => {
      let record = state.records.find(row => row.target.ref === ref);
      if (record && (identity(record.target) !== identity(target) || record.observation.workId !== observation.workId)) throw fail('提交绑定或作品编号发生变化，不能重新归属旧回采记录。');
      if (state.records.some(row => row.target.ref !== ref && row.observation.accountId === observation.accountId && row.observation.workId === observation.workId)) throw fail('此账号的同一作品已归属另一条提交记录。');
      if (record && sameOrNewer(record.observation.observedAt, observation.observedAt)) return { accepted: false, sequence: record.sequence };
      if (!record) {
        record = { target, observation, sequence: 0, projectedSequence: 0, samples: [], projectionError: '' };
        state.records.push(record);
      }
      record.target = structuredClone(target); record.observation = observation; record.sequence++; record.projectionError = '';
      if (Object.keys(observation.metrics).length) {
        const day = shanghaiDay(Date.parse(observation.observedAt)), id = sampleId(target.accountId, observation.workId, day);
        let sample = record.samples.find(row => row.id === id);
        if (!sample) { sample = { id, day, metrics: {}, metricObservedAt: {} }; record.samples.push(sample); }
        Object.assign(sample.metrics, observation.metrics);
        for (const key of Object.keys(observation.metrics)) sample.metricObservedAt[key] = observation.observedAt;
        sample.observedAt = observation.observedAt; sample.evidence = observation.evidence;
        record.samples = record.samples.slice(-90);
      }
      return { accepted: true, sequence: record.sequence };
    });
    return result;
  }

  async project(record) {
    const { target, observation } = record;
    const ownerStore = target.kind === 'daily' ? this.dailyProduction.store : this.automation.store;
    const review = { state: observation.reviewState, observedAt: observation.observedAt, evidence: observation.evidence };
    const fields = {
      platform: 'douyin', platformWorkId: observation.workId, platformUrl: observation.url,
      platformReview: review, platformObservedAt: observation.observedAt, platformTrackingRef: target.ref
    };
    if (observation.publishedAt) fields.platformPublishedAt = observation.publishedAt;
    await ownerStore.update(state => {
      const owner = (target.kind === 'daily' ? state.runs : state.items).find(row => row.id === target.id);
      const current = owner && targetFrom(target.kind, owner);
      if (!current || guardIdentity(current) !== guardIdentity(target)) throw fail('提交记录或人工核实结论已变化，回采证据已保留，未覆盖结论。');
      if (owner.platformWorkId && owner.platformWorkId !== observation.workId) throw fail('提交记录已经关联另一作品。');
      if (!sameOrNewer(owner.platformObservedAt, observation.observedAt)) Object.assign(owner, fields);
    });
    await this.workspace.update(state => {
      const draft = target.draftId && state.drafts.find(row => row.id === target.draftId);
      if (draft && (target.kind !== 'daily' || draft.sourceProductionId === target.id)) {
        if (draft.platformWorkId && (draft.platformWorkId !== observation.workId || draft.platformTrackingRef !== target.ref)) throw fail('草稿已关联另一条作品记录。');
        if (!sameOrNewer(draft.platformObservedAt, observation.observedAt)) Object.assign(draft, fields);
      }
      for (const sample of record.samples) {
        let metric = state.metrics.find(row => row.id === sample.id);
        if (metric && (metric.source !== 'douyin-tracking' || metric.platformWorkId !== observation.workId || metric.accountId !== target.accountId || metric.sourceTarget !== target.ref)) throw fail('效果记录编号与已有数据冲突。');
        if (metric && sameOrNewer(metric.collectedAt, sample.observedAt)) continue;
        if (!metric) {
          metric = {
            id: sample.id, source: 'douyin-tracking', sourceTarget: target.ref,
            accountId: target.accountId, platform: 'douyin', platformWorkId: observation.workId,
            publishedUrl: observation.url, draftId: target.draftId, mTitle: target.title,
            date: sample.day, createdAt: sample.observedAt
          };
          state.metrics.push(metric);
        }
        Object.assign(metric, sample.metrics, { collectedAt: sample.observedAt, metricObservedAt: sample.metricObservedAt, evidence: sample.evidence });
      }
      // Existing consumers use the last metric as the latest result.
      state.metrics.sort((a, b) => (Date.parse(a.collectedAt || a.createdAt || a.date) || 0) - (Date.parse(b.collectedAt || b.createdAt || b.date) || 0));
    });
  }

  async projectPending(ref) {
    const pending = (await this.store.read()).value.records.filter(row => (!ref || row.target.ref === ref) && row.projectedSequence < row.sequence);
    const results = [];
    for (const record of pending) {
      let problem = '';
      try { await this.project(record); } catch (error) { problem = error.message; }
      await this.store.update(state => {
        const current = state.records.find(row => row.target.ref === record.target.ref);
        // Never acknowledge a newer observation that arrived during projection.
        if (current?.sequence !== record.sequence) return;
        current.projectionError = problem;
        if (!problem) current.projectedSequence = record.sequence;
      });
      results.push({ ref: record.target.ref, sequence: record.sequence, applied: !problem, error: problem });
    }
    return results;
  }

  async bind(ref, url, { discover = this.discover } = {}) {
    if (this.busy || this.stopping) throw fail('回采正在执行或已停止，请稍后再试。', 503);
    if (typeof discover !== 'function') throw fail('尚未接入已验证的抖音作品核对器。', 503);
    let parsed;
    try { parsed = new URL(url); } catch {}
    const workId = parsed?.pathname.match(/^\/video\/(\d{1,32})$/)?.[1];
    if (!workId) throw fail('请提供完整的抖音作品链接。', 400);
    workUrl(url, workId);
    this.busy = true;
    let release;
    try {
      release = await this.automation.lease();
      const target = (await this.targets()).find(row => row.ref === ref);
      if (!target) throw fail('没有可绑定的提交记录。');
      if (target.boundWorkId && target.boundWorkId !== workId) throw fail('此提交已经绑定另一作品，不能自动更换归属。');
      const proposal = await discover(structuredClone(target));
      if (proposal?.requiresExplicitBinding !== true || proposal.candidate?.workId !== workId) throw fail('页面未能唯一核实指定作品，未保存绑定。');
      const result = await this.recordObservation(ref, proposal.candidate, { target });
      const projections = await this.projectPending(ref);
      this.error = projections.filter(row => row.error).map(row => row.error).join('\n');
      return { ref, ...result, projections };
    } catch (error) { this.error = error.message; throw error; }
    finally { try { if (release) await release(); } finally { this.busy = false; } }
  }

  async checkNow(ref) {
    if (this.busy || this.stopping) throw fail('回采正在执行或已停止，请稍后再试。', 503);
    if (typeof this.inspect !== 'function') throw fail('尚未接入已验证的抖音页面读取器。', 503);
    this.busy = true;
    let release;
    const results = [];
    try {
      release = await this.automation.lease();
      const targets = (await this.targets()).filter(target => ref ? target.ref === ref : !!target.boundWorkId);
      if (ref && !targets.length) throw fail('没有可回采的提交记录。');
      for (const target of targets) {
        if (this.stopping) break;
        try {
          const observation = await this.inspect(structuredClone(target));
          const result = observation ? await this.recordObservation(target.ref, observation, { target }) : { accepted: false, unresolved: true };
          results.push({ ref: target.ref, ...result });
        } catch (error) { results.push({ ref: target.ref, error: error.message }); }
      }
      const projections = await this.projectPending(ref);
      this.error = [...results, ...projections].filter(row => row.error).map(row => `${row.ref}：${row.error}`).join('\n');
      return { results, projections };
    } catch (error) { this.error = error.message; throw error; }
    finally { try { if (release) await release(); } finally { this.busy = false; } }
  }

  start() {
    if (this.timer) return;
    if (typeof this.inspect !== 'function' || !Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1000) throw fail('回采读取器或检查间隔未配置。', 503);
    this.stopping = false;
    const tick = () => { if (!this.busy) void this.checkNow().catch(error => { this.error = error.message; }); };
    this.timer = setInterval(tick, this.intervalMs); this.timer.unref?.(); tick();
  }

  stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}
