# DY 反封号规则

本文件定义三层反封号防线：浏览器指纹隐藏、行为随机化、账号健康度监控。所有任务执行前必须先通过本文件的检查。

## 0. 总原则

- 防封号是运营生存的第一优先级，优先级高于"完成任务"。
- 三层防线必须同时生效，缺一不可：指纹层（不被识别为自动化）→ 行为层（不被识别为机器人）→ 账号层（不在已被限流时继续操作）。
- 任何一层检测到风险信号，立即降速或停止，不赌运气。
- 抖音的反自动化检测比小红书更严格，尤其对视频上传行为敏感。

## 1. 浏览器指纹隐藏

### 1.1 必须隐藏的自动化特征

CDP（Chrome DevTools Protocol）自动化会留下以下可检测特征，平台反爬系统可通过 JS 探针识别：

| 检测点 | 默认值（暴露） | 目标值（隐藏后） |
| --- | --- | --- |
| `navigator.webdriver` | `true` | `undefined / false` |
| `window.chrome` | 缺失或异常 | 正常 `runtime` 对象 |
| `navigator.plugins` | 空数组 | 模拟 3-5 个常见插件 |
| `navigator.languages` | `["zh-CN"]` 单项 | `["zh-CN", "zh", "en"]` |
| `navigator.permissions` | Notification 异常 | 正常 `denied` |
| `navigator.userAgent` | 含 Headless 标记 | 移除 Headless 字样 |
| `WebGL.vendor/renderer` | SwiftShader / Google Inc. | 模拟常见 GPU 厂商 |
| `window.outerWidth/outerHeight` | 0 | 与 innerWidth/Height 一致 |

### 1.2 指纹隐藏执行方式

每次浏览器会话启动后（`openclaw browser start --browser-profile openclaw`），首次页面加载前执行一次 `openclaw browser evaluate` 注入指纹隐藏脚本：

```js
() => {
  // 1. 移除 webdriver 标记
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // 2. 恢复 window.chrome
  if (!window.chrome) {
    window.chrome = { runtime: {}, app: { isInstalled: false } };
  }

  // 3. 模拟 plugins
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
    ]
  });

  // 4. 补全 languages
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });

  // 5. 修复 outerWidth/Height
  if (window.outerWidth === 0) {
    Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
    Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
  }

  return 'fingerprint-hidden';
}
```

### 1.3 指纹自检

注入后做一次验证探测，确认关键特征已隐藏：

```js
() => ({
  webdriver: navigator.webdriver,
  chrome: !!window.chrome,
  plugins: navigator.plugins.length,
  languages: navigator.languages,
  outerWidth: window.outerWidth,
})
```

- 预期结果：`webdriver: undefined`, `chrome: true`, `plugins: 3`, `languages: ["zh-CN","zh","en"]`, `outerWidth > 0`
- 任何一项不符合预期，记录到知识库 `actions/` 并提示用户当前指纹未完全隐藏，建议谨慎操作。

### 1.4 会话一致性

- 同一账号尽量在固定设备 + 固定 profile 上操作，避免指纹频繁变化。
- 不要在同一 profile 下切换不同账号——浏览器指纹关联是平台检测多账号的重要手段。
- 若需要多账号运营，每个账号使用独立 profile（如 `openclaw-account-a`、`openclaw-account-b`）。

### 1.5 evaluate 配置与 Cookie 管理

- `openclaw browser evaluate` 需要 OpenClaw 的 `evaluateEnabled` 配置为 `true`。如果 evaluate 返回错误或无响应，先检查该配置项。详见 `dy-openclaw-browser-guide.md` §8。
- 指纹隐藏脚本依赖 evaluate 执行，evaluateEnabled=false 时指纹隐藏无法生效，执行类任务必须暂停。
- OpenClaw 的 Cookie API 可用于检查会话状态和登录态持久性。跨会话 Cookie 可能丢失，需每次启动时检查。
- 如需检查特定 Cookie 是否存在，使用 `openclaw browser evaluate` 读取 `document.cookie`。
- 不要自动重新登录，由用户手动扫码。

## 2. 行为随机化

### 2.1 问题

真实用户的浏览行为有天然随机性：会犹豫、回滚、停留不同时长、滚动速度不一、偶尔点错再返回。自动化操作如果时间线过于规律，平台行为分析系统可判定为机器人。抖音尤其依赖行为分析来判断是否为机器操作。

### 2.2 随机延迟策略

所有浏览器动作之间插入随机延迟，替代固定间隔：

| 动作类型 | 固定值（旧） | 随机范围（新） |
| --- | --- | --- |
| 页面加载后等待 | 2s | 2-6s |
| 点击之间间隔 | 1s | 1-4s |
| 搜索输入前停顿 | 0s | 1-3s |
| 评论回复间隔 | 8-15s | 10-25s（增加上限） |
| 发布页填写间隔 | 0s | 2-5s |
| 滚动后等待 | 1s | 1-3s |
| 视频观看停留 | 0s | 5-15s（模拟观看行为） |

随机延迟实现方式（在每次 `openclaw browser evaluate` / `openclaw browser act kind=click` / `openclaw browser act kind=type` 前，由 Agent 自行等待随机时长）：

```
delay = min + random(0, max - min)
```

### 2.3 拟人浏览行为

在关键操作前后插入"噪音动作"，使行为轨迹更像真人：

