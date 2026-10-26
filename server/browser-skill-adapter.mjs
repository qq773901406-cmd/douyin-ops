import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBsk, parseBskJson, resolveBskBinary, BSK_TIMEOUTS } from '../lib/bsk-client.mjs';
import { planBrowserConnectionRecovery } from '../lib/browser-connection-recovery.mjs';
import { shortDiagnostic } from '../lib/background-service-policy.mjs';

let activeSession = process.env.BSK_SESSION_ID || '';
let startingSession = null;

// Screenshot output must stay inside the runtime directory — input.path arrives
// from the client and was previously passed straight to the CLI's --out flag,
// allowing a crafted path to write outside runtime (path traversal).
// Resolve against the project root (matching the previous relative behaviour,
// where 'runtime/browser-screenshot.png' meant <root>/runtime/...), then require
// the result to stay within runtimeDir.
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const runtimeDir = resolve(process.env.DOUFENG_DATA_DIR || join(root, 'runtime'));
function safeRuntimeOutPath(inputPath) {
  const fallback = 'runtime/browser-screenshot.png';
  const resolved = resolve(root, String(inputPath || fallback));
  if (resolved !== runtimeDir && !resolved.startsWith(runtimeDir + sep)) {
    throw Object.assign(new Error('截图输出路径必须位于 runtime 目录内。'), { status: 400 });
  }
  return resolved;
}

async function run(args, timeout = BSK_TIMEOUTS.DEFAULT_MS) {
  return runBsk(args, { timeout });
}

export async function browserSkillStatus(invoke = run) {
  const version = await invoke(['--version'], BSK_TIMEOUTS.STATUS_MS);
  if (!version.ok) return { installed: false, connected: false, message: version.message, sessionId: activeSession || null };
  // `doctor` can sync installed skills and emit update hints. Status requests
  // must remain read-only and must distinguish a daemon from a live extension.
  const result = await invoke(['status', '--json'], BSK_TIMEOUTS.STATUS_MS);
  const payload = parseBskJson(result.stdout);
  if (!result.ok || !payload || payload.ok === false || payload.error) {
    return { installed: true, connected: false, version: version.stdout || '已安装',
      state: 'daemon_unavailable', sessionId: null, browserCount: null,
      message: shortDiagnostic(result.message || payload?.message || 'BrowserSkill 守护进程未响应，请检查后台连接。') };
  }
  const { state } = planBrowserConnectionRecovery({ health: { state: 'healthy' }, status: payload });
  if (Array.isArray(payload.browsers) && payload.browsers.length === 0 && state.status === 'needs_user_action') {
    state.status = 'disconnected';
    state.message = 'BrowserSkill 守护进程已运行，浏览器扩展尚未连接；请查看后台恢复状态或启用扩展本地连接。';
  }
  const sessionKnown = Array.isArray(payload.sessions) && payload.sessions.some(session => session.session_id === activeSession);
  if (Array.isArray(payload.sessions) && !sessionKnown) activeSession = '';
  return { installed: true, connected: state.status === 'connected', version: version.stdout || '已安装',
    state: state.status, sessionId: sessionKnown ? activeSession : null,
    browserCount: Array.isArray(payload.browsers) ? payload.browsers.length : null,
    responsiveBrowserCount: state.connectedBrowserIds.length,
    unresponsiveBrowserCount: state.unresponsiveBrowserCount,
    message: state.message };
}

function assertDouyinUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || !new Set(['douyin.com', 'www.douyin.com', 'creator.douyin.com']).has(url.hostname)) throw Object.assign(new Error('仅允许打开抖音和抖音创作者中心的 HTTPS 地址。'), { status: 400 });
  return url.href;
}

// Injectable command runner keeps session protocol tests entirely offline.
export async function startBrowserSkillSession(browserId, invoke = run) {
  const token = `${Date.now() + BSK_TIMEOUTS.TOKEN_TTL_MS}:${randomUUID()}`;
  let sessionId, prepared = false;
  const json = async (args, timeout = BSK_TIMEOUTS.SESSION_REQUEST_MS) => {
    const result = await invoke([...args, '--json'], timeout);
    const payload = parseBskJson(result.stdout);
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
    const started = await json(['session', 'start', '--browser', selected, '--request-id', token, '--no-focus', '--name', '豆蜂浏览器查看'], BSK_TIMEOUTS.SESSION_START_ADAPTER_MS);
    sessionId = started.session_id;
    if (!sessionId || started.browser_instance_id !== selected) throw new Error('浏览器会话与所选实例不一致。');
    const claimed = await json(['session', 'request', token, '--claim']);
    if (claimed.state !== 'active' || claimed.session?.session_id !== sessionId) throw new Error('浏览器会话未领取成功，请检查扩展中的请求。');
    return { ok: true, sessionId, data: started, message: '浏览器会话已准备并领取。' };
  } catch (error) {
    const cleanup = sessionId ? ['session', 'stop', sessionId, '--json'] : prepared ? ['session', 'request', token, '--cancel', '--json'] : null;
    if (cleanup) await invoke(cleanup, BSK_TIMEOUTS.SESSION_STOP_MS).catch(() => {});
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
        const listed = await run(['session', 'list', '--json'], BSK_TIMEOUTS.SESSION_REQUEST_MS), sessions = parseBskJson(listed.stdout);
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
  if (action === 'navigate') return run(['navigate', assertDouyinUrl(input.url), '--session', sessionId, '--timeout', '60s'], BSK_TIMEOUTS.NAVIGATE_ADAPTER_MS);
  if (action === 'observe') return run(['observe', '--session', sessionId]);
  if (action === 'screenshot') return run(['screenshot', '--session', sessionId, '--out', safeRuntimeOutPath(input.path)]);
  if (action === 'stop') { const result = await run(['session', 'stop', sessionId]); if (result.ok && sessionId === activeSession) activeSession = ''; return result; }
  return { ok: false, code: 'ACTION_NOT_ALLOWED', message: '本地工作台只开放会话、导航、观察和截图；输入、点击、上传与发布由 WorkBuddy 调用 BrowserSkill，并在执行前确认。' };
}
