# 前端开发与联调

先运行 npm ci。日常前端开发使用 npm run dev:ui，打开 http://127.0.0.1:4318。

| 入口 | 用途 | 运行环境 | 数据位置 |
| --- | --- | --- | --- |
| npm run dev:ui | 独立开发聊天与管理页面 | 静态服务器、浏览器构建；无需 Electron、CLI、Rust 或模型 | 页面内存 Mock、独立模拟偏好 |
| npm run dev:web | 真实 Web 联调 | Node、原生核心、所用 CLI | .data/web-rpc |
| npm run dev:desktop | Electron 联调 | Electron、原生核心、所用 CLI | 开发模式 .data；打包模式 userData |

真实入口需要 npm run build:native，或已有可用的原生构建。它们复用现有 RPC 运行时；连接失败显示离线，不会转为 Mock。Web 默认端口 4317，由 PORT 调整；Mock 端口由 UI_PORT 调整。真实模式仍需按 CLI 要求配置账号或连接方案。

Mock 页面持续显示“模拟开发”。管理导航打开 workbench.html，可开发连接、MCP/Skills、用量、工作区、房间和成员管理。模拟目录和证书是虚构值；Mock 不启动 MCP、读取真实凭证或请求模型。模拟运行时在当前页面内存中，导航或刷新会重建，不宣称持久恢复。聊天偏好前缀 ar-chat-mock-，头像 ar-mock-agent-avatars，工作台 ar-mock-workbench-。

开发监听覆盖 React、Client/Mock、共享契约和差异资源；重新构建后刷新页面。工作台普通 JS/CSS 由静态服务器直接读取。

## Interface 与状态归属

- 页面使用 AgentRoomClient 的 read/subscribe/open/dispatch/query/watch/close。契约位于 contracts/，客户端位于 renderer/client/。
- Client 拥有只读投影、实例/revision 校验、重连、未知操作记录与查询轮询。页面持有草稿、筛选、焦点和折叠状态。
- 管理读模型按需查询，不随每个聊天快照下发。工具摘要最多 300 字符，详情输出最多 16000 字符，差异总计最多 256KB；截断和过期明确提示。
- PlatformClient 声明目录/证书选择和窗口控制。浏览器缺少选择能力时显示错误，允许填写后端可读取的路径；不提供任意 IPC 或文件读取。
- 审批的用户决定与引擎接收分开记录。仅写入管道为 unknown；OpenCode 当前 Adapter 只在收到明确 true 响应后确认接收。未知决定不会静默补发。
- 未知管理命令不能换 key 重复提交。同一目标同类操作在 Client 生命周期内保持阻止，需先核查后端状态。旧运行时没有持久回执查询，不宣称刷新后能恢复未知操作。
- MCP 凭证使用加密环境变量或请求头。公开保存不接受 URL 查询参数或常见凭证命令参数；旧配置中的这些内容被隐藏并提示迁移。

## 可控模拟场景

聊天“模拟场景”提供空对话/工作区、重置、暂停/继续、推进时间、并发流、长输出/大差异/无效差异/失败/过期、审批/问题/过期及断线恢复。初始时刻和 ID 确定，推进增加模拟时间。

工作台控制台可使用 window.AgentRoomChat.controls：failNext('saveConnection')、failNext('launchAgent')、launchUnknown()、failNext('capabilities')、telemetry(true)、failNext('contexts')。控制器只在 Mock 提供，不包含真实密钥。Mock 与真实 Adapter 共用 Client 与契约校验。

## 验证

~~~text
npm run check
npm run check:client
npm run check:chat
npm test
npm run build:renderer
npm run verify:chat-ui
npm run verify:management-ui
npm run verify:chat-transports
npm run verify:rpc-ui
npm run verify:mentions-ui
npm run verify:capabilities-ui
npm run verify:chat-regressions
npm run verify:chat-polish
npm run verify:chat-interactions
npx electron scripts/verify-group-clarity.cjs --disable-gpu
npm run verify:capability-clis
npx electron scripts/verify-rpc.cjs pi --disable-gpu
~~~

check:client 包含依赖边界检查。UI 脚本用 Electron 作为浏览器驱动；纯 Mock 页面没有 preload，测试拦截外部请求并断言零生产 API 请求。verify:chat-transports 使用真实 HcomService、HTTP/SSE 和生产 preload，外部运行时是 fixture。最后两项使用已安装的 Codex/Pi CLI；实际 Pi 推理指向回环服务，付费调用为零。

验收范围与内部迁移 Adapter 退出条件见 [客户端接入记录](CHAT-CLIENT-BOUNDARY.md)。
