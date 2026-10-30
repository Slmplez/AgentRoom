# 本机单 Agent 持久问答 API

2026-10-31，实施票据 [#26](https://github.com/Slmplez/AgentRoom/issues/26)，属于 [#23](https://github.com/Slmplez/AgentRoom/issues/23) 的本机单用户切片。多人登录、Teams、多 Agent 咨询和运行中改目标继续暂缓。本切片交付后端真实 API 与 Pi CLI 验证，现有聊天 UI 的问题/建议示例仍为 Mock。

## 显式启用

默认 `scripts/start-persistence-server.cjs --data-dir <directory>` 仍只提供讨论。可信宿主额外传入 `--agent-workspace <directory>` 时，装配 `local-pi` 和现有独立 Pi RPC 协议适配器；不导入 hcom/RpcRuntime。数据目录与工作目录分开，后者不能由 HTTP 请求指定。Pi 使用 read/grep/find/ls 工具，关闭自动扩展、Skills、提示模板与主题发现；原生权限请求不会变成普通问题或被批准。

只读工具集不是操作系统路径沙箱，工作目录也不是恶意租户隔离边界；本机 owner 的受信任执行范围沿用现有部署约束。

认证引导与原持久服务一致：fork IPC 返回当前回环 origin/token，独立命令行从 stdin 接收 token，不在命令行、URL、日志或浏览器存储暴露令牌。已有桌面/Web 持久宿主不会自动开启此参数；完整 UI 接入另交付。

Bootstrap 的 `localExecution` 和 `localAgentId` 表示后端专用 API 能力；原聊天 `tasks` 保持 false，避免当前 Composer 误用旧任务协议。SQLite schema 从 1 原子迁移到 2，保留原库、消息和回执；旧版仅支持 schema 1 的后端不能读取升级后的库。

## 接口

所有接口复用 Authorization、Host/Origin、运行时 owner 与房间成员检查。写请求必须携带 JSON 和 Idempotency-Key，不能提供调用者身份、命令、环境或凭证。

| 方法与路由 | 正文 / 结果 |
| --- | --- |
| POST /api/v1/rooms/:roomId/local-tasks | workspaceId、ownerAgentId=`local-pi`、goal；返回原有持久回执和 taskId |
| GET /api/v1/rooms/:roomId/local-tasks | 最近 100 个任务 |
| GET /api/v1/rooms/:roomId/local-tasks/:taskId | task/run/发起人/负责人、phase、result、当前问题与历史、投递状态 |
| POST /api/v1/rooms/:roomId/local-tasks/:taskId/answers | workspaceId、questionId、expectedRevision、optionIds、text |
| GET /api/v1/operations | workspaceId、commandType=createLocalTask 或 answerLocalQuestion、原 key，核查丢失的响应 |
| GET /api/v1/events | 复用已有 roomId/after 订阅；localTask.updated 的脱敏任务快照与状态/回执同事务提交 |

Task 与唯一 Run 有独立稳定 ID，负责人固定为宿主配置的 Agent；正文 @ 不创建执行。一次 backend 最多一项活跃或结果未知执行，避免另起进程覆盖未核查状态。原生输入映射保留在私有存储/存活引擎会话，不出现在查询与事件 DTO 中。

## 状态与恢复

创建事务保存 queued 状态和回执/outbox；提交后才可进入 dispatching 并启动 CLI。引擎原生输入事件保存 awaiting_input 与问题版本。真人答复事务保存答案、answer_pending、投递意图和回执，提交后才可进入 submitting/attempting，并对原 incarnation 的输入请求响应一次。管道写入成功只记 submitted，不宣称引擎已确认或任务验收完成。

原引擎轮次完成且有明确完成事实时任务进入 reviewing；未知/失败派发不会自动重试。初版仅保存最终正文（最多 16000 字符），不承诺逐 token 展示；最多 21 个原生问题，超限停止并待核查。审批、多 Agent 建议、任务结果验收另有正式契约，不从普通答复推断。

重启后：原 queued 变为 paused；已派发、等待输入或答复投递中的任务变为 unknown，未答问题过期，已保存答复仍可读取；不自动重建 CLI 或重发答案。首切片不提供未知执行的解除/重新运行按钮，需后续核查接口与完整执行资源规则；未知状态会阻止另一项新任务。用户关闭客户端不终止后台执行，宿主关闭服务会关闭托管管道，持久状态在下次启动按上述规则核查。

已接受但响应丢失的命令按原 key 查询或在同库重发同一命令；不会重复执行。不同内容沿用原 key 返回冲突。新数据库不承接旧请求。简单问题仅在存活且映射一致的引擎会话接受答复，失效/跨房间/错误版本/非法选项拒绝。

## 验证

- `node --test test/local-execution.test.cjs`：真实 SQLite、认证 HTTP、真实子进程 RPC；重复请求、范围/身份/版本、原生输入继续、重启、after_receipt/after_commit/before_local_answer/after_local_answer 强制中断。
- `node scripts/verify-local-agent.cjs`：本机安装的 Pi CLI，可信测试扩展发出原生输入，HTTP 答复继续原会话，一次本地回环模型请求、零付费调用；独立于协议 fixture 报告。
- 原持久讨论/客户端/类型/边界测试继续运行；API 成功不能计作真实聊天 UI 已接入，也不能计作多人或 Teams 验收。

前端下一切片需要通过同一 AgentRoomClient 装配任务查询、问题答复和未知回执，增加真实任务详情与状态显示；不将新 API 接到页面直接网络调用，不将 current Mock 的成功替代真实验证。
