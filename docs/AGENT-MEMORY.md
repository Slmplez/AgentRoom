# 独立 Soul 与明确记忆（M1）

对应规格 [#30](https://github.com/Slmplez/AgentRoom/issues/30)、实施 [#31](https://github.com/Slmplez/AgentRoom/issues/31)。本阶段交付真实持久 API；任务固定加载属于 #32，产品管理界面和桌面/Web 宿主代理路由属于 #33，尚未在本阶段实现。

不使用 RAG、向量、全文检索、模型抽取或自动写入。Soul 按稳定 Agent ID 保存；个人记忆与房间记忆分别保存。改变显示名或模型不改变身份。

## 宿主与授权

`createApplicationRuntime({ directory, execution, knownAgents })` 使用同一个 `application.sqlite`。`knownAgents` 是宿主传入的可信字符串 ID 数组，默认使用 `execution.agentId`（无执行配置则为空）。HTTP 无登记身份、编辑执行配置或传入作者身份的入口。bootstrap 返回 `capabilities.agentMemory` 与 `knownAgents`。

仅支持已有的本机单 owner 会话；调用者来自认证 HTTP，不接受请求正文指定 caller。每次命令、查询、历史和回执读取都校验 owner/workspace，以及登记 Agent 或 Room 成员范围。两个测试 Agent 的隔离不表示已经实现多 Agent 执行或多人登录。

## HTTP Interface

独立持久后端的既有 loopback listener 提供：

- `POST /api/v1/agent-memory/commands`：JSON 命令；`Idempotency-Key` 请求头必填，正文不得包含 `key`。
- `POST /api/v1/agent-memory/query`：JSON 查询，不产生写入或回执。
- 既有 `GET /api/v1/operations/:operationId` 或按 workspace/commandType/key 查询原命令回执。

沿用既有 Bearer 认证、Host/Origin 校验和 128 KiB 请求体上限；不开放任意 runtime 命令。桌面/Web 的 cookie 代理目前尚未转发新路径，M3 需在其文件交接后接入；不要在页面直接访问后端或复制令牌。

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

查询为 `agentSoul`、`agentSoulHistory`、`explicitMemories`、`explicitMemoryHistory`，均带 workspaceId 和相应 Agent/scope。历史分页默认 20、最大 100，通过返回的 `beforeRevision` 继续。未配置 Soul 返回 `configured:false, revision:0`，不生成假个性。

## 来源、修订与停用

`owner-note` 保存 owner 明确输入的文本、服务端作者和时间。消息来源要求 `{kind:"message", messageId, revision}`，且只能保存到消息所属 Room；后端读取完整原文和作者/时间，不接受客户端伪造原文或把消息隐式复制为跨房间的 Agent 记忆。

同一消息版本在同 scope 中复用一个稳定 Memory；新 key/相同内容返回现有实体，新内容要求明确更正。更正追加 owner-note 来源和修订，不覆盖原始消息快照。来源保存内容 hash，读取历史时检查完整性；它不是第三方事实真实性证明，也不能防止本机文件管理员篡改。

停用同事务记录 deleted 修订与所有关联来源的墓碑。之后旧 update 或同消息来源换 key 重放均不能恢复。原 key/原内容返回原回执，表示当时的操作成功，不代表当前仍 active；客户端应重新查询当前状态。新写一份 owner-note 是一次新的主动保存，不是恢复旧来源。首版无 restore 操作。

“停用”不抹除原文、历史或未来 M2 已冻结的任务上下文，不能声称彻底擦除或使模型遗忘。每 scope 最多 16 条 active，每条 256 Unicode code points；Soul 三字段合计 2048。超限明确拒绝，没有自动裁剪、摘要或淘汰。

## 事务、事件与迁移

状态、Source、修订、来源关联/墓碑、元数据事件和幂等回执都由 ApplicationRuntime 同一事务提交。提交前失败全部回滚；提交后响应丢失可用原 key 查询，不需要猜测或生成新 key。

数据库 schema 从 3 迁移到 4，保留原消息、任务、产物、日志位置和回执。Soul/agent 命令的 Room 为空，不借用虚构 Room；迁移允许相应事件/回执的 `room_id=NULL`。旧版后端不能读取 schema 4。迁移检查外键，失败回滚；启动拒绝未知的新 schema。

记忆事件只有实体标识、scope、revision 和状态，没有正文。现有 Room SSE/事件查询不发送新记忆事件，仍正常推进 checkpoint；管理能力依靠成功回执和显式重读，不承诺多窗口实时同步。没有第二个数据库、独立事务拥有者或后台模型调用。

## 验证

`npm test` 覆盖真实 SQLite、authenticated HTTP、双 Agent/双 Room、来源保真、Unicode/容量、并发修订冲突、幂等回执、重启和删除重放。12 项子进程故障测试在 save/correct/forget 的 entity/event/receipt/commit 节点强制终止后端，验证全有或全无以及原 key 核查。

`test/fixtures/persistence-v3.sql` 由基线 `caaea30435ae5429e01002bbe98bff79eb8226f8` 的实际运行时通过合成消息、Task、报告发布生成；包含真实格式的历史事件和回执，不含用户聊天或凭据。迁移后逐项对比数据、报告和游标，并验证损坏旧库的迁移回滚。样例个性存储不构成长期模型个性遵从的保证。
