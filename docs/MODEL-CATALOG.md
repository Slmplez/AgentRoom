# 模型目录与 Magpie 可选连接

本阶段对应 [Issue #25](https://github.com/Slmplez/AgentRoom/issues/25)。连接设置、模型目录和启动选择通过同一 AgentRoomClient 访问；页面不直接访问供应商或持有已保存的密钥。适用于现有引擎管理入口及独立 Mock 开发。持久讨论模式尚不提供真实 Agent 启动，本次不扩展其执行范围。

## 前端接入

已保存的连接通过连接 ID 读取目录，模型描述和凭据分开传输：

```js
const connections = await client.query({ type: 'connections' });
const result = await client.query({
  type: 'modelCatalog',
  connectionId: connections.profiles[0].id,
  // 可选：将手动模型追加为能力未知的目录项，不改变已保存的默认模型。
  model: 'my-model',
});
```

`result` 包含 `ok`、`message`、`models`（上游 ID 列表）、`catalog`（规范化描述）和可选 `latencyMs`。`ok` 仅表示成功读取目录，不表示推理、工具调用或所有协议已通过验证。`catalog` 中的模型具有：

- `id`、`name`、`source`：`upstream` 是上游列出的模型；`manual` 是手动 ID。
- `capabilities`：`tools`、`images`、`streaming`、`reasoning` 为 `true` / `false` / `null`；`null` 表示没有有效声明。`contextWindow`、`maxOutputTokens` 为正整数或 `null`。
- `compatibility`：每个已适配引擎的 `engineId`、`status` 和 `reason`。`compatible` 表示协议和声明能力匹配，`incompatible` 表示已知冲突，`unknown` 表示协议匹配但能力声明不完整。

不支持工具调用或流式输出的模型不能用于编码智能体。引擎不支持所选协议也会被拒绝。目录不可用、模型未列出或能力缺失时，保留手动配置和明确的未知状态；不要把 `null` 渲染为“不支持”或“支持”。

创建连接前仍使用 `testConnection`，其 `profile.model` 现在可为空；保存连接时模型 ID 仍必填。凭据继续使用 `keep` / `replace` / `clear`。目录失败时保持用户输入；能力结果只对应测试时的连接，改变地址、协议或凭据后需重新读取。

启动 Agent 时可以覆盖连接的默认模型，无需为每个模型重复保存凭据。后端会重新读取目录并检查最新声明，防止绕过前端提交已知不兼容的组合。每次读取有既有的 12 秒网络闲置超时；不做自动重试。模型列表不可用时允许沿用手动配置，实际推理失败由现有执行流程报告。

## Magpie 接入

1. 在后端所在主机启动 Magpie。
2. 打开“连接与模型”→“连接 Magpie”。预设使用 `multi` 和 `http://127.0.0.1:3425/v1`。
3. 按 Magpie 实际配置填写认证信息。Web 环境不能保存加密密钥时，使用 Electron 桌面版配置；无需认证的本地服务可明确选择“无认证”。不自动读取其他客户端凭据。
4. 点击“测试连接”，选择目录模型并保存。
5. 添加 Agent 时选择该连接及本次模型，查看兼容性说明。

`127.0.0.1` 指运行后端的主机。AgentRoom 的 `multi` 网关负责原样转发；协议转换由 Magpie 提供。Magpie 是可选上游，不是任务或持久化运行时的依赖。应用不自动启动、安装或配置 Magpie。

目录读取兼容 Magpie 的 `display_name`、`tool_call`、`reasoning`、`modalities.input`、`context_window` 和 `max_output_tokens`，也接收常见兼容接口的明确能力字段。Magpie 的 `native_endpoints` 只说明原生协议，不等于网关转换后的可用协议，因此不会用它排除其他引擎。未识别的字段不进入公开 DTO，模型参数也不会因目录刷新而覆盖用户配置。

本阶段仍使用现有连接记录保存供应商地址和加密凭据，没有新增账号池、Provider 数据表或持久目录缓存。模型描述按连接独立查询，不将不同供应商的同名模型合并。

## 验证和边界

```powershell
npm test
npm run check:chat
npm run check:client
npm run build:renderer
node_modules/.bin/electron scripts/verify-model-catalog-ui.cjs --disable-gpu
```

`test/model-catalog.test.cjs` 验证公开客户端发现/查询、能力归一化、手动回退、后端启动阻止，以及三种协议工具调用流的字节保留、错误透传和取消。UI 脚本验证 Magpie 预设、空模型发现、三态能力和启动交互，使用独立 Mock，不发送真实模型请求。

这些是本地协议夹具验证，不等于对真实 Magpie 加真实供应商的端到端推理验证。首次接入具体部署后，需要分别验证实际模型的文本流、工具调用及结果续接、取消和错误处理。

后续备用线路、会话绑定、自研协议转换另行实施。模型请求失败不得自动重跑整个 Task；已输出内容或外部副作用未知时，仍遵循运行时的显式恢复规则。

设计参考：[Magpie 参考文档](https://github.com/yetone/magpie/blob/main/docs/reference.md)、[模型列表实现](https://github.com/yetone/magpie/blob/main/internal/gateway/gateway.go)、[路由策略边界](https://github.com/yetone/magpie/blob/main/internal/routes/routes.go)。本次独立实现目录规范化与适配，没有引入 Magpie 源码或运行时依赖。
