import glob, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from moviepy import VideoFileClip, ImageClip, concatenate_videoclips

VIDDIR = "D:/ai/runtime/ai_gen/videos"
OUT = "D:/ai/runtime/ai_gen/videos/cat-dance-final.mp4"
FONT = "C:/Windows/Fonts/simhei.ttf"
W, H = 720, 1280

# 5 段按时间顺序（比耶→叉腰→画圈→指镜头→收尾）
names = [
    "The_orange_tabby_cat_wearing_t_2026-10-13T06-19-00.mp4",
    "One_paw_on_hip__the_orange_tab_2026-10-13T06-20-22.mp4",
    "Both_paws_drawing_circles_in_t_2026-10-13T06-21-53.mp4",
    "Pointing_one_paw_at_the_camera_2026-10-13T06-23-03.mp4",
    "Freezing_in_an_end_pose_with_o_2026-10-13T06-24-58.mp4",
]
files = [os.path.join(VIDDIR, n) for n in names]
print("segments:")
for f in files:
    print("  ", os.path.basename(f), os.path.exists(f))

clips = []
for f in files:
    v = VideoFileClip(f).resized((W, H))
    clips.append(v)

# 片尾卡 2s
img = Image.new("RGB", (W, H), (10, 10, 14))
d = ImageDraw.Draw(img)
f1 = ImageFont.truetype(FONT, 54)
msg1 = "@OmniOrange小橙"
w1 = d.textlength(msg1, font=f1)
d.text(((W - w1) / 2, H // 2 - 90), msg1, font=f1, fill=(255, 214, 89))
f2 = ImageFont.truetype(FONT, 38)
msg2 = "AI萌宠拟人 · 每日整活"
w2 = d.textlength(msg2, font=f2)
d.text(((W - w2) / 2, H // 2 - 10), msg2, font=f2, fill=(230, 230, 235))
end = ImageClip(np.array(img)).with_duration(2)
clips.append(end)

final = concatenate_videoclips(clips, method="chain")
final.write_videofile(OUT, codec="libx264", fps=24, audio=False)
print("OK ->", OUT)
