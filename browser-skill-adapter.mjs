import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
let activeSession = process.env.BSK_SESSION_ID || '';
let startingSession = null;

function browserSkillBinary() {
  if (process.env.BSK_BIN) return process.env.BSK_BIN;
  if (process.platform === 'win32') {
    const userInstall = join(homedir(), '.local', 'bin', 'bsk.exe');
    if (existsSync(userInstall)) return userInstall;
  }
  return 'bsk';
}

async function run(args, timeout = 30000) {
  try {
    const { stdout, stderr } = await execFileAsync(browserSkillBinary(), args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { ok: false, code: error.code === 'ENOENT' ? 'BSK_NOT_FOUND' : (error.code || 'BSK_ERROR'), message: error.code === 'ENOENT' ? '未检测到 BrowserSkill CLI。请安装腾讯 BrowserSkill，并在 Chrome 或 Edge 扩展中启用本地连接。' : (error.stderr || error.message || 'BrowserSkill 调用失败。').trim(), stdout: String(error.stdout || '').trim(), stderr: String(error.stderr || '').trim() };
  }
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch {}
  const line = value.split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'));
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}

export async function browserSkillStatus() {
  const version = await run(['--version'], 5000);
  if (!version.ok) return { installed: false, connected: false, message: version.message, sessionId: activeSession || null };
  const doctor = await run(['doctor'], 15000);
  const output = `${doctor.stdout || ''}\n${doctor.stderr || ''}`.trim();
  const connected = doctor.ok && !/failed|not connected|disconnected|未连接|失败/i.test(output);
  return { installed: true, connected, version: version.stdout || '已安装', sessionId: activeSession || null, message: connected ? 'BrowserSkill CLI 与浏览器扩展已连接。' : (output || 'BrowserSkill 已安装，请在浏览器扩展中启用本地连接。') };
}

function assertDouyinUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || !new Set(['douyin.com', 'www.douyin.com', 'creator.douyin.com']).has(url.hostname)) throw Object.assign(new Error('仅允许打开抖音和抖音创作者中心的 HTTPS 地址。'), { status: 400 });
  return url.href;
}

// Injectable command runner keeps session protocol tests entirely offline.
export async function startBrowserSkillSession(browserId, invoke = run) {
  const token = `${Date.now() + 5 * 60000}:${randomUUID()}`;
  let sessionId, prepared = false;
  const json = async (args, timeout = 15000) => {
    const result = await invoke([...args, '--json'], timeout);
    const payload = parseJson(result.stdout);
    if (!result.ok || !payload || payload.ok === false || payload.error || payload.success === false) throw new Error(result.message || payload?.message || 'BrowserSkill 未完成请求，请检查扩展连接。');
    return payload;
  };
  try {
    const browsers = await json(['browsers']);
    if (!Array.isArray(browsers)) throw new Error('无法读取浏览器列表，请检查 BrowserSkill 版本。');
    const candidates = browsers.filter(b => b.instance_id && !b.unresponsive && (!browserId || b.instance_id === browserId));
    if (candidates.length !== 1) throw new Error(candidates.length ? '连接了多个浏览器，请为本次操作选择一个浏览器，或暂时关闭其他浏览器的扩展连接。' : '没有找到可用浏览器，请启用所选浏览器的 BrowserSkill 扩展连接。');
    const selected = candidates[0].instance_id;
    prepared = true;
    await json(['session', 'request', '--prepare', token]);
    const started = await json(['session', 'start', '--browser', selected, '--request-id', token, '--no-focus', '--name', '豆蜂浏览器查看'], 70000);
    sessionId = started.session_id;
    if (!sessionId || started.browser_instance_id !== selected) throw new Error('浏览器会话与所选实例不一致。');
    const claimed = await json(['session', 'request', token, '--claim']);
    if (claimed.state !== 'active' || claimed.session?.session_id !== sessionId) throw new Error('浏览器会话未领取成功，请检查扩展中的请求。');
    return { ok: true, sessionId, data: started, message: '浏览器会话已准备并领取。' };
  } catch (error) {
    const cleanup = sessionId ? ['session', 'stop', sessionId, '--json'] : prepared ? ['session', 'request', token, '--cancel', '--json'] : null;
    if (cleanup) await invoke(cleanup, 15000).catch(() => {});
    return { ok: false, code: 'SESSION_START_FAILED', message: error.message, sessionId: null };
  }
}

export async function executeBrowserSkill(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('请求必须是 JSON 对象。'), { status: 400 });
  const action = String(input.action || 'status');
  if (action === 'status') return browserSkillStatus();
  if (action === 'start') {
    if (startingSession) return startingSession;
    startingSession = (async () => {
      if (activeSession) {
        const listed = await run(['session', 'list', '--json'], 15000), sessions = parseJson(listed.stdout);
        if (!listed.ok || !Array.isArray(sessions)) return { ok: false, code: 'SESSION_CHECK_FAILED', message: '无法确认原会话状态，请检查浏览器连接后重试。' };
        if (sessions.some(s => s.session_id === activeSession)) return { ok: true, sessionId: activeSession, message: '继续使用当前浏览器会话。' };
        activeSession = '';
      }
      const result = await startBrowserSkillSession(input.browserId);
      if (result.ok) activeSession = result.sessionId;
      return result;
    })();
    try { return await startingSession; } finally { startingSession = null; }
  }
  const sessionId = String(input.sessionId || activeSession || '');
  if (!sessionId) return { ok: false, code: 'SESSION_REQUIRED', message: '请先启动 BrowserSkill 会话。' };
  if (action === 'navigate') return run(['navigate', assertDouyinUrl(input.url), '--session', sessionId, '--timeout', '60s'], 70000);
  if (action === 'observe') return run(['observe', '--session', sessionId]);
  if (action === 'screenshot') return run(['screenshot', '--session', sessionId, '--out', String(input.path || 'runtime/browser-screenshot.png')]);
  if (action === 'stop') { const result = await run(['session', 'stop', sessionId]); if (result.ok && sessionId === activeSession) activeSession = ''; return result; }
  return { ok: false, code: 'ACTION_NOT_ALLOWED', message: '本地工作台只开放会话、导航、观察和截图；输入、点击、上传与发布由 WorkBuddy 调用 BrowserSkill，并在执行前确认。' };
}
