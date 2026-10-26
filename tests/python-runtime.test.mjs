import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { resolveMediaPython, usablePythonLauncher } from '../lib/python-runtime.mjs';

const projectRoot = 'D:/project', userHome = 'C:/test-user';
const local = join(projectRoot, 'runtime', 'python', 'Scripts', 'python.exe');
const bundled = join(userHome, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');
const cfg = path => join(dirname(dirname(path)), 'pyvenv.cfg');
const options = files => ({ projectRoot, userHome, env: {}, platform: 'win32', exists: path => files.has(path), readText: path => files.get(path) });

test('本地媒体运行时优先于应用供应商venv，显式覆盖仍保持原意', () => {
  const files = new Map([[local, ''], [cfg(local), 'home = C:/stable-python\n'], [join('C:/stable-python', 'python.exe'), ''], [bundled, '']]);
  assert.equal(resolveMediaPython(options(files)), local);
  assert.equal(resolveMediaPython({ ...options(files), env: { DOUFENG_PYTHON: 'C:/chosen/python.exe' } }), 'C:/chosen/python.exe');
});
test('应用升级后残留venv启动器不能掩盖已被删除的base Python', () => {
  const files = new Map([[bundled, ''], [cfg(bundled), 'home = C:/removed/3.13.12\nversion = 3.13.14\n']]);
  assert.equal(usablePythonLauncher(bundled, options(files)), false);
  assert.equal(resolveMediaPython(options(files)), 'python');
  files.set(join('C:/removed/3.13.12', 'python.exe'), '');
  assert.equal(resolveMediaPython(options(files)), bundled);
});
test('缺失或不可读取venv配置不会被当成可用Python', () => {
  const files = new Map([[local, ''], [cfg(local), 'version = 3.13.14\n']]);
  assert.equal(resolveMediaPython(options(files)), 'python');
  assert.equal(usablePythonLauncher(local, { ...options(files), readText: () => { throw new Error('denied'); } }), false);
});
