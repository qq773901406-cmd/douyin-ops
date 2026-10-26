import { mayStopOwnedChild, shortDiagnostic } from './background-service-policy.mjs';

const result = (action, reason, extra = {}) => ({ action, reason, ...extra });

/**
 * Run one recovery attempt after the caller's stall/grace/cooldown policy.
 * Callbacks must not retry: stopChild(child, service) confirms the exact child's
 * close with true; startChild(service) updates the supervisor's child ownership.
 */
export async function recoverOwnedBrowser({ service, acquireGuard, acquireMaintenance, probe, stopChild, startChild, log = async () => {} } = {}) {
  const releases = [];
  let outcome, stopAttempted = false, stopped = false, startAttempted = false, started = false;
  const owns = child => mayStopOwnedChild(service) && service.process === child && service.lastHealthyPid === child.pid;
  const attempt = async () => {
    if (!service || [acquireGuard, acquireMaintenance, probe, stopChild, startChild, log].some(fn => typeof fn !== 'function')) return result('blocked', '恢复回调或服务配置不完整，未操作进程。');
    const guard = await acquireGuard(service);
    if (!guard?.ok) return result('blocked', shortDiagnostic(guard?.reason || '业务执行权尚未释放，暂不恢复。'));
    if (typeof guard.release !== 'function') return result('blocked', '业务恢复锁缺少释放方法，未操作进程。');
    releases.push({ name: '业务恢复锁', release: () => guard.release() });
    const maintenance = await acquireMaintenance(service);
    if (!maintenance?.ok) return result('blocked', shortDiagnostic(maintenance?.reason || '浏览器仍有活动命令，暂不恢复。'));
    if (typeof maintenance.release !== 'function') return result('blocked', '浏览器维护锁缺少释放方法，未操作进程。');
    releases.push({ name: '浏览器维护锁', release: () => maintenance.release() });

    // Probe only after both fences are held. A timeout observed before the
    // fences may already have recovered or belong to a different process now.
    const current = await probe(service);
    if (current?.state === 'healthy') {
      service.health = current;
      service.stallCount = 0; service.stalledSince = null;
      return result('none', '复查已恢复响应，无需重启。');
    }
    const child = service.process;
    if (current?.state !== 'unknown' || current.recoverable !== true || !owns(child)) return result('blocked', '复查状态或进程身份已变化，保留进程等待下次检查。');
    if (service.name === 'browser' && service.lastSessionCount !== 0) return result('blocked', '无法确认浏览器会话已经结束，暂不恢复。');

    await log({ event: 'recovery-stop', service: service.name, pid: child.pid });
    // Logging is asynchronous; preserve the ownership check immediately before
    // passing the captured child to the only stopping callback.
    if (!owns(child)) return result('blocked', '恢复前进程所有权已变化，未停止任何进程。');
    service.lastRecoveryAt = Date.now();
    stopAttempted = true;
    stopped = await stopChild(child, service) === true;
    if (!stopped) return result('blocked', '自有进程尚未确认退出，未启动第二个实例。');
    // A callback/event may have installed a replacement while waiting for close.
    // Never launch a second child even when the old child's close was confirmed.
    if (mayStopOwnedChild(service)) return result('blocked', '已有存活的自有进程，未启动第二个实例。');
    startAttempted = true;
    await startChild(service);
    started = true;
    await log({ event: 'recovery-start', service: service.name, pid: service.process?.pid ?? null });
    return result('restarted', '已恢复空闲的自有进程；原发布回执及计划保持不变。', { at: new Date().toISOString() });
  };
  try { outcome = await attempt(); }
  catch (error) { outcome = result('blocked', `恢复步骤未确认完成，未自动重试：${shortDiagnostic(error?.message || error)}`); }
  finally {
    const cleanupErrors = [];
    for (const entry of releases.reverse()) {
      try { await entry.release(); }
      catch (error) { cleanupErrors.push(`${entry.name}：${shortDiagnostic(error?.message || error)}`); }
    }
    if (cleanupErrors.length) {
      outcome = result('blocked', `${outcome?.reason || '恢复未完成。'} 锁清理失败，需要检查后继续。`, { cleanupFailed: true, cleanupErrors });
    }
  }
  return { ...outcome, stopAttempted, stopped, startAttempted, started };
}
