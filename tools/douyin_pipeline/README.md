# 豆蜂 · 抖音热点二创视频本地流水线

把「抓热点 → 下载源视频 → 二创重剪 → 发抖音」固化成可复用本地工具。
**零成本**：不依赖剪映会员、不耗 AI 视频积分；配音走 Windows 本机中文语音（离线）。

## 目录结构
```
douyin_pipeline/
├─ make_video.py          # 主合成：源视频 + 口播文案 → 竖屏 9:16 成片
├─ download_source.py     # yt-dlp 下载 B站/抖音源视频 + 预转码 H.264
├─ scripts/
│  └─ dog-justice.json   # 样例脚本配置（小狗追凶案）
└─ README.md
```

## 一次性安装依赖（用 WorkBuddy managed venv）
```powershell
$py = "C:/Users/wuzhuoxuan123/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
& $py -m pip install moviepy Pillow pyttsx3 imageio-ffmpeg yt-dlp
```

## 标准工作流

### 1. 抓热点 + 拿源视频直链
- 用 WebSearch 抓当日热点，或去抖音/B站找当事人原片，拿到**单条视频直链/BV号**。
  （B站批量列表常遇 412 风控，单条直链用浏览器 UA+Referer 可下，见 download_source.py）

### 2. 下载并预转码
```powershell
& $py download_source.py "https://www.bilibili.com/video/BVxxxx" --out-dir D:/ai/runtime/videos/source
```
→ 输出 `source/<id>_h264.mp4`（H.264 竖屏，加速合成）

### 3. 写脚本配置（只改这一份 JSON）
字段：`src`(源视频) / `title`(片头行) / `segments`(口播文案数组) / `endcard`(片尾二创卡) / `out`(输出)
> ⚠️ 必须保留 `endcard.source`（素材来源）与 `endcard.declaration`（二次创作声明），规避搬运判定。

### 4. 合成成片
```powershell
& $py make_video.py --config scripts/dog-justice.json
```
→ 输出竖屏 1080×1920、H.264+AAC 成片，可直接发抖音。

## 发布到抖音
通过已连接的 BrowserSkill（Chrome 扩展）走发布流程：
1. `bsk session start` → 导航 `creator.douyin.com` → `bsk upload` 上传成片
2. `bsk fill` 填标题/话题 → 停在最终「发布」按钮前
3. **展示完整发布内容（视频/标题/话题/二创标注）取得本次确认** → 再 `bsk click` 发布
（写操作按规范须用户确认；登录/验证码由用户本人完成）

## 已知边界
- 配音为系统自带中文嗓音（偏机械）；想更拟人可用剪映免费「文本朗读」换音色，或换接入更好的 TTS。
- 源视频须有使用权（当事人公开稿/已授权），二创需显著标注来源。
- edge-tts（微软云）在本沙箱出网受限，已改用本机 pyttsx3 离线语音。
