<!--
  douyin-ops skill README
-->

# douyin-ops

抖音自动运营Skill，搭配Openclaw可以独立运营抖音账号，帮你分析、选题、创作、复盘、复刻

基于浏览器自动化(CDP)，第一次需要扫码登录，后续无需重复验证

## What's New
- **09.03**：基于小红书技能架构设计，适配抖音平台特性（视频优先、完播率核心、创作服务平台发布）
- 新增`推荐流分析`,`账号分析`,`选题灵感`,`知识库`,`效果追踪`
- 支持`爆款视频复刻`，输入爆款视频链接，分析爆款因素，生成类似的内容

## 核心能力
- ✅ 推荐流分析：为什么这些高赞视频能被推荐给你？背后的传播钩子和内容结构是什么？
- ✅ 账号分析：分析账号定位，不同视频之间的区别，为什么这个视频赞更多
- ✅ 选题灵感：结合知识库、账号定位，提供选题灵感和内容
- ✅ 知识库：分析结果和动作会被保存下来（markdown），为未来决策和复盘提供便利
- ✅ 效果追踪：发布后 T+1/T+7 自动回采互动数据，与基线对比评级

- ✅ 自动发布视频/图文：上传视频/图片，填写文案/标题/话题
- ✅ 自动回复评论：通知评论逐个回复
- ✅ 目标视频下载：下载URL视频封面和文案
- ✅ 爆款视频复刻：输入爆款视频链接，发布相似内容
- ✅ persona.md：账号定位和人设，设定回复语气

### 1. 推荐流分析
```
帮我分析一下我抖音推荐流，为什么这些高赞视频会被推荐给我？
```

### 2. 账号分析
```
帮我分析这个账号定位和最近视频表现，为什么有些视频点赞明显更高？
```

### 3. 选题灵感
```
结合我的账号定位和最近平台热点，给我 5 条能直接发布的抖音选题
```

### 4. 知识库沉淀
```
把这次分析结果和动作沉淀到知识库，方便后续复盘复用
```

### 5. 自动发布
```
帮我发布一条关于XX话题的抖音视频
```

### 6. 自动回复评论
```
帮我检查抖音最新评论并回复
```

### 7. 爆款视频复刻
```
帮我复刻爆款视频 https://www.douyin.com/video/XXXXXXX
```

## 安装
- 方法1: openclaw / codex 安装，复制以下内容发送
```
帮我安装这个skill，`https://github.com/Xiangyu-CAS/douyin-ops-skill`
```

- 方法2: clawhub安装
```
clawhub install douyin-ops
```

## 仓库结构

- `SKILL.md`
  - 技能主逻辑与执行规则（SOP、流程、边界）
- `persona.md`（人设/语气/回复风格）
  - 抖音对外文本语气（人设、话术、禁忌）
- `examples/`
  - 具体垂直场景案例（如 `drama-watch`）
  - `examples/drama-watch/case.md`：陪你看剧实例化流程
- `references/`
  - `references/dy-comment-ops.md`：评论互动与回复策略
  - `references/dy-publish-flows.md`：发布流程（视频/图文）拆解
  - `references/dy-home-feed-analysis.md`：推荐流分析 SOP
  - `references/dy-account-analysis.md`：账号体检与诊断 SOP
  - `references/dy-topic-ideation.md`：选题灵感生成 SOP
  - `references/dy-knowledge-base.md`：知识库沉淀与检索规范
  - `references/dy-anti-ban-rules.md`：反封号与账号健康检查
  - `references/dy-publish-cadence.md`：发布频率管理
  - `references/dy-effect-tracking.md`：发布效果追踪
  - `references/dy-creator-dashboard-analysis.md`：创作后台数据复盘
  - `references/dy-selectors.md`：Selector 集中管理
  - `references/dy-viral-copy-flow.md`：爆款视频复刻链路
  - `references/dy-runtime-rules.md`：运行规则
  - `references/dy-draft-save-flow.md`：草稿保存流程
  - `references/dy-eval-patterns.md`：通用提取模板
- `knowledge-base/`
  - `knowledge-base/README.md`：知识库总览入口
  - 其他细分分析结果与动作记录默认本地保存，并通过 `.gitignore` 忽略
- `examples/reply-examples.md`
  - 近场评论对位回复样例（含偏离与修正对照）

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=Xiangyu-CAS/douyin-ops-skill&type=Date)](https://star-history.com/#Xiangyu-CAS/douyin-ops-skill&Date)
