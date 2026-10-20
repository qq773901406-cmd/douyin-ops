import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from moviepy import VideoFileClip, ImageClip, CompositeVideoClip, TextClip, AudioFileClip, vfx

VID = "D:/ai/runtime/ai_gen/videos"
BGM = "D:/ai/runtime/ai_gen/bgm/flova_meow.mp3"
OUT = "D:/ai/runtime/ai_gen/videos/cat-clip-final.mp4"
FONT = "C:/Windows/Fonts/simhei.ttf"
W, H = 720, 1280
CF = 0.4  # crossfade seconds

# 8 镜顺序 + 每镜字幕（按最终分镜：猫爪动作版）
clips_info = [
    ("橘色虎斑小猫站在温暖室内木地板上_低头看脚边地上的一个粉色蝴_2026-10-16T01-41-58.mp4", "嗯？谁的发夹？"),
    ("橘色虎斑小猫蹲下身子_伸出毛茸茸的猫爪轻轻夹起掉在木地板上的_2026-10-15T13-46-08.mp4", "试戴一下？"),
    ("橘色虎斑小猫用猫爪把粉色蝴蝶结发夹别在头侧耳边_松开爪子后开_2026-10-16T01-41-53.mp4", "戴上就…停不下来！"),
    ("橘色虎斑小猫把双爪做成毛茸茸的猫爪状举到耳朵旁边_开心地左右_2026-10-16T01-41-47.mp4", "喵～阿里嘎多！"),
    ("橘色虎斑小猫用毛茸茸的猫爪做可爱抓挠动作_同时左右点胯扭动身_2026-10-16T01-44-05.mp4", "这发夹有点上头"),
    ("橘色虎斑小猫双手比成猫耳形状放在头顶_然后在胸前画出一个爱心_2026-10-16T01-44-11.mp4", ""),
    ("Pointing_one_paw_at_the_camera_2026-10-13T06-23-03.mp4", "就你啦！"),
    ("Freezing_in_an_end_pose_with_o_2026-10-13T06-24-58.mp4", ""),
]


def norm(path):
    v = VideoFileClip(path).without_audio()
    w, h = v.size
    r = w / h
    if r > W / H:                      # too wide -> crop width (center)
        nw = int(h * W / H)
        x1 = (w - nw) // 2
        v = v.cropped(x1=x1, x2=x1 + nw)
    else:                              # too tall -> crop height (center)
        nh = int(w * H / W)
        y1 = (h - nh) // 2
        v = v.cropped(y1=y1, y2=y1 + nh)
    return v.resized((W, H))


clips = []
for fn, sub in clips_info:
    v = norm(os.path.join(VID, fn))
    if sub:
        t = (TextClip(text=sub, font=FONT, font_size=42, color="white",
                      stroke_color="black", stroke_width=3)
             .with_duration(v.duration)
             .with_position(("center", H - 130)))
        v = CompositeVideoClip([v, t])
    clips.append(v)

# 片尾卡：@OmniOrange小橙 关注我看更多
img = Image.new("RGB", (W, H), (10, 10, 14))
d = ImageDraw.Draw(img)
f1 = ImageFont.truetype(FONT, 56)
m1 = "@OmniOrange小橙"
w1 = d.textlength(m1, font=f1)
d.text(((W - w1) / 2, H // 2 - 110), m1, font=f1, fill=(255, 214, 89))
f2 = ImageFont.truetype(FONT, 40)
m2 = "关注我看更多"
w2 = d.textlength(m2, font=f2)
d.text(((W - w2) / 2, H // 2 - 20), m2, font=f2, fill=(235, 235, 240))
f3 = ImageFont.truetype(FONT, 30)
m3 = "AI萌宠拟人 · 每日整活"
w3 = d.textlength(m3, font=f3)
d.text(((W - w3) / 2, H // 2 + 50), m3, font=f3, fill=(180, 180, 190))
end = ImageClip(np.array(img)).with_duration(3)
clips.append(end)

# timeline with crossfades
n = len(clips)
starts = [0.0]
for i in range(1, n):
    starts.append(starts[i - 1] + clips[i - 1].duration - CF)
total = starts[-1] + clips[-1].duration

timeline = []
for i, c in enumerate(clips):
    seg = c.with_start(starts[i])
    if i > 0:
        seg = seg.with_effects([vfx.CrossFadeIn(CF)])
    timeline.append(seg)

final = CompositeVideoClip(timeline, size=(W, H)).with_duration(total)
audio = AudioFileClip(BGM).subclipped(0, total)
final = final.with_audio(audio)
final.write_videofile(OUT, codec="libx264", audio_codec="aac", fps=24, preset="medium")
print("OK ->", OUT, "duration=%.2fs" % total)
