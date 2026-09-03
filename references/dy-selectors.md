# DY Selectors 集中管理

本文件集中维护所有抖音页面操作的 CSS selector 和 XPath。其他文件引用本文件即可，页面改版时只需修改此处。

## 0. 使用规则

- 所有 references 文件和 SKILL.md 中的 selector 引用，以本文件为准。
- 页面改版时先更新本文件，再做一次轻量探测验证。
- selector 按页面场景分组，每组标注：selector、用途、备选、更新日期。
- 探测失败时使用备选 selector，全部失败后做 `openclaw browser snapshot` 重新定位。
- 抖音页面结构变化较频繁，selector 需定期验证更新。

## 1. 推荐流/首页

| 用途 | 主 selector | 备选 selector |
| --- | --- | --- |
| 视频卡片 | `[data-e2e="feed-active-video"]` | `[class*="video-feed"]`、`[class*="recommend"]` |
| 视频标题/文案 | `[data-e2e="video-desc"]` | `[class*="title"]`、`[class*="desc"]` |
| 作者名 | `[data-e2e="video-author-nickname"]` | `[class*="author"]`、`[class*="nickname"]` |
| 点赞数 | `[data-e2e="like-count"]` | `[class*="like"] span`、`[class*="count"]` |
| 评论数 | `[data-e2e="comment-count"]` | `[class*="comment"] span` |
| 转发数 | `[data-e2e="share-count"]` | `[class*="share"] span` |
| 收藏数 | `[data-e2e="collect-count"]` | `[class*="collect"] span` |
| 话题标签 | `[data-e2e="video-tag"]` | `a[href*="/hashtag/"]`、`[class*="tag"]` |

## 2. 视频详情页

| 用途 | 主 selector | 备选 selector |
| --- | --- | --- |
| 视频标题/文案 | `[data-e2e="video-desc"]` | `[class*="title"]`、`[class*="desc"]` |
| 视频描述全文 | `[data-e2e="video-desc"] span` | `[class*="desc"] p` |
| 作者名 | `[data-e2e="video-author-nickname"]` | `[class*="author"]` |
| 作者主页链接 | `[data-e2e="video-author-nickname"] a` | `a[href*="/user/"]` |
| 点赞数 | `[data-e2e="like-count"]` | `[class*="like"] span` |
| 评论数 | `[data-e2e="comment-count"]` | `[class*="comment"] span` |
| 转发数 | `[data-e2e="share-count"]` | `[class*="share"] span` |
| 收藏数 | `[data-e2e="collect-count"]` | `[class*="collect"] span` |
| 话题标签 | `[data-e2e="video-tag"]` | `a[href*="/hashtag/"]` |
| 视频封面（meta） | `meta[property="og:image"]` | `videoposter` 属性 |

### 封面抓取规则

- 优先从 `meta[property="og:image"]` 的 `content` 属性获取封面 URL
- 兜底：从 `<video>` 元素的 `poster` 属性获取
- 取到 URL 后可下载转存为 PNG/JPG

## 3. 账号主页

| 用途 | 主 selector | 备选 selector |
| --- | --- | --- |
| 昵称 | `[data-e2e="user-info-nickname"]` | `[class*="nickname"]`、`h1` |
| 抖音号 | `[data-e2e="user-info-unique-id"]` | `[class*="unique-id"]` |
| 简介 | `[data-e2e="user-info-desc"]` | `[class*="desc"]`、`[class*="intro"]` |
| 粉丝数 | `[data-e2e="user-info-fans-count"]` | `[class*="fans"]`、`[class*="follow"]` |
| 关注数 | `[data-e2e="user-info-follow-count"]` | `[class*="follow"]` |
| 获赞量 | `[data-e2e="user-info-like-count"]` | `[class*="like"]` |
| 视频列表 | `[data-e2e="user-post-list"]` | `[class*="video-list"]`、`[class*="feed"]` |
| 单条视频数据 | 同推荐流 | — |

## 4. 通知/消息页

