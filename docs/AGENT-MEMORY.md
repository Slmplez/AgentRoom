# 独立 Soul、明确记忆与任务启动快照

对应规格 [#30](https://github.com/Slmplez/AgentRoom/issues/30)、持久管理 [#31](https://github.com/Slmplez/AgentRoom/issues/31)、固定加载 [#32](https://github.com/Slmplez/AgentRoom/issues/32) 和管理界面 [#33](https://github.com/Slmplez/AgentRoom/issues/33)。真实持久 API、任务启动快照、桌面/Web 管理界面均已实现。

不使用 RAG、向量或相关度检索。Soul 按稳定 Agent ID 保存；个人记忆与房间记忆分别保存。改变显示名或模型不改变身份。

当前分支已将原始记录与任务加载预算分开：原始记录无 16 条数量上限，每条最多 2048 字符，并支持分页。后台 Agent 自动整理的独立模块、专用模型配置和设置控制器见 [#43](https://github.com/Slmplez/AgentRoom/issues/43) 与 [整理方案](MEMORY-CURATION-PLAN.md)；共享 runtime/HTTP/Client/宿主接线尚未完成，当前不能宣称生产自动整理已启用。

## 宿主与授权

`createApplicationRuntime({ directory, execution, knownAgents })` 使用同一个 `application.sqlite`。`knownAgents` 是宿主传入的可信字符串 ID 数组，默认使用 `execution.agentId`（无执行配置则为空）。HTTP 无登记身份、编辑执行配置或传入作者身份的入口。bootstrap 返回 `capabilities.agentMemory` 与 `knownAgents`。

仅支持已有的本机单 owner 会话；调用者来自认证 HTTP，不接受请求正文指定 caller。每次命令、查询、历史和回执读取都校验 owner/workspace，以及登记 Agent 或 Room 成员范围。两个测试 Agent 的隔离不表示已经实现多 Agent 执行或多人登录。

## HTTP Interface

独立持久后端的既有 loopback listener 提供：

- `POST /api/v1/agent-memory/commands`：JSON 命令；`Idempotency-Key` 请求头必填，正文不得包含 `key`。
- `POST /api/v1/agent-memory/query`：JSON 查询，不产生写入或回执。
- `GET /api/v1/rooms/:roomId/local-tasks/:taskId/context`：查询该 Task/Run 实际启动快照，严格验证任务所属 Room。
- 既有 `GET /api/v1/operations/:operationId` 或按 workspace/commandType/key 查询原命令回执。

沿用既有 Bearer 认证、Host/Origin 校验和 128 KiB 请求体上限；不开放任意 runtime 命令。桌面/Web 的 cookie 代理已转发这些明确记忆路径；不要在页面直接访问后端或复制令牌。新的自动整理控制路径仍待 #43 共享入口接线。

命令和查询的严格 schema 在 `contracts/agent-memory.mjs`。例：

```json
{
  "type": "editAgentSoul",
  "workspaceId": "<bootstrap workspace id>",
  "agentId": "local-pi",
  "expectedRevision": 0,
  "personality": "冷静、审慎",
  "expression": "简洁、直接",
  "workStyle": "先核实证据，再给结论"
}
```

```json
{
  "type": "saveExplicitMemory",
  "workspaceId": "<bootstrap workspace id>",
  "scope": { "kind": "agent", "agentId": "local-pi" },
  "text": "用户偏好先给结论，再解释依据。",
  "source": { "kind": "owner-note" }
}
```

命令还包括 `correctExplicitMemory`、`forgetExplicitMemory`：传 `scope`、`memoryId`、`expectedRevision`，更正另传 `text`。来源、Memory ID、修订和作者由后端维护。

查询为 `agentSoul`、`agentSoulHistory`、`explicitMemories`、`explicitMemoryHistory`，均带 workspaceId 和相应 Agent/scope。原始记录列表默认 20、最大 100，按稳定 ID 顺序通过 `afterId` 继续，返回 `total` 与下一页游标；历史分页默认 20、最大 100，通过返回的 `beforeRevision` 继续。列表分页不是跨多个请求冻结的一致性快照；并发新增在游标之前的记录通过刷新列表读取。未配置 Soul 返回 `configured:false, revision:0`，不生成假个性。

## 来源、修订与停用

`owner-note` 保存 owner 明确输入的文本、服务端作者和时间。消息来源要求 `{kind:"message", messageId, revision}`，且只能保存到消息所属 Room；后端读取完整原文和作者/时间，不接受客户端伪造原文或把消息隐式复制为跨房间的 Agent 记忆。

同一消息版本在同 scope 中复用一个稳定 Memory；新 key/相同内容返回现有实体，新内容要求明确更正。更正追加 owner-note 来源和修订，不覆盖原始消息快照。来源保存内容 hash，读取历史时检查完整性；它不是第三方事实真实性证明，也不能防止本机文件管理员篡改。

停用同事务记录 deleted 修订与所有关联来源的墓碑。之后旧 update 或同消息来源换 key 重放均不能恢复。原 key/原内容返回原回执，表示当时的操作成功，不代表当前仍 active；客户端应重新查询当前状态。新写一份 owner-note 是一次新的主动保存，不是恢复旧来源。首版无 restore 操作。

“停用”不抹除原文、历史或 M2 已冻结的任务上下文，不能声称彻底擦除或使模型遗忘。原始记录不设置每 scope 的条数上限，每条最多 2048 Unicode code points；Soul 三字段合计 2048。超长内容明确拒绝，不自动裁剪。整理 Module 的归档仅改变有效记忆投影，保留原始记录、来源、版本和人工停用墓碑。

## 任务固定加载与版本兼容

`queued → dispatching` 的同一事务读取当前有效 Soul 与记忆上下文，保存 `run_context_snapshots` 并给任务设置 `contextSnapshotId`。旧 v1 快照维持原来的每范围 16 条、每条 256 字符、按 ID 排序的格式和完整原文，读取时不升级、不改 hash。

新快照写为 v2。个人和当前 Room 各有最多 16 项、8192 Unicode 字符预算；在可选整理提供者未接线时，按修订时间、ID 降序确定性加载原始记录。接线后通过 `agentMemory(db, {curationContext})` 读取整理 Module 的上下文，优先加载尚未整理的最新记录，再加载仍有效的摘要。快照分别记录 `memoryContexts` 中实际加载的内容、原始 ID/修订、摘要的整理 run ID、字符数、`deferred` 未加载项数和 `stale` 失效摘要数；没有相关度选择或查询文本。

快照包含 Task/Run/Agent/Room、Soul 内容和 revision、原始记录的 ID/revision/来源 IDs、v2 的有效记忆上下文、`contextText` 以及最终发送的完整 `prompt`。来源原文和历史修订不进入提示；它们仍可由管理 API 核查。存储用 hash 检查损坏，身份必须与 Task/Run 一致，不宣称防止本机文件管理员重写整个数据库。

提交成功后才创建并启动引擎，`engine.prompt()` 直接使用已提交快照的 `prompt`，不重新读取当前记忆。任务 goal 在任务记录中保持原文，作为提示的独立末段。没有 Soul/记忆时 `contextText` 为空，发送的 prompt 就是原 goal；未配置个性不会被自动编造。

修改与开始按 SQLite 提交顺序生效：修改先提交，新任务载入新版本；启动快照先提交，本次任务保持旧版本。原生问题答复继续同一引擎和快照。停用后仍可核查旧快照，不声称撤回已经交给模型的内容。

快照冻结时再次检查本次所选内容的文本预算、Soul 修订、每个摘要依赖的原始版本、来源完整性和墓碑。所选配置损坏或所选版本不匹配则明确 failed，且不启动引擎；正常预算外的记录通过 `deferred` 明确计数，不会从存储中删除。数据库提交结果不确定、进程中断及已派发后的失败仍遵循既有 unknown/不自动重放规则。

查询结果遵循 `contracts/run-context.mjs`：`available` 返回实际快照；尚未开始的 queued/paused 任务返回 `not_started`；没有历史记录的旧任务或未生成快照的失败返回 `not_recorded`。已标记有快照却缺失/损坏时返回 `context_unavailable`，不能伪造空内容。快照正文不会进入 Task SSE，只附加可选的 `contextSnapshotId`。

Soul 和记忆不能改变可信宿主的 CLI 参数、只读工具集合或报告发布能力。配置内容作为偏好/背景提示使用；代码中的工具限制仍独立执行，文本分隔符不被当作权限控制。

## 事务、事件与迁移

状态、Source、修订、来源关联/墓碑、元数据事件和幂等回执都由 ApplicationRuntime 同一事务提交。提交前失败全部回滚；提交后响应丢失可用原 key 查询，不需要猜测或生成新 key。

M1 将 schema 从 3 迁移到 4，M2 在 schema 5 添加启动快照表；保留原消息、任务、产物、记忆、日志位置和回执。Soul/agent 命令的 Room 为空，不借用虚构 Room；迁移允许相应事件/回执的 `room_id=NULL`。旧版后端不能读取新的 schema。迁移检查外键，失败回滚；启动拒绝未知的新 schema。

记忆事件只有实体标识、scope、revision 和状态，没有正文。现有 Room SSE/事件查询不发送新记忆事件，仍正常推进 checkpoint；管理能力依靠成功回执和显式重读，不承诺多窗口实时同步。没有第二个数据库或独立事务拥有者。自动整理的运行 ledger、投影与来源确认由既有事务 seam 原子提交；其后台模型调用在宿主接线前不会启动。

## 桌面与 Web 管理（M3）

持久模式中打开左下角设置，选择“记忆”分类，在同一设置对话框内管理 Soul、个人记忆和当前 Room 记忆。归属选择器只使用后端 `knownAgents` 和当前真实 Room，不把演示成员映射为持久身份。无记忆能力的模式不显示入口，Client 拒绝通过 Mock 保存真实记忆。

Soul 三个字段分别编辑；记忆支持手动记录，以及选择当前已加载的讨论消息作为来源，明确填写原始记录后保存；列表展示总数并可继续分页。更正保留旧版本，停用前显示对未来任务的影响。来源与历史按需分页读取，最近选中的记忆历史在刷新后仍可打开，包括已经停用的记忆。原始记录列表不展示旧版本。可选的 `MemoryCurationBridge` 接入设置控制器后展示有效摘要和整理历史；配置、进程核查与结果恢复必须继续通过 Client 的原请求日志，不由页面直接通信或轮询。

所有业务读写通过 AgentRoomClient。草稿按 backend/database/owner/workspace/scope/entity/revision 保存在界面本地；已提交命令仍由 Persistent Adapter 的独立持久日志管理。网络提交前写日志，刷新只查询原回执。草稿保留原请求标识，核查成功后重新读取当前状态；历史回执不会重新启用记忆。未找到原请求时，用户可明确重试原内容和原 key。版本冲突保留草稿；读取当前版本后必须明确选择继续编辑旧草稿或使用当前内容。

面板打开、重新连接和本窗口操作成功后查询当前配置。其他窗口使用“刷新当前状态”，没有新增记忆 SSE 或轮询 Store。任务卡片的“任务启动时的 Soul 与记忆”按需读取冻结快照，列出版本、来源引用和实际发送的完整提示；来源历史也可按需读取。当前管理配置与已启动快照分别展示。

## 界面验证

`test/agent-memory-client.test.cjs` 通过公开 Client、真实 SQLite 和认证 HTTP 验证两个 Agent/两个 Room、版本冲突、消息来源分页、更正停用、容量/Unicode、重启及旧回执不复活记忆。

`electron scripts/verify-agent-memory-ui.cjs --disable-gpu` 使用真实 cookie 宿主及桌面/Web 界面，验证 Soul 与记忆编辑、两个登记 Agent/两个 Room 的草稿隔离、来源原文、双窗口冲突、响应丢失、停用后核查、刷新/重启、Unicode/IME/焦点和明暗主题窄屏。第二 Room 由测试夹具选择 bootstrap 房间，不扩展生产房间管理入口。

该脚本还启动已安装 Pi CLI，等待原生 input 期间修改 Soul/停用记忆，再答复并逐字比较模型请求和界面展示的冻结 prompt。推理使用本机回环夹具，每次验证 1 次本地请求、0 付费请求；它验证真实 CLI 协议与上下文传递，不评估外部模型的个性遵从能力。

## 后端验证

`npm test` 覆盖真实 SQLite、authenticated HTTP、双 Agent/双 Room、来源保真、Unicode/容量、并发修订冲突、幂等回执、重启和删除重放。12 项子进程故障测试在 save/correct/forget 的 entity/event/receipt/commit 节点强制终止后端，验证全有或全无以及原 key 核查。

`test/fixtures/persistence-v3.sql` 由基线 `caaea30435ae5429e01002bbe98bff79eb8226f8` 的实际运行时通过合成消息、Task、报告发布生成；包含真实格式的历史事件和回执，不含用户聊天或凭据。迁移后逐项对比数据、报告和游标，并验证损坏旧库的迁移回滚。样例个性存储不构成长期模型个性遵从的保证。

M2 的 `test/run-context*.test.cjs` 覆盖开始前/后的更正停用、双 Agent/Room 隔离、预算内 32 项加载、空配置、坏数据拒绝、迁移和重启。`test/memory-evolution.test.cjs` 另验证 55 条原始记录分页、2048 Unicode、8192 字符加载预算、未加载计数、整理摘要可选接入及 v1 字节/回执/hash 保真。真实子进程分别在快照前、事务内和提交后强制终止，验证快照与 dispatching 全有或全无，重启不派发；已等待原生输入的中断也保留旧快照。

`node scripts/verify-local-agent.cjs --memory-context` 使用已安装 Pi CLI、原生 input、authenticated HTTP 答复和受控回环推理，逐字核对提供给模型的 prompt 与快照一致；任务运行中编辑 Soul/停用记忆后仍发送原版本，并确认记忆文本不能增加 bash/write 工具。该验证为真实 CLI 集成证据，只有 1 次本地模型夹具请求、0 付费请求，不是外部模型个性遵从评测。

`test/fixtures/memory-v1.sql` 与对应 expected JSON 由提交 `df37e96a730b6df15ec62843cfd52d75758b11a9` 的实际运行时、合成 Soul/记忆/任务生成，未使用付费模型或用户数据。新版读取原 v1 payload 与 content hash 完全不变；用原 key/原命令重放返回原 receipt 和 request hash，不生成重复记录。
