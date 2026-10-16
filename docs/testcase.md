# 豆蜂 WorkBuddy 版验收清单

## 本地工作台

- `node server.mjs` 后首页可访问。
- 账号诊断、推荐流、选题、拆解、发布、评论、效果和知识库表单可保存。
- 刷新页面后数据仍存在。
- JSON 备份可导出和导入。
- 素材可复制到 `runtime/uploads`。

## WorkBuddy Connector

- `initialize` 返回 MCP 版本、服务器信息和 tools 能力。
- `tools/list` 返回全部豆蜂工具。
- `workspace_summary` 能读取当前工作区。
- 各 add/save 工具能写入 `runtime/workbench.json`。
- `knowledge_search` 能查到已保存记录。
- `job_create/list/delete` 能维护回采计划。

## BrowserSkill

- 未安装时页面显示明确安装提示，不影响其他功能。
- 安装并连接扩展后，`bsk doctor` 通过。
- 可启动会话、打开抖音、观察页面并结束会话。
- 最终发布、评论发送等写操作只能由 WorkBuddy 在确认后执行。

## Buddy 应用

- 3 个工作模式和 7 个场景可在开放平台配置。
- 绑定 `douyin-ops`、`doufeng-douyin-ops` 和 `browser-skill`。
- 预览态能调用 MCP 工具并读取工作区数据。
- 账号登录与验证码可由用户接管。
