# #44 集成交接

本任务副本：`E:/Repo/ASCET/agent-chat-desktop-review-edit`，分支 `codex/diff-review-edit`。基线 #42 的 462f9fb + main335a618。仅新增文件审阅模块/契约/独立传输适配器/状态机/UI/测试；未修改共享 runtime/index/storage/http/host/Client。

## 已有可验证行为

- 行内原生 +、键盘行号入口、左右侧绑定、补丁 digest 和原文片段。SQLite 持久本地真人评论，同 key 重试；不产生 Agent 消息。
- 完整文件编辑；700 ms 防抖、IME 暂停、串行保存、未保存/冲突/失败状态。草稿按后台/数据库/真人/房间/文件/标签页隔离。
- 同文件共享控制器，关闭/重开不会产生竞争保存；待确认请求不可变，重试保持 key；外部版本变化保留草稿且停止覆盖。
- 服务端受信根路径、授权 resolver、已有 UTF-8 文件限制、hash/文件身份复查、prepared 持久记录和同目录原子替换。不是跨外部进程的绝对 CAS，详细边界见 lib/file-review/README.md。

## 共享入口交接后所需接线

1. 宿主新增显式 `editorWorkspace` / `--editor-workspace` 配置；不能把只读 `agentWorkspace` 自动变成写入授权。
2. Runtime 配置通过 `createRuntimeFileReview(runtime,{directory,editorWorkspace})` 实例化独立文件审阅存储；共享 HTTP 在已有身份/Origin/CSRF 校验后挂载 `createFileReviewHandler`。代理需要允许 `/api/v1/file-review`，POST 仅限 JSON，2 MiB 上限。关闭宿主时关闭文件审阅服务。
3. AgentRoomClient 的 `review(input)` 调用传输并验证 `reviewRequestSchema/reviewResultSchema`，校验 generation、当前房间与工作区。持久 Cookie 通道使用 `createFileReviewTransport`；桌面和旧版 API 必须继续经公共 Client，不能由组件直接调 fetch/IPC。
4. App 在真实 Client 暴露 `review` 前保留只读状态；Mock 的评论与编辑存入浏览器，明确标为模拟。测试 harness 安装真实认证 HTTP Client 并验证磁盘文件，而非只测 Mock。
5. 差异入口：旧版真实工具的 toolDetails.patches → ChatThread.showDiff → DiffPreview 是现有真实入口；需要验证其工作区相对路径能解析到宿主绑定根目录。当前持久模式只读 Agent/报告没有文件差异产物来源，不能宣称持久任务已产生可编辑 Diff。正式装配还需提供真实变化/文件选择入口，或者先明确限定为已有真实工具差异模式。

## 验证命令

- `node --test test/file-review.test.cjs`
- `npm run check:chat`、`npm run check:boundaries`、`npm run build:renderer`
- `npx electron scripts/verify-file-review-ui.cjs --disable-gpu`：认证 HTTP、真实临时文件落地、评论重启、冲突、刷新草稿、窄屏。
- `npx electron scripts/verify-diff-workspace.cjs --disable-gpu`：原有差异工作区回归。

本阶段不代表生产宿主已装配，不关闭 #44。需要串行接线和真实入口验收后才能完成任务。
