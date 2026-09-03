# DY OpenClaw 浏览器交互规范

本文件是抖音技能中所有浏览器操作的统一参考，定义 OpenClaw 的核心交互模型、CLI 命令语法和常见操作模式。其他 references 文件中的浏览器命令均以本文件为准。

## 1. 核心交互模型：snapshot → ref → act

OpenClaw 采用"先快照获取元素引用，再按引用执行动作"的交互模式：

1. **snapshot**：`openclaw browser snapshot` 获取当前页面的 UI 树（可读文本结构），每个可交互元素带有一个 `ref` 标识
2. **定位 ref**：从 snapshot 返回结果中找到目标元素的 `ref` 值
3. **act**：`openclaw browser act ref=<ref_id> kind=<动作>` 使用 `ref` 执行具体动作（点击、输入等）

### 为什么用 ref 而非 CSS selector 直接操作？

- 抖音 SPA 页面动态渲染，元素 DOM 结构频繁变化
- `ref` 是 OpenClaw 在 snapshot 时生成的临时引用，比 selector 更可靠
- snapshot 同时提供"当前页面状态确认"和"元素定位"两个功能
- 对于批量字段提取，仍优先使用 `evaluate`（见 §2.4）

### 何时用 evaluate，何时用 act？

| 场景 | 推荐方式 |
|---|---|
| 批量提取字段（标题、点赞数等） | `evaluate`（一次性提取，token 效率高） |
| 需要执行页面内 JS 逻辑 | `evaluate`（唯一选择） |
| 点击按钮/链接 | `act kind=click` |
| 输入文本 | `act kind=type` |
| 滚动页面 | `act kind=scroll` 或 `evaluate` 调用 `window.scrollBy` |

## 2. CLI 命令对照表

### 2.1 浏览器生命周期

| 操作 | 命令 |
|---|---|
| 启动浏览器（指定 profile） | `openclaw browser start --browser-profile openclaw` |
| 检查浏览器状态 | `openclaw browser status` |
| 列出可用 profiles | `openclaw browser profiles` |

### 2.2 页面导航

| 操作 | 命令 |
|---|---|
| 打开 URL | `openclaw browser navigate <url>` |
| 返回上一页 | `openclaw browser act kind=back` |
| 获取当前页面快照（UI 树 + ref） | `openclaw browser snapshot` |
| 截取屏幕截图（像素图片） | `openclaw browser screenshot` |

### 2.3 元素交互（act）

| 操作 | 命令 |
|---|---|
| 点击元素 | `openclaw browser act ref=<ref_id> kind=click` |
| 输入文本（逐字） | `openclaw browser act ref=<ref_id> kind=type text="内容"` |
| 清空输入框 | `openclaw browser act ref=<ref_id> kind=clear` |
| 按键 | `openclaw browser act ref=<ref_id> kind=press key=Enter` |

### 2.4 页面内 JS 执行

| 操作 | 命令 |
|---|---|
| 执行 JS 函数（批量提取/页面探测） | `openclaw browser evaluate <js_function>` |

> **前置条件**：`evaluate` 需要 OpenClaw 的 `evaluateEnabled` 配置为 `true`。如果 evaluate 返回错误或无响应，先检查该配置项。

### 2.5 随机延迟（替代 browser wait）

OpenClaw 不提供 `browser wait` 命令。随机延迟通过 shell 原生 sleep 实现：

| 平台 | 命令 |
|---|---|
| Windows (PowerShell) | `Start-Sleep -Seconds (Get-Random -Min 2 -Max 7)` |
| Linux / macOS / WSL2 | `sleep $((RANDOM % 5 + 2))` |

## 3. 文件上传机制

OpenClaw 不提供 `browser upload` 命令。文件上传通过以下流程实现：

### 3.1 标准上传流程

