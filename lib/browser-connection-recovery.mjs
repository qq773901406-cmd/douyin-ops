import { shortDiagnostic } from './background-service-policy.mjs';

export const BROWSER_CONNECTION_RECOVERY_POLICY = Object.freeze({
  disconnectGraceMs: 60_000,
  connectionWaitMs: 60_000,
  launchCooldownMs: 10 * 60_000,
  deferredRetryMs: 60_000,
});

const timeValue = value => Number.isFinite(value) && value >= 0 ? value : null;

function recoveryPolicy(input) {
  return Object.fromEntries(Object.entries(BROWSER_CONNECTION_RECOVERY_POLICY).map(([key, fallback]) => [
    key, Number.isFinite(input?.[key]) && input[key] >= 0 ? input[key] : fallback,
  ]));
}

// This planner deliberately never picks a replacement for a publishing binding.
// Browser IDs below come only from this check's status response, not persisted
// state. A healthy daemon alone does not mean an extension can execute commands.
export function planBrowserConnectionRecovery({
  previous = {}, health, status, launchConfigured = false, allowLaunch = true,
  now = Date.now(), policy = {},
} = {}) {
  if (!Number.isFinite(now) || now < 0) throw new Error('连接检查时间无效。');
  const settings = recoveryPolicy(policy);
  const state = {
    checkedAt: now,
    status: 'unknown',
    message: '',
    needsUserAction: false,
    disconnectedSince: timeValue(previous?.disconnectedSince),
    lastAttemptAt: timeValue(previous?.lastAttemptAt),
    lastAttemptDeferred: previous?.lastAttemptDeferred === true,
    lastAttemptError: previous?.lastAttemptError ? shortDiagnostic(previous.lastAttemptError) : null,
    nextDeferredAt: timeValue(previous?.nextDeferredAt),
    attempted: previous?.attempted === true,
    connectedBrowserIds: [],
    unresponsiveBrowserCount: 0,
    nextAttemptAt: null,
  };
  const finish = (connectionStatus, message, needsUserAction = false, action = null) => {
    Object.assign(state, { status: connectionStatus, message, needsUserAction });
    return { state, action };
  };
  if (health?.state !== 'healthy') {
    return finish('daemon_unavailable', 'BrowserSkill 守护进程尚未恢复，暂停浏览器启动尝试。');
  }
  if (!Number.isSafeInteger(status?.pid) || status.pid < 1
    || !Array.isArray(status.browsers) || !Array.isArray(status.sessions)) {
    return finish('unknown', '无法确认浏览器与会话列表，未尝试启动浏览器。', true);
  }
  if (Array.isArray(status.version_skew_browsers) && status.version_skew_browsers.length) {
    return finish('needs_user_action', '浏览器扩展与 BrowserSkill 协议版本不兼容，请更新扩展后重新连接。', true);
  }
  const responsive = status.browsers.filter(browser => typeof browser?.instance_id === 'string'
    && browser.instance_id.trim() && !browser.unresponsive);
  state.connectedBrowserIds = responsive.map(browser => browser.instance_id);
  state.unresponsiveBrowserCount = status.browsers.filter(browser => browser?.unresponsive).length;
  if (responsive.length) {
    state.disconnectedSince = null;
    state.attempted = false;
    state.lastAttemptError = null;
    state.nextDeferredAt = null;
    return finish('connected', responsive.length === 1
      ? '浏览器扩展已连接并响应；发布账号及审批绑定仍须由发布流程核对。'
      : '多个浏览器扩展已连接；操作时须明确选择实例。');
  }
  state.disconnectedSince ??= now;
  if (status.browsers.length) {
    return finish('needs_user_action', state.unresponsiveBrowserCount
      ? '浏览器扩展已连接但无响应；请检查扩展或重启对应浏览器，系统不会结束用户浏览器。'
      : '浏览器列表缺少可用实例标识，请检查扩展连接。', true);
  }
  if (status.sessions.length) {
    return finish('busy', '仍有浏览器会话记录，等待现有任务结束后再检查连接。');
  }
  if (!launchConfigured) {
    return finish('needs_user_action', '尚未配置已验证的现有浏览器启动方式，请打开浏览器并启用 BrowserSkill 本地连接。', true);
  }
  if (state.attempted) {
    if (state.lastAttemptError) return finish('needs_user_action', `浏览器恢复启动失败，需检查配置或手动连接：${state.lastAttemptError}`, true);
    if (state.lastAttemptAt !== null && now - state.lastAttemptAt < settings.connectionWaitMs) {
      return finish('waiting_for_connection', '已尝试启动现有浏览器，正在等待扩展重新连接。');
    }
    return finish('needs_user_action', '已尝试恢复浏览器但扩展仍未连接，请检查 BrowserSkill 扩展开关；不会重复打开窗口。', true);
  }
  if (!allowLaunch) return finish('busy', '存在未完成的任务或无法确认任务状态，暂缓浏览器恢复。');
  const graceEnds = state.disconnectedSince + settings.disconnectGraceMs;
  const cooldownEnds = state.lastAttemptAt === null || state.lastAttemptDeferred ? 0 : state.lastAttemptAt + settings.launchCooldownMs;
  state.nextAttemptAt = Math.max(graceEnds, cooldownEnds, state.nextDeferredAt || 0);
  if (now < state.nextAttemptAt) {
    return finish('waiting_for_connection', cooldownEnds > graceEnds
      ? '浏览器连接恢复处于冷却期，避免反复打开窗口。'
      : '正在等待浏览器扩展自行重新连接。');
  }
  // Persist this reservation before launching. An interrupted owner must not
  // reopen another window merely because the launch result was lost.
  state.lastAttemptAt = now;
  state.attempted = true;
  state.lastAttemptDeferred = false;
  state.lastAttemptError = null;
  state.nextDeferredAt = null;
  state.nextAttemptAt = null;
  return finish('waiting_for_connection', '正在尝试启动已配置的现有浏览器并等待扩展连接。', false, 'launch_browser');
}

