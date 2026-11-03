# 项目中的视频发布任务

- 用户要求发布或继续发布 B 站视频时，先读 `references/bilibili-publish-flow.md`，使用 `scripts/bilibili-workflow.mjs` 管理清单与回执；从 `list` 检查既有记录开始。
- 当前请求已明确授权的同一条视频、目标账号和发布动作不重复询问。固化流程、制作清单或历史发布授权不会自动授权其他视频。
- B 站网页投稿由 Agent 观察执行；本地流程命令不执行网页发布。`submitting`、`submitted`、`published`、`uncertain` 不能自动重试，不直接修改记录来解除重复保护。
- 使用即梦制作、补片或继续萌宠视频时，先读 `references/jimeng-pet-video-flow.md`，再读对应 `runtime/` 运行手册、最新策略和持久进度；按镜头恢复，不从头重复生成。按最新策略轮询（当前每 5 小时）；赠送积分足够且平台允许时可先提交下一镜头，不必等待上一镜头完成。免费赠送积分不足的未提交镜头跨日续做，已受理任务仍按期查询；成片验收后按本次已有授权衔接正式发布。
- 抖音每日自动发布仍使用 `server/automation-service.mjs` 和 `server/douyin-publisher.mjs`。不要把 B 站回执写成抖音队列的发布成功，也不要因一次 B 站实发就声称定时发布已验证。
- 本机账号、路径、截图和回执保存在 `runtime/`，不写入通用模板。BrowserSkill 实例与会话 ID 必须从当前工具结果取得。
- 即梦续做的本机恢复索引是 `runtime/jimeng-workflow/index.json`；存在时按其运行 ID 读取手册、配方、最新策略和发布清单，不能仅凭最近修改时间选择任务。
