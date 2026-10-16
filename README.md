# 豆蜂 · WorkBuddy 抖音运营工作台

这是面向个人使用的本地内容与电商运营工作台，当前版本 **4.1.1**。商品研究、账号定位、视频制作记录、发布排期、复盘和备份都保存在自己的电脑。可选连接 WorkBuddy Skill、MCP Connector 和腾讯 BrowserSkill。

## 个人版快速开始

1. 本机需要 Node.js **20.11 或更新版本**，无需安装 npm 依赖。
2. 双击项目目录的 **`start.cmd`**。它会启动本地服务并在默认浏览器打开工作台。
3. 首次使用打开“账号与设置”填写账号名称，再开始选题或制作视频。
4. 日常在“总览”查看待发布、逾期和待复盘内容；在“数据管理”备份和恢复。

`start.cmd` 默认从 4174–4184 选择可用端口，重复运行会打开同目录已启动的服务。服务在后台运行，关闭浏览器不会停止服务。日志位于数据目录 `logs/`。如需前台运行和用 Ctrl+C 退出，可执行 `npm run serve`。

## v4.1：整合电商选品项目

### v4.1.1 稳定性修复

- 日报导入只采用明确的单一金额；区间价格、负数和带备注的价格留空待核实，空白单元格不再误读为备注列。
- 实时利润校验所有费用与比例；商品保存验证实际日期及完整货源链接。
- 图文准备仅复用同平台、同商品、未发布的图文草稿，保留视频草稿。
- 素材移除、下拉选择和恢复中的编辑也会触发关闭提醒；发生商品版本冲突时可另存新商品。
- 商品图片先检查能否解码；上传接口检查图片类型和 20MB 限制。
- 修复 IPv6 本机访问、地址别名及错误请求的状态码；启动器提示仍在运行的旧版本服务。

### 使用流程

