# 钉钉版 Superagent 开发工作台

参考 https://github.com/deepseek-ai/dsh-superagent-prototype ，保留豆蜂业务层，新增独立开发任务控制层。默认关闭外部接入和代码执行；自动合并始终禁止。

## 本版已实现

- 任务核心：独立持久账本、事件去重、同任务补充信息、授权范围和版本、任务历史、配置历史及恢复。
- 任务流程：观察、排队、工作中、等待回答、待审核、完成、失败、受阻、停止；逐任务人工执行授权。
- 模型评估：本机 Ollama 结构化判断、任务和规则引用校验；评估结果可审阅，不能自行修改权限。
- 钉钉：官方 Stream SDK 适配，白名单校验、持久化后 ACK、连接状态、重连、原会话文本回传。
- GitHub：Issue/PR/评论/Review/CI 输入，提交、分支、草稿 PR、审查后更新原分支及结果评论。
- 独立 Worker：真实 DSH headless 协议、Session 续做、净化源码目录、派工回执、停止、实际源码差异提取。
- 可靠性：并发槽位、重启恢复、版本冲突、每次 GitHub 写入重新验证授权、未知外部结果禁止自动重放。
- 面板：任务、事件与评估、投递与运行、设置、历史观察五页签。

代码和模拟服务测试已完成。真实钉钉应用、模型、GitHub Agent 凭据及独立 Linux Worker 尚未配置，不能把本地验收当成线上连通或真实 AI 改码成功。

## 本地使用

在项目根运行 npm start，进入“AI 开发代理”（/#superagent）。旧服务需要重启才能加载新后端；应与正在执行的运营业务协调。

1. 登记本机请求，可以补充信息、搜索、查看授权、事件与历史。
2. 在设置配置已有的本机模型后执行评估；未配置时按钮明确不可用。
3. 切换手动执行模式、启用且通过健康检查的独立 Worker 后，逐任务“授权并排队”。
4. Worker 提问时补充信息，执行完成后查看报告或草稿 PR。审查后可继续同一 Session；更新分支前核对上一交付提交，禁止 force push。
5. 投递结果不确定时核对原会话，再选择“已核实送达”或“放弃此条”。只有明确失败允许重试。

原来的固定演示记录仍在“历史观察”。新工作流使用独立的 workflow.json，不把历史演示升级为执行授权。

## 模式与授权

mode=observe/manual 控制是否允许本机操作员授权执行，默认 observe。

acceptMode=off/observe/auto 控制候选评估：off 不评估；observe 记录 would_accept；auto 中命中规则的候选记录 accepted_pending_authorization，仍待人工执行授权。

模型的 attach/stop/ignore 是建议；实际关联通过明确任务编号或本机补充操作，停止由本机命令执行。原始任务范围固定，补充文字不自动扩大范围。这是本版有意采用的人工执行边界，与上游明确请求可直接执行的默认行为不同。

策略版本变化会请求停止本服务正在执行的 Worker，排队任务和外部交付也重新检查授权。若远端停止结果未知，历史中保留提示，需人工核对。取消后的任务不会因新消息自动恢复。

## 配置与凭据

在“设置”编辑非敏感配置。保存采用版本检查，恢复生成新版本；轮询不覆盖未保存草稿。页面不收集或返回密钥。

| 环境变量 | 进程 | 用途 |
| --- | --- | --- |
| DINGTALK_CLIENT_SECRET | 工作台 | Stream 应用密钥 |
| SUPERAGENT_GITHUB_TOKEN | 工作台 | 固定仓库的 GitHub Agent 权限 |
| SUPERAGENT_WORKER_TOKEN | 工作台及独立 Worker | 一致的随机身份令牌，至少32字符 |
| DEEPSEEK_API_KEY | 独立 Worker | 根据官方 DSH 模型配置使用 |

钉钉需要企业内部应用、Stream 机器人、corpId、ClientId、允许用户的 userId；群聊还需 conversationId。群消息同时要求人员、群白名单及真实 @机器人。缺失员工身份、跨企业和非文本消息拒绝。SDK 动态加载 dingtalk-stream；本次未安装依赖，部署时先核对官方注册表版本，固定安装并保存 lockfile。官方源码地址：https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs 。

模型使用本机 Ollama /api/chat，填写已有可用模型名；地址仅接受本机 HTTP 根地址。配置成功不等于调用已成功，运行页展示最近一次结果。

GitHub 固定为 qq773901406-cmd/douyin-ops，使用专门 Agent 账号及仅该仓库需要的权限。GitHub 入站保存为候选或上下文，不自动授权执行或发布回复。改动最多100个文本文件、1 MiB；禁止 runtime、凭据、浏览器状态、Git元数据和GitHub工作流等路径。GitHub令牌不传给Worker。

Worker部署见 [WORKER.md](WORKER.md)。要求独立非root Linux用户/VM、无宿主Windows盘挂载；不得共享宿主.git或运行数据。部署声明不替代隔离验收。

净化源码导出使用 scripts/superagent-export-source.mjs：必须指定全新 --out，默认解析HEAD，也可明确指定40位commit。只读取允许源码，外部manifest记录基线和逐文件哈希；Worker启动时核验。导出不包含未提交代码，因此待运行版本应先经过正常审查提交并同步到目标仓库。

## 持久化与恢复

数据根为 DOUFENG_DATA_DIR，默认项目 runtime；开发代理记录在其中 dingtalk-superagent 目录。

- workflow.json / .bak：任务、配置、授权、输入、判断、报告、GitHub游标和投递记录。
- tickets.json：初版观察记录；local-demo/dingtalk-superagent/tickets.json：初版固定演示。

仅确认写进程已退出后回收残留锁。损坏文件不静默重建。中断派工标记受阻；先核对Worker、分支和PR，再人工重试。投递时进程退出记为uncertain，保留证据而不自动重发。容量满时暂停新增，不删除去重记录。

## 主要模块

workflow-settings.mjs 校验配置；workflow-store.mjs 管理持久状态；workflow-service.mjs 负责调度。assessor.mjs、stream-client.mjs、outbound-transport.mjs、github-source.mjs、github-delivery.mjs 为外部适配器。dsh-executor.mjs 是认证客户端；worker-runner.mjs 是独立Linux服务端。

API根为 /api/superagent/workflow。GET读取；POST /requests登记；POST /tickets/:id/queue|stop|retry|evaluate|complete操作任务；PUT /settings、POST /pause、POST /settings/restore维护配置；POST /outbox/:id/reconcile核对投递。写操作要求JSON，任务与配置操作需要对应If-Match。任意外部来源不能通过HTTP伪造身份。

## 验证

运行 npm run check，然后运行 node --test tests/superagent-*.test.mjs tests/dingtalk-*.test.mjs tests/server.test.mjs tests/operations-http.test.mjs 。

测试使用临时数据、模拟Stream/Ollama/GitHub及模拟DSH进程，不发送真实消息或创建真实PR。真实模型、机器人、Linux隔离和GitHub交付，需要账号及环境准备好后另行验收。

当前使用文本回传与工作台操作，尚无钉钉互动审批卡片。执行中的DSH不会即时注入补充消息；输入留到下一轮处理。不会自动开放已有抖音/B站发布任务，也未启用自动合并。
