"""Assemble four newly generated moving pet shots with original audible music.

Only Python's standard library and an explicitly supplied FFmpeg are used.
Technical checks measure media properties, not semantic or aesthetic quality.
"""
import argparse
import array
import hashlib
import json
import math
from pathlib import Path
import random
import re
import subprocess
import sys
import wave

RATE = 48000
DURATION = 20
WIDTH, HEIGHT, FPS = 468, 832, 16


def run(ffmpeg, args, binary=False, timeout=180):
    result = subprocess.run([str(ffmpeg), "-hide_banner", "-nostdin", *map(str, args)],
                            capture_output=True, timeout=timeout,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise ValueError("FFmpeg failed: " + result.stderr.decode("utf-8", "replace")[-2000:])
    return result if binary else (result.stdout.decode("utf-8", "replace"), result.stderr.decode("utf-8", "replace"))


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def probe_video(ffmpeg, path):
    output, report = run(ffmpeg, ["-xerror", "-i", path, "-map", "0:v:0", "-an", "-fps_mode", "passthrough", "-progress", "pipe:1", "-f", "null", "-"])
    line = next((line for line in report.splitlines() if "Stream #0:" in line and "Video:" in line), "")
    dimensions = re.search(r"\b(\d{2,5})x(\d{2,5})\b", line)
    fps = re.search(r"([\d.]+) fps", line)
    frames = re.findall(r"^frame=(\d+)\s*$", output, re.M)
    duration = re.search(r"Duration: (\d+):(\d+):([\d.]+)", report)
    if not dimensions or not fps or not frames or not duration:
        raise ValueError("Cannot verify video stream and complete frame decode: " + str(path))
    return {"width": int(dimensions[1]), "height": int(dimensions[2]), "fps": float(fps[1]),
            "frames": int(frames[-1]), "seconds": int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3]), "decoded": True}


