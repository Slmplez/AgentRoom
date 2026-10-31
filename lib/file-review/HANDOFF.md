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

## 串行交接后的最小修改清单

以下为已检查的文件位置；#39 → #43 交接完成前不修改共享入口。后续实现以交接后的文件为准，不整段替换旧基线。

| 位置 | 最小修改与关键约束 |
| --- | --- |
| `scripts/serve-persistence.cjs`、`lib/persistence-host.cjs`、`scripts/start-persistence-server.cjs` | 增加并逐层传递 `--editor-workspace`；验证目录；不能由 `agentWorkspace` 推断。子进程创建文件审阅服务，并在启动失败/关闭时释放 SQLite。Web 与桌面复用同一持久宿主，不增加独立 Renderer 文件访问通道。 |
| `lib/application-http/index.mjs` | 在现有 Host/Origin/Bearer 检查之后挂载 `createFileReviewHandler`，认证 actor 使用现有宿主身份。必须在通用 body parser 之前分流；该接口处理自己的 2 MiB JSON 上限和 `{ok,value}` / `{ok:false,error}` 包装。 |
| `lib/persistence-host.cjs` 的 `proxy` | 允许固定 `POST /api/v1/file-review`，保持 Cookie、来源及 fetch-site 检查。只对此路由将请求体上限从当前 128 KiB 改为 2 MiB，不扩大其他路由。转发原 JSON，不剥离保存 key。 |
| `contracts/persistence.mjs`、`contracts/chat.mjs`、runtime bootstrap | 增加默认 false 的文件审阅 capability；仅显式编辑根配置时启用。不把根路径送入浏览器。权限与真实身份继续由 runtime adapter 验证。 |
| `renderer/client/persistent.mjs` | 增加 review transport 方法，使用 active session 的 origin/Cookie 或 Bearer。服务包装与现有 json helper 格式不同，需显式解析；断线/换后台后拒绝晚到结果。文件保存/评论使用自身 key 和恢复状态机，不塞进现有 sendDiscussion journal。 |
| `renderer/client/client.mjs` | 公开 `review(input)`，校验请求/结果契约、类型配对、当前房间/工作区、key/version 及连接 generation。传播 capability（初次 bootstrap 与后续更新都保留）。方法存在不等于已授权，UI 不能仅凭 `typeof review` 启用。 |
| `renderer/chat/app.tsx` | 在持久模式提供“工作区变更”按钮；只在用户点击/刷新时调用 `changes`。请求中、错误、空状态明确显示；切换房间或后台立即失效旧请求。传递完整文件元数据，不只提取 patches。 |
| `renderer/chat/diff-preview.tsx`、`review-diff-file.tsx` | 接受文件级 editable/reason；无 patch 项仍列出只读原因。删除项禁止编辑但保留可定位原始行评论。只有只读项时也正常展示文件列表；刷新后重新生成补丁 digest，不能把原评论迁移到新行。 |

### 本轮只补接线验收

不重复已通过的 26 项独立测试（15 项文件服务/保存状态机、9 项 Git、2 项刷新控制器）。接线有变化时重点补以下实际链路：

1. 真实临时 Git 根 + 隔离数据目录，通过正式持久宿主启动；没有 `editorWorkspace` 时 capability 为 false、接口拒绝编辑，已有只读 Agent 配置不会隐式授权。
2. 正式页面点击“工作区变更”，验证暂存/未暂存/新增文件及无变更状态；读目录不产生任务、不改变文件或 index。Web 和桌面均通过公共 Client。
3. 行内评论经真实宿主保存，刷新/重启后仍在同一补丁；修改完整文件自动保存后，以磁盘读取验证字节，不能只断言页面“已保存”。覆盖大于 128 KiB 的合法文件保存，验证代理没有旧上限。
4. 外部改文件后编辑保留草稿并显示冲突；切换房间/后台时晚到结果不污染新范围。Agent 有未停止租约时保存仍被 runtime adapter 拒绝。
5. 验证未认证/跨来源/伪造 root 请求被拒绝；删除、二进制、超限项不出现可用编辑按钮，列表没有静默遗漏；Git 缺失或整体超限不显示部分补丁。
6. 在指定持久测试入口（计划 4331）保留真实可操作页面并截图；此项完成前 #44 保持开放。4320 的模拟页只作视觉预览。

独立代码提交顺序：`d0e17b4` → `00df1d5`（关闭窄屏文件抽屉后验证冲突操作）→ `778f1bb` → `f28ff22`（Git 文件名按字面匹配）。ADR 由监督会话维护 `0008-*`，本分支不占用编号。

## 独立面板已实现

`renderer/chat/workspace-changes.tsx` 导出 `WorkspaceChanges({review,close,theme,returnFocus})`。授权的生产按钮点击后挂载它，使用当前房间的真实 `createFileReviewClient`；切换后台/房间时卸载，入口仍须校验宿主 capability。组件负责首次读取及显式刷新，不轮询、不创建任务。`DiffPreview` 新增可选完整 `changes` 元数据，保留原有 patches 调用兼容性；不丢弃无补丁的只读项。

刷新期间保留上次结果，失败明确标为旧结果；过期响应与卸载后的结果丢弃。补丁变化后清空旧评论状态并按新 digest 读取，禁止旧批注附到新行。删除文件仍可评论原始行、不能编辑；二进制/过大/不支持项显示原因；全部只读与暂无变更都支持。

`npx electron scripts/verify-workspace-changes-ui.cjs --disable-gpu` 已通过：隔离真实 Git + 认证 HTTP、完整列表/只读原因、评论版本隔离、面板自动保存落磁盘、刷新错误、空状态及窄屏暗色截图。这是独立组件验证，尚不替代正式 public Client/host/4331 的端到端验收。后续共享接线仍由本任务完成，不交由 Root 代实现。

安全修复 `2a1faf6`：Git 使用工作区外的固定绝对可执行路径；差异由已校验文件内容与 Git blob 在独立临时目录生成。对应隔离标记测试通过。
