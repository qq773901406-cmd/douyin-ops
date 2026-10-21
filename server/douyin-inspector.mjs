import { setTimeout as delay } from 'node:timers/promises';
import { DouyinPublisher } from './douyin-publisher.mjs';
import { BSK_TIMEOUTS } from '../lib/bsk-client.mjs';

const manageUrl = 'https://creator.douyin.com/creator-micro/content/manage';
const compact = value => String(value || '').replace(/\s+/g, '');
const workIdPattern = /^\d{1,32}$/;
const metricNames = { 播放: 'plays', 点赞: 'likes', 评论: 'mComments', 分享: 'shares', 收藏: 'saves', 吸粉量: 'followers', 完播率: 'completion' };

// This function is serialized into evaluate. Only rendered DOM is inspected.
export function readDouyinManageDOM() {
  const visible = node => !!node?.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  const text = node => String(node?.innerText || node?.textContent || '').trim();
  const selector = node => {
    const parts = [];
    for (let element = node; element && element.nodeType === 1; element = element.parentElement) {
      const siblings = element.parentElement ? [...element.parentElement.children].filter(item => item.tagName === element.tagName) : [element];
      parts.unshift(`${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`);
      if (element.tagName === 'BODY') break;
    }
    return parts.join(' > ');
  };
  const leafTexts = [...document.querySelectorAll('span,p,div,label')]
    .filter(node => visible(node) && text(node).length < 140 && ![...node.children].some(child => visible(child) && text(child) === text(node)));
  const accountIds = [...new Set(leafTexts.map(node => text(node).match(/^抖音号\s*[：:]?\s*([A-Za-z0-9_.-]+)$/)?.[1]).filter(Boolean))];
  const cards = [...document.querySelectorAll('div[class*="video-card-content-"]')].filter(visible).map(card => {
    const fields = {};
    for (const [name, className] of Object.entries({ title: 'info-title-text-', time: 'info-time-', status: 'info-status-', cover: 'video-card-cover-' })) {
      const matches = [...card.querySelectorAll(`div[class*="${className}"]`)].filter(visible);
      if (matches.length !== 1) return null;
      fields[name] = name === 'cover' ? selector(matches[0]) : text(matches[0]);
    }
    const metrics = {};
    for (const node of card.querySelectorAll('div[class*="metric-item-"]')) {
      if (!visible(node) || /(?:^|\s)metric-item-container(?:[-\s]|$)/.test(String(node.className || ''))) continue;
      const labels = [...node.querySelectorAll('[class*="metric-label-"]')].filter(visible);
      const values = [...node.querySelectorAll('[class*="metric-value-"]')].filter(visible);
      if (labels.length !== 1 || values.length !== 1) continue;
      const label = text(labels[0]);
      // Repeated labels are ambiguous; do not let a later value overwrite one.
      metrics[label] = Object.hasOwn(metrics, label) ? null : text(values[0]);
    }
    return { ...fields, metrics, text: text(card).slice(0, 5000) };
  }).filter(Boolean);
  const password = [...document.querySelectorAll('input[type="password"]')].some(visible);
  const dialogs = [...document.querySelectorAll('[role="dialog"],dialog,[class*="captcha"],[id*="captcha"]')].filter(visible).map(text);
  return {
    url: location.href, accountIds, cards,
    needsHuman: password || /\/login(?:[/?#]|$)/.test(location.href) || dialogs.some(value => /验证|扫码|登录|滑块|安全|授权/.test(value)),
  };
}

// The preview may autoplay to someone else's modal_id. Identity comes from
// the visible original work link in the signed-in profile's observed list.
export function readDouyinProfileDOM() {
  const visible = node => !!node?.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  const text = node => String(node?.innerText || '').trim();
  const bodyText = String(document.body?.innerText || '');
  const accountIds = [...new Set([...bodyText.matchAll(/(?:^|\n)\s*抖音号\s*[：:]?\s*([A-Za-z0-9_.-]+)(?=\s|$)/g)].map(match => match[1]))];
  const items = [...document.querySelectorAll('ul[data-e2e="scroll-list"] a[href]')].filter(visible).map(anchor => {
    const title = anchor.querySelector('p');
    return visible(title) && text(title) ? { title: text(title), url: anchor.href } : null;
  }).filter(Boolean);
  return { url: location.href, accountIds, items };
}

export function parseDouyinMetrics(raw = {}) {
  const result = {};
  for (const [label, name] of Object.entries(metricNames)) {
    const text = typeof raw[label] === 'string' ? raw[label].trim() : '';
    if (name === 'completion') {
      if (!/^\d+(?:\.\d+)?%$/.test(text)) continue;
      const value = Number(text.slice(0, -1));
      if (Number.isFinite(value) && value >= 0 && value <= 100) result[name] = value;
    } else {
      if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(text)) continue;
      const value = Number(text.replaceAll(',', ''));
      if (Number.isSafeInteger(value) && value >= 0) result[name] = value;
    }
  }
  // No observed DOM field supplies retention or conversion. In particular,
  // 2-second bounce rate is not silently relabeled as retention.
  return result;
}

export function parseDouyinCardTime(value) {
  const match = String(value || '').match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00+08:00`;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const local = new Date(time + 8 * 3600000);
  if (local.getUTCFullYear() !== Number(year) || local.getUTCMonth() + 1 !== Number(month) || local.getUTCDate() !== Number(day) || local.getUTCHours() !== Number(hour) || local.getUTCMinutes() !== Number(minute)) return null;
  return new Date(time).toISOString();
}

export function douyinWorkIdFromUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !['www.douyin.com', 'douyin.com'].includes(url.hostname)) return null;
  const video = url.pathname.match(/^\/video\/(\d{1,32})\/?$/)?.[1];
  const modal = url.searchParams.getAll('modal_id');
  if (modal.length > 1 || modal.length && !workIdPattern.test(modal[0])) return null;
  if (video && modal.length && video !== modal[0]) return null;
  return video || (/^\/user\/[^/]+\/?$/.test(url.pathname) && modal.length === 1 ? modal[0] : null);
}

export function selectDouyinCard(cards, target, windowMs = 15 * 60000) {
  const expected = new Set([compact(target.title), compact(String(target.title || '') + String(target.caption || ''))].filter(Boolean));
  const submitted = Date.parse(target.submitStartedAt);
  if (!expected.size || !Number.isFinite(submitted)) return null;
  const matches = cards.filter(card => {
    const time = parseDouyinCardTime(card.time);
    return expected.has(compact(card.title)) && time && Math.abs(Date.parse(time) - submitted) <= windowMs;
  });
  return matches.length === 1 ? matches[0] : null;
}

function reviewState(text) {
  if (text === '已发布') return 'published';
  if (['审核中', '待审核', '审核未完成'].includes(text)) return 'pending';
  if (['审核不通过', '未通过审核', '审核未通过'].includes(text)) return 'rejected';
  return 'unknown';
}

function agentTabs(result) {
  if (!Array.isArray(result?.tabs)) throw new Error('无法确认检查会话内的标签页。');
  return result.tabs.filter(tab => tab.scope === 'agent' && Number.isSafeInteger(tab.tab_id));
}

export function selectDouyinProfileWork(page, title, accountId) {
  let location;
  try { location = new URL(page?.url); } catch {}
  if (!location || location.protocol !== 'https:' || location.port || location.username || location.password || !['www.douyin.com', 'douyin.com'].includes(location.hostname) || !/^\/user\/self\/?$/.test(location.pathname)) return null;
  if (!Array.isArray(page.accountIds) || page.accountIds.length !== 1 || page.accountIds[0] !== accountId || !Array.isArray(page.items)) return null;
  const matches = page.items.filter(item => {
    let url;
    try { url = new URL(item?.url); } catch {}
    return url && /^\/video\/\d{1,32}\/?$/.test(url.pathname) && douyinWorkIdFromUrl(item.url) && compact(item.title) === compact(title);
  });
  if (matches.length !== 1) return null;
  return { title: matches[0].title, url: matches[0].url, profileUrl: page.url, workId: douyinWorkIdFromUrl(matches[0].url) };
}

export class DouyinInspector {
  constructor({ publisher = new DouyinPublisher(), previewReader, pause = delay, stableSamples = 3, sampleDelayMs = 1000, pageAttempts = 5, matchWindowMs = 15 * 60000 } = {}) {
    this.publisher = publisher;
    this.previewReader = previewReader || (async session => {
      const result = await this.publisher.command(['evaluate', `(${readDouyinProfileDOM.toString()})()`, '--session', session, '--timeout', '10s'], BSK_TIMEOUTS.EVALUATE_MS);
      return result.value;
    });
    this.pause = pause;
    this.stableSamples = Math.max(2, stableSamples);
    this.sampleDelayMs = sampleDelayMs;
    this.pageAttempts = pageAttempts;
    this.matchWindowMs = matchWindowMs;
  }
  async managePage(session) {
    const result = await this.publisher.command(['evaluate', `(${readDouyinManageDOM.toString()})()`, '--session', session, '--timeout', '10s'], BSK_TIMEOUTS.EVALUATE_MS);
    const page = result.value;
    let url;
    try { url = new URL(page?.url); } catch {}
    if (!url || url.origin !== 'https://creator.douyin.com' || url.pathname !== '/creator-micro/content/manage') throw new Error('页面未停留在抖音作品管理页。');
    if (page.needsHuman) throw new Error('抖音需要登录或人工验证，请完成后再检查作品。');
    if (!Array.isArray(page.cards) || !Array.isArray(page.accountIds)) throw new Error('作品管理页结构无法确认。');
    return page;
  }
  async stablePreview(session, card, accountId) {
    let previous = null;
    let consecutive = 0;
    for (let attempt = 0; attempt < this.pageAttempts + this.stableSamples; attempt++) {
      const page = await this.previewReader(session, this.publisher);
      const sample = selectDouyinProfileWork(page, card.title, accountId);
      if (sample) {
        const key = `${sample.workId}\n${sample.url}\n${compact(sample.title)}`;
        consecutive = previous === key ? consecutive + 1 : 1;
        previous = key;
        if (consecutive >= this.stableSamples) return sample;
      } else {
        previous = null;
        consecutive = 0;
      }
      if (attempt + 1 < this.pageAttempts + this.stableSamples) await this.pause(this.sampleDelayMs);
    }
    return null;
  }
  async collect(target, discovery) {
    if (!target?.browserId || !target.accountId) throw new Error('检查作品需要已确认的浏览器和抖音账号。');
    if (!discovery && !workIdPattern.test(String(target.boundWorkId || ''))) return null;
    if (!discovery && target.boundUrl && douyinWorkIdFromUrl(target.boundUrl) !== target.boundWorkId) return null;
    if (!target.title || !Number.isFinite(Date.parse(target.submitStartedAt))) return null;
    if (typeof this.previewReader !== 'function') return null;
    return this.publisher.session(target.browserId, async session => {
      const account = await this.publisher.accountInSession(session);
      if (account.accountId !== target.accountId) throw new Error('当前登录抖音账号与目标作品绑定不一致。');
      await this.publisher.command(['navigate', manageUrl, '--session', session, '--timeout', '60s'], BSK_TIMEOUTS.NAVIGATE_PUBLISHER_MS);
      let card;
      for (let attempt = 0; attempt < this.pageAttempts; attempt++) {
        const page = await this.managePage(session);
        if (page.accountIds.length && (page.accountIds.length !== 1 || page.accountIds[0] !== target.accountId)) throw new Error('作品管理页显示的抖音账号与绑定不一致。');
        card = selectDouyinCard(page.cards, target, this.matchWindowMs);
        if (card) break;
        if (page.cards.length) return null;
        if (attempt + 1 < this.pageAttempts) await this.pause(this.sampleDelayMs);
      }
      if (!card?.cover) return null;
      const before = agentTabs(await this.publisher.command(['tab', 'list', '--session', session, '--scope', 'agent']));
      const previousIds = new Set(before.map(tab => tab.tab_id));
      const manageTabs = before.filter(tab => {
        try { const url = new URL(tab.url); return url.origin === 'https://creator.douyin.com' && url.pathname === '/creator-micro/content/manage' && tab.active; } catch { return false; }
      });
      if (manageTabs.length !== 1) return null;
      await this.publisher.command(['click', '--selector', card.cover, '--session', session], BSK_TIMEOUTS.CLICK_MS);
      let opened;
      for (let attempt = 0; attempt < this.pageAttempts; attempt++) {
        const tabs = agentTabs(await this.publisher.command(['tab', 'list', '--session', session, '--scope', 'agent']));
        const additions = tabs.filter(tab => !previousIds.has(tab.tab_id));
        if (additions.length > 1) return null;
        if (additions.length === 1) { opened = additions[0]; break; }
        if (attempt + 1 < this.pageAttempts) await this.pause(this.sampleDelayMs);
      }
      if (!opened) return null;
      await this.publisher.command(['tab', 'select', String(opened.tab_id), '--session', session]);
      const preview = await this.stablePreview(session, card, target.accountId);
      if (!preview || !discovery && preview.workId !== target.boundWorkId) return null;
      // Re-read the card after resolving its actual work ID. Never mix metrics
      // from an earlier card render with a different or newly reordered item.
      await this.publisher.command(['tab', 'select', String(manageTabs[0].tab_id), '--session', session]);
      const freshPage = await this.managePage(session);
      if (freshPage.accountIds.length && (freshPage.accountIds.length !== 1 || freshPage.accountIds[0] !== target.accountId)) return null;
      const fresh = selectDouyinCard(freshPage.cards, target, this.matchWindowMs);
      if (!fresh || compact(fresh.title) !== compact(card.title) || fresh.time !== card.time) return null;
      const observedAt = new Date().toISOString();
      const evidence = {
        url: preview.url,
        text: JSON.stringify({
          accountId: target.accountId, cardTitle: fresh.title, cardTime: fresh.time,
          cardStatus: fresh.status, previewTitle: preview.title,
          previewUrl: preview.url, profileUrl: preview.profileUrl,
          stableSamples: this.stableSamples, rawMetrics: fresh.metrics,
        }),
      };
      const observation = {
        accountId: target.accountId, workId: preview.workId,
        url: `https://www.douyin.com/video/${preview.workId}`,
        reviewState: reviewState(fresh.status), observedAt, evidence,
        metrics: parseDouyinMetrics(fresh.metrics),
        ...(reviewState(fresh.status) === 'published' ? { publishedAt: parseDouyinCardTime(fresh.time) } : {}),
      };
      return discovery ? {
        requiresExplicitBinding: true, candidate: observation,
        metadata: { cardTitle: fresh.title, cardTime: fresh.time, previewTitle: preview.title },
      } : observation;
      // publisher.session owns this window and always stops its own session.
      // No user tab is borrowed or closed, including on ambiguity or failure.
    });
  }
  async inspect(target) { return this.collect(target, false); }
  async discover(target) { return this.collect(target, true); }
}
