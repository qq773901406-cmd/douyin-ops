import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from moviepy import VideoFileClip, ImageClip, CompositeVideoClip, vfx

VIDDIR = "D:/ai/runtime/ai_gen/videos"
OUT = os.path.join(VIDDIR, "cat-dance-v2.mp4")
FONT = "C:/Windows/Fonts/simhei.ttf"
W, H = 720, 1280
TARGET_R = W / H
CF = 0.6  # crossfade seconds

# Order: smooth Viggle dance first (hook) -> 5 gesture clips -> end card
names = [
    "viggle-cat-clap.mp4",                                   # Viggle 连贯拍手舞（带动作）
    "The_orange_tabby_cat_wearing_t_2026-10-13T06-19-00.mp4",# 比耶
    "One_paw_on_hip__the_orange_tab_2026-10-13T06-20-22.mp4",# 叉腰
    "Both_paws_drawing_circles_in_t_2026-10-13T06-21-53.mp4",# 画圈
    "Pointing_one_paw_at_the_camera_2026-10-13T06-23-03.mp4",# 指镜头
    "Freezing_in_an_end_pose_with_o_2026-10-13T06-24-58.mp4",# 收尾
]
files = [os.path.join(VIDDIR, n) for n in names]

def norm(path):
    v = VideoFileClip(path).without_audio()
    w, h = v.size
    r = w / h
    if r > TARGET_R:           # too wide -> crop width (center)
        nw = int(h * TARGET_R)
        x1 = (w - nw) // 2
        v = v.cropped(x1=x1, x2=x1 + nw)
    else:                      # too tall -> crop height (center)
        nh = int(w / TARGET_R)
        y1 = (h - nh) // 2
        v = v.cropped(y1=y1, y2=y1 + nh)
    return v.resized((W, H))

clips = [norm(f) for f in files]

# end card
img = Image.new("RGB", (W, H), (10, 10, 14))
d = ImageDraw.Draw(img)
f1 = ImageFont.truetype(FONT, 54)
m1 = "@OmniOrange小橙"
w1 = d.textlength(m1, font=f1)
d.text(((W - w1) / 2, H // 2 - 90), m1, font=f1, fill=(255, 214, 89))
f2 = ImageFont.truetype(FONT, 38)
m2 = "AI萌宠拟人 · 每日整活"
w2 = d.textlength(m2, font=f2)
d.text(((W - w2) / 2, H // 2 - 10), m2, font=f2, fill=(230, 230, 235))
end = ImageClip(np.array(img)).with_duration(2)
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

final = CompositeVideoClip(timeline, size=(W, H)).with_duration(total).without_audio()
final.write_videofile(OUT, codec="libx264", fps=24, audio=False, preset="medium")
print("OK ->", OUT, "duration=%.2fs" % total)
