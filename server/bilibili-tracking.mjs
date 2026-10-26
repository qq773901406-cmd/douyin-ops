import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { BilibiliWorkflow } from './bilibili-workflow.mjs';
import { parseBskJson, resolveBskBinary, BSK_TIMEOUTS } from '../lib/bsk-client.mjs';
import { runMediaProcess } from './media-automation.mjs';

const now = () => new Date().toISOString();
const failure = message => Object.assign(new Error(message), { code: 'requires_action', status: 400 });
const compact = value => String(value || '').replace(/\s+/gu, '');
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
export function bilibiliWorkURL(value) {
  let url; try { url = new URL(value); } catch { return null; }
  const bvid = url.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10})\/?$/)?.[1];
  return url.protocol === 'https:' && url.hostname === 'www.bilibili.com' && !url.port && !url.username && !url.password && bvid ? { bvid, url: `https://www.bilibili.com/video/${bvid}/` } : null;
}

// Serialized into BrowserSkill evaluate. Only visible DOM; no cookies, storage or page state.
export function readBilibiliDOM(bvid) {
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => String(el?.innerText || el?.textContent || '').trim();
  const links = [...document.querySelectorAll('a[href]')].filter(visible);
  const author = links.filter(a => /^https:\/\/space\.bilibili\.com\/[1-9]\d*\/?(?:\?|$)/.test(a.href) && (a.matches('.up-name,[class*="up-name"]') || a.closest('[class*="up-info"],[class*="upinfo"],[class*="video-owner"]'))).map(a => ({ uid: new URL(a.href).pathname.match(/\d+/)?.[0], name: text(a), url: a.href }));
  const titles = [...document.querySelectorAll('h1')].filter(visible).map(text).filter(Boolean);
  const dialogs = [...document.querySelectorAll('[role="dialog"],dialog,[class*="captcha"],[id*="captcha"],[class*="login-panel"]')].filter(visible).map(text);
  const cards = [];
  for (const link of links.filter(a => a.href.includes(`/video/${bvid}`) || a.href.includes(`bvid=${bvid}`))) {
    let node = link;
    for (let n = 0; n < 5 && node; n++, node = node.parentElement) {
      const value = text(node);
      const ids = new Set([...node.querySelectorAll('a[href]')].map(a => a.href.match(/(?:\/video\/|[?&]bvid=)(BV[A-Za-z0-9]{10})/)?.[1]).filter(Boolean));
      if (value.length <= 3500 && ids.size === 1 && ids.has(bvid) && /已发布|审核中|审核不通过|审核未通过|稿件审核|进行中/.test(value)) { cards.push({ text: value, link: link.href }); break; }
    }
  }
  const metrics = {};
  for (const [label, selector] of Object.entries({ plays: '.view-text,.video-view .view-text', danmaku: '.dm-text', likes: '.video-like .video-like-info,.video-like-info', coins: '.video-coin .video-coin-info,.video-coin-info', saves: '.video-fav .video-fav-info,.video-fav-info', shares: '.video-share .video-share-info,.video-share-info', mComments: '.reply-header .total-reply,.reply-header .total-reply-count' })) {
    const values = [...new Set([...document.querySelectorAll(selector)].filter(visible).map(text).filter(Boolean))];
    if (values.length === 1) metrics[label] = values[0];
  }
  const unavailable = [...document.querySelectorAll('[class*="error"],[class*="not-found"],[class*="video-error"],[class*="notice"],[class*="tip"]')].filter(visible).map(text).some(t => t.length < 1000 && /不存在|审核中|失效|删除|无法观看|不见了|不可见|仅自己可见|私密视频/.test(t));
  return { url: location.href, titles, authors: author, cards, metrics, videoVisible: [...document.querySelectorAll('video')].some(visible), unavailable, needsHuman: /(?:passport|account)\.bilibili\.com/.test(location.hostname) || dialogs.some(t => /登录|验证码|滑块|安全验证|扫码/.test(t)) };
}

export function parseBilibiliMetrics(raw = {}) {
  const metrics = {};
  for (const key of ['plays', 'danmaku', 'likes', 'coins', 'saves', 'shares', 'mComments']) {
    const value = typeof raw[key] === 'string' ? raw[key].trim() : '';
    if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) continue;
    const number = Number(value.replaceAll(',', ''));
    if (Number.isSafeInteger(number)) metrics[key] = number;
  }
  return metrics; // Rounded 万/亿 displays stay in rawMetrics, never invented precision.
}

