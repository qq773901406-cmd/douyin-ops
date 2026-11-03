# 独立 DSH Worker

此实现使用官方 DeepSeek Harness 的 headless CLI，而不是自定义 shell 假装 DSH。控制层通过仅监听回环地址、带独立 Bearer 令牌的 bridge 接入。Windows 工作台本身不会启动代码执行进程。

官方契约依据：

- [CLI 帮助](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md)：`--profile headless --json --permission-mode workspace-write --approval-policy never`；通过 stdin 输入任务，使用真实返回的 `--session-id` 继续已有会话。
- [Headless 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)：成功须同时满足进程退出码 0 和最终事件 `reason.kind === completed`。完成工具调用不代表其内部测试通过。
- [JSON 事件实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/src/json-stream.ts)：使用 `session.sessionId` 和 `final.{sessionId,reason,text}`。

## 部署前提

当前代码和 fixture 测试不代表已部署或已调用真实模型。需要在独立 Linux VM/专用账户中安装官方 DSH 并配置自己的模型路由。此账户不能访问 Windows 磁盘、个人目录、浏览器状态或运营 runtime。WSL 必须关闭 Windows 驱动器挂载；单独工作目录、`isolated: true` 和 bridge 检查都不是 OS 隔离的替代品。

当前 bridge 与 DSH 子进程使用同一 Linux UID，环境变量白名单不保证该 UID 无法通过 `/proc` 或文件读取 bridge 身份、状态及其他任务。部署者还必须验证进程/文件系统沙箱，隔离可信 bridge 状态和执行进程；只在专用账户中启动这两个进程不构成完整安全边界。本期未验证这层隔离，因此保持关闭，不建议直接据此开启生产执行。

准备两个互不包含的目录：

- Worker 状态根：属于专用 Linux 用户，权限 `0700`，保存 Session、派工回执和工作目录。
- 净化源码快照：必须对应固定仓库的已核验 40 位基线提交，只包含允许的 UTF-8 源文件，不带 `.git` 历史、runtime、输出、依赖、密钥、浏览器状态、符号链接或硬链接。不要把宿主原仓库挂载给 Worker。快照材料及基线提交由可信控制侧准备并核对。

在可信 Windows 控制侧使用 `node scripts/superagent-export-source.mjs --out <尚不存在的目录>` 导出。可指定 `--repo <仓库根目录>` 与 `--commit <40位SHA>`；省略 commit 时先把 HEAD 解析为固定 SHA。脚本核对 origin，只通过 Git 对象读取此提交的允许文本源码，忽略未提交工作区及受限路径，拒绝链接、子模块、二进制和已识别凭据。它同时在源码目录外写入 `<out>.manifest.json`，记录文件校验和、固定提交与整体摘要，不覆盖任何已有导出。将快照和清单复制到隔离 Linux，启动时必须通过清单校验；快照和清单都应由可信操作者审查，不可让模型制作或重写。凭据扫描不能替代提交内容审查。

环境变量（值由本机操作者设置，不放进聊天、仓库或设置 JSON）：

| 变量 | 内容 |
| --- | --- |
| `SUPERAGENT_ISOLATED_WORKER` | `1`，声明已完成 OS 隔离 |
| `SUPERAGENT_WORKER_ROOT` | 状态根绝对路径 |
| `SUPERAGENT_WORKER_SOURCE` | 净化源码快照绝对路径 |
| `SUPERAGENT_WORKER_BASE_COMMIT` | 已核验的 40 位基线 SHA |
| `SUPERAGENT_WORKER_MANIFEST` | 导出清单绝对路径；默认 `<SUPERAGENT_WORKER_SOURCE>.manifest.json`，须位于源码与状态目录之外 |
| `SUPERAGENT_DSH_BIN` | 已安装官方 DSH 的物理可执行路径 |
| `SUPERAGENT_WORKER_TOKEN` | 至少 32 字符的随机 bridge 令牌，与控制侧一致 |
| `DEEPSEEK_API_KEY` | 仅此隔离 Worker 的模型密钥（如路由使用它） |

启动 `node integrations/dingtalk-superagent/worker-runner.mjs`。默认地址为 `http://127.0.0.1:4190`；不同 VM 需要由操作者建立可信的回环端口转发，不能改成公网监听。控制侧 worker 设置需 `enabled: true`、`isolated: true` 和该回环 endpoint，令牌仍只在环境变量中。

## 执行及交付

每 Ticket 复制一个净化源码工作目录。首次 DSH 会话的 ID 来自官方开场事件，保存后后续派工使用同一目录与 Session。源码快照改变后，不允许续用旧任务。一个任务同一时间只能有一个派工，默认最多两个任务运行。派工先落盘再启动，同一 ID 重发返回原回执，输入变化会拒绝。

Worker 只能修改和验证源码，不能持有 GitHub 凭据或推送/合并。子进程只接收固定 PATH、自有 HOME/DSH_HOME/TMPDIR 和独立模型密钥，不继承 bridge/钉钉/GitHub token、代理或云凭据环境变量。

DSH 必须返回结构化 `{status,summary,question?}`。`ready` 之后 bridge 从实际目录计算 `changes:[{path,content|null}]`，附上固定 `baseCommit`；最多 100 个文件、合计 1 MiB，只接受源文件白名单。模型声称的 PR URL 或 changes 不会作为证据。提交与 PR 必须由持有独立 GitHub 凭据的可信交付层完成。

停止会终止 DSH 进程组并等待退出后才释放槽位；工作目录保留。bridge 重启会将旧中断派工标记需要核对，不自动重复执行。如果旧进程 PID 仍存活，拒绝启动，避免两个执行器写同一目录。新派工可在核对后恢复原 Session。

## 验证范围及限制

`node --test tests/superagent-worker.test.mjs tests/superagent-export-source.test.mjs` 使用注入的进程 fixture 和临时 Git 仓库验证适配器契约、落盘、去重、会话恢复、权限检查、实际文件 diff、固定提交导出及清单校验；不调用真实 DSH 或模型。现场部署还需单独核验 DSH 版本、模型、Linux sandbox 支持与一次小型改动。

本期 headless bridge 在一轮结束后接续补充信息，不实现上游同一运行中 Session 的实时 inbox steering。新消息由控制层排队，正在执行的 Worker 可停止后续接。源码快照只接受文本；二进制资产、新的顶层目录及超过变更限额的任务需拆分或人工处理。模型报告中的测试证据仍需审查；进程成功不等于所有测试成功。
