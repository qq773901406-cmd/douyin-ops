# -*- coding: utf-8 -*-
"""
豆蜂 · 抖音热点二创视频本地生成流水线（固化版）
============================================================
不依赖剪映会员、不耗 AI 积分、纯本地 ffmpeg 合成。
输入：一份脚本配置(JSON) + 一条竖屏源视频(B站/抖音下载)，
输出：可直接发抖音的竖屏 9:16 成片（离线中文配音 + 烧入字幕 + 片头/片尾二创卡）。

依赖（一次性安装，用 managed venv）：
  python -m pip install moviepy Pillow pyttsx3 imageio-ffmpeg

用法：
  python make_video.py --config script.json --out output.mp4
  python make_video.py --src source.mp4 --script-json '{"segments":["...","..."],"title":["...","..."],"endcard":{"handle":"@OmniOrange","follow":"关注我","source":"素材来源：@xxx"}}' --out out.mp4

配置字段说明（script.json）：
  src        源视频路径（必填，建议已预转码为 H.264 竖屏）
  segments   口播文案列表（必填，每段一句，自动生成配音+字幕）
  title      片头标题行列表（可选，默认空=不生成片头卡）
  endcard    片尾卡配置（可选）：{ handle, follow, source, declaration }
  rate       配音语速（可选，默认 190）
  out        输出路径（可选，默认 ./output.mp4）
  font       中文字体路径（可选，默认 C:/Windows/Fonts/simhei.ttf）
"""
import os, json, argparse, numpy as np
from PIL import Image, ImageDraw, ImageFont
import pyttsx3
from moviepy import (ImageClip, VideoFileClip, AudioFileClip, AudioClip,
                     concatenate_videoclips, concatenate_audioclips, CompositeVideoClip)

W, H = 1080, 1920
DEFAULT_FONT = "C:/Windows/Fonts/simhei.ttf"


def make_bg(top=(18, 22, 38), bot=(42, 30, 58)):
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        t = y / H
        r = int(top[0] + (bot[0] - top[0]) * t)
        g = int(top[1] + (bot[1] - top[1]) * t)
        b = int(top[2] + (bot[2] - top[2]) * t)
        for x in range(W):
            px[x, y] = (r, g, b)
    return img


def wrap(text, fnt, maxw):
    lines, cur = [], ""
    for ch in text:
        if ch == "\n":
            lines.append(cur); cur = ""; continue
        if fnt.getlength(cur + ch) > maxw:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def gen_audio(text, path, rate=190):
    e = pyttsx3.init()
    vs = e.getProperty("voices")
    zh = [v for v in vs if ("Chinese" in v.name) or ("zh" in v.id.lower())]
    if zh:
        e.setProperty("voice", zh[0].id)
    e.setProperty("rate", rate)
    e.setProperty("volume", 1.0)
    e.save_to_file(text, path)
    e.runAndWait()


def render_caption(text, font):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    band_h = 340
    d.rectangle([0, H - band_h, W, H], fill=(0, 0, 0, 165))
    fnt = ImageFont.truetype(font, 58)
    lines = wrap(text, fnt, W - 150)
    lh = fnt.getbbox("测")[3] + 16
    y = H - band_h + (band_h - lh * len(lines)) // 2
    for ln in lines:
        w = fnt.getlength(ln)
        d.text(((W - w) / 2, y), ln, font=fnt, fill=(255, 255, 255, 255))
        y += lh
    return img


def render_title(title_lines, font):
    img = make_bg()
    d = ImageDraw.Draw(img)
    tf = ImageFont.truetype(font, 42)
    d.text((60, 90), "热点二创 · 真实事件", font=tf, fill=(255, 170, 90))
    bf = ImageFont.truetype(font, 78)
    for i, ln in enumerate(title_lines):
        w = bf.getlength(ln)
        d.text(((W - w) / 2, 640 + i * 100), ln, font=bf, fill=(246, 246, 250))
    return img


