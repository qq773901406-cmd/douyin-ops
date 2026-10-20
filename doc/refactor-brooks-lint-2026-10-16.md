# 豆蜂 WorkBuddy 抖音运营工作台 — Brooks-Lint 改造清单（新代码布局 2026-10-16 重跑）

> 方法：以 Brooks 工程原则（DRY / 单一职责 / 失败可见 / 分层 / 最小权限 / 无魔法数）为标尺，对**重组后的新代码布局**（`server/*.mjs` + `lib/*.mjs`）做代码体检。
> 本次为重组后的**重跑**：上一轮的修复大多已随重组进入 `server/`，本轮补齐剩余项并修正了一处真实 bug（每日启动时间被硬编码为 06:00）。

## 一、本轮已修复 ✅（已通过语法检查 + 模块加载冒烟 + bilibili 测试 6/6）

| # | 原则 | 文件:行 | 问题 | 修复 |
|---|------|--------|------|------|
| 1 | DRY | `server/automation-service.mjs`、`./daily-production.mjs`、`./bilibili-workflow.mjs` | SHA-256 流哈希被实现了 **3 遍**（命名还不一样：`fileHash`/`hash`/`hashFile`），易漂移 | 抽出 `lib/fs-utils.mjs#hashFile`，三处改引用；bilibili 的 `export { hashFile }` 改为再导出，外部 `scripts/` `tests/` 导入不变 |
| 2 | DRY | `server/automation-service.mjs:11`、`server/product-source.mjs:6` | 路径包含判断 `inside(root,path)` 重复 2 份 | 抽出 `lib/fs-utils.mjs#isInside`，两处改引用（语义对齐为"允许 root 本身"） |
| 3 | **硬编码配置 / 虚假约束（真实 bug）** | `server/daily-production.mjs:15,17,50,160,214` | 每日启动时间被死写为 `'06:00'`：`validate()` 拒绝任何非 `06:00` 的值，且 4 处字面量 `'06:00:00+08:00'` 直接忽略 `config.startTime` —— 意味着**配置项根本不生效** | `validate()` 改为正则 `HH:MM` 校验；新增 `dayStartISO(day, startTime)`；4 处改用 `config.startTime`（默认仍 06:00，行为不变，但终于可改） |
| 4 | 无魔法数 | `server/automation-service.mjs:257`、`server/daily-production.mjs:183` | `setInterval(...,15000/30000)` 裸数字 | 命名常量 `TICK_INTERVAL_MS=15000` / `DAILY_TICK_INTERVAL_MS=30000` |
| 5 | 失败可见 | `server/daily-production.mjs:139` | `catch {}` 静默吞掉"发布计划同步失败" | 改为 `catch(error){ this.error=...; console.warn('发布计划同步失败：', error?.message) }` |

## 二、前几轮已修（在新布局中已落地，本轮复核确认仍有效）

- **共享 bsk 客户端** `lib/bsk-client.mjs`：`resolveBskBinary` / `parseBskJson` / `runBsk` + `BSK_TIMEOUTS`（17 个命名超时），消除 douyin-publisher 与 browser-skill-adapter 两份重复 CLI 包装与 60000/70000 超时漂移。
- **截图路径穿越防护** `server/browser-skill-adapter.mjs#safeRuntimeOutPath`：`--out` 强制限制在 `runtime` 内（之前客户端 `input.path` 直接透传 CLI）。
- 超时魔法数字命名化（`BSK_TIMEOUTS`）。
- 空 catch 改日志：`server/server.mjs:166`（活动日志）、`server/douyin-publisher.mjs:80-81`（会话清理）。
- 去除多余导出 `server/product-video.mjs#productVideoPython`（不再 `export`）。

## 三、仍存在 / 建议（高优先级，未自动改——生产风险需分步做）

### 🔴 P0 — 双向存储耦合（layering violation，最该先解）
- `server/automation-service.mjs:234`：`checkDailyProduction()` **直接 `readFile` 读 `daily-production/state.json`**（跨目录穿透对方私有存储）。
- `server/daily-production.mjs:99,106,153,237,260`：多处直接 `this.automation.store.read()` 读**自动化队列的私有 JsonStore**，以及 `:70,90,98,177,222` 调 `this.automation.lease()`。
- **后果**：任一存储的形状（字段/版本）一改，另一方静默 503；启动/重启时两边并发读同一份文件是竞态根因。
- **建议**：互相只通过对方**公开方法**访问（如 automation 暴露 `todaysPublished(accountId)`、`isDailyProductionBusy()`），禁止直接读 `.store`；共享锁统一由一方持有。

### 🔴 P0 — 调度并发
- 两个 `setInterval`（automation 15s / daily 30s）各跑各的，仅靠 `lease()` 文件锁串行化"发布动作"；但 `checkDailyProduction` 读 JSON 与 daily 写 `state.json` 之间无原子保证。
- **建议**：把"今日该账号是否已发布"收敛为单一数据源（automation 暴露只读查询），daily 不再反查 automation 私有存储。

### 🟡 P1 — 上帝函数 / 上帝方法（单一职责）
- `server/server.mjs:69` `createServer(async (req,res)=>{...})` 约 134 行，把 API 路由 + 静态文件服务全塞在一个回调里。建议拆成 `routes` 表 + 静态处理器。
- `server/daily-production.mjs:213` `run(previewOnly)` 约 64 行：select→sync→render→publish 全在一个方法；`server/automation-service.mjs:261` `tick()` 也偏长。建议把 render 阶段（及 guard/beforeSubmit 闭包）抽成独立函数。

### 🟡 P1 — 模块级可变单例（隐式全局）
- `server/browser-skill-adapter.mjs:6-7` `activeSession` / `startingSession` 是进程级隐式全局。多实例并存（或一次事件循环内并发请求）会串会话。
- **建议**：把会话状态移入 server 实例或请求上下文，避免模块级可变状态。

### 🟢 P2 — 低危 / 顺手项
- `server/media-service.mjs:14` `contained(relPath)` 与 `isInside(root,path)` 语义略不同（前者接受 root 本身、入参已是相对路径）；可后续统一。
- `server/product-video.mjs` 与 `server/douyin-publisher.mjs` 各有一个同名小函数 `cleanText`，可并入 `lib/fs-utils.mjs` 或文本工具。
- `server/server.mjs:14` 启动期 `JSON.parse(await readFile('package.json'))` 若文件缺失会直接崩溃（启动期健壮性，low）。

## 四、验证记录
- `node --check` 全部通过：lib/fs-utils.mjs、server/automation-service.mjs、server/daily-production.mjs、server/product-source.mjs、server/bilibili-workflow.mjs。
- 模块加载冒烟：5 个被改模块均可 import，无顶层抛错；`hashFile`/`isInside` 正确导出。
- `node --test tests/bilibili-workflow.test.mjs`：**6/6 通过**（修复中曾误删 `createHash` 导致 6 失败，已回补 `digest()` 所需 import，复测全绿）。
- 06:00 修复功能性校验：`06:00`/`08:30`/`23:59` 均通过，`24:00`/`6:00`/`25:00` 正确拒绝；旧代码只允许 `06:00`。

## 五、让修复生效
当前 4174 端口运行的若是重组前加载到内存的旧 `server.mjs`，**不会自动读盘**。需重启：`taskkill` 占用进程后重新 `node server.mjs`（根 `server.mjs` 现是 2 行重定向到 `./server/server.mjs`）。bisk 真连抖音的端到端建议人工点检一次。
