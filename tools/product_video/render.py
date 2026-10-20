"""Offline product slideshow. Only uses supplied pictures and text; no model calls."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont, ImageOps
import imageio_ffmpeg

WIDTH, HEIGHT = 720, 1280
MAX_IMAGE_PIXELS = 40_000_000


def load_product_image(path):
    with Image.open(path) as source:
        if source.width * source.height > MAX_IMAGE_PIXELS:
            raise ValueError("商品图片分辨率过大。")
        # Decode all pixels and apply the same conversion used by rendering.
        return ImageOps.exif_transpose(source).convert("RGB")


def check_images(paths):
    if not isinstance(paths, list) or len(paths) > 20 or any(not isinstance(path, str) for path in paths):
        raise ValueError("图片检查需要不超过 20 个本地图片路径。")
    results = []
    for path in paths:
        try:
            with load_product_image(path):
                pass
            results.append({"ok": True})
        except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as error:
            results.append({"ok": False, "error": f"图片无法解码或不符合尺寸要求：{error}"[:300]})
    return {"images": results}


def font_path():
    candidates = [os.environ.get("DOUFENG_FONT", ""),
                  "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
                  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise ValueError("未找到中文字体，请设置 DOUFENG_FONT。")


def lines(text, font, width):
    result, current = [], ""
    for char in str(text):
        if char == "\n":
            result.append(current)
            current = ""
        elif current and font.getlength(current + char) > width:
            result.append(current)
            current = char
        else:
            current += char
    if current:
        result.append(current)
    return result


def render(config, destination):
    pictures = config.get("images", [])
    title = str(config.get("title", "")).strip()
    if not title or len(title) > 80 or not 1 <= len(pictures) <= 6:
        raise ValueError("需要 1–6 张商品图和不超过 80 字的标题。")
    path = font_path()
    heading = ImageFont.truetype(path, 38)
    body = ImageFont.truetype(path, 32)
    small = ImageFont.truetype(path, 22)
    title_lines = lines(title, heading, WIDTH - 96)
    if len(title_lines) > 3:
        raise ValueError("商品标题太长，请缩短后再合成。")
    caption = str(config.get("caption", "")).strip() or "商品介绍 · 具体规格请查看商品资料"
    if len(caption) > 500:
        raise ValueError("视频字幕不能超过 500 字。")
    captions = lines(caption, body, WIDTH - 96)
    pages = [captions[i:i + 4] for i in range(0, len(captions), 4)] or [[""]]
    count = max(3, len(pictures), len(pages))
    if count > 10:
        raise ValueError("字幕过长，请精简后再合成。")
    out = Path(destination).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        raise ValueError("输出视频已存在，不能覆盖。")
    with tempfile.TemporaryDirectory(prefix="frames-", dir=out.parent) as temporary:
        frames = Path(temporary)
        for index in range(count):
            canvas = Image.new("RGB", (WIDTH, HEIGHT), "#101f1b")
            draw = ImageDraw.Draw(canvas)
            draw.text((48, 38), "每日好物 · 商品介绍", font=small, fill="#b6e5c9")
            for row, line in enumerate(title_lines):
                draw.text((48, 88 + row * 49), line, font=heading, fill="white")
            with load_product_image(pictures[index % len(pictures)]) as source:
                picture = ImageOps.contain(source, (624, 620))
                canvas.paste(picture, ((WIDTH - picture.width) // 2, 285 + (620 - picture.height) // 2))
            draw.rounded_rectangle((32, 940, 688, 1180), radius=20, fill="#203c31")
            for row, line in enumerate(pages[index % len(pages)]):
                draw.text((48, 965 + row * 46), line, font=body, fill="white")
            draw.text((48, 1220), "商品图片展示 · 非实拍测评", font=small, fill="#b6c9bf")
            draw.text((605, 1220), f"{index + 1}/{count}", font=small, fill="#b6c9bf")
            canvas.save(frames / f"frame-{index:02d}.png")
        # The concat manifest contains only generated filenames, never user text.
        duration = 6
        manifest = "".join(f"file 'frame-{i:02d}.png'\nduration {duration}\n" for i in range(count))
        manifest += f"file 'frame-{count - 1:02d}.png'\n"
        (frames / "frames.txt").write_text(manifest, encoding="utf-8")
        partial = frames / "render.mp4"
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error",
                        "-f", "concat", "-safe", "1", "-i", "frames.txt",
                        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                        "-t", str(duration * count), "-r", "24", "-c:v", "libx264",
                        "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac",
                        "-movflags", "+faststart", str(partial)], cwd=frames,
                       check=True, timeout=900, capture_output=True)
        # Exclusive destination creation; an existing video is never replaced.
        with partial.open("rb") as source, out.open("xb") as target:
            import shutil
            shutil.copyfileobj(source, target)
    return {"path": str(out), "seconds": duration * count, "width": WIDTH, "height": HEIGHT}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--check-images", action="store_true")
    parser.add_argument("--config")
    parser.add_argument("--out")
    args = parser.parse_args()
    if args.check:
        ImageFont.truetype(font_path(), 32)
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-version"],
                       check=True, timeout=10, capture_output=True)
        print(json.dumps({"ok": True}))
    elif args.check_images:
        print(json.dumps(check_images(json.load(sys.stdin)), ensure_ascii=False))
    else:
        if not args.config or not args.out:
            parser.error("需要 --config 和 --out，或使用 --check 检查环境。")
        print(json.dumps(render(json.loads(Path(args.config).read_text(encoding="utf-8-sig")), args.out), ensure_ascii=False))
