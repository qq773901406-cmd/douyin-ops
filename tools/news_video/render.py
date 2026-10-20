"""Offline headline cards. No downloads, article scraping, or model calls."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

WIDTH, HEIGHT = 720, 1280
SHANGHAI = timezone(timedelta(hours=8))
DISCLAIMER = "资讯标题速览·非现场画面"
INK = "#F5F4ED"
MUTED = "#B7C8D7"
ACCENTS = ["#A2F2CD", "#BFC7FF", "#FFCBA8"]


def font_path():
    candidates = [
        os.environ.get("DOUFENG_FONT", ""),
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise ValueError("未找到中文字体，请设置 DOUFENG_FONT。")


def wrapped(text, font, width):
    result, current = [], ""
    for char in text:
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


def fitted(text, path, width, height, maximum, minimum, gap):
    for size in range(maximum, minimum - 1, -2):
        font = ImageFont.truetype(path, size)
        rows = wrapped(text, font, width)
        advance = size + gap
        if rows and len(rows) * advance <= height:
            return font, rows, advance
    raise ValueError("资讯标题或来源名称过长，无法完整、清晰地排入图卡；请减少长标题资讯。")


def draw_rows(draw, rows, origin, font, advance, fill=INK):
    x, y = origin
    for index, row in enumerate(rows):
        draw.text((x, y + index * advance), row, font=font, fill=fill)


def base(day, accent, section):
    canvas = Image.new("RGB", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(canvas)
    top, bottom = (14, 30, 46), (27, 49, 65)
    for y in range(HEIGHT):
        mix = y / (HEIGHT - 1)
        color = tuple(round(a * (1 - mix) + b * mix) for a, b in zip(top, bottom))
        draw.line((0, y, WIDTH, y), fill=color)
    draw.ellipse((430, -210, 990, 350), outline="#34566A", width=2)
    draw.ellipse((485, -155, 935, 295), outline="#34566A", width=2)
    for x in range(48, 673, 24):
        draw.ellipse((x, 1120, x + 3, 1123), fill="#456172")
    small = ImageFont.truetype(font_path(), 23)
    label = ImageFont.truetype(font_path(), 25)
    draw.rounded_rectangle((48, 50, 204, 98), radius=24, fill=accent)
    draw.text((98, 58), "资讯", font=label, fill="#10283A")
    draw.text((48, 124), day.replace("-", "."), font=small, fill=MUTED)
    draw.text((480, 62), section, font=small, fill=MUTED)
    draw.line((48, 1165, 672, 1165), fill="#456172", width=1)
    draw.text((48, 1190), DISCLAIMER, font=small, fill=MUTED)
    return canvas


def intro(day, count, path):
    canvas = base(day, ACCENTS[0], "DAILY BRIEF")
    draw = ImageDraw.Draw(canvas)
    large = ImageFont.truetype(path, 76)
    body = ImageFont.truetype(path, 31)
    small = ImageFont.truetype(path, 25)
    draw.rounded_rectangle((48, 248, 126, 257), radius=4, fill=ACCENTS[0])
    draw.text((48, 300), "今天，", font=large, fill=INK)
    draw.text((48, 406), "看这几条", font=large, fill=INK)
    draw.text((48, 554), f"{count:02d} 条资讯标题", font=body, fill=ACCENTS[0])
    draw.rounded_rectangle((48, 760, 672, 1014), radius=24, fill="#203D50")
    draw.text((76, 798), "公开标题 · 来源可追溯", font=body, fill=INK)
    draw.text((76, 862), "原创信息卡编排", font=small, fill=MUTED)
    draw.text((76, 910), "完整内容请查看说明中的来源链接", font=small, fill=MUTED)
    return canvas


def publish_label(value):
    if not value:
        return "来源发布时间未提供"
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("资讯发布时间需要包含时区。")
    return f"来源发布于 {parsed.astimezone(SHANGHAI):%Y.%m.%d %H:%M}（北京）"


def news_card(item, index, count, day, path):
    accent = ACCENTS[index]
    canvas = base(day, accent, f"{index + 1:02d} / {count:02d}")
    draw = ImageDraw.Draw(canvas)
    number = ImageFont.truetype(path, 74)
    small = ImageFont.truetype(path, 23)
    draw.text((48, 192), f"{index + 1:02d}", font=number, fill=accent)
    draw.line((182, 246, 672, 246), fill="#456172", width=2)
    font, rows, advance = fitted(item["title"], path, 600, 534, 54, 34, 14)
    draw_rows(draw, rows, (48, 326), font, advance)
    draw.rounded_rectangle((48, 908, 672, 1080), radius=22, fill="#203D50")
    source_font, source_rows, source_advance = fitted(
        f"来源：{item['sourceName']}", path, 568, 98, 27, 21, 7
    )
    draw_rows(draw, source_rows, (76, 930), source_font, source_advance, accent)
    draw.text((76, 1038), publish_label(item.get("publishedAt", "")), font=small, fill=MUTED)
    return canvas


def outro(day, count, path):
    canvas = base(day, ACCENTS[1], "SOURCES")
    draw = ImageDraw.Draw(canvas)
    heading = ImageFont.truetype(path, 64)
    body = ImageFont.truetype(path, 30)
    small = ImageFont.truetype(path, 26)
    draw.text((48, 298), "保留来源，", font=heading, fill=INK)
    draw.text((48, 392), "再了解详情", font=heading, fill=INK)
    draw.rounded_rectangle((48, 600, 672, 946), radius=24, fill="#203D50")
    draw.text((78, 638), f"本期 {count:02d} 条标题速览", font=body, fill=ACCENTS[1])
    draw.text((78, 710), "完整来源链接见作品说明", font=body, fill=INK)
    draw.text((78, 790), "本片仅编排来源公开标题", font=small, fill=MUTED)
    draw.text((78, 842), "详情与后续进展以原文为准", font=small, fill=MUTED)
    return canvas


def render(config, destination):
    items = config.get("items")
    day = config.get("day")
    if not isinstance(items, list) or not 1 <= len(items) <= 3:
        raise ValueError("资讯视频需要 1–3 条资讯。")
    if not isinstance(day, str) or datetime.strptime(day, "%Y-%m-%d").strftime("%Y-%m-%d") != day:
        raise ValueError("资讯日期需要是有效的 YYYY-MM-DD。")
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("资讯格式无效。")
        for key, limit in (("title", 160), ("sourceName", 70)):
            if not isinstance(item.get(key), str) or not item[key].strip() or len(item[key]) > limit:
                raise ValueError("资讯标题或来源名称为空或过长。")
    path = font_path()
    out = Path(destination).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        raise ValueError("输出视频已存在，不能覆盖。")
    cards = out.parent / "cards"
    # Keep the original graphics next to input.json and sources.json for review.
    cards.mkdir()
    timeline = [("intro.png", intro(day, len(items), path), 6)]
    timeline.extend(
        (f"news-{index + 1}.png", news_card(item, index, len(items), day, path), 8)
        for index, item in enumerate(items)
    )
    timeline.append(("outro.png", outro(day, len(items), path), 6))
    seconds = sum(duration for _, _, duration in timeline)
    for name, canvas, _ in timeline:
        try:
            with (cards / name).open("xb") as target:
                canvas.save(target, format="PNG")
        finally:
            canvas.close()
    with tempfile.TemporaryDirectory(prefix="frames-", dir=out.parent) as temporary:
        frames = Path(temporary)
        for name, _, _ in timeline:
            shutil.copyfile(cards / name, frames / name)
        # Only generated filenames enter this manifest; source text is never code.
        manifest = "".join(f"file '{name}'\nduration {duration}\n" for name, _, duration in timeline)
        manifest += f"file '{timeline[-1][0]}'\n"
        (frames / "frames.txt").write_text(manifest, encoding="utf-8")
        partial = frames / "render.mp4"
        executable = imageio_ffmpeg.get_ffmpeg_exe()
        # Preserve relative executable overrides when changing the child cwd.
        if Path(executable).is_file():
            executable = str(Path(executable).resolve())
        try:
            subprocess.run([
                executable, "-hide_banner", "-loglevel", "error",
                "-f", "concat", "-safe", "1", "-i", "frames.txt",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-t", str(seconds), "-r", "24", "-c:v", "libx264",
                "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac",
                "-movflags", "+faststart", str(partial),
            ], cwd=frames, check=True, timeout=900, capture_output=True)
        except subprocess.CalledProcessError as error:
            detail = error.stderr.decode("utf-8", errors="replace").strip()[-500:]
            raise ValueError(f"FFmpeg 编码失败：{detail}") from error
        created = False
        try:
            with partial.open("rb") as source, out.open("xb") as target:
                created = True
                shutil.copyfileobj(source, target)
        except Exception:
            if created:
                out.unlink(missing_ok=True)
            raise
    return {"path": str(out), "seconds": seconds, "width": WIDTH, "height": HEIGHT}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    config_path = Path(args.config)
    if config_path.stat().st_size > 64 * 1024:
        raise ValueError("资讯配置超过 64KB。")
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    if not isinstance(config, dict):
        raise ValueError("资讯配置格式无效。")
    print(json.dumps(render(config, args.out), ensure_ascii=False))
