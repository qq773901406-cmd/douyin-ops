# -*- coding: utf-8 -*-
"""二创重剪：B站源视频(1080x1920竖屏) + 真实事实口播(pyttsx3离线中文) + 烧入字幕 + 片头片尾卡。
不依赖剪映、不耗积分、纯本地 ffmpeg 合成。输出竖屏 9:16，可直接发抖音。"""
import os, numpy as np
from PIL import Image, ImageDraw, ImageFont
import pyttsx3
from moviepy import ImageClip, VideoFileClip, AudioFileClip, AudioClip, concatenate_videoclips, concatenate_audioclips, CompositeVideoClip

FONT = "C:/Windows/Fonts/simhei.ttf"
W, H = 1080, 1920
TMP = "D:/ai/runtime/videos"
SRC = "D:/ai/runtime/videos/source/papi_source_h264.mp4"
OUT = "D:/ai/runtime/videos/erchuang-dog-justice.mp4"

# (口播文案) — 基于真实新闻事实
segments = [
    "北京，一名男子用沾了毒药的鸡肉，毒死了小区里九条宠物狗。",
    "狗主人李女士，为了讨回公道，辞了工作，自学法律，追了整整三年——1185天。",
    "为什么这么较真？她说：狗，是我二分之一的生命。这只狗，陪了她十三年。",
    "更让人心碎的是，有邻居家雪纳瑞被毒死，第二天，狗主人的父亲就因伤心过度走了。",
    "直到电梯里偶遇，对方还叫嚣：“不就是毒死你一条狗吗？”——他根本没当回事。可对李女士，那是被毒杀的家人。",
    "如今一审落槌，张某某被判四年。她说，要把狗的骨灰做成项链，戴一辈子。你，能为家人拼一次命吗？评论区聊聊。",
]

def make_bg(top=(18, 22, 38), bot=(42, 30, 58)):
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        t = y / H
        r = int(top[0] + (bot[0]-top[0])*t)
        g = int(top[1] + (bot[1]-top[1])*t)
        b = int(top[2] + (bot[2]-top[2])*t)
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

def gen_audio(text, path):
    e = pyttsx3.init()
    vs = e.getProperty("voices")
    zh = [v for v in vs if ("Chinese" in v.name) or ("zh" in v.id.lower())]
    if zh:
        e.setProperty("voice", zh[0].id)
    e.setProperty("rate", 190)
    e.setProperty("volume", 1.0)
    e.save_to_file(text, path)
    e.runAndWait()

def render_caption(text):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    band_h = 340
    d.rectangle([0, H-band_h, W, H], fill=(0, 0, 0, 165))
    fnt = ImageFont.truetype(FONT, 58)
    lines = wrap(text, fnt, W - 150)
    lh = fnt.getbbox("测")[3] + 16
    y = H - band_h + (band_h - lh*len(lines)) // 2
    for ln in lines:
        w = fnt.getlength(ln)
        d.text(((W-w)/2, y), ln, font=fnt, fill=(255, 255, 255, 255))
        y += lh
    return img

def render_title():
    img = make_bg()
    d = ImageDraw.Draw(img)
    tf = ImageFont.truetype(FONT, 42); d.text((60, 90), "热点二创 · 真实事件", font=tf, fill=(255, 170, 90))
    bf = ImageFont.truetype(FONT, 78)
    for i, ln in enumerate(["北京首例毒杀宠物狗案", "她辞职追凶1185天"]):
        w = bf.getlength(ln); d.text(((W-w)/2, 640 + i*100), ln, font=bf, fill=(246, 246, 250))
    sf = ImageFont.truetype(FONT, 40); d.text((60, H-120), "一个把狗当家人的女人，和她的三年", font=sf, fill=(200, 205, 220))
    return img

def render_end():
    img = make_bg()
    d = ImageDraw.Draw(img)
    bf = ImageFont.truetype(FONT, 70)
    lines = wrap("你，能为家人拼一次命吗？", bf, W-160)
    lh = bf.getbbox("测")[3] + 20
    y = 700
    for ln in lines:
        w = bf.getlength(ln); d.text(((W-w)/2, y), ln, font=bf, fill=(246, 246, 250)); y += lh
    # 二次创作声明（规避搬运判定）
    decl = ImageFont.truetype(FONT, 30)
    decl_text = "二次创作声明：本片基于公开新闻重新剪辑与配音，非原作者发布"
    dw = decl.getlength(decl_text); d.text(((W-dw)/2, H-258), decl_text, font=decl, fill=(255, 200, 120))
    hf = ImageFont.truetype(FONT, 40)
    d.text((60, H-185), "@OmniOrange 小橙", font=hf, fill=(185, 195, 215))
    d.text((60, H-135), "关注我 · 每天一个热点背后的情绪", font=hf, fill=(150, 160, 185))
    d.text((60, H-85), "素材来源：@西高地Papi妈妈（B站）", font=ImageFont.truetype(FONT, 32), fill=(120, 128, 150))
    return img

src = VideoFileClip(SRC, audio=False)
src_dur = src.duration
pos = 0.0
clips, audios = [], []
for i, text in enumerate(segments):
    ap = f"{TMP}/_seg{i}.wav"
    gen_audio(text, ap)
    a = AudioFileClip(ap)
    d = a.duration
    end = min(pos + d, src_dur)
    v = src.subclipped(pos, end)
    if v.duration < d - 0.05:
        v2 = src.subclipped(0, d - v.duration)
        v = concatenate_videoclips([v, v2])
    cap = ImageClip(np.array(render_caption(text))).with_duration(v.duration)
    shot = CompositeVideoClip([v, cap]).with_duration(v.duration)
    clips.append(shot); audios.append(a); pos = end

title = ImageClip(np.array(render_title())).with_duration(2.5)
endc = ImageClip(np.array(render_end())).with_duration(3.0)
sil_s = AudioClip(lambda t: np.zeros(2, dtype=np.float32), duration=2.5, fps=44100)
sil_e = AudioClip(lambda t: np.zeros(2, dtype=np.float32), duration=3.0, fps=44100)

video = concatenate_videoclips([title] + clips + [endc], method="compose")
audio = concatenate_audioclips([sil_s] + audios + [sil_e])
final = video.with_audio(audio)
final.write_videofile(OUT, fps=30, codec="libx264", audio_codec="aac")
print("SAVED", OUT, "DURATION", round(final.duration, 1), "s")
