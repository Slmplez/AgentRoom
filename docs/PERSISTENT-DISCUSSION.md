# 本机持久讨论（G2a）

这是显式选择的独立模式。桌面和浏览器使用同一个 AgentRoomClient、Node 后端及 SQLite 数据库；普通讨论（包括正文中的 @）不启动 Agent。旧工作区、四引擎联调和 Mock 入口继续保留。

## 启动

在仓库目录运行：

```powershell
npm run dev:persistent
```

该命令构建界面，在 `http://127.0.0.1:4319` 提供页面，使用独立目录 `.data/persistent`。第一次启动通过公开命令建立一间“持久讨论”房间。打开该地址即可使用浏览器；另一个终端运行桌面入口：

```powershell
npm run desktop:persistent
```

服务与桌面是两个独立启动项。桌面不偷偷启动 hcom、CLI 或 Mock，也不假设 Electron 内嵌 Node 支持 SQLite。后端使用启动服务的真实 Node 运行时，需支持 `node:sqlite`（本次验证 Node 24.4.1）；不满足时应按启动错误升级 Node，再启动服务。当前 SQLite API 可能打印实验性功能提示。

自定义数据目录和端口：

```powershell
npm run build:renderer
node server.cjs --persistent --data-dir E:/AgentRoom/discussion-data --port 4320
npm run desktop:persistent -- --persistent-url http://127.0.0.1:4320
```

仅支持 `127.0.0.1` 的 HTTP 地址。桌面和浏览器必须连接相同地址；请保持端口稳定，以保留该来源下的草稿和已提交请求核查记录。不要将数据目录放在网络共享盘，也不要同时启动两个服务管理同一数据库。原 hcom 数据不会导入或双写。

## 生命周期与恢复

- 服务终端拥有独立后端进程；在该终端按 Ctrl+C 停止服务并等待后端退出。
- 关闭桌面窗口或浏览器页面只释放对应连接；其他界面仍可继续工作。
- 同一数据目录重启后，数据库与消息身份保持稳定，进程实例标识变化。界面自动重连，已提交但未知的请求只核查原 key，不自动重发。
- 最新页最多 100 条；“加载更早的消息”通过同一个 Client 合并历史。实时消息不会改变历史页边界。
- 事件保留 7 天，消息及幂等回执不随事件清理删除。过期时重新获取快照并提示，历史仍可分页读取；不承诺重放已清理的逐条通知。
- 需要更换数据库时停止服务后更换目录，并刷新界面重新确认。不会把旧库的未知命令重放到新库。

齿轮内显示当前数据库和后端实例标识；启动日志显示数据目录。身份是本机 owner，两端同属一个用户，不是多人登录。Agent 执行、审批、Teams、任意房间管理尚未接入此模式。

## 会话边界

宿主仅监听 loopback，校验 Host、Origin 与浏览器请求来源。浏览器使用 HttpOnly、SameSite=Strict 会话 cookie，后端 Bearer 凭证仅经私有子进程 IPC 传给服务宿主；代理在服务端注入凭证。凭证不进入 URL、日志、localStorage、消息投影或页面脚本。刷新或重新建立本机会话不会改变持久 authorId。

## 验证

`npm test` 覆盖真实 SQLite、HTTP/SSE、崩溃回滚、未知回执、双客户端、事件保留和分页。`npm run verify:persistence-ui` 启动真实 Node 服务，在桌面 preload 和浏览器环境验证收发身份、历史分页、草稿、关闭单端和重启恢复；不使用模型/CLI fixture 代替持久后端。

既有模式回归：`npm run check:chat`、`npm run check:client`、`npm run verify:chat-transports`、`npm run verify:chat-ui` 及侧栏设置验证。

### G2a 故障矩阵证据

| 范围 | 实际验证入口 |
| --- | --- |
| 原子事务、同键并发/冲突、不同键相同正文、跨房间引用、提交前后终止、数据库损坏/版本/锁 | `test/persistence-durable.test.cjs` |
| 双客户端、快照到订阅交界、日志等待交界、提交后未唤醒即终止、重复事件、断线与进程重启、数据库更换、慢连接 | `test/persistence-stream.test.cjs` |
| 固定历史窗口、并发新消息、7 天严格边界、连续前缀清理、清理中崩溃/重启、活跃订阅过期、迟到历史隔离 | `test/persistence-history.test.cjs` |
| 实际 Node SQLite 能力、私有 IPC/cookie、跨源拒绝、静态目录边界、后端崩溃与关闭等待、单连接退出 | `test/persistence-host.test.cjs` |
| 桌面 preload/Web 同页、相同消息身份、108 条历史、真实响应丢失核查、原键重试保留编辑草稿、服务重启、关闭单端 | `scripts/verify-persistence-ui.cjs` |

上述入口均采用真实临时数据库和真实 HTTP；崩溃与宿主生命周期使用真实子进程。持久 UI 验收没有模型或 CLI fixture。旧四引擎协议回归中的外部运行时仍使用明确标注的 fixture，不作为真实引擎接入新持久模式的证明。当前全量测试为 148 项，类型、边界、构建和相关 UI 回归通过；规范与规格复审均无未解决发现。
