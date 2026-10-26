import { resolve, win32 } from 'node:path';

const normalPath = value => /^[A-Za-z]:[\\/]/.test(value || '')
  ? win32.resolve(value).toLowerCase() : resolve(value || '');

export function workbenchHealth(payload, config) {
  if (payload?.service !== 'douyin-ops-workbuddy-workbench'
    || typeof payload.root !== 'string' || typeof payload.dataDir !== 'string'
    || normalPath(payload.root) !== normalPath(config.root)
    || normalPath(payload.dataDir) !== normalPath(config.dataDir)
    || !Number.isSafeInteger(payload.pid) || payload.pid < 1) {
    return { state: 'conflict', error: '端口响应与配置的工作台身份不符。' };
  }
  return { state: 'healthy', pid: payload.pid, uptime: payload.uptime ?? null };
}

export function workbenchFailure(error) {
  const code = error?.cause?.code || error?.code || error?.name || 'ERROR';
  return { state: code === 'ECONNREFUSED' ? 'absent' : 'unknown', recoverable: /TimeoutError|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(String(code)) || error?.name === 'TimeoutError', error: String(code) };
}

export function browserHealth(payload) {
  if (!Number.isSafeInteger(payload?.pid) || payload.pid < 1) {
    return { state: 'unknown', error: 'BrowserSkill 状态没有有效进程标识。' };
  }
  const health = {
    state: 'healthy', pid: payload.pid,
    browserCount: Array.isArray(payload.browsers) ? payload.browsers.length : null,
    sessionCount: Array.isArray(payload.sessions) ? payload.sessions.length : null,
    responsiveBrowserCount: Array.isArray(payload.browsers) ? payload.browsers.filter(browser => browser.instance_id && !browser.unresponsive).length : null,
  };
  if (health.browserCount > 0 && health.sessionCount === 0
    && payload.browsers.every(browser => browser.unresponsive === true)
    && !payload.version_skew_browsers?.length) {
    return { ...health, state: 'unknown', daemonResponsive: true, recoverable: true, error: '浏览器扩展已连接但无响应。' };
  }
  return health;
}

export function browserFailure({ code, killed, signal, message = '' }) {
  // Permission/protocol/timeouts are ambiguous, even if a generic missing-daemon
  // hint appears in the same reply. Never turn them into another daemon launch.
  const ambiguous = killed || signal || /permission|denied|EACCES|EPERM|timed?\s*out|timeout|protocol|invalid reply/i.test(message);
  const absent = !ambiguous && code === 2
    && /ensure daemon is running/i.test(message)
    && /automatic daemon startup is disabled \(BSK_AUTO_START=0\)/i.test(message);
  const recoverable = Boolean((killed || /timed?\s*out|timeout|deadline has elapsed/i.test(message))
    && !/permission|denied|EACCES|EPERM|protocol|invalid reply/i.test(message));
  return { state: absent ? 'absent' : 'unknown', recoverable, error: shortDiagnostic(message || String(code || 'ERROR')) };
}

export function stalledRecoveryDecision(service, now, { samples = 3, graceMs = 90_000, cooldownMs = 10 * 60_000 } = {}) {
  if (service.health?.state !== 'unknown' || !service.health.recoverable) return { action: 'none' };
  if ((service.stallCount || 0) < samples || !Number.isFinite(service.stalledSince) || now - service.stalledSince < graceMs) {
    return { action: 'wait', reason: '短暂超时，正在连续检查。' };
  }
  if (!mayStopOwnedChild(service) || service.lastHealthyPid !== service.process.pid) {
    return { action: 'blocked', reason: '无法确认无响应进程属于本次宿主，已保留现场。' };
  }
  if (service.name === 'browser' && service.lastSessionCount !== 0) {
    return { action: 'blocked', reason: '断线前仍有浏览器会话，无法确认已结束，需要检查后恢复。' };
  }
  if (service.lastRecoveryAt && now - service.lastRecoveryAt < cooldownMs) {
    return { action: 'wait', reason: '恢复后仍不稳定，正在退避，避免反复重启。' };
  }
  if ((service.recoveryAttempts || 0) >= 3 && now - service.lastRecoveryAt < 60 * 60_000) {
    return { action: 'blocked', reason: '连续恢复仍无响应，已停止重启，需要检查浏览器扩展。' };
  }
  return { action: 'recover', reason: '连续无响应，准备在空闲时恢复自有进程。' };
}

export function shortDiagnostic(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:https?|wss?):\/\/\S+/gi, '[URL]')
    .replace(/\b(?:bearer\s+)[\w.+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:token|secret|password|cookie|authorization|api[_-]?key)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '[credential redacted]')
    .replace(/\b[A-Za-z0-9_+/=-]{48,}\b/g, '[long value redacted]').slice(0, 400);
}

export function restartDelayMs(failureCount) {
  return Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.max(0, failureCount - 1)));
}

export function mayStart({ health, ownedChildRunning, nextStartAt = 0, now, stopping = false }) {
  return !stopping && health.state === 'absent' && !ownedChildRunning && now >= nextStartAt;
}

export function mayStopOwnedChild(child) {
  return Boolean(child?.owned && child.process?.pid && child.process.exitCode === null && child.process.signalCode === null);
}
