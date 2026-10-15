# -*- coding: utf-8 -*-
"""
下载抖音/B站热点源视频（yt-dlp 封装）
====================================
注意：
- B站 列表接口(youtube-dl 批量)常遇 412 风控，但【单条视频】用浏览器 UA + Referer 可下。
- 先用浏览器/搜索拿到单条 BV 号或分享链接，再传入本脚本。
- 下载后建议预转码为 H.264 竖屏（见 pre_transcode 逻辑），可大幅加速合成。

依赖：python -m pip install yt-dlp
"""
import subprocess, sys, os, argparse

PY = sys.executable
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def download(url, out_dir="D:/ai/runtime/videos/source"):
    os.makedirs(out_dir, exist_ok=True)
    cmd = [
        PY, "-m", "yt_dlp",
        "--user-agent", UA,
        "--referer", "https://www.bilibili.com",
        "--no-playlist",
        "-f", "bv*+ba/best",
        "-o", os.path.join(out_dir, "%(id)s.%(ext)s"),
        url,
    ]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)
    return out_dir


def pre_transcode(src, out=None):
    """把源视频（如 HEVC）预转码为 H.264，加速 moviepy 合成。"""
    if out is None:
        out = os.path.splitext(src)[0] + "_h264.mp4"
    ff = os.path.join(os.path.dirname(__file__), "ffmpeg.exe")
    if not os.path.exists(ff):
        # 回退到 imageio_ffmpeg 自带内核
        import imageio_ffmpeg
        ff = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [ff, "-y", "-i", src, "-an", "-c:v", "libx264", "-crf", "22",
           "-preset", "medium", "-pix_fmt", "yuv420p", out]
    subprocess.run(cmd, check=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", help="视频直链（BV/av/分享链接）")
    ap.add_argument("--out-dir", default="D:/ai/runtime/videos/source")
    ap.add_argument("--no-transcode", action="store_true")
    args = ap.parse_args()
    d = download(args.url, args.out_dir)
    if not args.no_transcode:
        for f in os.listdir(d):
            if f.endswith(".mp4") and "_h264" not in f:
                pre_transcode(os.path.join(d, f))
    print("DONE ->", d)


if __name__ == "__main__":
    main()
