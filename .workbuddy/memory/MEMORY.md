# D:\ai 抖音运营工作台 — 长期记忆

## 项目定位
本地抖音运营工作台（豆蜂·WorkBuddy）。发布引擎 = 本地 `server.mjs`（端口 4174）+ `AutomationService` + `douyin-publisher.mjs`（用 BrowserSkill `bsk` 真连 `creator.douyin.com` 上传并提交）。数据：`runtime/workbench.json`；发布收件箱：`runtime/automation-inbox/`。

## 复用指令：发布抖音视频（标准流程）
**触发语（用户说一句即可）**：「发抖音」/「发布 inbox 里的视频」/「帮我发条抖音」→ 即执行以下流程。

**前置（常驻，一般已就绪，否则先起）**：
- 工作台服务跑在 4174：`cd /d/ai && "C:/Program Files/nodejs/node.exe" server.mjs`（用持久后台任务起，避免随 shell 退出）。若 `/api/automation` 报 404，说明跑的是旧 server 实例，需 `taskkill` 掉 4174 占用进程后重启最新 `server.mjs`。
- bsk daemon 长驻（Windows 沙箱不自动拉起，须用 `run_in_background:true` 起 `bsk daemon start --foreground`）。bsk 0.3.2 会话协议：`session start` 前必须先 `session request --prepare <token>`，`douyin-publisher.mjs` 的 `session()` 已补此步。
- chrome 扩展已连（实例 `b31fc78b`），且已在 `creator.douyin.com` 登录抖音号 `138528608`（=Omni Orange）。

**执行步骤**（全部走 `http://127.0.0.1:4174/api/automation`，注意 If-Match 乐观锁拿 revision）：
1. 把待发视频复制到 `D:/ai/runtime/automation-inbox/`（只放这一条，避免旧片段被 scan 入队）。
2. `POST /scan` 把成片入队 → 拿到 item id。
3. `POST /items/<id>/edit` 填标题+文案（默认见下；用户给了则用用户的）。
4. `POST /settings` 设 `folder=inbox, dailyTime=<用户指定或晚间高峰>, browserId=b31fc78b`。
5. `POST /items/<id>/approve`（`reviewed:true, accountId:138528608, scheduledAt=<建议时间>`）。
6. `POST /toggle`（`enabled:true`）→ 调度器到点自动上传+填文案+点发布。

**默认标题/文案/话题**（用户未另给时用）：
- 标题：橘猫捡到发夹跳喵阿里嘎多
- 文案：谁家小猫捡到发夹直接跳起喵阿里嘎多～戴上就停不下来，猫爪一抬整个上头。你家的主子也会这样吗？
- 话题：#喵阿里嘎多 #橘猫 #AI视频 #萌宠跳舞 #热点橙一下

**已知坑（必读，避免重复踩）**：
- bsk 0.3.2 会话协议：`douyin-publisher.mjs` 的 `session()` 已补 `session request --prepare`，否则 connect 报 "request is not prepared"。
- navigate 超时：`douyin-publisher.mjs` 三处 navigate 超时已从 30000→60000（抖音首屏加载偶发卡 30s）。
- **fill 偶发闪退（最常见）**：bsk 会话在"填标题"那步可能掉线（报 "连接或操作失败"），属环境不稳非内容问题。兜底方案：**若自动发布在 fill 失败，让用户手动在抖音网页点最后一下发布即可**（已验证可行）。
- 4174 旧实例：若 `/api/automation` 404，kill 后重启最新 server.mjs。
- 音乐授权：成片配乐若是 Flova 原创 AI 曲，发布前需用户确认接受。

## 上次发布（2026-10-16）
`cat-clip-final.mp4`（橘猫捡发夹·喵阿里嘎多）用户手动发布成功；自动发布在 bsk fill 闪退，条目已 cancel 清理回 pending。
