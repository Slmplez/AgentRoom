# 前端开发与联调

`npm ci` 后运行 `npm run dev:ui`，打开 http://127.0.0.1:4318。该入口只有静态文件服务器与浏览器构建，不加载 Electron、hcom、Rust 核心、模型网关或凭证存储。页面持续显示“模拟开发”，真实连接失败不会切换到此模式。

“模拟场景”提供空对话、空工作区、重置、暂停、继续与推进。ID 和初始时刻固定；每次推进增加模拟时间，重置清除模拟操作。Mock 位于 transport 边界，使用相同 AgentRoomClient 与契约；页面草稿使用 `ar-chat-mock-` 命名空间，头像使用 `ar-mock-agent-avatars`。模拟目录仅用于展示，不传给真实后端。生产命令不包含场景控制。

`npm run dev:web` 启动真实 Web 联调；`npm run dev:desktop` 启动 Electron 联调，两者需要已配置的真实运行环境。窗口操作等原生能力由 PlatformClient 声明，纯浏览器不会假装执行本机窗口操作。

验证：`node --test test/client.test.cjs` 与 `npm run verify:chat-ui`。界面验证使用 Electron 作为浏览器测试驱动，但被测页面没有 preload，不接触业务 IPC，测试拦截外部请求且断言零生产 API 请求；`dev:ui` 本身不加载 Electron。
