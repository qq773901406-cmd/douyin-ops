import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runBsk, parseBskJson, BSK_TIMEOUTS } from '../lib/bsk-client.mjs';

const creatorHome = 'https://creator.douyin.com/creator-micro/home';
const videoUpload = 'https://creator.douyin.com/creator-micro/content/upload';
const cleanText = text => String(text || '').replace(/\r\n?/g, '\n').replace(/\u200b/g, '').replace(/\u00a0/g, ' ')
  .split('\n').filter(line => line.trim()).join('\n').trim();
const isVideoEditor = url => /\/creator-micro\/content\/(?:post\/video|publish)(?:[/?#]|$)/.test(url);

// Fixed, read-only DOM inspection. It never reads cookies, storage or page JS state.
export function inspectCreatorDOM() {
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => String(el.innerText || el.textContent || '').trim();
  const selector = el => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const siblings = node.parentElement ? [...node.parentElement.children].filter(s => s.tagName === node.tagName) : [node];
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
      if (node.tagName === 'BODY') break;
    }
    return parts.join(' > ');
  };
  const leafTexts = [...document.querySelectorAll('span,p,div,label')].filter(el => visible(el) && !el.closest('[contenteditable="true"],textarea,input') && text(el).length < 140 && ![...el.children].some(child => visible(child) && text(child) === text(el)));
  const accounts = [...new Set(leafTexts.map(el => text(el).match(/^抖音号\s*[：:]?\s*([A-Za-z0-9_.-]+)$/)?.[1]).filter(Boolean))];
  const bodyText = document.body?.innerText || '';
  const alerts = [...document.querySelectorAll('[role="alert"],[role="status"],[class*="toast"],[class*="message-content"]')].filter(visible).map(text).filter(t => t.length < 180);
  const dialogs = [...document.querySelectorAll('[role="dialog"],dialog,[class*="captcha"],[id*="captcha"]')].filter(visible).map(text);
  const needsHuman = dialogs.some(t => /验证|扫码|登录|滑块|安全|授权/.test(t)) || /\/login(?:[/?#]|$)/.test(location.href) || (!!document.querySelector('input[type="password"]') && /登录/.test(bodyText));
  const uploads = [...document.querySelectorAll('button,label,[role="button"],div,span')].filter(el => visible(el) && /^(上传视频|选择视频|点击上传)$/.test(text(el)) && ![...el.children].some(child => visible(child) && text(child) === text(el)));
  const titles = [...document.querySelectorAll('input,textarea')].filter(el => visible(el) && !el.disabled && /作品标题|添加.*标题|填写.*标题/.test(el.getAttribute('placeholder') || el.getAttribute('aria-label') || ''));
  const captions = [...document.querySelectorAll('[contenteditable="true"],textarea')].filter(el => visible(el) && !el.disabled && !titles.includes(el));
  const publish = [...document.querySelectorAll('button,[role="button"]')].filter(el => visible(el) && text(el) === '发布' && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  const choices = [...document.querySelectorAll('input[type="radio"]:checked,input[type="checkbox"]:checked,[role="radio"][aria-checked="true"],label:has(input[type="radio"]:checked),label:has(input[type="checkbox"]:checked),[class*="radio"][class*="checked"],[role="combobox"],[class*="select-selection"],[class*="selectSelection"],select')].filter(visible).map(el => el.tagName === 'INPUT' ? [...(el.labels || [])].filter(visible).map(text).join(' ') : el.tagName === 'SELECT' ? text(el.selectedOptions[0] || el) : text(el));
  return {
    url: location.href, accountIds: accounts, needsHuman,
    upload: uploads.length === 1 ? selector(uploads[0]) : null,
    title: titles.length === 1 ? { selector: selector(titles[0]), value: titles[0].value } : null,
    caption: captions.length === 1 ? { selector: selector(captions[0]), value: captions[0].value ?? captions[0].innerText } : null,
    publish: publish.length === 1 ? selector(publish[0]) : null,
    publicVisible: choices.some(t => /^(公开|所有人可见)(?:\s*[·：:]?\s*(?:所有人可见|任何人可见))?$/.test(t)),
    immediateVisible: choices.some(t => /^立即发布$/.test(t)) && !choices.some(t => /^定时发布/.test(t)),
    uploaded: /上传成功|上传完成|重新上传|更换视频/.test(bodyText),
    uploading: /上传中|上传失败|正在上传|正在转码|转码中/.test(bodyText),
    success: alerts.find(t => /发布成功|提交成功|发布完成/.test(t)) || '',
    validationError: alerts.find(t => /失败|请.{0,15}(封面|标题|声明|分类)|违规|限制/.test(t)) || ''
  };
}

export class DouyinPublisher {
  constructor({ run = runBsk } = {}) { this.run = run; }
  async command(args, timeout = BSK_TIMEOUTS.DEFAULT_MS) {
    const result = await this.run(args, { timeout });
    const parsed = parseBskJson(result.stdout);
    if (!result.ok) {
      // Do not expose command lines containing captions, file names or page dumps.
      if (result.code === 'BSK_NOT_FOUND') throw new Error('未找到 BrowserSkill，请在应用接入中完成安装和浏览器扩展连接。');
      if (args[0] === 'fill' && parsed?.data?.reason === 'fill_value_mismatch') {
        throw Object.assign(new Error('浏览器填写结果需要重新读取页面核对。'), { code: 'fill_value_mismatch' });
      }
      throw new Error(`浏览器步骤 ${args[0]} 未完成。请检查扩展、登录状态和页面；系统不会盲目重试。`);
    }
    if (!parsed || parsed.ok === false || parsed.error || parsed.success === false) throw new Error(`浏览器步骤 ${args[0]} 被拒绝或未完成，请在浏览器中检查。`);
    return parsed;
  }
  async browsers() {
    const result = await this.command(['browsers'], BSK_TIMEOUTS.SESSION_REQUEST_MS);
    if (!Array.isArray(result)) throw new Error('无法读取浏览器列表，请检查 BrowserSkill 版本。');
    return result.filter(item => item.instance_id && !item.unresponsive).map(item => ({ id: item.instance_id, name: [item.label, item.browser_name, item.instance_id].filter(Boolean).join(' · ') }));
  }
  async session(browserId, action) {
    if (!browserId) throw new Error('未选择发布用浏览器。');
    const token = `${Date.now() + BSK_TIMEOUTS.TOKEN_TTL_MS}:${randomUUID()}`;
    let sessionId;
    try {
      // Tracked requests must be prepared and claimed; extension permissions still apply.
      await this.command(['session', 'request', '--prepare', token], BSK_TIMEOUTS.SESSION_REQUEST_MS);
      const started = await this.command(['session', 'start', '--browser', browserId, '--no-focus', '--request-id', token, '--name', '豆蜂已审批视频发布'], BSK_TIMEOUTS.SESSION_START_PUBLISHER_MS);
      sessionId = started.session_id;
      if (!sessionId || started.browser_instance_id !== browserId) throw new Error('浏览器实例与审批绑定不一致，请重新检查连接。');
      const claimed = await this.command(['session', 'request', token, '--claim'], BSK_TIMEOUTS.SESSION_REQUEST_MS);
      if (claimed.state !== 'active' || claimed.session?.session_id !== sessionId) throw new Error('浏览器会话未能完成领取，请重新检查连接。');
      return await action(sessionId);
    } finally {
      if (sessionId) await this.command(['session', 'stop', sessionId], BSK_TIMEOUTS.SESSION_STOP_MS).catch(error => console.warn('浏览器会话清理失败：', error?.message || error));
      else await this.command(['session', 'request', token, '--cancel'], BSK_TIMEOUTS.CANCEL_MS).catch(error => console.warn('浏览器会话请求取消失败：', error?.message || error));
    }
  }
  async page(session) {
    const result = await this.command(['evaluate', `(${inspectCreatorDOM.toString()})()`, '--session', session, '--timeout', '10s'], BSK_TIMEOUTS.EVALUATE_MS);
    const value = result.value;
    if (!value || typeof value.url !== 'string') throw new Error('无法观察抖音页面，请检查浏览器连接。');
    let url; try { url = new URL(value.url); } catch {}
    if (!url || url.protocol !== 'https:' || url.hostname !== 'creator.douyin.com') throw new Error('页面已离开抖音创作者中心，任务已暂停。');
    if (value.needsHuman) throw new Error('抖音需要登录、验证码或额外确认，请在浏览器中完成后重新检查。');
    return value;
  }
  async waitPage(session, condition, guard = async () => {}, timeout = BSK_TIMEOUTS.WAIT_PAGE_MS) {
    const deadline = Date.now() + timeout;
    do {
      await guard(); const page = await this.page(session);
      if (page.validationError) throw new Error(`抖音提示：${page.validationError}`);
      if (condition(page)) return page;
      await delay(1500);
    } while (Date.now() < deadline);
    throw new Error('抖音页面未在预期时间内就绪，请检查页面或素材要求。');
  }
  async accountInSession(session) {
    await this.command(['navigate', creatorHome, '--session', session, '--timeout', '60s'], BSK_TIMEOUTS.NAVIGATE_PUBLISHER_MS);
    const page = await this.waitPage(session, value => value.accountIds.length === 1);
    return { accountId: page.accountIds[0] };
  }
  async inspectAccount(browserId) {
    return this.session(browserId, async session => {
      const account = await this.accountInSession(session);
      await this.command(['navigate', videoUpload, '--session', session, '--timeout', '60s'], BSK_TIMEOUTS.NAVIGATE_PUBLISHER_MS);
      await this.waitPage(session, page => !!page.upload);
      return account;
    });
  }
  async fill(session, field, selector, value) {
    try {
      await this.command(['fill', '--selector', selector, '--value', value, '--session', session]);
      return null;
    } catch (error) {
      if (error.code !== 'fill_value_mismatch') throw error;
      // Some Slate editors normalize blank paragraphs and insert U+200B. Do not
      // retry a write: inspect the same visible field immediately and compare it.
      const page = await this.page(session);
      if (!isVideoEditor(page.url) || page.validationError || page[field]?.selector !== selector
        || cleanText(page[field]?.value) !== cleanText(value)) throw new Error('页面填写结果与审批内容不一致，已停止。');
      return page;
    }
  }
  async publish(item, { guard, beforeSubmit }) {
    const approval = item.approval;
    return this.session(approval.browserId, async session => {
      await guard();
      const account = await this.accountInSession(session);
      if (account.accountId !== approval.accountId) throw new Error('当前登录抖音号与审批账号不同，已停止。');
      await this.command(['navigate', videoUpload, '--session', session, '--timeout', '60s'], BSK_TIMEOUTS.NAVIGATE_PUBLISHER_MS);
      const uploadPage = await this.waitPage(session, page => !!page.upload, guard);
      await guard();
      await this.command(['upload', '--selector', uploadPage.upload, '--file', approval.asset, '--session', session, '--timeout', '10m'], BSK_TIMEOUTS.UPLOAD_MS);
      let page = await this.waitPage(session, page => isVideoEditor(page.url) && page.uploaded && !page.uploading && page.title && page.caption, guard, BSK_TIMEOUTS.WAIT_UPLOAD_MS);
      await guard();
      page = await this.fill(session, 'title', page.title.selector, approval.title) || await this.page(session);
      if (!page.caption) throw new Error('无法唯一识别视频文案输入框，已停止。');
      await this.fill(session, 'caption', page.caption.selector, approval.caption);
      // The whole publish flow runs in this single persistent session, so the
      // logged-in account cannot switch without a re-login — which page() already
      // catches via needsHuman / login redirection. Re-checking the account in a
      // second controlled session (as before) risked stealing this session's upload
      // form, so we validate the account on the current editor page instead.
      page = await this.waitPage(session, page => !!page.publish && page.uploaded && !page.uploading, guard, BSK_TIMEOUTS.WAIT_PAGE_MS);
      const validateSubmission = page => {
        if (!isVideoEditor(page.url) || !page.publish || !page.uploaded || page.uploading || !page.title || !page.caption || cleanText(page.title.value) !== cleanText(approval.title) || cleanText(page.caption.value) !== cleanText(approval.caption)) throw new Error('页面视频标题、文案或上传状态与审批内容不一致，已停止。');
        if (page.accountIds.length && !page.accountIds.includes(approval.accountId)) throw new Error('发布页面账号与审批记录不符。');
        if (!page.publicVisible) throw new Error('无法确认页面已选择公开可见，已停止。请检查抖音发布页的可见范围。');
        if (!page.immediateVisible) throw new Error('无法确认抖音页面已选择立即发布，已停止。豆蜂已负责排期，请检查平台发布方式。');
      };
      validateSubmission(page);
      await beforeSubmit();
      page = await this.page(session); validateSubmission(page); await guard();
      // One submission only. Any failure from here is reconciled by the user.
      await this.command(['click', '--selector', page.publish, '--session', session], BSK_TIMEOUTS.CLICK_MS);
      const result = await this.waitPage(session, page => !!page.success, async () => {}, BSK_TIMEOUTS.SUCCESS_MS);
      return { message: '抖音页面已显示提交成功，仍需等待平台审核；可在队列中记录最终作品链接。', evidence: { kind: 'platform-message', text: result.success, url: result.url, checkedAt: new Date().toISOString() } };
    });
  }
}
