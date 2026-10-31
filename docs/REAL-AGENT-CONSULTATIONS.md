# 本机真实多 Agent 咨询（#37）

实现 [#37](https://github.com/Slmplez/AgentRoom/issues/37) / [#23](https://github.com/Slmplez/AgentRoom/issues/23) 的冻结规则，仅本机单 owner。多个独立 Pi CLI 实例真实执行，各自使用登记的身份、模型、工作目录、Soul 与明确记忆。普通讨论和 `@` 不启动咨询；原任务唯一 Owner 保持不变。

## 启动与可信配置

先运行 `npm run build:renderer`，再启动：

```text
node server.cjs --persistent --data-dir .data/consult-demo --consultation-config C:/trusted/agents.json --port 4331
```

连接同一服务的桌面入口：`electron . --persistent --persistent-url http://127.0.0.1:4331/`。如果还需原任务的原生问题，可另加 `--agent-workspace <可信只读目录>`；`--agent-reports` 仍按原规则显式开启。默认启动不启用咨询。

宿主启动时读取一次 JSON，最多 20 个不同 Agent ID，文件不超过 64 KiB。工作目录相对配置文件定位。下面的地址、模型和环境变量名是配置示例，应替换为自己的模型服务配置；凭据值不写入此文件：

```json
{
  "version": 1,
  "agents": [
    {
      "id": "reviewer",
      "displayName": "代码审阅",
      "directory": "./workspace",
      "provider": "agent_room",
      "model": "your-model-a",
      "connection": {
        "baseUrl": "http://127.0.0.1:8000/v1",
        "protocol": "chat",
        "authMode": "bearer",
        "credentialEnv": "ADVISOR_A_KEY",
        "contextWindow": 128000,
        "maxTokens": 2048
      }
    },
    {
      "id": "architect",
      "displayName": "架构建议",
      "directory": "./workspace",
      "provider": "agent_room",
      "model": "your-model-b",
      "connection": {
        "baseUrl": "http://127.0.0.1:8000/v1",
        "protocol": "chat",
        "authMode": "bearer",
        "credentialEnv": "ADVISOR_B_KEY"
      }
    }
  ]
}
```

`connection.protocol` 支持 `chat` / `responses` / `anthropic`，`authMode` 支持 `bearer` / `api-key` / `none`。使用既有模型网关与 Pi provider 适配，每次执行创建独立回环网关和临时 provider 扩展，完成后清理；浏览器看不到上游凭据、路径、命令或环境变量。

也可以省略 `connection`，由 `provider` / `model` 选择 **Pi CLI 已配置好的** 模型服务。可选 `envBindings` 将宿主环境变量映射到支持的供应商凭据变量，例如 `{"DEEPSEEK_API_KEY":"REVIEWER_DEEPSEEK_KEY"}`。映射只影响该 Agent 的子进程，不修改宿主全局环境。配置文件不支持任意 CLI、工具或扩展路径。

所有咨询只开启 `read,grep,find,ls`，关闭自动扩展、Skills、提示模板和主题发现。只读工具限制不等于操作系统路径沙箱；本功能由可信本机 owner 使用。咨询不能发布报告、批准执行或发起子咨询；咨询引擎再请求原生输入时明确中止，提示另建完整问题。

## 界面

“Agent 咨询”区域可以创建独立问题，或选择当前任务的原生问题作为来源。也可从任务的“请 Agent 提供建议”进入。选择 1–3 位 Agent，填写问题和分析要求后显式发起。结果分别展示，真人可以采用一条建议或输入自己的决定。

来源由后端核对 Task、Run、Owner、questionId/revision 和存活的原生会话；来源任务目标、原问题和选项在创建时保存，咨询开始时再固定该咨询 Agent 的 Soul/记忆。所有快照可从建议卡查看，启动后的记忆更改不会改写本次提示。

采纳本身不是工具授权。只有真人明确决定，才在同一事务中记录决定、取消其他等待意图，并通过既有 `answerLocalQuestion` 路径记录原会话答复。原生会话已失效时保留决定并显示“未向旧会话投递”。原任务投递状态继续由原任务区展示。

修改问题/接收者需要撤销旧轮次再填写新一轮，不热改运行中的提示。提前决定时，尚未开始的咨询取消，运行中的咨询请求中止，晚到输出仅保留历史。已解析的决定不会被其他晚到建议覆盖。

草稿按 backend/database/owner/room 隔离；决定草稿关联问题 ID 和版本。咨询提交使用原有持久命令日志，先保存命令再发网络，响应丢失只核查原 key。刷新/重连不重放。原请求未核查时不能换 key 重复提交。普通聊天不会被未知咨询请求锁住。

## 队列、限额与恢复

- 每问题固定 1–3 个不同 Agent，每 assignment 仅预留并启动一次，总启动预算最多 3；深度 1、不递归、不自动重试。
- 持久 FIFO，跳过忙碌 Agent；咨询总占用槽最多 2、每 Agent 1，排队/暂停合计最多 20。
- 原本机任务也持有该 Agent 的执行槽，直至确认进程结束；`reviewing` 不提前释放。禁止向等待该问题答复的 Owner 自询而造成死锁。
- 若宿主恰在原任务 reviewing、进程尚未确认退出时重启，可信工厂登记的执行标记会保留。宿主仅在核查确认对应进程已停止后释放此终态槽，保留 reviewing 和原结果；枚举故障不释放，不会重跑任务。没有标记/可信核查器的旧执行不能据此推定结束。
- 执行最长 120 秒；问题自创建起 10 分钟有效，暂停不延长有效期。限制次数、并发和时限，不宣称能精确限制供应商金额或取消计费。
- 重启将 queued 变为 paused，已派发执行变为 unknown。未启动且未过期的项可明确恢复；已派发项不可恢复或重放。
- unknown 可以核查。宿主根据持久化的随机执行标记检查是否仍有对应 Pi 进程，不按旧 PID 杀进程；枚举失败保持未知。确认结束后才能放弃旧结果及释放执行槽。放弃不把未知结果改称失败；另建咨询需要新 ID 和新预算。
- 超时/取消只在 `isStopped` 确认结束后释放槽。派发后响应丢失，即使进程已经结束仍是 unknown。原生取消确认、进程结束和模型计费结束是不同事实。

调度只查询索引覆盖的排队、持有槽、到期和核查记录；不在每次 tick 扫描完整历史或历史上下文。

可信引擎工厂收到 `executionTag` 后必须转交 Pi 包装器；若提供 `inspectStopped`，必须核查同一标记。`close()` 和 `isStopped()` 是不同事实，不得将关闭函数返回等同于确认进程退出。后续产物/表单包装器需继续转交该参数。

## 契约和持久边界

`POST /api/v1/consultations/commands` 接收严格类型化命令，幂等标识只能来自 `Idempotency-Key` 请求头：

- `createConsultation`：workspaceId、roomId、title、instruction、agentIds、可选 source。
- `decideConsultation`：consultationId、expectedRevision、text 或 adoptedAssignmentId。
- `cancelConsultation`：consultationId、expectedRevision。
- `resumeConsultation` / `checkConsultation` / `abandonConsultation`：consultationId、expectedRevision、assignmentId。

`POST /api/v1/consultations/query` 支持 `consultations`、`consultation`、`consultationContext`。房间快照和 `consultation.updated` SSE 在同一 AgentRoomClient 投影；旧 revision 不覆盖新状态。Bootstrap 公开 `consultationAgents` 的 id/displayName/engine/model 与独立 `consultations` 能力。

SQLite schema 5→6 增加咨询、持久队列表和表达式索引，保持原消息、回执、产物和记忆。来源答复涉及的 Task/咨询状态、回执、多个事件在一个 ApplicationRuntime 事务内提交；事务提交后才派发外部执行。原任务仍使用已有真实等待与答复边界，为后续表单的记录/显式继续保留入口，不建立第二条根任务执行队列。

## 验证

- `node --test test/consultations.test.cjs`：真实 SQLite/认证 HTTP/公开双 Client，FIFO/并发/队列上限、不同 Soul、采纳竞争、原生管道继续、过期来源、取消/未知槽、重启与显式恢复、响应丢失不重发、CIM 故障、延迟结束和派发后不确定结果。
- `node --test test/consultation-durable.test.cjs`：真实后端/原生协议子进程，在回执、提交、预留、启动前后和结果返回后强杀，验证事务恢复及不自动重放。
- `npx electron scripts/verify-consultations-ui.cjs --disable-gpu`：生产可信配置装配、两个已安装 Pi CLI、独立模型/凭据/Soul/记忆、桌面/Web 同状态、原回执核查、草稿刷新、明确采纳/答复、取消、重启核查/放弃/恢复、快照逐字核对及深色窄屏。六次本地回环模型请求、零付费调用；这不计作外部供应商推理验收。
- 旧本机任务、记忆设置、报告、Mock 和持久讨论继续单独回归。
