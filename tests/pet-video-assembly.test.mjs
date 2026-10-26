import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { productVideoPython } from '../server/product-video.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../tools/pet_video/assemble.py', import.meta.url));
const code = `import importlib.util,json,sys
from pathlib import Path
import imageio_ffmpeg
spec=importlib.util.spec_from_file_location('pet_assembly',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=Path(sys.argv[2]);ffmpeg=Path(imageio_ffmpeg.get_ffmpeg_exe())
static=root/'static.mp4'
module.run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=orange:s=480x832:r=16:d=5','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',static])
static_motion=module.measure_motion(ffmpeg,static)
assert static_motion['passed'] is False
clips=[]
for i in range(4):
 path=root/f'moving-{i}.mp4'
 module.run(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=s=480x832:r=16:d=5','-vf',f'hue=h={i*35}','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',path])
 clips.append(str(path))
config={'clips':clips,'output':str(root/'video.mp4'),'duration':20,'seed':42}
receipt=module.assemble(config,ffmpeg)
assert receipt['seconds']==20
assert receipt['audioVerification']['nonSilent'] is True
assert receipt['motionVerification']['passed'] is True
try:
 module.assemble(config,ffmpeg)
 raise AssertionError('must not overwrite existing media')
except ValueError as e:
 assert 'overwrite' in str(e)
try:
 module.assemble({'clips':[clips[0]]*4,'output':str(root/'duplicate.mp4'),'duration':20},ffmpeg)
 raise AssertionError('must not repeat clips')
except ValueError as e:
 assert 'Repeated' in str(e)
silent=root/'silent.wav'
module.run(ffmpeg,['-v','error','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','20',silent])
assert module.measure_audio(ffmpeg,silent)['nonSilent'] is False
print(json.dumps({'staticRejected':not static_motion['passed'],'receipt':receipt,'silentRejected':True}))`;

test('真实FFmpeg组装四镜二十秒，检查可听音轨与运动，并拒绝静帧、静音、重复及覆盖', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pet-assembly-'));
  t.after(async () => { const actual = resolve(directory); assert.ok(actual.startsWith(resolve(tmpdir()) + sep)); await rm(actual, { recursive: true, force: true }); });
  let result;
  try { result = await execute(productVideoPython(), ['-c', code, script, directory], { windowsHide: true, timeout: 110000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } }); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('本机未安装 Python。'); return; } throw error; }
  const verified = JSON.parse(result.stdout);
  assert.equal(verified.staticRejected, true); assert.equal(verified.silentRejected, true);
  assert.equal(verified.receipt.video.frames, 320); assert.equal(verified.receipt.motionVerification.shots.length, 4);
  assert.ok(verified.receipt.audioVerification.rmsDb > -45); assert.ok(verified.receipt.audioVerification.seconds >= 19.9);
});