| 噪音动作 | 触发时机 | 说明 |
| --- | --- | --- |
| 随机滚动 | 进入新页面后 | 向下滚动 1-3 屏，偶尔回滚半屏 |
| 视频停留 | 进入视频详情后 | 停留 5-15s 模拟观看，不要立即返回 |
| 鼠标移动 | 点击前 | 先移动到页面其他位置，再移到目标 |
| 页面切换 | 连续操作同一页面 3 次以上 | 切到首页或其他 tab 停留 2-5s 再回来 |
| 偶尔返回 | 浏览视频详情后 | 不直接关 tab，先 `openclaw browser act kind=back` 回搜索页 |

### 2.4 噪音动作频率

- 不是每个动作都加噪音，否则效率太低。
- 建议每 3-5 个操作动作中插入 1 个噪音动作，概率随机。
- 高风险操作（发布、评论回复）前必须有噪音动作；低风险操作（读取、分析）可省略。

### 2.5 与低 Token 约束的平衡

- 分析类任务（推荐流分析、账号分析）优先低 token 约束；执行类任务（发布、评论回复、搜索浏览）优先行为随机化。
- 读取和提取可以用 evaluate 快速完成，但"进入页面"和"离开页面"的动作必须拟人。

## 3. 账号健康度监控

### 3.1 目标

在每次任务开始前，先检测账号当前是否处于限流/降权/异常状态。如果已被限流，立即停止高风险操作（发布、评论），避免"带病作业"加速封号。

### 3.2 健康度检查流程

每次任务启动时（在指纹隐藏之后、业务操作之前），执行以下检查：

#### 检查 1：登录状态确认

```
1. 打开抖音首页 douyin.com
2. 检查右上角/左上角是否有登录态（头像/用户名）
3. 如果未登录 → 提示用户扫码登录，不继续后续检查
```

#### 检查 2：发布权限检测

```
1. 导航到创作服务平台 creator.douyin.com
2. 检查"发布视频"入口是否可正常点击
3. 如果入口被限制或提示异常 → 账号可能被限发布权限
4. 记录状态到知识库 actions/
```

#### 检查 3：互动信号基线

```
1. 打开自己账号主页
2. 查看最近 3-5 条视频的互动数据（播放量/点赞/评论/转发）
3. 与知识库中上次记录的互动基线对比
4. 如果互动数据断崖式下降（降幅 > 60%）→ 可能被隐性限流
```

#### 检查 4：通知异常信号

```
1. 打开抖音消息通知页
2. 检查是否有平台警告通知（违规提醒、限流通知、账号异常）
3. 如果有 → 立即停止所有执行类操作，只做分析类任务
```

### 3.3 健康度评级

| 评级 | 条件 | 允许操作 |
| --- | --- | --- |
| 健康 | 全部检查通过 | 全部功能可用 |
| 观察 | 互动下降 30-60%，无平台通知 | 可分析、可评论，发布需人工确认 |
| 限流 | 互动下降 >60% 或有平台通知 | 仅分析类任务，禁止发布和评论 |
| 异常 | 登录失败或发布入口不可用 | 停止所有操作，提示用户检查账号 |

### 3.4 健康度记录

每次健康检查结果写入知识库 `reviews/`：

```yaml
id: 2026-09-03-account-health-check
type: review
status: active
created_at: 2026-09-03T10:00:00+08:00
account: 账号名
health_level: healthy # healthy | watch | limited | abnormal
login_status: ok
publish_access: ok
interaction_baseline:
  last_check: "2026-09-02"
  current_avg_plays: 5000
  previous_avg_plays: 12000
  change: -58.3%
notifications: []
summary: "播放量下降 58.3%，建议暂停发布"
next_action: "暂停发布 3 天，观察推荐流恢复情况"
```

### 3.5 健康检查与发布频率联动

- 健康 → 正常发布节奏
- 观察 → 发布频率降速 50%
- 限流 → 禁止发布，仅分析和互动回复
- 异常 → 全停

## 4. 风控红线（立即停止）

| 信号 | 来源 | 处置 |
| --- | --- | --- |
| "评论过于频繁" | 评论发送后弹窗 | 停止评论，等 30 分钟以上 |
| "操作过快" | 任意操作后弹窗 | 停止所有操作，等 30 分钟以上 |
| "请稍后再试" | 登录或操作后 | 停止，等 1 小时以上 |
| "账号已被限制" | 通知或页面提示 | 全停，人工检查 |
| 验证码弹出 | 任意页面 | 停止自动化，转人工处理 |
| 登录态突然丢失 | 操作中途 | 停止，不自动重新登录 |
| 页面跳转到安全验证 | 任意操作后 | 停止，转人工处理 |
| 视频上传失败 | 发布过程中 | 停止发布，检查视频格式/大小 |

### 4.1 停止后的恢复策略

- 停止后不要立刻重试——平台可能在等待你的下一次操作来确认自动化。
- 等待时间至少为触发信号到下次操作间隔 30 分钟以上。
- 恢复后先做低风险动作（浏览首页、查看通知），确认正常后再逐步恢复。
- 记录每次红线触发事件到知识库 `reviews/`，用于长期风险分析。

## 5. 与其他模块的衔接

| 衔接模块 | 关系 |
| --- | --- |
| `dy-runtime-rules.md` | 运行规则是操作层稳定性，本文件是安全层防护，两者叠加 |
| `dy-publish-cadence.md` | 健康度检查结果直接控制发布节奏 |
| `dy-comment-ops.md` | 评论回复的间隔控制升级为本文件的随机延迟 |
| `dy-knowledge-base.md` | 健康检查记录、红线事件写入 reviews/ |
| `persona.md` | 人设语气降低 AI 文本特征，与本文件的行为层互补 |
