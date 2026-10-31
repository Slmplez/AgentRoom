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
5. 真实差异入口：持久 Web/桌面提供用户手动点击的“工作区变更”按钮，经公共 Client 发 `{type:'changes',workspaceId,roomId}`。独立服务已实现该请求，仅读取宿主显式 `editorWorkspace` 根的 Git 差异；不启动 Agent，也不写文件。返回 `{type:'changes',workspaceId,roomId,rootId,base,complete:true,files:[{file,status,patch,editable,reason?}]}`。`files=[]` 显示“暂无变更”；Git 缺失/非仓库/超限错误明确显示。
6. `patch !== null` 的项可交给现有 DiffPreview；`patch === null` 的项必须同时显示文件名和只读原因，不能静默遗漏。`complete:true` 表示完整状态列表和未截断的已返回补丁，不表示每个文件都有补丁。文件级 `editable:false` 必须禁用编辑入口；删除文件仍可审阅原始差异。刷新后替换补丁并重新绑定评论 digest。不要只限定旧工具模式或 Mock。
7. 读取范围是 HEAD 对当前工作树的净变化（含暂存、新增、未跟踪；未首次提交也支持）。Git 忽略文件及子模块内部变更不包含；重命名按删除+新增显示。根目录必须是 Git 仓库顶层。响应最多 60 文件，补丁合计 1 MiB，单次 Git 3 秒/整次读取 10 秒上限；超限整体拒绝，不返回部分结果。读取不是跨文件原子快照，结束时复核 HEAD/状态，文件编辑仍以完整文件 hash 独立检查冲突。

## 验证命令

- `node --test test/file-review.test.cjs`
- `node --test test/file-review-changes.test.cjs`：真实临时 Git 仓库的暂存/未暂存/未跟踪/无提交/删除/只读/数量和大小限制/禁止执行 clean filter/Git 缺失。
- `npm run check:chat`、`npm run check:boundaries`、`npm run build:renderer`
- `npx electron scripts/verify-file-review-ui.cjs --disable-gpu`：认证 HTTP、真实临时文件落地、评论重启、冲突、刷新草稿、窄屏。
- `npx electron scripts/verify-diff-workspace.cjs --disable-gpu`：原有差异工作区回归。

本阶段不代表生产宿主已装配，不关闭 #44。需要串行接线和真实入口验收后才能完成任务。
