import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { collectNews, validateNewsSettings } from './news-source.mjs';
import { DouyinPublisher } from './douyin-publisher.mjs';
import { parseDouyinMetrics, readDouyinManageDOM } from './douyin-inspector.mjs';
import { validateProduct, reportNames } from '../workbuddy/connector/lib/shop-products.mjs';
import { shanghaiDay } from '../shared/automation-model.mjs';
import { downloadPublicImage } from './content-download.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const kinds = ['research', 'ideas', 'diagnosis', 'insights', 'remix', 'comments', 'productDiscover', 'productResearch', 'capture'];
const clean = (value, max = 12000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 28);
const issue = (message, code = 'SOURCE_REQUIRED') => Object.assign(new Error(message), { status: 400, code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const checkSignal = signal => { if (signal?.aborted) throw signal.reason || issue('任务已取消。', 'ABORTED'); };
const domains = ['douyin.com', 'ithome.com', '1688.com', 'taobao.com', 'tmall.com', 'jd.com'];
const shopDomains = ['1688.com', 'taobao.com', 'tmall.com', 'jd.com'];
const hostIn = (host, hosts) => hosts.some(domain => host === domain || host.endsWith(`.${domain}`));

export function productSearchUrl(keywords) {
  if (typeof keywords !== 'string' || !keywords.trim() || [...keywords.trim()].length > 80 || /[\u0000-\u001f\u007f]/.test(keywords)) {
    throw issue('商品发现需要 1–80 字的明确关键词，不能包含控制字符。', 'KEYWORDS_REQUIRED');
  }
  const url = new URL('https://s.1688.com/selloffer/offer_search.htm');
  url.searchParams.set('keywords', keywords.trim());
  return url.href;
}

// Only these known sites are navigated by the signed-in browser. RSS fetching
// has its own pinned-DNS, redirect and decompression limits in news-source.mjs.
export function validateContentUrl(value, purpose = 'research') {
  let url;
  try { url = new URL(clean(value, 4097)); } catch { throw issue('请提供完整的 HTTPS 来源链接。', 'INVALID_URL'); }
  if (url.href.length > 4096 || url.protocol !== 'https:' || url.username || url.password || url.port
    || !hostIn(url.hostname, purpose === 'productResearch' ? shopDomains : domains)) {
    throw issue(`来源仅支持公开 HTTPS ${purpose === 'productResearch' ? '1688、淘宝、天猫和京东商品' : '抖音、IT之家或受支持商品'}页面，不能使用本机地址、账号密码或非标准端口。`, 'INVALID_URL');
  }
  if (purpose === 'comments' && (!['www.douyin.com', 'douyin.com'].includes(url.hostname) || !/^\/video\/\d{1,32}\/?$/.test(url.pathname))) {
    throw issue('评论采集需要一个明确的抖音作品链接。', 'INVALID_WORK_URL');
  }
  if (purpose === 'comments' && url.searchParams.has('modal_id') && url.searchParams.get('modal_id') !== url.pathname.split('/')[2]) {
    throw issue('页面播放器与指定作品编号不同。', 'WORK_MISMATCH');
  }
  if (purpose === 'productResearch') {
    const detail = hostIn(url.hostname, ['1688.com']) && /^\/offer\/\d+\.html\/?$/.test(url.pathname)
      || hostIn(url.hostname, ['taobao.com', 'tmall.com']) && /^\/item\.htm\/?$/.test(url.pathname) && /^\d+$/.test(url.searchParams.get('id') || '')
      || hostIn(url.hostname, ['jd.com']) && /^\/\d+\.html\/?$/.test(url.pathname);
    if (!detail) throw issue('请提供具体商品详情链接，不能用商城首页或搜索页代替商品。', 'INVALID_PRODUCT_URL');
  }
  if (purpose === 'productDiscover') {
    if (url.hostname !== 's.1688.com' || url.pathname !== '/selloffer/offer_search.htm'
      || url.searchParams.getAll('keywords').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'keywords')) {
      throw issue('商品发现仅允许由关键词构造的 1688 公开搜索页面。', 'INVALID_SEARCH_URL');
    }
    productSearchUrl(url.searchParams.get('keywords'));
  }
  url.hash = '';
  return url.href;
}

const isPublicAddress = address => {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    const [a, b] = address.toLowerCase().split(':').map(v => Number.parseInt(v || '0', 16));
    return !address.includes('.') && a >= 0x2000 && a <= 0x3fff && ![0x2002, 0x3ffe, 0x3fff].includes(a)
      && !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
  }
  return false;
};

export async function assertPublicContentHost(url, lookup = dnsLookup) {
  let timeout;
  try {
    const records = await Promise.race([
      lookup(new URL(url).hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(issue('来源 DNS 解析超时。', 'SOURCE_UNAVAILABLE')), 5000); })
    ]);
    if (!records.length || records.some(row => !isPublicAddress(row.address))) throw issue('来源解析到本机或非公网地址，已停止读取。', 'INVALID_URL');
  } finally { clearTimeout(timeout); }
}

