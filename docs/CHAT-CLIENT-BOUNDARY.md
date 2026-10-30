# 聊天客户端接入记录

2026-10-30：[Issue #1](https://github.com/Slmplez/AgentRoom/issues/1) 的实现与验证记录。

## 已接入的链路

默认工作台与 React 聊天入口均通过 AgentRoomClient 收发消息。客户端拥有只读投影、版本检查和订阅生命周期；HTTP/SSE 与 Electron IPC 使用相同聊天契约。

后端 Chat API 将现有运行时数据转换为公开的 Agent、Room、Message 和审批描述。页面使用 roomId，hcom thread、引擎请求和旧状态映射留在后端。共享提及逻辑由浏览器构建与后端共同依赖，后端不再导入 Renderer 的提及实现或头像模块。

- HTTP：GET `/api/chat/snapshot`、GET `/api/chat/events`、POST `/api/chat/commands`。
- Electron：受限的 `chat:request` 与 `chat:event`，通过 preload 暴露相同 request/subscribe 行为。
- 消息命令返回受理回执，不返回整份应用状态；受理不表示 Agent 已完成工作。
- 错误带 code、outcome、requestId，区分明确拒绝与结果未知。旧运行时没有持久幂等账本，客户端不自动重发未知命令。
- 快照与订阅以实例标识及版本衔接。事件携带完整聊天快照，当前未实现持久事件补发。
- 流式消息在结束时保留身份；执行失败后保留关联错误信息。界面重载保留已选房间，聊天差异从消息 DTO 获取。

本次接入复用了工作区内已有的 React、Mock 和界面基础。设置、诊断及其他尚未迁移功能继续由后续票据负责；本记录不代表 #2–#11 均已验收，也不代表 hcom 已被替换。

## 验证

```text
npm run build:renderer
npm run check
npm run check:client
npm run check:chat
npm test
npm run verify:chat-transports
npm run verify:rpc-ui
npm run verify:mentions-ui
npm run verify:chat-ui
node scripts/verify-rpc.cjs pi
```

本次结果：80 项自动化测试通过；默认工作台和 React 聊天各自通过真实 HTTP/SSE 与 Electron IPC 联调。该界面联调使用真实应用服务和受控外部 runtime，覆盖发送、审批、流式完成和默认工作台重载后保留私聊选择。

另行运行实际安装的 Pi CLI 与原生运行核心：本地回环推理 4 次，付费模型调用 0 次，完成原线程回复及 Agent 间消息验证。此证据验证真实 CLI 协议链路，不代表生产模型或所有引擎的联网验收。

独立 Standards / Spec 审查发现的错误投影丢失、房间选择重置、聊天差异依赖旧 RPC 状态和异常错误响应问题均已修复，并有相应回归验证。