def measure_motion(ffmpeg, path):
    result = run(ffmpeg, ["-v", "error", "-xerror", "-i", path, "-t", "5", "-an", "-vf", "fps=2,scale=32:32:flags=area,format=gray", "-f", "rawvideo", "-"], binary=True)
    data = result.stdout
    if len(data) < 9 * 1024 or len(data) % 1024:
        raise ValueError("Not enough decoded motion samples: " + str(path))
    frames = [data[index:index + 1024] for index in range(0, len(data), 1024)]
    changes = [sum(abs(a - b) for a, b in zip(left, right)) / 1024 for left, right in zip(frames, frames[1:])]
    changing = sum(change >= 0.5 for change in changes)
    passed = changing >= max(3, len(changes) // 2) and sum(changes) / len(changes) >= 0.5
    return {"checked": True, "passed": passed, "sampleCount": len(frames), "changingPairs": changing,
            "meanPixelDifference": round(sum(changes) / len(changes), 5),
            "method": "2 fps grayscale frame differences; verifies variation, not semantic motion quality"}


def compose_music(path, seed):
    rng = random.Random(seed)
    scale = [0, 3, 5, 7, 10, 12]
    melody = [60 + rng.choice(scale) for _ in range(40)]
    values = array.array("f")
    for index in range(RATE * DURATION):
        t = index / RATE
        beat = int(t * 2)
        local = t - beat * 0.5
        note = 440 * 2 ** ((melody[beat] - 69) / 12)
        pluck = (math.sin(2 * math.pi * note * local) + .22 * math.sin(4 * math.pi * note * local)) * math.exp(-local * 9) * min(1, local * 180) * .16
        bass = math.sin(2 * math.pi * (65.406 if beat < 20 else 87.307) * local) * math.exp(-local * 7) * .13
        kick = math.sin(2 * math.pi * (45 * local + 1.4 * (1 - math.exp(-local * 35)))) * math.exp(-local * 24) * .28
        hat_local = t % .25
        hat = rng.uniform(-1, 1) * math.exp(-hat_local * 85) * .018
        fade = min(1, t / .1, (DURATION - t) / .35)
        values.append((pluck + bass + kick + hat) * max(0, fade))
    rms = math.sqrt(sum(value * value for value in values) / len(values))
    gain = min(.1 / max(rms, .000001), .85 / max(max(abs(value) for value in values), .000001))
    samples = array.array("h", (int(max(-1, min(1, value * gain)) * 32767) for value in values))
    if sys.byteorder != "little":
        samples.byteswap()
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(samples.tobytes())


def measure_audio(ffmpeg, path):
    result = run(ffmpeg, ["-v", "error", "-xerror", "-i", path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"], binary=True)
    samples = array.array("h")
    samples.frombytes(result.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        raise ValueError("No decoded audio samples")
    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples)) / 32768
    peak = max(abs(sample) for sample in samples) / 32768
    rms_db = 20 * math.log10(max(rms, 1e-12))
    peak_db = 20 * math.log10(max(peak, 1e-12))
    seconds = len(samples) / RATE
    non_silent = rms_db > -45 and peak_db > -25 and abs(seconds - DURATION) <= .15
    return {"decoded": True, "nonSilent": non_silent, "rmsDb": round(rms_db, 3), "peakDb": round(peak_db, 3),
            "seconds": round(seconds, 5), "sampleRate": RATE, "channels": 1,
            "source": "Original code-composed melody, bass and percussion; no external samples or reference audio"}


def assemble(config, ffmpeg):
    if not isinstance(config, dict) or set(config) - {"clips", "output", "duration", "seed"} or config.get("duration") != DURATION:
        raise ValueError("Assembly requires the fixed 20-second configuration")
    if not isinstance(config.get("clips"), list) or len(config["clips"]) != 4:
        raise ValueError("Exactly four newly generated clips are required")
    clips = [Path(path).resolve(strict=True) for path in config["clips"]]
    output = Path(config["output"]).resolve()
    if output.exists() or output in clips:
        raise ValueError("Refusing to overwrite output or source video")
    if not output.parent.is_dir():
        raise ValueError("Output directory must already exist")
    hashes = [sha256(path) for path in clips]
    if len(set(hashes)) != 4:
        raise ValueError("Repeated clips cannot stand in for four new shots")
    measured = [probe_video(ffmpeg, path) for path in clips]
    for metadata in measured:
        if metadata["seconds"] < 5 or metadata["frames"] / metadata["fps"] < 5 or metadata["width"] < WIDTH or metadata["height"] < HEIGHT or metadata["fps"] != FPS:
            raise ValueError("A generated shot is too short or too small; no loops or frame filling are allowed")
    motions = [measure_motion(ffmpeg, path) for path in clips]
    if not all(item["passed"] for item in motions):
        raise ValueError("At least one generated shot has insufficient measured frame movement")
    music = output.parent / "original-music.wav"
    if music.exists():
        raise ValueError("Music already exists; inspect the previous attempt instead of overwriting")
    compose_music(music, int(config.get("seed", 0)))
    filters = [f"[{index}:v]trim=start_frame=0:end_frame={5 * FPS},setpts=PTS-STARTPTS,scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT},setsar=1[v{index}]" for index in range(4)]
    filters.append("[v0][v1][v2][v3]concat=n=4:v=1:a=0[outv]")
    args = ["-v", "error", "-n"]
    for path in clips:
        args += ["-i", path]
    args += ["-i", music, "-filter_complex", ";".join(filters), "-map", "[outv]", "-map", "4:a:0", "-c:v", "libx264",
             "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS), "-fps_mode", "cfr", "-frames:v", str(DURATION * FPS), "-t", str(DURATION),
             "-c:a", "aac", "-b:a", "128k", "-ar", str(RATE), "-movflags", "+faststart", output]
    run(ffmpeg, args)
    video = probe_video(ffmpeg, output)
    if video["frames"] != DURATION * FPS or abs(video["seconds"] - DURATION) > .1 or video["width"] != WIDTH or video["height"] != HEIGHT:
        raise ValueError("Output video duration or dimensions did not pass verification: " + json.dumps(video))
    audio = measure_audio(ffmpeg, output)
    if not audio["nonSilent"]:
        raise ValueError("Output does not contain the expected audible original soundtrack")
    receipt = {"status": "completed", "asset": str(output), "seconds": video["seconds"], "sha256": sha256(output), "video": video,
               "audioVerification": audio, "motionVerification": {"checked": True, "passed": True, "shots": motions, "distinctSourceCount": 4},
               "sourceHashes": hashes, "visualAndListeningReview": "Technical verification only; not a human semantic, visual or listening review"}
    (output.parent / "assembly-verification.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    args = parser.parse_args()
    if not args.ffmpeg.is_file():
        parser.error("FFmpeg executable does not exist")
    config = json.loads(args.config.read_text(encoding="utf-8"))
    print(json.dumps(assemble(config, args.ffmpeg), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