| 用途 | 主 selector | 备选 selector |
| --- | --- | --- |
| 评论通知列表 | `[data-e2e="comment-list"]` | `li[class*="notification"]`、`[class*="message-item"]` |
| 评论用户名 | `[data-e2e="comment-user-name"]` | `[class*="user"]`、`[class*="name"]` |
| 评论文本 | `[data-e2e="comment-content"]` | `[class*="content"]` |
| 回复按钮 | `[data-e2e="comment-reply-btn"]` | `button[class*="reply"]` |
| 回复输入框 | `[contenteditable="true"]` | `textarea[class*="reply"]`、`input[class*="reply"]` |
| 发送按钮 | `[data-e2e="comment-send-btn"]` | `button[class*="send"]`、`[class*="submit"]` |

### 对位校验

回复输入框出现后，校验上下文是否包含目标用户名，作为唯一对位凭证。

## 5. 创作发布页（creator.douyin.com）

| 用途 | 主 selector | 备选 selector |
| --- | --- | --- |
| 发布视频入口 | `[data-e2e="publish-video-entry"]` | `a[href*="publish"]`、`[class*="publish"]` |
| 上传视频区 | `input[type="file"][accept*="video"]` | `[class*="upload"]`、`[class*="drag"]` |
| 封面上传 | `input[type="file"][accept*="image"]` | `[class*="cover"] input` |
| 标题/文案输入框 | `[data-e2e="publish-input-title"]` | `input[class*="title"]`、`textarea[class*="desc"]` |
| 视频描述输入框 | `[data-e2e="publish-input-desc"]` | `textarea[class*="desc"]`、`[class*="content"] textarea` |
| 话题输入 | `[data-e2e="publish-input-topic"]` | `input[class*="tag"]`、`input[class*="topic"]` |
| 发布按钮 | `[data-e2e="publish-submit-btn"]` | `button[class*="publish"]`、`[class*="submit"]` |
| 存草稿按钮 | `[data-e2e="publish-draft-btn"]` | `button[class*="draft"]`、`[class*="save"]` |
| 字数计数 | `[class*="counter"]` | `[class*="count"]` |

## 6. 搜索结果页

| 用途 | 主 selector | 备选 selector |
| --- | --- | --- |
| 搜索输入框 | `[data-e2e="searchbar-input"]` | `input[type="search"]`、`input[class*="search"]` |
| 视频 tab | `[data-e2e="search-video-tab"]` | `a[href*="search/video"]` |
| 搜索结果卡片 | `[data-e2e="search-result-item"]` | `[class*="result"]`、`[class*="card"]` |
| 卡片标题 | `[data-e2e="search-result-title"]` | `[class*="title"]` |
| 卡片作者 | `[data-e2e="search-result-author"]` | `[class*="author"]` |
| 卡片播放量 | `[data-e2e="search-result-plays"]` | `[class*="play"]` |

## 7. 通用元素提取

用于 `dy-eval-patterns.md` 的批量提取模板：

```js
const VIDEO_SELECTORS = ['[data-e2e="feed-active-video"]', '[class*="video-item"]', '[class*="card"]'];
const TITLE_SELECTORS = ['[data-e2e="video-desc"]', '.title', '[class*="title"]'];
const DESC_SELECTORS = ['[data-e2e="video-desc"] span', '.desc', '[class*="desc"]'];
const TAG_SELECTORS = ['[data-e2e="video-tag"]', '.tag', 'a[href*="/hashtag/"]'];
const LIKE_SELECTORS = ['[data-e2e="like-count"]', '.like-count', '[class*="like"] span'];
const COMMENT_SELECTORS = ['[data-e2e="comment-count"]', '.comment-count', '[class*="comment"] span'];
const SHARE_SELECTORS = ['[data-e2e="share-count"]', '.share-count', '[class*="share"] span'];
```

## 8. 版本管理

| 更新日期 | 变更内容 | 验证状态 |
| --- | --- | --- |
| 2026-09-03 | 初始创建，基于抖音 Web 端常见结构 | 待验证 |

### 更新流程

1. 页面改版时，先 `openclaw browser snapshot` 确认新结构
2. 更新本文件对应 selector
3. 用 `openclaw browser evaluate` 跑一次探测确认可取到值
4. 标记验证状态和更新日期
5. 在知识库 `actions/` 记录一次 selector 更新事件
