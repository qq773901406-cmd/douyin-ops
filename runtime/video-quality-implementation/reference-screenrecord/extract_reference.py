from pathlib import Path
import io
import json
import re
import subprocess
from PIL import Image, ImageDraw

source = Path(r"C:\Users\wuzhuoxuan123\Documents\xwechat_files\wxid_gbq8zkj8rzzz22_e8e9\temp\RWTemp\2026-10\7862ffef91a8052235e6d609875abfe3\3ed48dd30d3c24c9e365c07614aa3724.mp4")
out = Path(__file__).parent
ffmpeg = Path(r"D:\ai\.codex_tmp\video-deps\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe")
probe = subprocess.run([str(ffmpeg), "-hide_banner", "-i", str(source)], capture_output=True)
info = probe.stderr.decode("utf-8", errors="replace")
match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", info)
duration = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
times = list(range(int(duration) + 1))
frames = []
for time in times:
    result = subprocess.run([str(ffmpeg), "-v", "error", "-ss", str(time), "-i", str(source), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True, check=True)
    frame = Image.open(io.BytesIO(result.stdout)).convert("RGB")
    path = out / f"frame-{time:02d}s.jpg"
    frame.save(path, quality=95)
    frames.append({"seconds": time, "path": str(path), "dimensions": list(frame.size)})
for page in range((len(frames) + 11) // 12):
    sheet = Image.new("RGB", (4 * 216, 3 * (480 + 28)), "#202020")
    draw = ImageDraw.Draw(sheet)
    for i, item in enumerate(frames[page * 12:(page + 1) * 12]):
        frame = Image.open(item["path"])
        frame.thumbnail((216, 480))
        x, y = (i % 4) * 216, (i // 4) * 508
        sheet.paste(frame, (x, y))
        draw.text((x + 6, y + 484), f"{item['seconds']:02d}s", fill="white")
    sheet.save(out / f"contact-{page + 1}.jpg", quality=93)
metadata = {"source": str(source), "duration_seconds": duration, "probe": info, "frames": frames}
(out / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"duration_seconds": duration, "frame_count": len(frames), "output": str(out)}, ensure_ascii=False))
