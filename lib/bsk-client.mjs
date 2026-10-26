// Shared BrowserSkill CLI client.
// Previously duplicated across douyin-publisher.mjs and browser-skill-adapter.mjs
// (binary resolution, JSON parsing, and the exec wrapper were near-identical and
// had already drifted: e.g. session-start timeout was 60000 in one, 70000 in the
// other). Centralising them removes the duplication and makes the many timeouts
// auditable instead of scattered magic numbers.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserActivity } from './browser-activity.mjs';

const execFileAsync = promisify(execFile);

// Single source of truth for the BrowserSkill CLI location.
export function resolveBskBinary() {
  if (process.env.BSK_BIN) return process.env.BSK_BIN;
  if (process.platform === 'win32') {
    const userInstall = join(homedir(), '.local', 'bin', 'bsk.exe');
    if (existsSync(userInstall)) return userInstall;
  }
  return 'bsk';
}

// The CLI often prints banners/blank lines around its JSON payload, so fall back
// to the last line that looks like an object.
export function parseBskJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch {}
  const line = value.split(/\r?\n/).reverse().find(item => item.trim().startsWith('{'));
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}

// Named timeouts so the many magic numbers at the call sites are auditable.
// Values are preserved from the original code. A few of them drift between the
// publisher and the adapter (e.g. session-start 60000 vs 70000) — they are kept
// distinct on purpose until someone reconciles them intentionally.
export const BSK_TIMEOUTS = {
  DEFAULT_MS: 30000,
  // Local status can spend ~5s on CLI housekeeping even with a responsive
  // daemon. Match the supervisor probe budget instead of timing out at 5s.
  STATUS_MS: 8000,
  DOCTOR_MS: 15000,
  SESSION_REQUEST_MS: 15000,
  SESSION_START_PUBLISHER_MS: 60000,
  SESSION_START_ADAPTER_MS: 70000,
  SESSION_STOP_MS: 15000,
  CANCEL_MS: 10000,
  EVALUATE_MS: 20000,
  NAVIGATE_PUBLISHER_MS: 70000,
  NAVIGATE_ADAPTER_MS: 70000,
  UPLOAD_MS: 620000,
  WAIT_PAGE_MS: 30000,
  WAIT_UPLOAD_MS: 600000,
  CLICK_MS: 30000,
  SUCCESS_MS: 45000,
  TOKEN_TTL_MS: 2 * 60000,
};

// Unified CLI contract: always resolves to { ok, code, message, stdout, stderr }.
// The publisher (throws on failure) and the adapter (returns a flag) both use it.
export async function runBsk(args, { timeout = BSK_TIMEOUTS.DEFAULT_MS, json = true } = {}) {
  let release;
  let result;
  try {
    release = await acquireBrowserActivity(process.env.DOUFENG_DATA_DIR || fileURLToPath(new URL('../runtime', import.meta.url)));
    const finalArgs = json && !args.includes('--json') ? [...args, '--json'] : args;
    const { stdout, stderr } = await execFileAsync(resolveBskBinary(), finalArgs, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, BSK_AUTO_START: '0' } });
    result = { ok: true, code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
    return result;
  } catch (error) {
    result = {
      ok: false,
      code: error.code === 'ENOENT' ? 'BSK_NOT_FOUND' : (error.code || 'BSK_ERROR'),
      message: error.code === 'ENOENT'
        ? '未检测到 BrowserSkill CLI。请安装腾讯 BrowserSkill，并在 Chrome 或 Edge 扩展中启用本地连接。'
        : (error.stderr || error.message || 'BrowserSkill 调用失败。').trim(),
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || '').trim(),
    };
    return result;
  } finally {
    // Cleanup must never turn a completed page command into an apparent failed
    // command. In particular, a successful submit must retain its real result.
    if (release) await release().catch(() => { if (result) result.cleanupError = '浏览器执行锁清理失败，请检查后台恢复状态。'; });
  }
}
