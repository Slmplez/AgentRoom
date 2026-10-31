# 后台 Agent 自动整理记忆

规格：[GitHub #43](https://github.com/Slmplez/AgentRoom/issues/43)。用户已明确：后台有一个 Agent，可以自行整理；不要求逐条人工确认。不使用 RAG 或向量召回，每个 Agent 的 Soul 保持独立。

## 交付状态与分工

已完成原始记录容量/分页、schema 9 生产迁移、认证命令与查询、Client 原请求日志、可信宿主配置、后台调度、v2 任务上下文和设置入口。无需逐条确认整理结果。未提供专用模型配置时，设置明确显示“尚未配置后台整理 Agent”；配置后各合法记忆范围默认自动整理，可分别暂停。

工作副本 `E:/Repo/ASCET/agent-chat-desktop-memory-curator`，分支 `codex/memory-curator`。已合入附件/表单整合基线 `568d19c`，保留 #38/#39 行为；main 与 ADR7/8 由协调任务管理。交付提交由协调任务继续合入，本文不表示用户当前运行的旧服务已热更新。

当前验收：完整 `npm test` 319 项通过；TypeScript、Client 边界与 renderer 构建通过。生产 Web/桌面、真实 Pi 和本地推理端点通过，1 次回环调用、0 付费调用。原持久记忆 UI 验证另外覆盖 55 条分页交错、原回执、草稿、停用和冻结 prompt。v1 夹具验证原 payload/hash/receipt 保真。

## 记录与有效记忆分开

- 原始记录沿用 Explicit Memory 的 ID、版本、来源和停用墓碑。后台整理绝不改写这些记录；人工更正仍追加修订，人工停用保持原语义。
- 有效记忆是独立的整理结果。每条包含文本、理由、来源 Memory ID/修订和整理 run ID。一次模型回复必须将所有输入各处理一次：合并到某条摘要，或者说明为什么归档。禁止遗漏、未知引用和重复引用。
- 归档表示某项结论退出有效记忆，不删除原始来源。历史保留当时输入、输出、理由、Agent ID、模型标识、执行 tag、时间、状态和 hash。可通过明确更正原始记录将新证据重新进入整理队列；此切片没有伪装成“撤销”的旧结果重放操作。
- 已归档且未变化的记录不再次自动进入上下文。更正或停用某条来源后，所有依赖旧版本的摘要立即失效。有效来源重新排队，按批次重建；已停用来源不交给模型。
- 本切片整理的是明确保存的记忆，不把所有讨论、文件或模型自行生成的内容自动当成事实。自动从任务结果提炼新的候选记忆属于后续独立行为，不能借整理权限隐式跨范围采集。

这种实现不需要让模型直接写 SQLite，也不需要检索查询或相似度计算。模型只产生受限的整理计划，Module 验证并提交结果。

## 固定预算

| 项目 | 首版预算 |
| --- | --- |
| 全局并发 / 单归属并发 | 1 / 1；持久 lease 未确认停止前不释放 |
| 调度间隔 | 宿主每 60 秒检查；全局两次启动至少间隔 10 分钟 |
| 启动预算 | 滚动 1 小时最多 6 次，滚动 24 小时最多 24 次，SQLite 持久计数 |
| 单轮 | 最多 32 条新/待重整记录 + 最多 16 条当前摘要 |
| 模型输入 / 输出 | 各最多 64 KiB；输入不足以容纳 32 条时缩小批次 |
| 摘要文本 | 最多 16 条，每条最多 1024 Unicode code points，总计最多 8192 |
| 当前摘要的来源引用 | 合计最多 10000 个唯一 Memory ID/修订；超出则拒绝计划，不截断依据 |
| 执行 | 120 秒上限，关闭等待和停止检查各最多 1 秒 |
| 进程核查 | 最多 5 秒；错误或未知仍持有 lease |
| Pi | 独立临时工作目录和配置；无工具/MCP；关闭自动重试、自动压缩、缓存保温 |
| 生产模型装配 | 显式配置模型；输出 token 上限不超过 8192；不继承任意聊天的可写工具或模型权限 |

没有新证据时不再次调用模型。打开设置、查看历史或启动普通任务均不触发模型调用。内部 Module 提供 `tick()`；ApplicationRuntime 的维护定时器和提交后的唤醒负责调度，启动恢复后接收请求，关闭时封住迟到结果。

## Interface 与提交顺序

`createMemoryCurator({ db, atomic, engine, allowedScope, clock, checkpoint })` 是内部 Module；`engine` 可为空，存在时必须提供可信 `agentId`、`model`、`createEngine`，并可提供 `inspectStopped`。`allowedScope` 由宿主绑定当前 owner、登记 Agent 和 Room 成员关系，HTTP 不能提供这个函数或执行配置。

Interface：`recover()`、`tick()`、`configure(scope, {enabled, expectedRevision})`、`inspect(scope, runId)`、`status(scope)`、`context(scope)`、`history(scope, page)`、`shutdown()`。

`atomic` 是现有 ApplicationRuntime 的同步事务 seam；回调不跨 `await`。公开授权、幂等命令回执、事件、查询契约和宿主生命周期继续归 ApplicationRuntime 管理。前置切片测试用真实 SQLite 实现相同事务行为，没有第二个生产事务拥有者或数据库。

1. 调度在事务内检查启用状态、scope、全局 lease、滚动预算和该设置版本下是否有失败/未知结果。发现失效摘要时移除其有效投影并持久排队仍有效的来源。
2. 同事务持久化 run、确切输入、输入 hash、设置版本、投影版本、execution tag 和 lease。提交后才创建引擎。
3. Pi 在独立目录执行，无工具；只读取传入的记忆文本。额外输入请求直接失败。
4. 完成后关闭引擎，确认进程停止。只有明确 `complete` 和停止事实齐备，才解析、检查模型输出；限制不是靠提示词保证。
5. 提交事务再次检查设置版本、投影版本以及全部依赖的原始修订和来源完整性。任何并发修改使整轮结果 `stale`，不覆盖新事实。
6. 有效摘要、已处理来源游标、队列确认和 run 输出在一个事务里提交。来源、Soul 和旧任务快照保持不变。

中断、超时、断连或提交不确定记录为 `unknown`，不自动重放。未确认停止时全局执行槽保留；核查只能解除进程占用，不能把未知结果变成成功。原范围仍需要明确的新设置版本才能重新整理。用户暂停只阻止后续应用和调度；已经发出的模型请求可能运行至关闭/超时，但其结果不会在暂停后生效。

## 生产装配

- schema 9 在 schema 8 上原子增加整理表与核查请求，原命令哈希、回执、快照和附件/表单保持兼容。
- `/api/v1/memory-curation/query` 提供状态和分页历史；`/api/v1/memory-curation/commands` 提供版本化配置和进程核查。仅当前 owner 可以访问登记 Agent 或可访问 Room。
- 配置和核查通过统一 command receipt 边界；Client 提交前持久记录原命令，重连只查回执。核查命令先保存请求，事务外执行限时停止检查，崩溃后可继续这一只读核查，不重放模型请求。
- 新任务通过 `context(scope)` 优先加载尚未整理的最新记录，再加载有效摘要。每个范围最多 16 项、8192 字符、10000 个来源引用；放不下整项计入 `deferred`，不能截断摘要来源。Soul 使用独立预算。
- 设置显示原始记忆分页、整理员/模型、启用/暂停、状态、待处理量、摘要来源和完整整理历史。页面只使用公开 Client；进入/重连/本窗口操作后读取，其他窗口或后台完成后可用“刷新整理状态”。
- 首版整理明确保存的记录，不自动提炼所有对话/文件。没有 RAG、向量检索或模型直接写库。

## 已验证证据

`node --test test/memory-curation.test.cjs`：18 项通过，其中包含 4 个真实子进程退出点；覆盖合并/归档、独立 Soul、无变化无调用、范围隔离、并发设置和来源变更、删除不复活、伪造/重复/遗漏引用、Unicode/批次预算、滚动每日预算、持久化 lease、未知不重放、超时及迟到回复、事务回滚、历史/来源损坏、未配置状态和重启。

`node scripts/verify-memory-curator.cjs`：真实安装的 Pi CLI、流式本地推理端点、真实 SQLite；核对传出的确切 prompt、零工具、来源引用、自动应用及 Soul 不变。1 次本地请求，0 次付费调用。

`node scripts/verify-memory-curator.cjs --failure`：真实 Pi 收到 HTTP 503；只产生 1 次本地请求，无内部自动重试、无摘要应用，0 次付费调用。这验证了执行协议和预算行为，不证明外部模型的语义整理质量。

## 已准备的宿主配置与展示模块

`loadMemoryCuratorConfig(file)` 仅由可信宿主启动时调用，返回专用引擎配置。文件最多 64 KiB，不能携带任意 argv、工作目录、扩展路径或明文密钥。密钥通过 `credentialEnv` 引用已有环境变量，在宿主网关使用，不进入可序列化配置或页面。读取配置不会启动进程、模型请求或凭据发现。正式启动器 `scripts/serve-persistence.cjs` 与 `scripts/start-persistence-server.cjs` 支持 `--memory-curator-config <trusted-json>`；`startPersistentHost` 接受 `memoryCuratorConfig`。专用连接不改写现有聊天模型配置。

```json
{
  "version": 1,
  "agentId": "memory-curator",
  "displayName": "记忆整理员",
  "model": "<明确的模型 ID>",
  "connection": {
    "baseUrl": "https://your-gateway.example/v1",
    "protocol": "chat",
    "authMode": "bearer",
    "credentialEnv": "AGENTROOM_MEMORY_API_KEY",
    "contextWindow": 128000,
    "maxTokens": 8192
  }
}
```

`MemoryCurationSection` 是独立展示模块：显示启用/暂停、待处理数量、原进程核查、明确允许重新整理、摘要来源与历史归档理由。它不直接 fetch、轮询、保存凭据或生成命令 key。由 Settings/Client controller 按 backend/database/owner/scope 挂载，持有正确的查询状态和幂等日志，不能跨归属复用历史。`memory-curation-view.mjs` 提供当前 Module 返回值对应的严格只读 schema。

补充验证：

- `node --test test/memory-curation.test.cjs test/memory-curator-config.test.cjs`：21 项通过（18 项整理 + 3 项配置），实际 Module 状态与历史通过展示契约解析。
- `node scripts/verify-memory-curator.cjs --configured`：配置文件 → 宿主网关 → 真实 Pi → SQLite 自动应用完整通过；读取配置零请求，整轮 1 次本地请求、0 次付费调用。
- `npm run check:chat`：设置展示 TypeScript 检查通过。
- `electron scripts/verify-memory-curation-section.cjs --disable-gpu`：独立展示夹具验证暂停/重新开始意图、lease 控制、忙碌禁用、历史来源、跨 scope 卸载、未配置状态、窄屏深色布局。0 次生产 API/模型调用；这不是正式设置接入验收。
- `node scripts/verify-memory-curator.cjs --configured --oversize`：真实 Pi 输出超过 64 KiB 时在流式事件中停止执行，不等到最终 JSON 应用；1 次本地请求、无重试、无摘要应用，0 次付费调用。Adapter 也在派发前检查实际输入字节数。


生产启动示例（需先设置配置引用的凭据环境变量）：

```powershell
node scripts/serve-persistence.cjs --data-dir E:/AgentRoomData --port 4331 --memory-curator-config E:/AgentRoomConfig/memory-curator.json
```

该配置允许整理当前 Room。登记 Agent 的独立记忆仍使用既有宿主配置：例如 `--agent-workspace` 登记 `local-pi`，或可信咨询配置登记对应 Agent ID。整理员的执行身份不会冒充这些 Agent，也不会修改其 Soul。

生产验证：`node --test test/memory-curation-runtime.test.cjs` 覆盖调度、权限、原请求恢复、未知结果核查及冻结快照；`electron scripts/verify-memory-curation-ui.cjs --disable-gpu` 使用正式启动器、真实 Pi、SQLite 与 Web/桌面公开 Client。配置加载零模型请求；有新记录且已启用时由后台执行。
