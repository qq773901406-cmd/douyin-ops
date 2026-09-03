# DY 运行规则（引用自技能主文）

## 0.1 低 token 与快照约束

- 优先 `evaluate`，减少无意义 dump 与重复抓取。

- 只在关键节点做快照：登录确认、到发布页、填写完成、发布前停顿。

- 避免 `fullPage`（除用户要求整页归档）；重复调用优先复用同一 `targetId`。

- 每个动作最多重试 1 次；第二次失败改稳健路径并汇报。

- 记录关键证据：账号名、页面状态、按钮可见、字数等，返回可执行信号。

## 0.2 浏览器稳定规则（最高优先）

- 默认仅用内置浏览器：`profile="openclaw"`。

- 每次动作前先确认会话目标 tab（`openclaw browser start --browser-profile openclaw` 后再 `openclaw browser navigate` / `openclaw browser snapshot`）。

- 若出现 `no tab is connected`、`profile "chrome"` 等异常，立刻切回 `openclaw` 并重试。

- 连续 2 次点击/导航失败后改稳健路径（如直达点击改为 evaluate+定位），不做盲重试。

## 3.5 搜索并浏览（核心约束）

1. 仅从搜索结果页点击进入视频，禁止直接 `navigate` 到 `douyin.com/video/<id>`。
2. 默认跳过本账号作者内容（避免自刷）。
3. 进入后先校验：不是 404、可见评论/互动信息、可识别标题或作者。
4. 进入方式优先点卡片本体，避免点头像/作者名导致跳错。
5. 若评论控件为 `contenteditable` 或 `div[contenteditable]`，需先触发 input 事件再发送。
6. 两条点击失败或 404 后返回搜索页换下一条，不对同链接直跳重试。
7. 抖音搜索页有"视频/用户/直播/商品"多个tab，默认搜索"视频"tab。

## 6.0 回放与降级

- 若搜索结构变化先 snapshot 更新 selector 再继续，不盲跑旧路径。

- 关键页（创作页、搜索页、用户页）尽量复用已打开 tab，不重复 `open`。

- 先告诉用户"已达异常节点"，避免无意义继续操作导致误发。

- 发布页关键动作（切 tab、上传、点击发布）失败时：

  1. 先 snapshot 刷新 ref
  2. 同动作最多再试 1 次
  3. 仍失败则切稳健路径（同义入口/用户手动最后一击）

- 视频详情页抓取封面时，优先从视频元素截取或从 meta 标签获取封面 URL，不依赖播放器截图。

- 抓取后要做一次人工核对：检查封面 URL 是否与视频实际封面一致。不一致则重新抓取。

- 图生图产物需要做"相似度体感检查"：若用户反馈元素过于雷同，切换到 style-only 提示词并重生，不争辩。

- 涉及文件上传时，OpenClaw 不提供 `browser upload` 命令，改用标准上传流程（详见 `dy-openclaw-browser-guide.md` §3）：将文件复制到白名单目录 → `openclaw browser snapshot` 获取上传区域 ref → `openclaw browser act ref=<ref_id> kind=click` 触发文件选择器 → `POST /hooks/file-chooser` 设置文件路径。白名单目录：WSL2/Linux/macOS：`/tmp/openclaw/uploads`；Windows 原生：`%LOCALAPPDATA%\openclaw\uploads`（若被拒绝改用 `D:\openclaw\media\inbound`）。

- SSRF 策略：OpenClaw 有 SSRF 防护，需确保 `www.douyin.com` 和 `creator.douyin.com` 在允许列表中。如果 `openclaw browser navigate` 或 `openclaw browser evaluate` 被拦截，检查 OpenClaw 的 `ssrfPolicy` 配置。

- 抖音视频上传是大文件操作，上传期间不要做其他页面操作，避免浏览器卡顿导致上传失败。

