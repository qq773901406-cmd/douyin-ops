# DY Publish Flows

本文件拆分并细化「发布链路」的操作步骤，供 `SKILL.md` 按需引用。

## 0. 总览

发布类型：
- 视频（核心）
- 图文（辅助）

三要素（发布前必须齐全）：
1. 封面
2. 标题/文案
3. 正文/视频描述

抖音发布统一通过创作服务平台 creator.douyin.com 进行。

## 1. 视频发布（推荐默认）

### 1.1 普通视频上传

1. 打开 creator.douyin.com 并进入「发布视频」页面
2. 上传视频文件：先将文件复制到 OpenClaw 上传白名单目录，再 `openclaw browser snapshot` 获取上传区域 ref → `openclaw browser act ref=<ref_id> kind=click` 触发文件选择器 → `POST /hooks/file-chooser` 设置文件路径（详见 `dy-openclaw-browser-guide.md` §3）
3. **等待视频上传完成**（进度条到100%，出现封面选择界面）——这是关键等待点
4. 选择/设置封面：
   - 方式A：从视频截取（选择时间帧）
   - 方式B：上传自定义封面图
5. 填写视频标题/文案（建议 <=55 字，前20字为核心展示区）
6. 填写视频描述（正文）
7. 追加话题/标签（点击话题按钮选择，不建议纯文本粘贴 `#话题`）
8. 设置合集（如有需要）
9. 校验三要素后停在发布按钮（待用户确认）

### 1.2 视频上传注意事项

- **上传期间不要操作其他页面元素**：视频文件较大，上传过程占用浏览器资源
- **上传完成后确认封面选择界面出现**：不出现说明上传可能失败
- **视频格式要求**：MP4 / MOV / WebM，建议分辨率 1080P，时长 15s-10min
- **视频大小限制**：Web端一般支持 4GB 以内

### 1.3 视频半程预发（不发布）

满足以下条件即视为"半程预发完成"：
- 视频已上传完成
- 封面已选择/生成
- 已填写标题文案与描述
- 已设置话题
- 仅停在「发布」按钮可见处，未点击发布

注意：半程预发 ≠ 草稿箱保存。若用户要求"草稿/存草稿"，必须继续执行 `references/dy-draft-save-flow.md`。

### 1.4 外部生成封面上传

适用于使用外部工具先生成封面图，再走视频发布的场景。

前置说明（提一句即可）：如未安装生图技能，可先执行 `clawhub install nano-banana-pro`。

1. 先确认封面图已生成（推荐 PNG/JPG，建议 9:16 竖版或 1:1 方版）
2. 将封面图复制到 OpenClaw 上传白名单目录

**跨平台上传路径**：

| 平台 | 上传白名单目录 | 命令示例 |
|---|---|---|
| WSL2 / Linux / macOS | `/tmp/openclaw/uploads` | `cp cover.png /tmp/openclaw/uploads/` |
| Windows（原生） | `%LOCALAPPDATA%\openclaw\uploads`；若被白名单拒绝，实测可用 `D:\openclaw\media\inbound` | `Copy-Item cover.png D:\openclaw\media\inbound\` |
| Windows（WSL2） | `/tmp/openclaw/uploads`（WSL2 内） | `cp cover.png /tmp/openclaw/uploads/` |

3. 文件上传流程（OpenClaw 无 `browser upload` 命令，详见 `dy-openclaw-browser-guide.md` §3）：
   - `openclaw browser snapshot` 获取封面上传区域的 ref
   - `openclaw browser act ref=<ref_id> kind=click` 点击上传区域触发文件选择器
   - `POST /hooks/file-chooser` 设置封面图文件路径
4. 视频上传完成后，在封面选择处选择"上传自定义封面"
5. 上传封面图并确认
6. 继续填写标题、描述、话题
7. 停在发布按钮，等待用户确认

## 2. 图文发布

### 2.1 图文发布流程

1. 进入 creator.douyin.com 选择「图文发布」
2. 上传图片（支持多图，建议 9:16 或 4:3）
3. 填写标题/文案
4. 填写描述
5. 追加话题/标签
6. 校验三要素后停在发布按钮（待用户确认）

### 2.2 图文发布注意

- 抖音图文会以轮播形式展示，建议图片数量 3-9 张
- 第一张图为核心展示图，类似封面作用
- 图文内容适合知识类、清单类、对比类内容

## 3. 常见问题与处理

- 视频上传卡住：检查网络连接和视频文件大小，等待超时后重试一次
- 封面选择界面不出现：可能上传未完成，等待或重新上传
- 标题超限：出现字数超限提示时立刻压缩（前55字为核心，前20字为关键展示区）
- 话题无法添加：优先使用平台推荐话题，不要纯文本粘贴
- 文件上传报错：OpenClaw 无 `browser upload` 命令，需走"复制到白名单目录 → snapshot → act click → POST /hooks/file-chooser"流程（详见 `dy-openclaw-browser-guide.md` §3）
  - 白名单目录：WSL2 / Linux / macOS：`/tmp/openclaw/uploads`
  - Windows 原生：优先 `%LOCALAPPDATA%\openclaw\uploads`；若报 `must stay within inbound media directory`，改用 `D:\openclaw\media\inbound`
- 最后点击发布时报元素失效：先 snapshot 刷新引用；仍失败则提示用户手动点击「发布」
- 创作后台登录态丢失：提示用户扫码登录，不自动重新登录
- 视频审核中提示：发布后视频会进入审核状态，属正常流程，不影响发布完成判定