export function observationFromBilibiliDOM(page, target, observedAt = now()) {
  let location; try { location = new URL(page?.url); } catch { throw failure('未取得 B 站页面地址。'); }
  if (location.protocol !== 'https:' || location.port || location.username || location.password || !['www.bilibili.com', 'member.bilibili.com'].includes(location.hostname)) throw failure('页面离开 B 站作品或创作中心，停止回采。');
  if (page.needsHuman) throw failure('B 站需要登录或验证，请在浏览器中完成后重试只读回采。');
  const identity = bilibiliWorkURL(page.url);
  if (identity?.bvid === target.bvid) {
    const titles = [...new Set((page.titles || []).map(compact))];
    const authors = (page.authors || []).filter(a => target.account.uid ? a.uid === target.account.uid : compact(a.name) === compact(target.account.name));
    if (page.unavailable || !page.videoVisible || titles.length !== 1 || titles[0] !== compact(target.title) || !authors.length) throw failure('尚不能确认本条作品已公开：需要标题、作者及可见视频一致。');
    return { bvid: target.bvid, url: target.url, reviewState: 'published', observedAt, metrics: parseBilibiliMetrics(page.metrics), rawMetrics: page.metrics || {}, evidence: { kind: 'visible-dom', pageURL: page.url, title: page.titles[0], author: authors[0], videoVisible: true } };
  }
  const matches = (page.cards || []).filter(card => {
    let link; try { link = new URL(card.link); } catch { return false; }
    const work = bilibiliWorkURL(link.href);
    return (work?.bvid === target.bvid || link.hostname === 'member.bilibili.com' && link.searchParams.get('bvid') === target.bvid) && compact(card.text).includes(compact(target.title));
  });
  const texts = [...new Set(matches.map(c => c.text))];
  if (texts.length !== 1) throw failure('创作中心没有唯一匹配本条 BV 编号和标题的审核记录。');
  const rejected = /审核不通过|审核未通过/.test(texts[0]), pending = /审核中|稿件审核|进行中/.test(texts[0]);
  const published = /已发布/.test(texts[0]);
  if (Number(rejected) + Number(pending) + Number(published) !== 1) throw failure('本条审核状态不明确，保留原发布回执。');
  return { bvid: target.bvid, url: target.url, reviewState: rejected ? 'rejected' : pending ? 'pending' : 'published', observedAt, metrics: {}, rawMetrics: {}, evidence: { kind: 'visible-dom', pageURL: page.url, text: texts[0] } };
}