// Serialized as a fixed function. It reads rendered DOM only: no fetch,
// cookies, page JS state, form input, scrolling, clicking or network interception.
export function readContentDOM(purpose) {
  const visible = node => !!node?.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  const text = node => String(node?.innerText || '').trim();
  const all = selector => [...document.querySelectorAll(selector)].filter(visible);
  const body = String(document.body?.innerText || '').slice(0, 64000);
  const dialogs = all('[role="dialog"],dialog,[class*="captcha"],[id*="captcha"]');
  const needsHuman = all('input[type="password"]').length > 0 || /\/(?:login|signin)(?:[/?#]|$)/i.test(location.href)
    || dialogs.some(node => /登录|扫码|验证|滑块|访问频繁|安全|授权/.test(text(node)))
    || /访问过于频繁|访问受限|请完成安全验证|拖动滑块完成|页面不存在|页面已失效/.test(body)
    || body.length < 1200 && /请先登录|登录后(?:查看|继续|访问)|扫码登录/.test(body);
  const main = all('article,[role="main"],main,#paragraph').sort((a, b) => text(b).length - text(a).length)[0];
  const paragraphs = [...(main || document.body).querySelectorAll('p')].filter(visible).map(text).filter(value => value.length >= 15 && value.length <= 1500).slice(0, 35);
  const comments = [];
  const rows = all('[data-e2e="comment-item"],[data-e2e="comment-level-1"],.comment-item,li[class*="commentItem"]');
  for (const row of rows.slice(0, 100)) {
    const contents = [...row.querySelectorAll('[data-e2e="comment-content"],[data-e2e="comment-text"],.comment-content,[class*="commentText"]')].filter(visible);
    if (contents.length === 1 && text(contents[0])) comments.push({ text: text(contents[0]).slice(0, 1500) });
  }
  const priceElements = all('[data-e2e="price"],[class*="price-text"],[class*="priceText"],.price,.price-now,[class*="price-value"]');
  const priceTexts = [...new Set(priceElements.map(text).filter(value => value && value.length < 100))].slice(0, 20);
  const title = text(all('h1')[0]) || document.title || '';
  const images = purpose === 'productResearch' ? all('img').filter(img => img.naturalWidth >= 240 && img.naturalHeight >= 240).map(img => ({ url: img.currentSrc || img.src, alt: img.alt || '' }))
    .filter(img => /^https:\/\//.test(img.url) && img.url.length <= 4096).slice(0, 20) : [];
  const accountIds = [...new Set([...body.matchAll(/(?:^|\n)\s*抖音号\s*[：:]?\s*([A-Za-z0-9_.-]+)(?=\s|$)/g)].map(match => match[1]))];
  const publicMetrics = {};
  for (const [label, selector] of Object.entries({ 点赞: '[data-e2e="video-player-digg"]', 评论: '[data-e2e="video-player-comment"]', 收藏: '[data-e2e="video-player-collect"]', 分享: '[data-e2e="video-player-share"]' })) {
    const nodes = all(selector);
    if (nodes.length === 1) publicMetrics[label] = text(nodes[0]);
  }
  const offers = [];
  if (purpose === 'productDiscover') {
    const seen = new Set();
    for (const anchor of all('a[href]').slice(0, 300)) {
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
      let url;
      try { url = new URL(anchor.href); } catch { continue; }
      if (url.protocol !== 'https:' || url.hostname !== 'detail.1688.com' || url.username || url.password || url.port || !/^\/offer\/\d+\.html\/?$/.test(url.pathname)) continue;
      url.search = ''; url.hash = '';
      if (seen.has(url.href)) continue;
      let card = anchor.closest('[data-offer-id],.offer-list-row-offer,[class*="offer-item"],[class*="offerItem"],[class*="search-offer"]') || anchor;
      const cardOffers = new Set([...card.querySelectorAll('a[href]')].map(node => {
        try { const candidate = new URL(node.href); return candidate.hostname === 'detail.1688.com' && /^\/offer\/\d+\.html\/?$/.test(candidate.pathname) ? candidate.pathname : ''; } catch { return ''; }
      }).filter(Boolean));
      if (cardOffers.size > 1) card = anchor;
      const titleNode = [...card.querySelectorAll('h2,h3,[class*="title"],[class*="Title"]')].find(node => visible(node) && text(node));
      const offerTitle = (text(titleNode) || text(anchor)).slice(0, 200);
      if (!offerTitle || /^(?:查看详情|立即购买|进店|详情)$/.test(offerTitle)) continue;
      const prices = [...card.querySelectorAll('[class*="price"],[class*="Price"]')].filter(visible).map(text).filter(value => value && value.length <= 100);
      seen.add(url.href); offers.push({ url: url.href, title: offerTitle, priceTexts: [...new Set(prices)].slice(0, 5), visibleText: text(card).slice(0, 600) });
      if (offers.length >= 12) break;
    }
  }
  const loading = /视频数据加载中|正在加载数据|页面加载中/.test(body) || !title && !paragraphs.length && !comments.length
    || purpose === 'productDiscover' && !offers.length && /加载中|正在搜索|搜索中/.test(body);
  return { url: location.href, title: title.slice(0, 300), text: body.slice(0, 18000), paragraphs, accountIds, loading,
    needsHuman, comments, commentStructureFound: rows.length > 0, commentsEmpty: /暂无评论|还没有评论|暂无相关评论/.test(body),
    priceTexts, images, publicMetrics, offers };
}

export function parseObservedPrice(values = []) {
  const amounts = [...new Set(values.map(value => clean(value, 100).match(/^(?:[¥￥]\s*|(?:CNY|RMB)\s*)?(\d+(?:\.\d{1,2})?)(?:\s*元)?$/i)?.[1]).filter(Boolean))];
  return amounts.length === 1 && Number(amounts[0]) > 0 ? amounts[0] : '';
}

const sentences = text => clean(text).split(/(?<=[。！？!?；;])\s*|\n+/u).map(s => s.trim()).filter(s => s.length >= 12 && s.length <= 450);
const contentTerms = text => [...new Set(clean(text).toLowerCase().match(/[a-z][a-z0-9.-]{2,}|[\u4e00-\u9fff]{2,6}/g) || [])];
const unsafeSource = /(?:忽略|无视).{0,12}(?:指令|规则)|system\s*prompt|api[_ -]?key|(?:密码|验证码|令牌)[：:]|(?:执行|运行).{0,10}(?:命令|powershell|shell)|curl\s+https?:/i;
export function selectEvidenceFacts(source, limit = 3) {
  const terms = contentTerms(source.title);
  const candidates = sentences((source.paragraphs || []).join('\n') || source.summary || '')
    .filter(value => !unsafeSource.test(value) && !/版权所有|广告|扫码|免责声明|相关阅读|全部评论/.test(value));
  const ranked = candidates.map((value, index) => ({ value, index, score: terms.reduce((n, term) => n + (value.toLowerCase().includes(term) ? 3 : 0), 0) + (/\d/.test(value) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const unique = [];
  for (const row of ranked) if (!unique.some(item => item.value === row.value)) unique.push(row);
  return unique.slice(0, limit).sort((a, b) => a.index - b.index).map(row => row.value);
}

export function buildEvidenceIdea(source, input = {}) {
  const facts = selectEvidenceFacts(source), title = clean(source.title, 120);
  const target = clean(input.audience || input.target, 200), angle = clean(input.angle, 240);
  // This is an attributed, evidence-derived working draft, never labeled AI
  // or verified narration. Quote spans remain explicit for editorial review.
  const hook = /[？?]$/.test(title) ? title : `关于“${title}”，目前确认了什么？`;
  const lines = [`【开场】${hook}`, `【来源】${source.sourceName || new URL(source.url).hostname}发布了“${title}”这条信息。`];
  if (facts.length) facts.forEach((fact, index) => lines.push(`【事实 ${index + 1}｜需核对原文】来源摘录：“${fact}”`));
  else lines.push('【信息边界】当前仅取得来源标题，细节尚不足；请核对原文后再补充结论。');
  if (angle) lines.push(`【选题角度｜编辑设定】${angle}`);
  lines.push(`【收尾】${target ? `对${target}来说，` : ''}你最关心这条信息中的哪一点？`, `【来源链接】${source.url}`);
  return { title, angle: angle || (target ? `面向${target}解释来源已披露的信息` : '区分已披露事实与仍待确认的信息'), hook,
    script: lines.join('\n'), cta: `你最关心“${title}”中的哪一点？`, duration: `${Math.max(15, Math.ceil(lines.join('').length / 4))} 秒`,
    bgm: '静音；如需配乐须另行核实素材权利', status: '待核对', generationMethod: 'evidence-extractive-draft',
    reviewRequired: true, readyForProduction: false, sourceEvidence: [{ url: source.url, observedAt: source.observedAt, title, facts }],
    limitations: facts.length ? '本地自动提取证据稿，引用部分须核对及原创改写；未调用 AI 模型、未核实影像内容。' : '仅有标题证据，不能据此扩写事实或直接制作发布。' };
}

export function classifyComment(text) {
  if (/退款|退货|投诉|售后|损坏|没收到|欺骗|骗钱/.test(text)) return '售后需人工';
  if (/电话|手机号|身份证|住址|微信|私信|账号密码/.test(text)) return '隐私需人工';
  if (/错误|不对|造假|虚假|胡说|证据|来源/.test(text)) return '质疑核实';
  if (/多少钱|价格|怎么买|哪里买|链接/.test(text)) return '购买咨询';
  if (/[？?]|怎么|如何|为什么|能否|可以吗/.test(text)) return '信息提问';
  if (/谢谢|有用|不错|喜欢|赞|学会/.test(text)) return '正向反馈';
  return '一般交流';
}

export function commentReply(text, type = classifyComment(text)) {
  const topic = clean(text.replace(/[\r\n]+/g, ' '), 70).replace(/[“”]/g, '');
  if (type === '售后需人工') return '已看到你反馈的问题。具体订单和售后需要通过平台订单页联系对应商家处理，请不要在公开评论中留下订单号或联系方式。';
  if (type === '隐私需人工') return '为保护隐私，请不要在公开评论中提供联系方式、证件或账号信息。';
  if (type === '质疑核实') return `谢谢指出“${topic}”。这部分需要与原始来源核对，目前不能据此下定论。`;
  if (type === '购买咨询') return '当前没有已核实的购买信息；价格、规格和售后请以对应商品页面的实际说明为准。';
  if (type === '信息提问') return `你问到的“${topic}”还需要更多信息才能准确回答，不能仅凭现有内容作判断。`;
  if (type === '正向反馈') return '谢谢你的反馈，很高兴这条内容对你有帮助。';
  return `谢谢分享“${topic}”。也欢迎补充你的具体看法。`;
}

export class ContentAutomation {
  constructor(runtimeDir, { workspace, publisher = new DouyinPublisher(), tracking, collectNews: collect = collectNews,
    now = () => Date.now(), readPage, lookup = dnsLookup, downloadImage = downloadPublicImage, pause = delay } = {}) {
    if (!workspace?.read || !workspace?.update) throw new Error('内容自动化需要工作区存储。');
    this.root = resolve(runtimeDir, 'content-automation'); this.workspace = workspace; this.publisher = publisher;
    this.tracking = tracking; this.collect = collect; this.now = now; this.pageReader = readPage; this.lookup = lookup; this.downloadImage = downloadImage; this.pause = pause;
  }
  handlers() {
    return Object.fromEntries(kinds.map(kind => [kind, { readOnly: true,
      validate: input => this.validate(kind, input), execute: (input, context) => this.run(kind, input, context) }]));
  }
  validate(kind, input = {}) {
    if (!kinds.includes(kind) || !object(input)) throw issue('内容任务类型或参数无效。', 'INVALID_INPUT');
    const out = structuredClone(input);
    if (out.model || out.provider || out.endpoint) throw issue('此执行器提供本地证据稿；尚未配置经核实的 AI 文本模型，不能把模型参数当作已接入。', 'MODEL_NOT_CONFIGURED');
    const allowed = new Set(['feedUrl', 'keywords', 'urls', 'url', 'browserId', 'accountId', 'researchIds', 'productIds', 'limit', 'audience', 'target', 'angle', 'topic', 'extractor', 'downloadImages']);
    if (Object.keys(out).some(key => !allowed.has(key))) throw issue('任务包含不支持的参数。', 'INVALID_INPUT');
    for (const field of ['feedUrl', 'keywords', 'url', 'browserId', 'accountId', 'audience', 'target', 'angle', 'topic', 'extractor']) {
      if (out[field] !== undefined && (typeof out[field] !== 'string' || out[field].length > (['url', 'feedUrl'].includes(field) ? 4096 : 1000))) throw issue(`${field} 必须为长度受限的文本。`, 'INVALID_INPUT');
    }
    if (out.downloadImages !== undefined && typeof out.downloadImages !== 'boolean') throw issue('downloadImages 必须是布尔值。', 'INVALID_INPUT');
    if (out.downloadImages && !['productResearch', 'productDiscover'].includes(kind)) throw issue('仅商品研究支持图片下载。', 'INVALID_INPUT');
    if (out.topic && !out.angle) out.angle = out.topic;
    if (out.url) out.urls = [out.url];
    if (out.urls !== undefined) {
      if (!Array.isArray(out.urls) || out.urls.length > 5 || out.urls.some(value => typeof value !== 'string')) throw issue('每次最多读取 5 个明确来源链接。', 'INVALID_INPUT');
      out.urls = [...new Set(out.urls.map(value => validateContentUrl(value, kind)))];
    }
    if (out.feedUrl) Object.assign(out, validateNewsSettings(out));
    out.limit = out.limit === undefined ? 3 : Number(out.limit);
    if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > (kind === 'comments' ? 50 : kind === 'productDiscover' ? 3 : 5)) throw issue('资料数量须在允许范围内。', 'INVALID_INPUT');
    for (const field of ['researchIds', 'productIds']) if (out[field] !== undefined && (!Array.isArray(out[field]) || out[field].length > 20 || out[field].some(value => typeof value !== 'string'))) throw issue(`${field} 必须是记录编号列表。`, 'INVALID_INPUT');
    if (['comments', 'capture'].includes(kind) && out.urls?.length !== 1) throw issue('此任务需要一个明确页面链接。', 'SOURCE_REQUIRED');
    if (kind === 'capture' && !['currentVideo', 'creatorMetrics', 'account'].includes(out.extractor || 'currentVideo')) throw issue('不支持此回采类型。', 'INVALID_INPUT');
    if (kind === 'capture') {
      const url = new URL(out.urls[0]);
      if (!hostIn(url.hostname, ['douyin.com'])) throw issue('回采仅支持抖音页面。', 'INVALID_URL');
      if ((out.extractor || 'currentVideo') === 'currentVideo') validateContentUrl(url.href, 'comments');
      if (out.extractor === 'creatorMetrics' && url.hostname !== 'creator.douyin.com') throw issue('后台数据回采需要创作者中心地址。', 'INVALID_URL');
    }
    if (kind === 'productDiscover') {
      productSearchUrl(out.keywords);
      if (out.urls?.length || out.feedUrl || out.productIds?.length || out.researchIds?.length) throw issue('商品发现只使用明确关键词，不接受替代来源地址或记录集合。', 'INVALID_INPUT');
      out.keywords = out.keywords.trim();
    }
    return out;
  }
  async run(kind, input = {}, context = {}) {
    try {
      input = this.validate(kind, input); checkSignal(context.signal);
      await context.reportProgress?.({ message: '正在读取来源与已有记录。' });
      const output = await this[kind](input, context);
      return { status: output.requiresAction ? 'requires_action' : 'completed', output: { kind, ...output } };
    } catch (error) {
      if (context.signal?.aborted || error.code === 'ABORTED') throw error;
      if (error.code || error.status === 400) return { status: 'requires_action', output: { kind, summary: error.message, code: error.code || 'SOURCE_REQUIRED', ids: [], evidence: [] } };
      throw error;
    }
  }
  stamp() { return new Date(this.now()).toISOString(); }
  async page(url, kind, input, context = {}) {
    checkSignal(context.signal);
    url = validateContentUrl(url, kind);
    await assertPublicContentHost(url, this.lookup);
    checkSignal(context.signal);
    let result;
    if (this.pageReader) result = await this.pageReader(url, { kind, browserId: input.browserId, accountId: input.accountId, signal: context.signal });
    else {
      const browsers = await this.publisher.browsers();
      const available = browsers.filter(browser => !input.browserId || browser.id === input.browserId);
      if (available.length !== 1) throw issue(available.length ? '连接了多个浏览器，请选择本次任务的浏览器。' : '所选浏览器未连接，请检查 BrowserSkill 扩展。', 'BROWSER_REQUIRED');
      checkSignal(context.signal);
      result = await this.publisher.session(available[0].id, async session => {
        if (input.accountId) {
          const account = await this.publisher.accountInSession(session);
          if (account.accountId !== input.accountId) throw issue('当前账号与任务绑定账号不同。', 'ACCOUNT_MISMATCH');
        }
        checkSignal(context.signal);
        await this.publisher.command(['navigate', url, '--session', session, '--timeout', '25s'], 30000);
        checkSignal(context.signal);
        const deadline = Date.now() + 12000;
        let value;
        for (let attempt = 0; attempt < 6; attempt++) {
          checkSignal(context.signal);
          const remaining = Math.max(1, deadline - Date.now());
          value = (await this.publisher.command(['evaluate', `(${readContentDOM.toString()})(${JSON.stringify(kind)})`, '--session', session, '--timeout', `${Math.min(10000, remaining)}ms`], Math.min(15000, remaining + 1000))).value;
          if (!value?.loading || value.needsHuman || Date.now() >= deadline) break;
          await this.pause(Math.min(1000, deadline - Date.now()), undefined, { signal: context.signal });
        }
        if (kind === 'capture' && input.extractor === 'creatorMetrics' && !value?.needsHuman) {
          checkSignal(context.signal);
          value.manage = (await this.publisher.command(['evaluate', `(${readDouyinManageDOM.toString()})()`, '--session', session, '--timeout', '10s'], 15000)).value;
        }
        return value;
      });
    }
    checkSignal(context.signal);
    if (!object(result) || typeof result.url !== 'string') throw issue('页面未提供可核实的读取结果。', 'SOURCE_UNAVAILABLE');
    if (result.needsHuman) throw issue('来源需要登录、验证码或额外验证，请在浏览器中处理后再执行。', 'LOGIN_REQUIRED');
    if (result.loading) throw issue('页面在限定等待时间内仍显示加载中；未把未加载数据当作零。', 'PAGE_NOT_READY');
    const finalUrl = validateContentUrl(result.url, kind);
    await assertPublicContentHost(finalUrl, this.lookup);
    if (new URL(finalUrl).hostname !== new URL(url).hostname) throw issue('来源跳转到其他站点，请核对最终链接后重新创建任务。', 'SOURCE_REDIRECTED');
    if (kind === 'productDiscover' && new URL(finalUrl).searchParams.get('keywords') !== new URL(url).searchParams.get('keywords')) throw issue('搜索页面关键词与任务不一致，已停止读取。', 'SEARCH_MISMATCH');
    if (kind === 'comments' && new URL(finalUrl).pathname.replace(/\/$/, '') !== new URL(url).pathname.replace(/\/$/, '')) throw issue('评论页面已离开指定作品。', 'WORK_MISMATCH');
    return { ...result, url: finalUrl, observedAt: this.stamp() };
  }
  evidence(source) {
    return { url: source.url, observedAt: source.observedAt, title: clean(source.title, 300),
      scope: source.scope || (source.sourceUrl && source.publishedAt ? 'RSS / Atom 返回的标题、链接与发布时间；未读取文章正文或视频内容' : '来源页面当前可见文字；未读取视频音轨或不可见数据') };
  }
  async persist(collection, rows, context) {
    checkSignal(context.signal);
    const result = await this.workspace.update(state => {
      checkSignal(context.signal); const ids = [];
      for (const row of rows) {
        const existing = state[collection].find(item => item.id === row.id);
        // Never overwrite user-edited drafts during scheduled replay.
        if (!existing) state[collection].push(row);
        else if (collection === 'products' && existing.automationSource === 'content-automation') {
          // New explicitly requested downloads can enrich an earlier read-only
          // research result without replacing edited price/copy/report fields.
          existing.images = [...new Map([...(existing.images || []), ...(row.images || [])].map(image => [image.path, image])).values()].slice(0, 20);
          existing.latestResearchEvidence = row.sourceEvidence;
          existing.observedPrice = row.observedPrice;
          existing.observedPriceCurrency = row.observedPriceCurrency;
        }
        ids.push(row.id);
      }
      return ids;
    });
    return result.result;
  }
  async sources(input, context) {
    const sources = [], warnings = [], seen = new Set();
    const add = source => {
      if (!seen.has(source.url) && sources.length < input.limit) { seen.add(source.url); sources.push(source); }
    };
    // Explicit pages take precedence over the form's default RSS feed. Keep the
    // full observed page when RSS later contains the same URL, and use RSS only
    // to fill the remaining source budget.
    for (const url of (input.urls || []).slice(0, input.limit)) {
      await context.reportProgress?.({ message: `正在读取来源 ${sources.length + 1}。` });
      const page = await this.page(url, 'research', input, context);
      if (!page.title || !(page.paragraphs?.length || page.text?.trim())) throw issue('来源页面没有足够的可见文字，未生成研究结论。', 'SOURCE_UNAVAILABLE');
      add({ ...page, sourceName: new URL(page.url).hostname });
    }
    if (input.feedUrl && sources.length < input.limit) {
      checkSignal(context.signal);
      try {
        const feed = await this.collect({ feedUrl: input.feedUrl, keywords: input.keywords || '' }, join(this.root, 'feeds'));
        checkSignal(context.signal);
        warnings.push(...(feed.warnings || []));
        for (const item of feed.items.slice(0, 60)) {
          add({ ...item, observedAt: feed.at || this.stamp(), paragraphs: [], sourceName: item.sourceName || feed.feedTitle });
          if (sources.length >= input.limit) break;
        }
      } catch (error) {
        checkSignal(context.signal);
        if (!sources.length) throw error;
        warnings.push(`补充 RSS 来源未完成，已保留指定网页的真实资料：${clean(error.message, 300)}`);
      }
    }
    if (!sources.length) {
      const { value } = await this.workspace.read();
      for (const row of value.research.filter(row => !input.researchIds || input.researchIds.includes(row.id)).slice(-input.limit)) {
        if (!row.url || !row.sourceEvidence?.observedAt) continue;
        add({ title: row.title, url: row.url, observedAt: row.sourceEvidence.observedAt,
          sourceName: row.creator || row.author, paragraphs: row.sourceEvidence.facts || [], summary: row.sourceSummary || '', scope: row.sourceEvidence.scope });
      }
    }
    if (!sources.length) throw issue('请提供 RSS / 受支持页面链接，或先建立含来源时间的研究记录。');
    return { sources, warnings };
  }
  async research(input, context) {
    const { sources, warnings } = await this.sources(input, context);
    const rows = sources.map(source => {
      const facts = selectEvidenceFacts(source);
      return { id: `research-${hash([source.url, source.title, facts])}`, date: shanghaiDay(this.now()), title: clean(source.title, 160),
        url: source.url, creator: source.sourceName || new URL(source.url).hostname, hook: clean(source.title, 160),
        structure: facts.length ? facts.map((fact, i) => `${i + 1}. ${fact}`).join('\n') : '仅观察到标题；正文与视听结构未知。',
        signal: '未把可见文字解释为视频画面、口播或评论趋势。',
        takeaway: facts.length ? '可从已披露事实出发，说明信息来源与尚未确定之处；需原创改写。' : '先补充原文细节，再决定是否适合成片。',
        sourceSummary: facts.join('\n'), sourceEvidence: { ...this.evidence(source), facts }, automationSource: 'content-automation' };
    });
    const ids = await this.persist('research', rows, context);
    return { summary: `已保存 ${ids.length} 条有来源的研究观察。`, ids, evidence: sources.map(s => this.evidence(s)), warnings,
      articles: sources.filter(source => source.id && source.publishedAt && source.sourceUrl).map(({ id, title, url, publishedAt, sourceName, sourceUrl }) => ({ id, title, url, publishedAt, sourceName, sourceUrl })) };
  }
  async ideas(input, context) {
    const { sources, warnings } = await this.sources(input, context);
    const { value } = await this.workspace.read();
    const rows = sources.map(source => ({ ...buildEvidenceIdea(source, { audience: value.audience, ...input }),
      id: `idea-${hash([source.url, source.title, selectEvidenceFacts(source), input.angle || '', input.audience || value.audience])}`,
      date: shanghaiDay(this.now()), automationSource: 'content-automation' }));
    const ids = await this.persist('ideas', rows, context);
    return { summary: `已生成 ${ids.length} 条本地证据脚本草稿，等待内容核对与原创改写。`, ids, evidence: sources.map(s => this.evidence(s)),
      generationMethod: 'evidence-extractive-draft', warnings: [...warnings, '未接入 AI 文本模型；标题证据不足时不扩写事实。'], reviewRequired: true,
      articles: sources.filter(source => source.id && source.publishedAt && source.sourceUrl).map(({ id, title, url, publishedAt, sourceName, sourceUrl }) => ({ id, title, url, publishedAt, sourceName, sourceUrl })) };
  }
  async diagnosis(input, context) {
    const { value } = await this.workspace.read();
    const snapshot = this.tracking ? await this.tracking.snapshot() : null;
    const observations = (snapshot?.records || []).filter(row => row.observation && (!input.accountId || row.observation.accountId === input.accountId));
    const metrics = observations.length ? observations.map(row => ({ ...row.observation.metrics, workId: row.observation.workId, title: row.target?.title || '',
      accountId: row.observation.accountId, url: row.observation.url, observedAt: row.observation.observedAt, reviewState: row.observation.reviewState }))
      : value.metrics.filter(row => row.source === 'douyin-tracking' && (!input.accountId || row.accountId === input.accountId))
        .map(row => ({ ...row, title: row.mTitle || row.title, workId: row.platformWorkId, url: row.publishedUrl, observedAt: row.collectedAt || row.observedAt || row.updatedAt }));
    const latest = new Map();
    for (const row of metrics) if (row.workId && (!latest.has(row.workId) || Date.parse(row.observedAt) > Date.parse(latest.get(row.workId).observedAt))) latest.set(row.workId, row);
    const works = [...latest.values()];
    if (!works.length) throw issue('尚无已绑定作品的真实回采指标，不能自动生成表现诊断。', 'METRICS_REQUIRED');
    if (!input.accountId && new Set(works.map(row => row.accountId).filter(Boolean)).size > 1) throw issue('存在多个账号的数据，请为诊断选择一个账号。', 'ACCOUNT_REQUIRED');
    const plays = works.filter(row => Number.isFinite(row.plays)), completions = works.filter(row => Number.isFinite(row.completion));
    const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
    const totalPlays = sum(plays, 'plays'), completion = completions.length ? sum(completions, 'completion') / completions.length : null;
    const times = works.map(row => row.observedAt).filter(value => Number.isFinite(Date.parse(value))).sort();
    const summary = `已核实 ${works.length} 条作品；${plays.length} 条可见播放量合计 ${totalPlays}。${completion === null ? '完播率未知。' : `${completions.length} 条可见完播率平均 ${completion.toFixed(2)}%（未按播放量加权）。`}观察时间：${times[0] || '未知'} 至 ${times.at(-1) || '未知'}。`;
    const recommendation = works.length < 5 ? '有效样本少于 5 条，先积累更多同等观察时长的数据，不能据此判断稳定趋势。'
      : '下一轮只调整开场或标题中的一个变量，在相同发布后观察时长比较表现；不同内容的相关性不能证明因果。';
    const report = { id: `diagnosis-${hash([input.accountId || works[0].accountId, works])}`, date: shanghaiDay(this.now()), type: '诊断', category: '账号', title: '自动账号数据诊断',
      summary: `${summary}\n${recommendation}\n账号定位：${value.pillars || '未填写'}；受众：${value.audience || '未填写'}。`,
      evidence: works.map(row => ({ url: row.url, workId: row.workId, observedAt: row.observedAt, metrics: Object.fromEntries(['plays', 'likes', 'mComments', 'shares', 'saves', 'followers', 'completion'].filter(key => Number.isFinite(row[key])).map(key => [key, row[key]])) })),
      automationSource: 'content-automation', limitations: '仅基于已绑定作品的可见数据；不伪造五维评分，不推断未观察到的账号包装、受众画像或因果。' };
    await this.persist('records', [report], context);
    return { summary, ids: [report.id], evidence: report.evidence, recommendation, sampleCount: works.length,
      timeRange: { first: times[0] || null, last: times.at(-1) || null }, works, warnings: [report.limitations] };
  }
  async insights(input, context) {
    const diagnosis = await this.diagnosis(input, context);
    const candidates = diagnosis.works.filter(row => row.title && Number.isFinite(row.plays)).sort((a, b) => b.plays - a.plays);
    if (!candidates.length) return { ...diagnosis, summary: `${diagnosis.summary}没有带标题的数值样本，未生成后续选题。`, requiresAction: true };
    const baseline = candidates[0], title = `单变量内容实验：${clean(baseline.title, 100)}`;
    const id = `insight-idea-${hash([baseline.accountId, baseline.workId, shanghaiDay(this.now())])}`;
    const idea = { id, date: shanghaiDay(this.now()), title, angle: '保留主题，只改变开场信息顺序；发布后按相同观察时长比较',
      hook: `针对“${clean(baseline.title, 100)}”，先给出一条已核实的核心信息。`,
      script: `【实验依据】当前样本中《${clean(baseline.title, 200)}》的可见播放量为 ${baseline.plays}，观察于 ${baseline.observedAt || '未知时间'}。这不是效果原因或稳定趋势的证明。\n【写作任务】沿用同一主题与已核实来源，先交代核心信息，再说明背景，只调整开场顺序。需要取得原文和现有脚本后才能形成可拍摄的新文案。\n【验收方法】记录变动项，在相同发布后观察时长比较播放、完播和互动；缺失指标保持未知。`,
      cta: '哪一处信息还需要进一步说明？', duration: '与对照作品保持一致', bgm: '与对照作品保持一致',
      sourceEvidence: [{ url: baseline.url, observedAt: baseline.observedAt, workId: baseline.workId, metrics: { plays: baseline.plays } }],
      status: '待补充来源', reviewRequired: true, readyForProduction: false, generationMethod: 'measured-single-variable-experiment', automationSource: 'content-automation' };
    await this.persist('ideas', [idea], context);
    return { ...diagnosis, ids: [...diagnosis.ids, id], summary: `${diagnosis.summary}已保存 1 个单变量选题实验。`,
      warnings: [...diagnosis.warnings, '样本观察时长可能不同，当前最高播放仅用于选择实验对象，不能称作最佳内容或爆款。'] };
  }
  async remix(input, context) {
    const { sources, warnings } = await this.sources(input, context);
    const rows = sources.map(source => {
      const facts = selectEvidenceFacts(source), questions = /[？?]/.test(source.title), numbers = /\d/.test(source.title);
      return { id: `remix-${hash([source.url, source.title, facts])}`, date: shanghaiDay(this.now()), type: '拆解', category: '模式', title: `文字结构拆解：${clean(source.title, 100)}`,
        summary: `标题可见特征：${questions ? '提问式标题' : '陈述式标题'}；${numbers ? '含具体数字' : '未出现数字'}。\n${facts.length ? `正文可见事实 ${facts.length} 段：\n${facts.join('\n')}` : '正文证据不足。'}\n可迁移实验：保留同类信息组织方式，用自己的事实与表述制作新内容。\n尚未读取视频画面或音轨；没有播放基线，不能称为爆款或推断效果原因。`,
        evidence: this.evidence(source), automationSource: 'content-automation' };
    });
    const ids = await this.persist('records', rows, context);
    return { summary: `已完成 ${ids.length} 条来源文字结构拆解。`, ids, evidence: sources.map(s => this.evidence(s)), warnings: [...warnings, '未做视听分析，未把样本标为爆款。'] };
  }
  async comments(input, context) {
    const page = await this.page(input.urls[0], 'comments', input, context);
    if (!page.commentStructureFound && !page.commentsEmpty) throw issue('当前可见页面未提供可识别评论结构；未把未知评论数当作零。', 'COMMENTS_UNAVAILABLE');
    const comments = [...new Set((page.comments || []).map(row => clean(row.text, 1500)).filter(Boolean))].slice(0, input.limit);
    const rows = comments.map(comment => { const type = classifyComment(comment); return {
      id: `comment-${hash([page.url, comment])}`, date: shanghaiDay(this.now()), comment, context: clean(page.title, 200), replyType: type,
      reply: commentReply(comment, type), status: '待审核', sent: false, reviewRequired: true,
      sourceUrl: page.url, sourceEvidence: this.evidence(page), automationSource: 'content-automation' }; });
    const ids = await this.persist('comments', rows, context);
    return { summary: ids.length ? `已读取 ${ids.length} 条可见评论并生成待审回复草稿，未发送。` : '页面明确显示暂无评论，未生成回复。', ids,
      evidence: [this.evidence(page)], warnings: ['仅处理当前加载的可见评论，不代表全部评论。'], sentCount: 0 };
  }
  async capture(input, context) {
    const page = await this.page(input.urls[0], 'capture', input, context), extractor = input.extractor || 'currentVideo';
    const metrics = parseDouyinMetrics(page.publicMetrics || {});
    let details;
    if (extractor === 'creatorMetrics') {
      if (!page.manage || page.manage.needsHuman || !page.manage.cards?.length) throw issue('当前后台页面没有可核实的作品数据卡片；请提供内容管理页并保持登录。', 'METRICS_REQUIRED');
      if (input.accountId && (page.manage.accountIds?.length !== 1 || page.manage.accountIds[0] !== input.accountId)) throw issue('后台页面账号与任务不一致。', 'ACCOUNT_MISMATCH');
      details = page.manage.cards.slice(0, 30).map(card => ({ title: clean(card.title, 300), time: clean(card.time, 80), status: clean(card.status, 80), metrics: parseDouyinMetrics(card.metrics) }));
    } else if (extractor === 'account') {
      if (!page.accountIds?.length) throw issue('页面未显示可核实的抖音号，请打开账号主页后重试。', 'ACCOUNT_REQUIRED');
      details = { accountIds: page.accountIds, title: clean(page.title, 200), text: clean(page.text, 4000) };
    } else {
      validateContentUrl(page.url, 'comments');
      if (new URL(page.url).pathname.replace(/\/$/, '') !== new URL(input.urls[0]).pathname.replace(/\/$/, '')) throw issue('页面已离开指定作品。', 'WORK_MISMATCH');
      if (!Object.keys(metrics).length) throw issue('页面未显示可核实的数值指标；“万”等缩写不会当作精确数值。', 'METRICS_REQUIRED');
      details = { title: clean(page.title, 200), metrics };
    }
    const row = { id: `capture-${hash([page.url, extractor, shanghaiDay(this.now()), details])}`, date: shanghaiDay(this.now()), type: '回采', category: '复盘',
      title: `${extractor === 'account' ? '账号' : '作品'}可见数据回采：${clean(page.title, 100)}`, summary: JSON.stringify(details, null, 2),
      details, evidence: this.evidence(page), automationSource: 'content-automation' };
    const ids = await this.persist('records', [row], context);
    return { summary: '已保存真实页面回采记录；未改变发布回执或自动绑定归属。', ids, evidence: [this.evidence(page)], details };
  }
  async productDiscover(input, context) {
    const searchUrl = productSearchUrl(input.keywords), attemptedAt = this.stamp();
    let page;
    try { page = await this.page(searchUrl, 'productDiscover', input, context); }
    catch (error) {
      checkSignal(context.signal);
      return { requiresAction: true, summary: error.message, code: error.code || 'SOURCE_UNAVAILABLE', ids: [],
        evidence: [{ url: searchUrl, attemptedAt, scope: '尝试读取公开搜索页；未取得已验证搜索结果' }], selectedLinks: [] };
    }
    const candidates = [], seen = new Set();
    for (const offer of (Array.isArray(page.offers) ? page.offers : []).slice(0, 50)) {
      try {
        const url = new URL(validateContentUrl(offer.url, 'productResearch'));
        if (url.hostname !== 'detail.1688.com' || !clean(offer.title, 200)) continue;
        url.search = ''; url.hash = '';
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        candidates.push({ url: url.href, title: clean(offer.title, 200), priceTexts: (Array.isArray(offer.priceTexts) ? offer.priceTexts : []).slice(0, 5).map(value => clean(value, 100)), visibleText: clean(offer.visibleText, 600) });
        if (candidates.length >= input.limit) break;
      } catch { /* Malformed or unrelated links are data, never navigation targets. */ }
    }
    const selectedLinks = candidates.map(row => row.url), discovery = { ...this.evidence(page), keywords: input.keywords,
      selectedLinks, candidates, selectionPolicy: '只选当前首屏可见且符合详情地址的前几项；按页面 DOM 顺序，不代表推荐、销量、质量或价格排名。' };
    const record = { id: `product-discovery-${hash([searchUrl, candidates])}`, date: shanghaiDay(this.now()), type: '观察', category: '选品', title: `公开商品发现：${input.keywords}`,
      summary: candidates.length ? `${discovery.selectionPolicy}\n${candidates.map((row, index) => `${index + 1}. ${row.title}\n${row.url}\n页面价格片段：${row.priceTexts.join('；') || '未知'}`).join('\n')}` : '当前页面没有可识别的首屏商品详情链接，未虚构候选。',
      evidence: discovery, automationSource: 'content-automation' };
    await this.persist('records', [record], context);
    if (!candidates.length) return { requiresAction: true, summary: record.summary, code: 'PRODUCT_CANDIDATES_REQUIRED', ids: [], discoveryRecordId: record.id, evidence: [discovery], selectedLinks };
    await context.reportProgress?.({ message: `已读取 ${candidates.length} 个可见商品候选，正在核实详情与生成日报。` });
    let result;
    try {
      result = await this.productResearch({ urls: selectedLinks, limit: candidates.length, browserId: input.browserId,
        accountId: input.accountId, audience: input.audience, downloadImages: input.downloadImages === true }, context);
    } catch (error) {
      checkSignal(context.signal);
      return { requiresAction: true, summary: `搜索候选已保存；详情研究尚未完成：${error.message}`, code: error.code || 'SOURCE_UNAVAILABLE',
        ids: [], discoveryRecordId: record.id, evidence: [discovery], selectedLinks };
    }
    checkSignal(context.signal);
    await this.workspace.update(state => {
      checkSignal(context.signal);
      for (const product of state.products.filter(row => result.ids.includes(row.id) && row.automationSource === 'content-automation')) product.discoveryEvidence = discovery;
    });
    return { ...result, summary: `已从公开搜索页发现并研究 ${result.ids.length} 个商品，每项生成 5 份日报；未发布。`,
      discoveryRecordId: record.id, evidence: [discovery, ...result.evidence], selectedLinks, warnings: [discovery.selectionPolicy, ...result.warnings] };
  }
  async productResearch(input, context) {
    const { value } = await this.workspace.read();
    const urls = input.urls?.length ? input.urls : value.products.filter(row => input.productIds?.includes(row.id)).map(row => row.supplierUrl).filter(Boolean);
    if (!urls?.length) throw issue('请提供明确商品链接，或选择含货源链接的商品；不能凭空生成供应商与价格。');
    const pages = [];
    for (const url of [...new Set(urls)].slice(0, input.limit)) {
      const page = await this.page(url, 'productResearch', input, context);
      if (!clean(page.title)) throw issue('商品页面没有可核实的标题。', 'SOURCE_UNAVAILABLE');
      pages.push(page);
    }
    const at = this.stamp(), day = shanghaiDay(this.now()), rows = [], artifacts = [], warnings = [];
    for (const page of pages) {
      const id = `product-${hash(page.url)}`, price = parseObservedPrice(page.priceTexts);
      const title = clean(page.title, 160), evidence = this.evidence(page);
      const quotes = (page.priceTexts || []).map(value => clean(value, 100)).join('；') || '未观察到可识别价格';
      const alternatives = pages.filter(other => other.url !== page.url).map(other => `| ${clean(other.title, 80).replace(/\|/g, ' ')} | ${parseObservedPrice(other.priceTexts) || '未知/区间'} | ${other.url} |`).join('\n');
      const documents = {
        analysis: `# ${title}\n\n来源：${page.url}\n读取时间：${at}\n\n当前页面标题和价格是可见观察，不代表供应商资质、库存、销量或成交价格已核验。\n\n可见商品信息：\n${selectEvidenceFacts(page).join('\n') || '正文细节不足。'}\n\n受众：${clean(input.audience || value.audience, 200) || '待确定'}\n素材图片仅记录来源链接，尚未取得使用授权。`,
        suppliers: `# 货源比价\n\n本页：${page.url}\n可见标价文本：${quotes}\n\n| 对照页面 | 可见明确金额（人民币） | 来源 |\n| --- | --- | --- |\n${alternatives || '| 未提供其他商品链接 | 未知 | — |'}\n\n不同规格、起订量、运费和币种未统一，不能据此宣布最低价；没有推断供应商名称、销量或资质。`,
        pricing: `# 价格单\n\n| 项目 | 观察值 |\n| --- | --- |\n| 页面明确标价 | ${price ? `${price} CNY` : '未知/区间，须核对规格与起订量'} |\n| 采购成本 | 未核实 |\n| 建议售价 | 未核实 |\n| 运费 | 未核实 |\n| 平台费用 | 未核实 |\n| 广告与退货预留 | 未核实 |\n\n成本不足，未计算利润率。来源：${page.url}\n时间：${at}`,
        script: `# 视频脚本草稿\n\n开场：挑选“${title}”前，先确认规格和实际结算条件。\n主体：页面当前${price ? `出现 ${price} 元的明确标价` : `显示“${quotes}”`}，不能据此确认所有规格的最终到手价。\n演示：仅展示已经获准使用的实物或图片；当前未取得素材使用许可。\n收尾：下单前核对规格、数量、运费、售后与交期。\n\n未声称亲自使用，未编造性能、销量或推荐结论。\n来源：${page.url}`,
        copy: `## 中文\n\n商品研究草稿：${title}。规格、价格与售后条件请以商品页面实际选择结果为准；当前资料尚待核验。\n来源：${page.url}\n\n## English\n\nProduct research draft. Check the selected variant, final price, shipping and after-sales terms on the source page. Product claims and image rights have not been verified.\nSource: ${page.url}`
      };
      const directory = join(this.root, 'output', day, id);
      checkSignal(context.signal); await mkdir(directory, { recursive: true });
      for (const [key, name] of Object.entries(reportNames)) { checkSignal(context.signal); const path = join(directory, name); await writeFile(path, documents[key], 'utf8'); artifacts.push({ name, path }); }
      const imageSources = (page.images || []).filter(image => { try { const u = new URL(image.url); return u.protocol === 'https:' && !u.username && !u.password && !u.port; } catch { return false; } }).slice(0, 20);
      const downloaded = []; let imageBytes = 0;
      if (input.downloadImages) for (const image of [...new Map(imageSources.map(row => [row.url, row])).values()].slice(0, 3)) {
        checkSignal(context.signal);
        try {
          const file = await this.downloadImage(image.url, join(directory, '06_素材', 'images'), { signal: context.signal, maxBytes: 20 * 1024 * 1024 - imageBytes, lookup: this.lookup });
          imageBytes += file.bytes; downloaded.push(file); artifacts.push({ name: '公开商品图片', path: file.path });
        } catch (error) { checkSignal(context.signal); warnings.push(`${title}：${clean(error.message, 200)}`); }
      }
      const imagePath = join(directory, 'image-sources.json');
      await writeFile(imagePath, JSON.stringify({ observedAt: at, pageUrl: page.url, downloaded: downloaded.length > 0, rightsVerified: false, images: imageSources, downloads: downloaded }, null, 2)); artifacts.push({ name: '图片来源链接', path: imagePath });
      rows.push(validateProduct({ id, title, currency: 'CNY', status: 'research', supplierUrl: page.url, audience: clean(input.audience || value.audience, 200),
        sourceDate: day, sourceKey: `web/${hash(page.url)}`, documents, notes: `页面标价文本：${quotes}。未核实实际采购成本、规格、运费、供应商资质及素材权利。`,
        captionZh: documents.copy.split('## English')[0], captionEn: documents.copy.split('## English')[1].trim(),
        createdAt: at, updatedAt: at, automationSource: 'content-automation', sourceEvidence: evidence, observedPrice: price, observedPriceCurrency: 'CNY', imageSources,
        images: downloaded.map(file => ({ name: file.name, path: file.path, createdAt: at })), imageRightsVerified: false }));
    }
    const ids = await this.persist('products', rows, context);
    return { summary: `已研究 ${ids.length} 个商品并生成每项 5 份日报；未知成本留空，未发布。`, ids, evidence: pages.map(page => this.evidence(page)), artifacts,
      warnings: [...warnings, input.downloadImages ? '公开图片已按请求下载；图片可公开读取不等于取得发布授权，制作发布前仍须核实素材使用权。' : '只读当前页面可见信息；标价不等于采购成本；未下载或授权使用商品图片。'] };
  }
}
