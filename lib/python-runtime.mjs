import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// A Windows venv's python.exe can still exist after its base installation was
// removed by an updater. Check its recorded home before choosing that launcher.
export function usablePythonLauncher(executable, { platform = process.platform, exists = existsSync, readText = path => readFileSync(path, 'utf8') } = {}) {
  if (!exists(executable)) return false;
  const venvConfig = join(dirname(dirname(executable)), 'pyvenv.cfg');
  if (!exists(venvConfig)) return true;
  try {
    const home = readText(venvConfig).match(/^home\s*=\s*(.+)$/m)?.[1].trim();
    if (!home) return false;
    return platform === 'win32' ? exists(join(home, 'python.exe'))
      : exists(join(home, 'python3')) || exists(join(home, 'python'));
  } catch { return false; }
}

export function resolveMediaPython({ projectRoot, env = process.env, platform = process.platform, userHome = homedir(), exists = existsSync, readText } = {}) {
  // Explicit user configuration must fail visibly rather than silently select
  // another environment with different media dependencies.
  if (env.DOUFENG_PYTHON) return env.DOUFENG_PYTHON;
  const options = { platform, exists, ...(readText ? { readText } : {}) };
  const local = join(projectRoot, 'runtime', 'python', platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python');
  if (usablePythonLauncher(local, options)) return local;
  const bundled = join(userHome, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');
  if (platform === 'win32' && usablePythonLauncher(bundled, options)) return bundled;
  return 'python';
}
