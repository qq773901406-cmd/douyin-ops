# DY 发布效果追踪

本文件定义发布后效果自动回采机制，形成"发布→追踪→复盘→优化"的数据闭环。

## 0. 总原则

- 发布不是终点，效果数据才是决策依据。
- 用户要求确认真实数据时，优先按 `dy-creator-dashboard-analysis.md` 进入创作后台核验；不要用本地草稿推断。
- 回采是自动触发的——发布后 T+1 和 T+7 各采一次，不需要用户手动要求。
- 数据回写到知识库，直接影响选题灵感和发布节奏的推荐权重。
- 回采本身是低风险行为（只读不写），但仍需遵循行为随机化。
- 抖音特有关注指标：完播率、5秒留存率、平均播放时长。

## 1. 回采时机

| 时间点 | 采集内容 | 目的 |
|---|---|---|
| T+1（发布后 24 小时） | 播放量、点赞、评论、转发、收藏、完播率、粉丝增长 | 判断初始推荐效果 |
| T+7（发布后 7 天） | 累计互动、是否进入搜索结果、是否被二次推荐 | 判断长尾效果和内容质量 |
| T+30（可选） | 最终互动数据 | 判断内容生命周期，纳入 pattern 评估 |

如果 T+1 数据已明确低于基线，T+7 仍采但预期降低；如果 T+1 高于基线 3 倍以上，标记为"爆款候选"并立即通知用户。

## 2. 回采字段

```yaml
id: 2026-09-04-effect-track-2026-09-03-publish-001
type: action
status: active
created_at: 2026-09-04T14:00:00+08:00
task_type: effect_track
track_point: T+1 # T+1 | T+7 | T+30
source_action_id: "2026-09-03-publish-video-001"
video_url: "https://www.douyin.com/video/..."
video_title: "被 AI 惊到后改掉了 3 个坏习惯"
metrics:
  plays: 12000
  likes: 456
  comments: 23
  shares: 12
  collects: 89
  completion_rate: 0.45 # 完播率 45%
  avg_play_duration: "18s"
  new_followers: 15
interaction_quality: medium # low | medium | high
top_comments_summary:
  - user: "用户A"
    text: "真的改掉了第二个习惯"
    likes: 5
  - user: "用户B"
    text: "第三个习惯怎么改的？"
    likes: 3
benchmark:
  account_avg_plays: 5000
  account_avg_likes: 120
  account_avg_comments: 8
  delta_plays: "+140%"
  delta_likes: "+280%"
  delta_comments: "+188%"
verdict: above-baseline # below-baseline | baseline | above-baseline | viral
summary: "T+1 互动远超基线，前3秒钩子有效，完播率45%高于平均"
next_action: "记录视频结构到 patterns/，可复用"
```

## 3. 回采流程

### 3.1 定位目标视频

1. 从知识库 `actions/` 中查询最近发布记录的 `video_url`
2. 使用内置浏览器 `profile="openclaw"` 打开视频 URL
3. 校验页面正常加载（非 404、非删除、非审核中）
4. 如果视频已不可见，标记为 `removed` 并记录

### 3.2 数据提取

1. 优先从创作后台内容分析页提取表格数据（播放量/完播率/赞评转收/粉丝增长）
2. 公开详情页仅作为补充（公开页可见点赞/评论/转发/收藏）
3. 滚动到评论区，采样 Top 3-5 条评论
4. 按 `dy-selectors.md` 中的 selector 提取字段
5. 如果 selector 失效，做 `openclaw browser snapshot` 后更新

### 3.3 基线对比

1. 从知识库 `actions/` 中查询该账号最近 10 条视频的平均互动
2. 计算当前视频相对基线的偏差百分比
3. 偏差分级：

| 偏差范围 | 评级 | 含义 |
|---|---|---|
| < -50% | below-baseline | 明显低于平均 |
| -50% ~ +50% | baseline | 在平均范围内 |
| +50% ~ +200% | above-baseline | 明显高于平均 |
| > +200% | viral | 爆款级别 |

## 4. 结果应用

### 4.1 回写知识库

| verdict | 沉淀动作 |
|---|---|
| below-baseline | 记录到 `reviews/`，标注"此 pattern 效果差"，相关 pattern 降权 |
| baseline | 轻量记录，不特殊处理 |
| above-baseline | 记录到 `patterns/`，标注"验证有效"，提升推荐权重 |
| viral | 立即记录到 `patterns/` + 通知用户，标记为"高优复用模板" |

### 4.2 影响 pattern 置信度

| 当前 confidence | 回采结果 | 调整为 |
|---|---|---|
| low | above-baseline | medium |
| medium | above-baseline × 2 | high |
| medium | below-baseline × 2 | low |
| high | below-baseline | medium（降级） |
| 任意 | viral | high（升级） |

### 4.3 影响选题推荐

选题灵感生成时（参见 `dy-topic-ideation.md`），优先参考 `confidence=high` 的 pattern 产出的标题骨架和互动钩子。

### 4.4 影响发布节奏

如果连续 3 条视频 verdict 为 `below-baseline`，触发预警：

```
连续 3 条低于基线，建议：
1. 暂停发布 1-2 天
2. 回顾最近选题是否偏离账号定位
3. 检查账号健康度（dy-anti-ban-rules.md）
4. 重新做一次推荐流分析，校准选题方向
5. 检查视频前3秒钩子是否失效
```

## 5. 回采的注意事项

- 回采只读不写，风险极低，但仍需遵循 `dy-anti-ban-rules.md` 的行为随机化。
- 不要短时间内连续回采多条视频——间隔随机 30-60 秒。
- 如果回采时发现视频已被平台删除，标记为 `removed` 并检查是否有违规通知。
- 抖音视频审核期间数据不可见属正常，T+1 回采如遇审核中，推迟到 T+2。

## 6. 失败降级

- 视频 URL 不可访问 → 标记 `removed`，不重试
- selector 失效 → `openclaw browser snapshot` 后更新 `dy-selectors.md`，下次重试
- 知识库不可写 → 先返回结构化摘要，后续补记
- 基线数据不足（少于 5 条历史）→ 标注"基线不足，仅供参考"