def render_end(endcard, font):
    img = make_bg()
    d = ImageDraw.Draw(img)
    bf = ImageFont.truetype(font, 70)
    lines = wrap(endcard.get("question", "你，能为家人拼一次命吗？"), bf, W - 160)
    lh = bf.getbbox("测")[3] + 20
    y = 700
    for ln in lines:
        w = bf.getlength(ln)
        d.text(((W - w) / 2, y), ln, font=bf, fill=(246, 246, 250)); y += lh
    decl = ImageFont.truetype(font, 30)
    decl_text = endcard.get("declaration",
                            "二次创作声明：本片基于公开新闻重新剪辑与配音，非原作者发布")
    dw = decl.getlength(decl_text)
    d.text(((W - dw) / 2, H - 258), decl_text, font=decl, fill=(255, 200, 120))
    hf = ImageFont.truetype(font, 40)
    d.text((60, H - 185), endcard.get("handle", "@OmniOrange"), font=hf, fill=(185, 195, 215))
    d.text((60, H - 135), endcard.get("follow", "关注我 · 每天一个热点背后的情绪"), font=hf, fill=(150, 160, 185))
    d.text((60, H - 85), endcard.get("source", "素材来源：原作者"), font=ImageFont.truetype(font, 32), fill=(120, 128, 150))
    return img


def silent(duration):
    return AudioClip(lambda t: np.zeros(2, dtype=np.float32), duration=duration, fps=44100)


def build(cfg, out_path):
    font = cfg.get("font", DEFAULT_FONT)
    src = cfg["src"]
    segments = cfg["segments"]
    rate = cfg.get("rate", 190)
    tmp = os.path.join(os.path.dirname(os.path.abspath(out_path)), "_tmp_seg")
    os.makedirs(tmp, exist_ok=True)

    src_clip = VideoFileClip(src, audio=False)
    src_dur = src_clip.duration
    pos = 0.0
    clips, audios = [], []
    for i, text in enumerate(segments):
        ap = os.path.join(tmp, f"seg{i}.wav")
        gen_audio(text, ap, rate)
        a = AudioFileClip(ap)
        d = a.duration
        end = min(pos + d, src_dur)
        v = src_clip.subclipped(pos, end)
        if v.duration < d - 0.05:
            v2 = src_clip.subclipped(0, d - v.duration)
            v = concatenate_videoclips([v, v2])
        cap = ImageClip(np.array(render_caption(text, font))).with_duration(v.duration)
        shot = CompositeVideoClip([v, cap]).with_duration(v.duration)
        clips.append(shot); audios.append(a); pos = end

    parts = []
    aseq = []
    if cfg.get("title"):
        parts.append(ImageClip(np.array(render_title(cfg["title"], font))).with_duration(2.5))
        aseq.append(silent(2.5))
    parts += clips
    aseq += audios
    if cfg.get("endcard", True):
        ec = cfg.get("endcard") if isinstance(cfg.get("endcard"), dict) else {}
        parts.append(ImageClip(np.array(render_end(ec, font))).with_duration(3.0))
        aseq.append(silent(3.0))

    video = concatenate_videoclips(parts, method="compose")
    audio = concatenate_audioclips(aseq)
    final = video.with_audio(audio)
    final.write_videofile(out_path, fps=30, codec="libx264", audio_codec="aac")
    print("SAVED", out_path, "DURATION", round(final.duration, 1), "s")
    # 清理临时音频
    for f in os.listdir(tmp):
        try: os.remove(os.path.join(tmp, f))
        except OSError: pass
    try: os.rmdir(tmp)
    except OSError: pass


def main():
    ap = argparse.ArgumentParser(description="抖音热点二创视频本地生成")
    ap.add_argument("--config", help="脚本配置文件 JSON 路径")
    ap.add_argument("--src", help="源视频路径")
    ap.add_argument("--script-json", help="内联脚本 JSON（与 --config 二选一）")
    ap.add_argument("--out", default="./output.mp4", help="输出路径")
    args = ap.parse_args()

    if args.config:
        with open(args.config, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    elif args.script_json:
        cfg = json.loads(args.script_json)
    else:
        ap.error("需提供 --config 或 --script-json")

    if args.src:
        cfg["src"] = args.src
    if not cfg.get("src"):
        ap.error("配置缺少 src（源视频路径）")
    if not cfg.get("segments"):
        ap.error("配置缺少 segments（口播文案列表）")
    if args.out:
        cfg["out"] = args.out

    build(cfg, cfg.get("out", args.out))


if __name__ == "__main__":
    main()
