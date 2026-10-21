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
  STATUS_MS: 5000,
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
  try {
    const finalArgs = json && !args.includes('--json') ? [...args, '--json'] : args;
    const { stdout, stderr } = await execFileAsync(resolveBskBinary(), finalArgs, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      code: error.code === 'ENOENT' ? 'BSK_NOT_FOUND' : (error.code || 'BSK_ERROR'),
      message: error.code === 'ENOENT'
        ? '未检测到 BrowserSkill CLI。请安装腾讯 BrowserSkill，并在 Chrome 或 Edge 扩展中启用本地连接。'
        : (error.stderr || error.message || 'BrowserSkill 调用失败。').trim(),
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || '').trim(),
    };
  }
}
