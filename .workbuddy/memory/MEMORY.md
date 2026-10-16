# D:\ai 抖音运营工作台 — 长期记忆

## B 站发布流程（2026-10-16 固化）

- 用户要求“发到 B 站”“继续 B 站投稿”时，先读 `D:/ai/references/bilibili-publish-flow.md`；不要套用下面的抖音每日队列。项目 `AGENTS.md` 和两个运营技能入口均已链接该流程。
- 本地辅助命令：`node scripts/bilibili-workflow.mjs --help`。依次使用 list/prepare、最终点击前 begin-submit、平台核实后 finish；它只管理记录，不自行点击发布。
- 默认记录 `runtime/bilibili-publish/jobs.json`，保存视频副本、清单摘要、单次提交意图和截图。相同账号相同视频已有有效记录就先核实，submitting/uncertain 不自动重试。
- 当前任务对具体视频、账号、发布动作已有明确授权时继续执行，不重复询问；本流程本身不是对将来所有视频的授权。
- 已归档 B 站实发：账号 Omni_Orange，标题“橘猫捡到发夹跳喵阿里嘎多”，作品 `https://www.bilibili.com/video/BV1z4JD6xEcj/`，平台后台已显示“已发布”。相同成片不再次投稿。历史账号名不能代替当前登录账号检查，浏览器实例每次重新取得。
- 本机实发遇到的恢复与封面细节以流程文档为准。每日无人值守 B 站发布尚未接入，抖音调度与该记录分开。

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

## git 推送须知（2026-10-16 踩坑）
- 本机直连 github.com 被限制（端口 443 超时），git 默认不读系统代理，**必须显式走 Clash 代理**才能 push。
- Clash Verge 的 Mixed Port 在本机实际是 **61471**（非默认 7890）；推送前先设：
  `git config http.proxy http://127.0.0.1:61471` 与 `git config https.proxy http://127.0.0.1:61471`（或用 `$env:http_proxy`/`$env:https_proxy` 临时设）。
- WorkBuddy 沙箱与该机器网络隔离：沙箱内连 GitHub 始终 000（代理出口与直连都不通），**push 必须由用户在本机联网终端执行**。
- 本仓库 `origin` = `https://github.com/qq773901406-cmd/douyin-ops.git`，分支 `main`；推送会连带之前本地未推的 4 个 `wcy` commit。
