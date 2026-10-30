# 客户端解耦验收记录

2026-10-30，覆盖 GitHub Issues #1–#11 第一阶段前端解耦。独立后端持久讨论和多人协作属于后续阶段，仍按各自验收条件管理。

## 已接入链路

默认工作台与 React 聊天均使用 AgentRoomClient。聊天、Run、审批、工具、工作区/房间/Agent 管理、连接、MCP/Skills、用量和上下文已使用公开契约。后端不导入 Renderer；提及纯逻辑位于 shared/mentions.cjs。

- HTTP：GET /api/chat/snapshot、GET /api/chat/events、POST /api/chat/commands；查询使用相同 request 信封。
- Electron：agentRoomChat 只暴露 request/subscribe，使用 chat:request/chat:event；agentRoomPlatform 只暴露受限原生能力，由 PlatformClient 包装。
- 旧业务 IPC、整份原始状态事件、旧 HTTP 业务路由与无调用者的终端页面已删除。
- 命令只返回回执，受理不表示执行成功。错误带 code/outcome/requestId；未知操作不自动重发。
- Client 校验实例/revision，隔离迟到快照、旧实例和切换后的查询，集中管理重连、轮询与释放。
- 移除 Agent 隐藏活动成员但保留只读私聊历史。工具全文和差异按稳定引用读取。

## 内部迁移 Adapter

lib/chat-api.mjs、lib/chat-projection.mjs 与管理、连接、能力、遥测和工具 Adapter 仍连接当前 HcomService/RpcRuntime。引擎协议、wire ID 与 hcom thread 留在可信后端。原生 PTY 后端内部代码和测试未提前删除；当前 UI 启动使用 RPC。

退出条件：后续 ApplicationRuntime 对应功能通过真实 CLI 与客户端端到端验收后，逐项切换 Adapter 并删除旧后端。已有 #13 持久讨论内核提交不代表 #14–#16 同步、分页与默认入口切换已完成。本批不决定 Pi Durable、不实现新任务调度，也不宣称完整 React 迁移。

当前聊天事件仍是全量快照，无持久事件补发；工具输出和 Run 元数据主要处于当前引擎会话生命周期。未知命令保护是 Client 生命周期内的防重复措施，不是持久幂等账本。持久协议须另行完成恢复验收。

另一界面会话单独授权的 Mock 结果示例和群聊展示优化已整合；结果示例只渲染固定目录，不接受模型生成界面、不提交业务动作，不构成未来任务运行时。

## 验证证据

| 类别 | 验证内容 | 结果 |
| --- | --- | --- |
| 公开 Interface/单元回归 | Client、同步、未知操作、管理、连接/凭证、能力、工具、计量、审批、进程退出、引擎重新扫描 | 117 项全量通过 |
| 独立 Mock UI | 无 preload、零生产 API、并发流、中文输入/草稿、审批、工具回退、管理表单、双主题、窄窗口 | 通过 |
| HTTP/SSE 与 Electron | 真实 HcomService、受控外部运行时；工作台/React；生产 preload | 通过 |
| 四引擎协议 fixture | 实际管道/HTTP、审批归一化、取消、异常退出 | 通过，不等同于厂商 CLI/模型运行 |
| 真实 MCP | 本地 stdio Hub、Skill 导入/分配；实际 Codex 配置、Pi 连接 Hub | 通过，0 模型请求 |
| 真实 Pi CLI | Electron utilityProcess、原生核心、回环推理、原线程回复、Agent 互发、所有受托管进程退出 | 通过，4 次回环请求、0 付费调用 |

未对远程生产模型/证书服务、实际 Claude/OpenCode 完整会话及所有账号环境做联网验收。已有 TLS、网关和计量测试保留并通过。Windows Node 宿主验证曾在进程退出后遇到临时目录 EBUSY，清理单独记于 artifacts/rpc-real-pi-cleanup.json 并保留目录；后续 Electron utilityProcess 验证正常退出并清理成功。

Standards/Spec 独立审查发现的问题已修复：审批接收与用户决定混淆、真实上下文空值、凭证参数泄露、未知启动重复提交、移除成员导致历史消失、异步弹窗覆盖新页面。启动方式和完整检查命令见 [前端开发与联调](FRONTEND-DEVELOPMENT.md)。