// Injected IO keeps the same state machine usable by the real supervisor and
// offline tests. launchBrowser is restricted to the owner's verified existing
// profile; this module neither changes profiles nor runs any page interaction.
export function createBrowserConnectionRecovery({
  loadState = async () => null, saveState, launchBrowser, policy, now = Date.now,
} = {}) {
  if (typeof saveState !== 'function' || typeof launchBrowser !== 'function') {
    throw new Error('浏览器恢复需要持久状态写入器和已验证的启动器。');
  }
  let previous;
  let loaded = false;
  let queue = Promise.resolve();
  async function checkOnce(input = {}) {
    if (!loaded) {
      try {
        previous = await loadState();
        if (previous !== null && (typeof previous !== 'object' || Array.isArray(previous))) throw new Error('恢复状态格式无效。');
        previous ||= {};
        loaded = true;
      } catch (error) {
        return {
          status: 'needs_user_action', needsUserAction: true, connectedBrowserIds: [],
          message: `无法读取浏览器恢复记录，未尝试启动：${shortDiagnostic(error.message)}`,
        };
      }
    }
    const planned = planBrowserConnectionRecovery({ ...input, previous, now: now(), policy });
    // Update memory even if persistence fails, retaining any launch reservation.
    previous = planned.state;
    try { await saveState(previous); }
    catch (error) {
      return { ...previous, status: 'needs_user_action', needsUserAction: true,
        message: `无法保存浏览器恢复记录，未尝试启动：${shortDiagnostic(error.message)}` };
    }
    if (planned.action === 'launch_browser') {
      try {
        const result = await launchBrowser();
        // Only the launcher can attest it stopped before invoking spawn. A
        // thrown error or a lost result never refunds the attempt reservation.
        if (result?.deferred === true) {
          previous = { ...previous, attempted: false, lastAttemptDeferred: true,
            nextDeferredAt: now() + recoveryPolicy(policy).deferredRetryMs,
            status: 'waiting_for_connection', needsUserAction: false,
            message: `浏览器恢复已延后：${shortDiagnostic(result.reason || '等待当前任务或连接检查结束。')}` };
          await saveState(previous);
        }
      }
      catch (error) {
        previous = { ...previous, status: 'needs_user_action', needsUserAction: true,
          lastAttemptError: shortDiagnostic(error.message),
          message: `浏览器恢复启动失败，需检查配置或手动连接：${shortDiagnostic(error.message)}` };
        await saveState(previous).catch(() => {});
      }
    }
    return previous;
  }
  return {
    check(input) {
      const result = queue.then(() => checkOnce(input));
      queue = result.catch(() => {});
      return result;
    },
  };
}
