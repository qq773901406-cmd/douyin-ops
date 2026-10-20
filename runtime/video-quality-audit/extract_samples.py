from pathlib import Path
import subprocess, re, json, io
from PIL import Image, ImageDraw

root = Path(r"D:\ai")
folder = root / "runtime/ai_gen/videos"
out = root / "runtime/video-quality-audit"
ffmpeg = root / ".codex_tmp/video-deps/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe"
files = [folder / "cat-clip-final.mp4", folder / "cat-dance-v2.mp4"]
files += sorted(folder.glob("*2026-10-16*.mp4"))
metadata = []
for idx, file in enumerate(files):
    probe = subprocess.run([str(ffmpeg), "-hide_banner", "-i", str(file)], capture_output=True)
    info = probe.stderr.decode("utf-8", errors="replace")
    match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", info)
    duration = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
    count = 16 if idx < 2 else 5
    times = [(duration - 0.15) * i / (count - 1) for i in range(count)]
    cols = 4 if idx < 2 else 5
    thumb_w, thumb_h = (216, 384)
    rows = (count + cols - 1) // cols
    sheet = Image.new("RGB", (cols * thumb_w, rows * (thumb_h + 28)), "#202020")
    draw = ImageDraw.Draw(sheet)
    for j, time in enumerate(times):
        r = subprocess.run([str(ffmpeg), "-v", "error", "-ss", f"{time:.3f}", "-i", str(file), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True, check=True)
        image = Image.open(io.BytesIO(r.stdout)).convert("RGB")
        if j == 0:
            size = image.size
        image.thumbnail((thumb_w, thumb_h))
        x, y = (j % cols) * thumb_w, (j // cols) * (thumb_h + 28)
        sheet.paste(image, (x + (thumb_w - image.width) // 2, y))
        draw.text((x + 5, y + thumb_h + 6), f"{idx:02} / {time:.2f}s", fill="white")
    sheet_path = out / f"{idx:02}-{file.stem[-35:]}-contact.jpg"
    sheet.save(sheet_path, quality=92)
    entry = {"id": idx, "file": str(file), "duration": duration, "dimensions": size, "sheet": str(sheet_path), "probe": info}
    metadata.append(entry)
    print(json.dumps({k: v for k, v in entry.items() if k != "probe"}, ensure_ascii=False), flush=True)
(out / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
