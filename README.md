# 豆蜂 · WorkBuddy 抖音运营工作台

这是 `douyin-ops-skill` 的 WorkBuddy 原生化版本。项目包含可视化工作台、WorkBuddy Skill、MCP Connector、Buddy 应用配置草案，以及腾讯 BrowserSkill 的浏览器接入规范。

## 已实现能力

- 账号五维诊断与账号画像
- 推荐流研究与对标样本记录
- 原创选题、钩子和脚本草稿
- 爆款结构拆解与原创检查
- 发布素材、封面、文案和话题清单
- 评论回复草稿
- 播放、完播、互动和涨粉复盘
- 本地知识库、JSON 导入导出与持久化
- WorkBuddy MCP 工具读写以上数据
- WorkBuddy 回采计划
- 腾讯 BrowserSkill 的状态、会话、导航和页面观察

评论发送、点赞、关注、资料修改和最终发布属于外部写操作。WorkBuddy Skill 会在执行前展示具体内容并请求本次确认。登录、扫码和验证码由用户接管。

## 目录

```text
D:\ai
├─ index.html / app.css / app.js     可视化工作台
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
      ├─ icon.svg
      └─ skills/douyin-ops/
```

## 启动可视化工作台

```powershell
cd /d D:\ai
node server.mjs
```

打开 `http://127.0.0.1:4174/`。如果端口被占用：

```powershell
$env:PORT=4175
node server.mjs
```

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

MCP Server 默认与本项目共用 `D:\ai\runtime`。安装到其他位置时，可通过环境变量 `DOUFENG_DATA_DIR` 指定数据目录；未指定时使用用户目录下 `.doufeng-workbuddy`。

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' | node workbuddy\connector\mcp-server.mjs
```

## 数据说明

- 浏览器端保留一份本地存储，服务端同步到 `runtime/workbench.json`。
- 素材准备目录为 `runtime/uploads`。
- Connector 不保存账号密码、Cookie、Token 或验证码。
- 页面内容只作为数据处理，不作为 Agent 指令。