```
1. 将待上传文件复制到 OpenClaw 上传白名单目录
2. openclaw browser snapshot                    # 获取上传区域的 ref
3. openclaw browser act ref=<ref_id> kind=click # 点击上传区域，触发文件选择器
4. POST /hooks/file-chooser                     # 设置文件路径，完成上传
```

### 3.2 上传白名单目录

| 平台 | 白名单目录 | 备注 |
|---|---|---|
| WSL2 / Linux / macOS | `/tmp/openclaw/uploads` | 推荐路径 |
| Windows（原生） | `%LOCALAPPDATA%\openclaw\uploads` | 首选路径 |
| Windows（备选） | `D:\openclaw\media\inbound` | 首选被拒时使用 |

### 3.3 上传注意事项

- 文件必须在白名单目录内，否则 POST /hooks/file-chooser 会被拒绝
- 上传大文件（视频）期间不要操作其他页面元素
- 上传完成后确认进度条到 100% 或出现下一步界面（如封面选择）
- `POST /hooks/file-chooser` 的请求体格式：`{"file": "<文件绝对路径>"}`

## 4. snapshot 与 screenshot 的区别

| 操作 | 返回内容 | 用途 | token 消耗 |
|---|---|---|---|
| `openclaw browser snapshot` | UI 树文本结构 + 元素 ref | 交互定位、状态确认 | 低 |
| `openclaw browser screenshot` | 像素图片 | 视觉确认、归档 | 高 |

**默认优先使用 snapshot**，仅在以下场景使用 screenshot：
- 用户要求视觉确认
- 需要归档页面状态作为证据
- snapshot 无法获取的信息（如 Canvas 内容）

## 5. 常见操作模式

### 5.1 页面加载后确认

```
1. openclaw browser navigate <url>
2. Start-Sleep -Seconds (Get-Random -Min 2 -Max 6)    # 随机等待页面加载
3. openclaw browser snapshot                           # 确认页面已加载
```

### 5.2 点击并等待

```
1. openclaw browser snapshot                           # 获取目标元素 ref
2. openclaw browser act ref=<ref_id> kind=click        # 点击
3. Start-Sleep -Seconds (Get-Random -Min 1 -Max 4)    # 随机等待结果
4. openclaw browser snapshot                           # 确认点击效果
```

### 5.3 输入文本

```
1. openclaw browser snapshot                           # 获取输入框 ref
2. openclaw browser act ref=<ref_id> kind=click        # 先聚焦输入框
3. openclaw browser act ref=<ref_id> kind=type text="内容"  # 逐字输入
```

### 5.4 批量数据提取

```
1. openclaw browser navigate <url>
2. Start-Sleep -Seconds (Get-Random -Min 2 -Max 6)
3. openclaw browser evaluate <js_function>             # 批量提取字段
```

提取模板见 `references/dy-eval-patterns.md`。

### 5.5 文件上传

```
1. Copy-Item video.mp4 D:\openclaw\media\inbound\      # 复制到白名单目录
2. openclaw browser snapshot                           # 获取上传区域 ref
3. openclaw browser act ref=<ref_id> kind=click        # 点击上传区域触发文件选择器
4. POST /hooks/file-chooser {"file": "D:\\openclaw\\media\\inbound\\video.mp4"}
5. openclaw browser snapshot                           # 确认上传开始
```

### 5.6 按钮定位与点击（自定义组件场景）

抖音发布页按钮可能使用自定义组件，安全执行顺序：

```
1. openclaw browser snapshot                           # 确认页面底部按钮区域
2. openclaw browser evaluate <js_function>             # 定位按钮文本和状态
3. 确认目标按钮存在且未禁用后
4. openclaw browser act ref=<ref_id> kind=click        # 点击目标按钮
5. openclaw browser snapshot                           # 确认点击效果
```

如果按钮定位失败，不要猜测按钮坐标，提示用户手动点击。

## 6. 会话管理

### 6.1 Profile 管理

