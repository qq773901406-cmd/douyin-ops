# douyin-ops 技能 Smoke Test（2026-09-03）

## 测试环境
- Browser: OpenClaw 内置浏览器
- Profile: `openclaw`（启动命令：`openclaw browser start --browser-profile openclaw`）
- 站点: `https://www.douyin.com`
- 创作后台: `https://creator.douyin.com`
- 测试方式: 手工执行最小闭环（采样→分析→写入知识库）
- 交互模型: `snapshot → ref → act`（详见 `references/dy-openclaw-browser-guide.md`）

## 测试结果总览

1. ⬜ 推荐流分析
   - 执行：采样推荐流，抓取高赞视频样本及前3秒钩子
   - 预期产物：`knowledge-base/patterns/2026-09-03-home-feed-sample.md`

2. ⬜ 账号分析
   - 执行：打开账号主页并采样账号信息/近帖表现
   - 预期产物：`knowledge-base/accounts/2026-09-03-account-analysis.md`

3. ⬜ 选题灵感
   - 执行：结合推荐流信号 + 账号定位生成 5 条选题
   - 预期产物：`knowledge-base/topics/2026-09-03-topic-ideas.md`

4. ⬜ 知识库沉淀
   - 执行：按类型写入 patterns/accounts/topics/actions
   - 预期产物：`knowledge-base/actions/2026-09-03-smoke-test.md`

5. ⬜ 自动发布
   - 执行：上传视频/图片，填写标题文案话题，停在发布按钮
   - 预期产物：半程预发完成确认

6. ⬜ 自动回复评论
   - 执行：打开消息通知页，检查最新评论，对位回复
   - 预期产物：回复成功确认

7. ⬜ 爆款视频复刻
   - 执行：输入爆款视频URL，拆解爆款因素，生成新内容
   - 预期产物：Source Template + 新内容素材

## 已知限制

- 抖音 Web 端部分功能需要在 App 内操作（如部分评论互动）
- 视频上传受网络带宽影响较大
- 创作后台数据看板字段可能随平台更新变化
- 抖音反自动化检测较严格，需严格遵守反封号规则

## 结论

- 技能框架已完成搭建，等待实际环境验证。
- 建议首测顺序：推荐流分析 → 账号分析 → 选题灵感 → 知识库沉淀 → 发布 → 评论回复 → 爆款复刻
