import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

test('WinExe浏览器启动器可编译；参数受限且不创建新的用户配置', { skip: process.platform !== 'win32' }, async t => {
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  try { await access(compiler); } catch { t.skip('需要本机 .NET Framework 编译器'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'doufeng-browser-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'BrowserLaunchTests.cs');
  const executable = join(directory, 'BrowserLaunchTests.exe');
  await writeFile(source, `using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;
internal static class BrowserLaunchTests {
  private static int Main(string[] args) {
    var json = new JavaScriptSerializer();
    try {
      if (args[0] == "--quote") { Console.Write(json.Serialize(BackgroundServiceHost.Quote(args[1]))); return 0; }
      var config = json.Deserialize<Dictionary<string, object>>(args[0]);
      Console.Write(json.Serialize(new {ok=true,args=BackgroundServiceHost.BrowserLaunchArguments(config)}));
    } catch(Exception error) { Console.Write(json.Serialize(new {ok=false,error=error.Message})); }
    return 0;
  }
}`);
  await execute(compiler, ['/nologo', '/target:exe', '/main:BrowserLaunchTests',
    `/reference:${join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'System.Web.Extensions.dll')}`,
    `/out:${executable}`, join(root, 'scripts', 'background-service-host.cs'), source], { windowsHide: true });
  const validate = async value => JSON.parse((await execute(executable, [JSON.stringify(value)], { windowsHide: true })).stdout);
  assert.equal((await validate({})).ok, false);
  assert.equal((await validate({ browserLaunch: { executable: process.execPath, profileDirectory: 'Default' } })).ok, false);
  assert.equal((await validate({ browserLaunch: { executable: 'chrome.exe', profileDirectory: 'Default' } })).ok, false);
  const chrome = join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
  let installed = true;
  try { await access(chrome); await access(join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default')); }
  catch { installed = false; }
  if (installed) {
    const checked = await validate({ browserLaunch: { executable: chrome, profileDirectory: 'Default' } });
    assert.deepEqual(checked, { ok: true, args: [chrome, '--profile-directory=Default'] });
    for (const profileDirectory of ['../Default', 'Default --remote-debugging-port=9222', 'Default\n', 'Profile 999999999']) {
      assert.equal((await validate({ browserLaunch: { executable: chrome, profileDirectory } })).ok, false);
    }
  }
  const quoted = JSON.parse((await execute(executable, ['--quote', 'C:\\path with spaces\\'], { windowsHide: true })).stdout);
  assert.equal(quoted, '"C:\\path with spaces\\\\"');
  // Compile the exact shipping WinExe entry point too; the harness never calls
  // LaunchBrowser/CreateProcess and cannot launch the user's actual browser.
  const shipping = join(directory, 'ShippingHost.exe');
  await execute(compiler, ['/nologo', '/target:winexe',
    `/reference:${join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'System.Web.Extensions.dll')}`,
    `/out:${shipping}`, join(root, 'scripts', 'background-service-host.cs')], { windowsHide: true });
  assert.ok((await readFile(shipping)).length > 0);
});