已将 [shop-dropshipping-automation](https://github.com/qq773901406-cmd/shop-dropshipping-automation) 的日报约定、价格表解析、商品卡片和多平台草稿流程接入同一个工作台。来源版本与适配范围见 `integrations/shop-dropshipping/upstream.json`。

1. 左侧打开 **电商选品**，点击“导入日报目录”，选择原项目的 `output`、某个日期目录或单个商品目录。也可直接“录入商品”。
2. 导入前预览商品、报告和图片数量；相同日期与名称的商品跳过，保留已有手工修改。
3. 打开“资料 / 成本”，填写同一币种的售价、采购成本、运费和平台费率，按需补充包装、广告和退货预留。
4. 生成 1080×1080 商品卡片或选品汇总 PNG，下载或保存到本机素材。
5. “准备发布”可分别创建抖音、小红书、B站、微博、知乎、Instagram、Facebook、YouTube 社区草稿，继续在发布计划中编辑、检查和排期。
6. “转为视频项目”将商品、目标观众和原始脚本带入制作台；“研究任务单”可交给 WorkBuddy 继续完善。

商品资料共用全局搜索、自动备份、导入导出和回收站。首次使用不填充虚构商品；GitHub 仓库不包含被忽略的历史 output，已有日报需由用户选择本机目录导入。

原项目的自动发布、浏览器登录、定时任务、图片搜索下载和企业微信推送未在本版执行或启用。现有接入以本地研究、素材制作和发布准备为范围；导出文案与素材清单的 JSON 是交接数据，不是上游 CLI 参数文件。详细格式和边界见 `integrations/shop-dropshipping/README.md`。

## v4.0 基础能力

- 待办总览：今日待发布、逾期计划、制作受阻、待复盘和近期内容。
- 发布计划：列表 / 月历、日期和状态筛选、草稿编辑、CSV 导出、发布前检查。时间按本机时区显示，排期本身不执行自动发布。
- 内容库：分类、全文搜索、分页、编辑记录与 CSV 导出。Ctrl / ⌘ + K 可搜索整个工作区。
- 数据管理：手动备份、最近 30 个自动快照、导入和恢复前的数量对比、恢复前保护备份。
- 回收站：选题、项目、草稿和运营记录删除后可恢复；永久删除需再次确认。
- 输入暂存：常用表单在切换页面和刷新时保留；关闭标签页后不保证保留未提交内容，请及时保存。
- 离线字体、移动端布局、可键盘操作的弹窗、表单校验和错误提示。

本版保留现有业务数据。首次修改时写入 schemaVersion 5，为旧工作区补充空的 products 集合，同时保存修改前快照。导入比当前软件更新的数据版本会被拒绝，缺失或重复记录编号也会提示修复。升级后请重启本地服务及正在运行的 MCP 进程。

## 已实现能力

- 账号五维诊断与账号画像
- 推荐流研究与对标样本记录
- 原创选题、钩子和脚本草稿
- 视频制作台：分镜、制作提示词、费用约束、进度与成片归档
- 爆款结构拆解与原创检查
- 发布素材、封面、文案和话题清单
- 评论回复草稿
- 播放、完播、互动和涨粉复盘
- 本地知识库、JSON 导入导出与持久化
- 保存状态提示、未同步备份恢复、网页与 MCP 的版本冲突保护
- WorkBuddy MCP 工具读写以上数据
- WorkBuddy 回采计划
- 腾讯 BrowserSkill 的状态、会话、导航和页面观察

评论发送、点赞、关注、资料修改和最终发布属于外部写操作。WorkBuddy Skill 会在执行前展示具体内容并请求本次确认。登录、扫码和验证码由用户接管。

## 目录

```text
D:\ai
├─ index.html / app.css / app.js     可视化工作台
├─ product.css / dashboard.js        个人版界面与待办总览
├─ shop-workspace.js / shop.css       商品管理、成本估算与内容流转
├─ shop-import.js / shop-cards.js     日报目录导入与本地 PNG 卡片
├─ integrations/shop-dropshipping/   上游版本信息与整合说明
├─ content-library.js                内容检索、编辑、全局搜索
├─ publish-planner.js                草稿编辑与发布月历
├─ data-center.js                    备份、导入预览与回收站
├─ workspace-ui.js / legacy-pages.js  共用组件与专用业务表单
├─ start.cmd / scripts/              一键启动与静态检查
├─ video-studio.js                   视频制作项目与分镜编辑
├─ state-sync.js                     保存队列、冲突提示与浏览器恢复
├─ media-service.mjs                 素材上传与支持拖动进度的视频预览
├─ server.mjs                        本地服务与持久化 API
├─ browser-skill-adapter.mjs         腾讯 BrowserSkill 本地状态与只读预览
├─ SKILL.md                          WorkBuddy 运营 Skill
├─ references/                       运营和浏览器参考资料
├─ runtime/                          工作区数据与素材（不提交 Git）
└─ workbuddy/
   ├─ buddy-app.preview.json         Buddy 应用录入与预览草案
   └─ connector/
      ├─ connector-meta.json
      ├─ mcp.json
      ├─ mcp-server.mjs
      ├─ lib/                        网页与 MCP 共用的数据模型和原子存储
      ├─ icon.svg
      └─ skills/douyin-ops/
```

## 启动可视化工作台

```powershell
Set-Location D:\ai
node server.mjs
```

打开 `http://127.0.0.1:4174/`。如果端口被占用：

```powershell
$env:PORT=4175
node server.mjs
```

升级后需要重启本地 Node 服务和 WorkBuddy 中的 MCP 进程，再刷新工作台。新版页面需要服务端返回数据版本，旧服务无法接收新版保存请求。请通过本地服务打开页面，ES 模块不支持直接双击 HTML 使用。

HTTP 服务只监听本机地址，默认 `127.0.0.1`。个人版无需注册或登录，不提供公网部署或多人权限管理。

源码静态语法检查可执行 `npm run check`。该命令只检查 JavaScript 语法，不执行功能测试。

自动化回归执行 `npm test`：使用 Node 内置测试器，在 `.codex_tmp/` 创建独立数据目录，覆盖商品与日报、MCP、HTTP、媒体、冲突、备份和恢复，不写入正式 `runtime`。本次 31 项通过。浏览器实测已完成商品保存与重新加载、非法费用提示、卡片生成保存及中英文草稿创建；目录选择和关闭确认框受浏览器自动化连接阻塞，未记作端到端通过。

## 视频制作流程

1. 打开“视频制作台”，新建项目或选择“小猫跳舞模板”；也可以在选题卡片上选择“转为视频项目”。
2. 编辑主角、场景、画幅和分镜。总时长根据各分镜自动计算。
3. 记录计划使用的工具、预计费用与费用策略。价格未知时留空，不会当作免费。
4. 保存项目，复制提示词或导出 TXT 制作单，交给选择的生成或剪辑工具。
5. 有问题时标记“遇到问题”并填写原因；取得成片后填写路径或链接，标记“已完成”。
6. 点击“准备发布”，补充封面、文案、话题并更新草稿。同一项目重复点击会打开已有草稿。

### 编辑与查找

- 支持按名称、角色、场景、制作工具和备注搜索，并按状态筛选、按最近更新 / 名称 / 时长排序。搜索和筛选不会重置正在填写的表单。
- “复制项目”会把分镜带入编辑区，重置制作状态、成片路径、阻碍原因和预计费用，保存后才创建新项目。
- 分镜支持上移、下移和复制，并显示各镜头在整条视频中的时间段。
- 输入内容会暂存在当前标签页的 `sessionStorage`，刷新后可恢复；只有点击“保存制作项目”或 Ctrl / ⌘ + S，才加入工作区并同步。关闭标签页后不保证恢复未提交表单，重要内容请保存或导出。
- 恢复的表单若对应较旧版本或已删除的项目，会阻止直接覆盖；可重新打开最新项目，或“另存为新项目”。另存会保留当前表单内容，包括填写的成片路径。
- “预览提示词”可检查完整制作说明。剪贴板权限不足时会打开可手动复制的文本窗口。

### 成片上传与预览

- 制作表单支持选择 MP4、WebM、MOV 成片上传到本地工作区，显示上传进度并可取消。上传后填入实际文件路径，仍需保存项目进行归档。
- 已上传的文件可在页内播放和拖动进度。仅开放工作台 `uploads` 目录内的文件，其他本地路径作为文本保留；HTTP(S) 成片链接通过按钮在新页打开。
- MOV 和部分编码能否播放取决于浏览器，无法预览时可先转换为兼容的 MP4。删除项目不会删除素材文件或已有发布草稿。

本项目管理制作流程，不内置视频生成模型，也不自动调用付费服务或提交发布。费用由操作者填写，工作台不检查外部链接的可用性或实际报价。

WorkBuddy 可通过 `workspace_get` 的 `videos` 集合读取项目，使用 `video_project_save` 保存、`video_project_prompt` 获取提示词。更新项目须带上读取时的 `updatedAt` 作为 `expectedUpdatedAt`，防止覆盖较新的修改。

## 安装到 WorkBuddy

项目根目录的 `.mcp.json` 已声明 `doufeng-douyin-ops`，从 `D:\ai` 打开 WorkBuddy/CodeBuddy 项目时可以直接发现本地 MCP Server。也可以把以下目录作为正式 Connector 包上传：

1. 在 WorkBuddy 开放平台创建 Skill，上传根目录 `SKILL.md` 与 `references`，或上传 `workbuddy/connector/skills/douyin-ops`。
2. 创建 MCP Connector，上传 `workbuddy/connector`。它采用官方推荐的 `stdio + Node 20` 配置。
3. 安装腾讯 `BrowserSkill`，在 WorkBuddy 中安装 `browser-skill`，并在 Chrome 或 Edge 扩展中启用本地连接。
4. 在开放平台创建 Buddy 应用，参考 `workbuddy/buddy-app.preview.json` 录入 3 个工作模式和 7 个场景。
5. 将 `douyin-ops`、`doufeng-douyin-ops` 和 `browser-skill` 绑定到 Buddy 应用后预览调试，再提交审核。

Buddy 应用 ID、模型 ID、授权配置与发布审核由 WorkBuddy 开放平台生成，不能写死在本地项目中。

## BrowserSkill

Windows 安装与 WorkBuddy Skill 接入：

```powershell
irm https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1 | iex
bsk install-skill --harness workbuddy --json
```

WorkBuddy/CodeBuddy 会管理子进程，BrowserSkill 守护进程需要用独立终端保持运行：

```powershell
$env:BSK_AUTO_START='0'
bsk daemon start --foreground
```

保持该终端打开，在另一个终端检查：

```powershell
$env:BSK_AUTO_START='0'
bsk status --json
bsk doctor
```

浏览器扩展连接后，本地工作台的“WorkBuddy 接入”页面可启动会话、打开抖音、观察页面和结束会话。浏览器显示登录按钮时，需要用户本人扫码或登录；验证码和账号凭据不进入本项目。完整网页交互由 WorkBuddy 中的 `browser-skill` 执行。

## MCP 本地验证

MCP Server 默认与本项目共用 `D:\ai\runtime`。本地 HTTP 服务和 MCP 都支持通过 `DOUFENG_DATA_DIR` 指定数据目录；相对路径以进程工作目录为基准，建议两边配置同一个绝对路径。Connector 安装到其他位置且找不到项目 runtime 时，默认使用用户目录下 `.doufeng-workbuddy`。

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' | node workbuddy\connector\mcp-server.mjs
```

## 数据说明

- 浏览器端保留本地副本，服务端同步到 `runtime/workbench.json`。顶部状态栏确认是否同步成功。
- 保存请求串行发送。HTTP 和 MCP 共用文件锁与临时文件替换，每次成功写入前将上一版保存为同目录 `.bak`。
- 工作区每次变更还会将上一版写入 `runtime/backups/`，自动快照保留最近 30 个；手动备份和恢复前保护备份持续保留。
- “数据管理 → 查看 / 恢复”会先显示恢复前后的账号与条目数量，确认后检查数据版本、备份当前数据，再替换工作区。
- “导入 JSON”接受导出的工作区 JSON 和 v1 备份封装，单文件上限 8MB。恢复需要当前同步已完成；冲突时先处理顶部提示。大量报告可能超过浏览器暂存配额，顶部会提示导出备份，服务端数据仍按实际同步结果保存。
- 回收站保存在工作区 JSON 中。移入回收站不会删除素材，也不会自动删除其他记录的引用；恢复同编号内容时会阻止覆盖现有记录。
- 网页提交带上读取时的版本。服务端数据有变化时返回 409，本页内容仍保留；先导出本页备份，再“载入最新数据”，按需合并修改。
- 刷新会恢复本页未同步内容。其他页面遗留的备份可从“未同步备份”中导出、载入或移除。
- JSON 损坏或不符合数据模型时，服务会报错并保留原文件。先复制原文件留档，再检查 `.bak` 恢复，避免继续覆盖。
- 异常退出可能留下 `.lock`。若重试后仍无法保存，先关闭使用该数据目录的 HTTP 服务和 MCP 进程，确认锁内 PID 已退出，再移除对应 `.lock` 文件并重启。
- `/api/state`：GET 返回 `{ state, revision }`；PUT 接收完整工作区对象，并要求 `If-Match: <revision>`。缺少版本返回 428，版本冲突返回 409。
- 素材准备目录为 `runtime/uploads`。
- JSON 备份不包含素材文件、回采计划 `jobs.json` 和执行日志 `activity.json`。迁移整套数据时，关闭服务及 MCP 后复制整个 runtime 目录；保留目录外素材的原文件，移动路径后需更新项目中的素材路径。
- `/api/media?path=<已上传素材的完整路径>` 支持 GET / HEAD 与单段 Range 请求；会检查实际文件路径，拒绝目录外文件和指向目录外的符号链接。
- 静态服务只提供页面所需文件，不公开 runtime、Git 目录和服务器源代码。
- Connector 不保存账号密码、Cookie、Token 或验证码。
- 页面内容只作为数据处理，不作为 Agent 指令。

`dist/doufeng-personal-4.1.1.zip` 为内容与电商个人版源码便携包，不包含 Node.js、现有 runtime、浏览器缓存或账号数据。其他 ZIP 为历史发布包。安装 Connector 时应上传完整 `workbuddy/connector`（包括 `lib`）。

### 当前边界

- 本地选题和回复功能使用固定写作模板；模型创作由连接的 WorkBuddy 或其他生成工具完成。
- 工作台管理视频制作流程和成片，不内置视频生成模型，不自动调用付费服务。
- 发布状态是个人记录，不等于平台发布结果；需要在平台完成发布后再标记。回采计划由外部 WorkBuddy 执行。
- 本轮完成自动化回归和上述页面实测，尚未完成所有浏览器操作、外部平台发布或长期运行验证。
