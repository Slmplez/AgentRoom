# 真实只读报告界面（#29）

#27 的版本、消息引用和认证查询通过公共 AgentRoomClient.query 接入桌面/Web。只有声明 readOnlyArtifacts 能力且有 artifactRefs 的消息显示“查看报告”。打开旧消息始终读取引用中的精确版本；正文按需读取，不加入消息快照或 SSE。

## 启动与默认权限

```powershell
# 先构建界面
npm run build:renderer

# 真实本机任务 + 显式报告发布（使用已配置的 Pi）
node server.cjs --persistent --data-dir .data/reports --agent-workspace E:/your-workspace --agent-reports

# 桌面连接同一个服务；浏览器也可打开服务打印的地址
npm run desktop:persistent -- --persistent-url http://127.0.0.1:4319
```

`--agent-workspace` 单独使用仍只有读取工具。`--agent-reports` 额外允许向 AgentRoom 保存结构化报告，不能单独使用，也不允许写工作目录或运行 shell。不开执行时仍可读取已保存的历史报告。服务拥有后端生命周期，关闭页面不停止服务。模型配置和凭据沿用宿主中 Pi 的可信配置，页面不接触凭据。

## 阅读行为

- 报告独立注册 Section/Metrics/Bars/Table 四种可信 json-render 组件，读取 DTO 和正文均重新校验；没有 Field、动作、表达式、绑定或 HTML 执行。
- 显示标题、精确版本，可展开 Task/Run/Agent 和发布时间；版本列表每页 20 条，可读更早版本。
- 新交付事件提示新版本，不替换正在阅读的版本。切换版本、关闭面板或切换房间后，旧请求结果不能回写当前面板。
- 读取失败显示具体状态，可重读；不会退回示例数据。加载新内容时清空旧正文，错误仍可查看已有来源元数据。
- 报告与聊天共享可调整宽度；窄屏覆盖展示并可返回对话。Escape 关闭，焦点归还原消息按钮；保留聊天草稿，遵循 reduced-motion。
- Mock 菜单中的“发布模拟报告”使用同一 DTO，并明确标注模拟数据。原结果示例和本地表单仅在 Mock 中提供。

## 验证与范围

`node --test test/artifact-client.test.cjs test/persistence-host.test.cjs` 验证公共客户端懒加载、双端事件引用、历史分页、越房间拒绝、切换范围晚到结果丢弃、恶意正文拒绝，以及发布开关默认关闭/显式启用。#27 的事务、事件过期、迁移和崩溃测试继续保留。

`node_modules/.bin/electron.cmd scripts/verify-artifact-ui.cjs --disable-gpu` 使用真实安装的 Pi、两份真实桌面/Web 界面、SQLite/HTTP/SSE。仅推理服务为本机受控回环：三次请求完成两个版本的真实工具发布及最终回复，没有付费供应商调用。验证版本保留/提示/切换、延迟响应、网络重读、草稿、键盘焦点、刷新/后端重启、错误状态、恶意脚本文字只作为文本、双主题与窄屏。截图在 artifacts/report-ui-light.png 和 artifacts/report-ui-dark-narrow.png。

`node_modules/.bin/electron.cmd scripts/verify-artifact-mock-ui.cjs --disable-gpu` 单独验证明确标为模拟的 25 个版本分页、旧版选择、消息阅读位置保留和切房间关闭旧报告。该结果不作为真实 Agent 发布证据。既有 verify-local-agent-ui（--real-pi）、verify-persistence-ui 和 verify-chat-interactions 回归也已通过。

版本正文不可编辑；没有附件、导入、复杂表单、任务自动验收或自动继续执行。多人身份与 Teams 继续暂缓。