export class BilibiliTracking {
  constructor(runtimeDir, { workspace, workflow, run, clock = now } = {}) {
    this.directory = join(resolve(runtimeDir), 'bilibili-tracking');
    this.store = new JsonStore(join(this.directory, 'state.json'), { version: 1, records: [] });
    this.workflow = workflow || new BilibiliWorkflow(join(resolve(runtimeDir), 'bilibili-publish'));
    this.workspace = workspace; this.clock = clock;
    this.run = run || (async (args, options) => {
      const result = await runMediaProcess(resolveBskBinary(), [...args, '--json'], { ...options, env: { ...process.env, BSK_AUTO_START: '0' } });
      return { ...result, ok: result.code === 0 };
    });
  }
  handlers() { return { 'bilibili.track': { readOnly: true, validate: input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['jobId', 'browserId'].includes(k)) || input.jobId !== undefined && (typeof input.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.jobId)) || input.browserId !== undefined && (typeof input.browserId !== 'string' || !input.browserId || input.browserId.length > 200)) throw failure('回采只接受已有任务编号和浏览器选择。');
    return input;
  }, execute: async (input, context) => ({ status: 'completed', output: await this.checkNow(input.jobId, { ...context, browserId: input.browserId }) }) } }; }
  async targets() {
    return (await this.workflow.list()).filter(job => ['submitted', 'published'].includes(job.status) && bilibiliWorkURL(job.receipt?.url)).map(job => ({ jobId: job.id, title: job.title, account: job.account, ...bilibiliWorkURL(job.receipt.url) }));
  }
  async snapshot() { return { ...(await this.store.read()).value, targets: await this.targets() }; }
  async command(args, { signal, timeout = 30000 } = {}) {
    let result;
    try { result = await this.run(args, { signal, timeout }); }
    catch (error) { if (error.code === 'cancelled') throw error; throw failure(`BrowserSkill ${args[0]} 无法执行，请检查客户端安装、现有守护进程和浏览器连接。`); }
    const parsed = parseBskJson(result.stdout);
    if (!result.ok || !parsed || parsed.ok === false || parsed.error || parsed.success === false) throw failure(`BrowserSkill ${args[0]} 未完成，请检查浏览器连接和站点权限。`);
    return parsed;
  }
  async inspect(target, context) {
    const browsers = await this.command(['browsers'], { ...context, timeout: BSK_TIMEOUTS.SESSION_REQUEST_MS });
    const available = Array.isArray(browsers) ? browsers.filter(b => b.instance_id && !b.unresponsive) : [];
    const selected = context.browserId ? available.find(b => b.instance_id === context.browserId) : available.length === 1 ? available[0] : null;
    if (!selected) throw failure('请连接并选择一个 BrowserSkill 浏览器后回采。');
    const token = `${Date.now() + BSK_TIMEOUTS.TOKEN_TTL_MS}:${randomUUID()}`;
    let session;
    try {
      await this.command(['session', 'request', '--prepare', token], context);
      const started = await this.command(['session', 'start', '--browser', selected.instance_id, '--no-focus', '--request-id', token, '--name', 'B站只读审核回采'], { ...context, timeout: BSK_TIMEOUTS.SESSION_START_PUBLISHER_MS });
      session = started.session_id;
      if (!session || started.browser_instance_id !== selected.instance_id) throw failure('只读浏览器会话绑定失败。');
      const claimed = await this.command(['session', 'request', token, '--claim'], context);
      if (claimed.state !== 'active' || claimed.session?.session_id !== session) throw failure('只读会话未能领取。');
      await this.command(['navigate', target.url, '--session', session], { ...context, timeout: BSK_TIMEOUTS.NAVIGATE_PUBLISHER_MS });
      const evaluate = async () => (await this.command(['evaluate', `(${readBilibiliDOM.toString()})(${JSON.stringify(target.bvid)})`, '--session', session, '--timeout', '10s'], { ...context, timeout: BSK_TIMEOUTS.EVALUATE_MS })).value;
      let page = await evaluate();
      if (page?.needsHuman) throw failure('B 站需要登录或验证码，请在浏览器中完成。');
      try { return observationFromBilibiliDOM(page, target, this.clock()); }
      catch (error) {
        await this.command(['navigate', 'https://member.bilibili.com/platform/upload-manager/article', '--session', session], { ...context, timeout: BSK_TIMEOUTS.NAVIGATE_PUBLISHER_MS });
        page = await evaluate();
        return observationFromBilibiliDOM(page, target, this.clock());
      }
    } finally {
      // Cleanup ignores a cancelled task signal, and affects only our own session/request.
      if (session) await this.command(['session', 'stop', session], { timeout: BSK_TIMEOUTS.SESSION_STOP_MS }).catch(() => {});
      else await this.command(['session', 'request', token, '--cancel'], { timeout: BSK_TIMEOUTS.CANCEL_MS }).catch(() => {});
    }
  }
  async project(record) {
    if (!this.workspace) throw failure('工作区未连接；已保留回采证据，等待归档。');
    const observation = record.observation, day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(observation.observedAt));
    await this.workspace.update(state => {
      const recordId = `bilibili-review-${record.target.jobId}`;
      let review = state.records.find(r => r.id === recordId);
      if (!review) { review = { id: recordId, source: 'bilibili-tracking', type: 'B站审核回采', category: '动作', title: record.target.title }; state.records.push(review); }
      Object.assign(review, { summary: `平台当前状态：${observation.reviewState}。原始投稿回执保留。`, date: day, platform: 'bilibili', platformWorkId: record.target.bvid, publishedUrl: record.target.url, observedAt: observation.observedAt, evidence: observation.evidence, reviewState: observation.reviewState });
      if (Object.keys(observation.metrics).length) {
        const id = `bilibili-${hash(`${record.target.jobId}:${day}`)}`;
        let metric = state.metrics.find(m => m.id === id);
        if (!metric) { metric = { id, source: 'bilibili-tracking', platform: 'bilibili', platformWorkId: record.target.bvid, sourceTarget: record.target.jobId, mTitle: record.target.title, date: day, publishedUrl: record.target.url }; state.metrics.push(metric); }
        Object.assign(metric, observation.metrics, { collectedAt: observation.observedAt, evidence: observation.evidence, rawMetrics: observation.rawMetrics });
      }
    });
    await this.store.update(state => { const latest = state.records.find(r => r.target.jobId === record.target.jobId); if (latest?.sequence === record.sequence) { latest.projectedSequence = record.sequence; latest.projectionError = ''; } });
  }
  async checkNow(jobId, context = {}) {
    // Read the ledger first. Neither this module nor its handlers ever call finish/begin-submit.
    const targets = (await this.targets()).filter(t => !jobId || t.jobId === jobId);
    if (!targets.length) throw failure('没有带 BV 作品链接的已提交或已发布 B站回执。');
    const output = [];
    for (const target of targets.slice(0, 20)) {
      if (context.signal?.aborted) throw Object.assign(new Error('回采已取消。'), { code: 'cancelled' });
      const prior = (await this.store.read()).value.records.find(r => r.target.jobId === target.jobId);
      if (prior?.projectedSequence < prior?.sequence) await this.project(prior);
      await context.reportProgress?.({ phase: 'tracking', message: `正在只读核对 ${target.title}` });
      const observation = await this.inspect(target, context);
      let saved;
      await this.store.update(state => {
        let record = state.records.find(r => r.target.jobId === target.jobId);
        if (!record) { record = { target, sequence: 0, projectedSequence: 0 }; state.records.push(record); }
        record.observation = observation; record.sequence++; saved = structuredClone(record);
      });
      try { await this.project(saved); }
      catch (error) { await this.store.update(state => { const record = state.records.find(r => r.target.jobId === target.jobId); record.projectionError = error.message; }); throw error; }
      output.push({ jobId: target.jobId, ...observation });
    }
    return { summary: `完成 ${output.length} 条 B站只读审核与可见指标回采；未执行投稿。`, records: output, publicationSubmitted: false };
  }
}