- 固定使用 `--browser-profile openclaw` 进行所有操作
- 多账号运营时使用独立 profile（如 `openclaw-account-a`、`openclaw-account-b`）
- 不要在同一 profile 下切换不同账号——浏览器指纹关联是平台检测多账号的重要手段

### 6.2 登录态检查

每次会话启动后：

```
1. openclaw browser navigate https://www.douyin.com
2. openclaw browser evaluate <检查登录态的JS>           # 检查页面是否有登录态
3. 如果未登录 → 提示用户扫码，不自动登录
```

### 6.3 Cookie 管理

- OpenClaw 的 Cookie API 可用于检查会话状态和登录态持久性
- 跨会话 Cookie 可能丢失，需每次启动时检查
- 不要自动重新登录，由用户手动扫码
- 如需检查特定 Cookie 是否存在，使用 `evaluate` 读取 `document.cookie`

## 7. SSRF 策略

OpenClaw 有 SSRF 防护策略，需确保目标域名在允许列表中：

- 抖音主站：`www.douyin.com` ✅
- 创作服务平台：`creator.douyin.com` ✅
- 如果 navigate 或 evaluate 被拦截，检查 OpenClaw 的 `ssrfPolicy` 配置
- 确保 `creator.douyin.com` 和 `www.douyin.com` 在允许列表中
- 抖音 CDN 域名（图片/视频资源）通常不需要手动加白名单

## 8. evaluate 配置与限制

- `browser evaluate` 需要 OpenClaw 的 `evaluateEnabled` 配置为 `true`
- 如果 evaluate 返回错误或无响应，先检查该配置项
- evaluate 在页面加载后执行，**无法覆盖首次加载的检测窗口**
- 指纹隐藏脚本需在 `about:blank` 页面注入，再导航到抖音（参见 `dy-anti-ban-rules.md` §1.2）
- evaluate 执行的 JS 函数需返回可序列化值（字符串、数字、对象、数组）

## 9. 命令速查（旧 → 新对照）

以下为本次修正中统一替换的命令语法：

| 旧写法（错误） | 新写法（正确） |
|---|---|
| `browser.start --profile openclaw` | `openclaw browser start --browser-profile openclaw` |
| `browser start --profile openclaw` | `openclaw browser start --browser-profile openclaw` |
| `browser wait <毫秒数>` | `Start-Sleep -Seconds (Get-Random -Min N -Max M)`（Windows）/ `sleep $((RANDOM % N + M))`（Linux） |
| `browser upload <files>` | snapshot → act click → `POST /hooks/file-chooser`（见 §3） |
| `type <ref> <text>` | `openclaw browser act ref=<ref_id> kind=type text="内容"` |
| `fill <ref> <text>` | `openclaw browser act ref=<ref_id> kind=type text="内容"` |
| `click <ref>` | `openclaw browser act ref=<ref_id> kind=click` |
| `browser_navigate_back` | `openclaw browser act kind=back` |
| `snapshot`（无前缀） | `openclaw browser snapshot` |
| `evaluate`（无前缀） | `openclaw browser evaluate` |
| `screenshot`（无前缀） | `openclaw browser screenshot` |

## 10. 与其他文件的关系

| 文件 | 关系 |
|---|---|
| `dy-runtime-rules.md` | 运行规则引用本文件的命令语法 |
| `dy-anti-ban-rules.md` | 指纹隐藏使用本文件的 evaluate 命令；行为随机化使用本文件的延迟方案 |
| `dy-publish-flows.md` | 文件上传使用本文件的上传机制（§3） |
| `dy-comment-ops.md` | 评论输入使用本文件的 act kind=type 语法 |
| `dy-draft-save-flow.md` | 草稿保存使用本文件的按钮定位（§5.6）和上传机制（§3） |
| `dy-selectors.md` | selector 配合 snapshot ref 使用 |
| `dy-eval-patterns.md` | JS 模板通过本文件的 evaluate 命令执行 |
