# -*- coding: utf-8 -*-
"""免费合成 42 秒口播叙事成片：edge-tts 中文配音 + PIL 文字卡 + 小狗 AI 镜头 + ffmpeg 合成。
不依赖剪映、不耗积分。竖屏 9:16 (1080x1920)，适配抖音。"""
import os, numpy as np
from PIL import Image, ImageDraw, ImageFont
import pyttsx3
from moviepy import ImageClip, VideoFileClip, AudioFileClip, concatenate_videoclips, concatenate_audioclips, CompositeVideoClip

FONT = "C:/Windows/Fonts/simhei.ttf"
W, H = 1080, 1920
OUT = "D:/ai/runtime/videos/dog-justice-42s.mp4"
DOG = "D:/ai/runtime/videos/Cinematic_close_up_of_a_small__2026-10-13T02-15-05.mp4"
TMP = "D:/ai/runtime/videos"

# (口播文案, 是否用小狗镜头)
segments = [
    ("北京，一名男子用沾了毒药的鸡肉，毒死了小区里九条宠物狗。", True),
    ("狗主人李女士，为了讨回公道，辞了工作，自学法律，追了整整三年——1185天。", False),
    ("为什么这么较真？她说：狗，是我二分之一的生命。这只狗，陪了她十三年。", False),
    ("更让人心碎的是，有邻居家雪纳瑞被毒死，第二天，狗主人的父亲就因伤心过度走了。", False),
    ("直到电梯里偶遇，对方还叫嚣：“不就是毒死你一条狗吗？”——他根本没当回事。可对李女士，那是被毒杀的家人。", False),
    ("如今一审落槌，张某某被判四年。她说，要把狗的骨灰做成项链，戴一辈子。你，能为家人拼一次命吗？评论区聊聊。", False),
]

def make_bg():
    img = Image.new("RGB", (W, H))
    px = img.load()
    top, bot = (18, 22, 38), (42, 30, 58)
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

def render_card(text):
    img = make_bg()
    d = ImageDraw.Draw(img)
    fnt = ImageFont.truetype(FONT, 74)
    lines = wrap(text, fnt, W - 160)
    lh = fnt.getbbox("测")[3] + 26
    y = (H - lh*len(lines)) // 2
    for ln in lines:
        w = fnt.getlength(ln)
        d.text(((W-w)/2, y), ln, font=fnt, fill=(246, 246, 250))
        y += lh
    tf = ImageFont.truetype(FONT, 40)
    d.text((60, 70), "热点二创 · 情绪落点", font=tf, fill=(255, 170, 90))
    bf = ImageFont.truetype(FONT, 36)
    d.text((60, H-110), "@OmniOrange 小橙", font=bf, fill=(185, 195, 215))
    d.text((60, H-66), "关注我 · 每天一个热点背后的情绪", font=bf, fill=(150, 160, 185))
    return img

def render_caption_overlay(text):
    """透明 RGBA 图层：底部字幕带，叠在小狗镜头上。"""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    band_h = 300
    d.rectangle([0, H-band_h, W, H], fill=(0, 0, 0, 150))
    fnt = ImageFont.truetype(FONT, 64)
    lines = wrap(text, fnt, W - 140)
    lh = fnt.getbbox("测")[3] + 18
    y = H - band_h + (band_h - lh*len(lines)) // 2
    for ln in lines:
        w = fnt.getlength(ln)
        d.text(((W-w)/2, y), ln, font=fnt, fill=(255, 255, 255, 255))
        y += lh
    return img

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

clips, audios = [], []
for i, (text, isdog) in enumerate(segments):
    ap = f"{TMP}/_seg{i}.wav"
    gen_audio(text, ap)
    a = AudioFileClip(ap)
    dur = a.duration
    audios.append(a)
    if isdog:
        v0 = VideoFileClip(DOG).resized(height=1920)
        vw = v0.size[0]
        x1 = max(0, (vw - W)//2)
        v0 = v0.cropped(x1=x1, y1=0, x2=x1+W, y2=1920).with_duration(dur)
        cap = ImageClip(np.array(render_caption_overlay(text))).with_duration(dur)
        shot = CompositeVideoClip([v0, cap]).with_duration(dur)
    else:
        shot = ImageClip(np.array(render_card(text))).with_duration(dur)
    clips.append(shot)

video = concatenate_videoclips(clips, method="compose")
audio = concatenate_audioclips(audios)
final = video.with_audio(audio)
final.write_videofile(OUT, fps=24, codec="libx264", audio_codec="aac")
print("SAVED", OUT)
print("DURATION", round(final.duration, 1), "s")
