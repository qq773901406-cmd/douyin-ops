import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let activeSession = process.env.BSK_SESSION_ID || '';

async function run(args, timeout = 30000) {
  try {
    const { stdout, stderr } = await execFileAsync(process.env.BSK_BIN || 'bsk', args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
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
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || !new Set(['douyin.com', 'www.douyin.com', 'creator.douyin.com']).has(url.hostname)) throw new Error('仅允许打开抖音和抖音创作者中心的 HTTPS 地址。');
  return url.href;
}

export async function executeBrowserSkill(input = {}) {
  const action = String(input.action || 'status');
  if (action === 'status') return browserSkillStatus();
  if (action === 'start') {
    const result = await run(['session', 'start', '--no-focus', '--json']);
    const payload = parseJson(result.stdout);
    if (result.ok) activeSession = String(payload?.session_id || payload?.sessionId || '');
    return { ...result, sessionId: activeSession || null, data: payload };
  }
  const sessionId = String(input.sessionId || activeSession || '');
  if (!sessionId) return { ok: false, code: 'SESSION_REQUIRED', message: '请先启动 BrowserSkill 会话。' };
  if (action === 'navigate') return run(['navigate', assertDouyinUrl(input.url), '--session', sessionId]);
  if (action === 'observe') return run(['observe', '--session', sessionId]);
  if (action === 'screenshot') return run(['screenshot', '--session', sessionId, '--out', String(input.path || 'runtime/browser-screenshot.png')]);
  if (action === 'stop') { const result = await run(['session', 'stop', sessionId]); if (result.ok) activeSession = ''; return result; }
  return { ok: false, code: 'ACTION_NOT_ALLOWED', message: '本地工作台只开放会话、导航、观察和截图；输入、点击、上传与发布由 WorkBuddy 调用 BrowserSkill，并在执行前确认。' };
}
