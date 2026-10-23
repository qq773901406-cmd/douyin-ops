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
  return { state: code === 'ECONNREFUSED' ? 'absent' : 'unknown', error: String(code) };
}

export function browserHealth(payload) {
  if (!Number.isSafeInteger(payload?.pid) || payload.pid < 1) {
    return { state: 'unknown', error: 'BrowserSkill 状态没有有效进程标识。' };
  }
  return {
    state: 'healthy', pid: payload.pid,
    browserCount: Array.isArray(payload.browsers) ? payload.browsers.length : null,
    sessionCount: Array.isArray(payload.sessions) ? payload.sessions.length : null,
  };
}

export function browserFailure({ code, killed, signal, message = '' }) {
  // Permission/protocol/timeouts are ambiguous, even if a generic missing-daemon
  // hint appears in the same reply. Never turn them into another daemon launch.
  const ambiguous = killed || signal || /permission|denied|EACCES|EPERM|timed?\s*out|timeout|protocol|invalid reply/i.test(message);
  const absent = !ambiguous && code === 2
    && /ensure daemon is running/i.test(message)
    && /automatic daemon startup is disabled \(BSK_AUTO_START=0\)/i.test(message);
  return { state: absent ? 'absent' : 'unknown', error: shortDiagnostic(message || String(code || 'ERROR')) };
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
