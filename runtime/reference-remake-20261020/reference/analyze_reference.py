import json
import subprocess
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

SOURCE = Path(r"C:\Users\wuzhuoxuan123\Documents\xwechat_files\wxid_gbq8zkj8rzzz22_e8e9\temp\RWTemp\2026-10\7862ffef91a8052235e6d609875abfe3\3ed48dd30d3c24c9e365c07614aa3724.mp4")
DEST = Path(__file__).resolve().parent
FRAMES = DEST / "frames"
FRAMES.mkdir(parents=True, exist_ok=True)
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
reader = imageio_ffmpeg.read_frames(str(SOURCE))
metadata = next(reader)
reader.close()
probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(SOURCE)], capture_output=True, text=True, encoding="utf-8", errors="replace")
(DEST / "ffmpeg-probe.txt").write_text(probe.stderr, encoding="utf-8")
times = [round(i * 2.5, 2) for i in range(10) if i * 2.5 < metadata["duration"]]
records = []
for index, seconds in enumerate(times):
    frame = FRAMES / f"frame-{index:02d}-{seconds:05.2f}s.png"
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-n", "-ss", str(seconds),
        "-i", str(SOURCE), "-frames:v", "1", "-an", str(frame),
    ], check=True, capture_output=True)
    records.append({"timeSeconds": seconds, "path": str(frame)})

thumb_w, thumb_h, caption_h, gap = 288, 640, 30, 16
cols, rows = 5, 2
sheet = Image.new("RGB", (cols * (thumb_w + gap) + gap, rows * (thumb_h + caption_h + gap) + gap), "#151922")
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 21)
for index, record in enumerate(records):
    x = gap + (index % cols) * (thumb_w + gap)
    y = gap + (index // cols) * (thumb_h + caption_h + gap)
    with Image.open(record["path"]) as picture:
        thumb = picture.convert("RGB")
        thumb.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
        sheet.paste(thumb, (x + (thumb_w - thumb.width) // 2, y))
    draw.text((x + 6, y + thumb_h + 3), f'{record["timeSeconds"]:05.2f}s', fill="white", font=font)
contact = DEST / "reference-contact-sheet.jpg"
sheet.save(contact, quality=94)
metadata.update({
    "source": str(SOURCE), "bytes": SOURCE.stat().st_size, "frames": records,
    "contactSheet": str(contact),
})
(DEST / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(metadata, ensure_ascii=False, indent=2))
