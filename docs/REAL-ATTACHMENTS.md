# 真实附件（#38）

本机持久讨论支持桌面和 Web 选择文件、暂存、显式关联消息及认证下载。普通消息和附件都不启动 Agent。启动方式仍为 `npm run dev:persistent`，桌面使用 `npm run desktop:persistent`；无需额外开关。

## 用户流程

“添加附件”打开浏览器/桌面的文件选择器，按顺序上传选中的文件。成功的文件进入当前房间暂存区；符合单条消息数量和总大小的文件自动选中。用户可以取消选择、选择此前的暂存文件，或移除尚未关联的文件。暂存列表显示失效时间。点击发送才生成消息；允许正文为空的纯附件消息。

每文件 1 byte–8 MiB；每消息最多 5 个、合计不超过 20 MiB；整个数据库内容额度 256 MiB（包括暂存内容）。未关联的附件在 24 小时后不可访问，每轮维护最多回收 100 条；已关联内容不自动清理。文件使用稳定 ID，可以明确引用到同房间后续消息，但单条消息内不允许重复 ID。移除操作不能删除已关联文件。

支持 UTF-8 `txt/md/csv/json/log`（无 NUL），以及基本签名匹配的 `pdf/png/jpg/jpeg/webp`。拒绝其他扩展名、无效 UTF-8、错误签名、不安全显示名和超限内容。签名校验不是杀毒或完整格式解析；所有类型都作为下载文件，不内联执行，不自动解析成报告、写入工作目录或导入记忆。

文件选择器只上传用户选择的字节；协议不接收目录、软链接对象、本机路径或远程 URL，也不根据路径回读。浏览器不提供源文件是否经操作系统软链接解析的可靠信息，因此本实现不宣称能识别源文件系统链接；无论源是什么，后端只保存已选择的字节。

## Interface 与事务

UI 只调用 AgentRoomClient：

- `uploadAttachment({key, roomId, name, file: Blob, signal?})`：返回持久回执和附件元数据。Blob 仅存在于当前调用，不进入本地命令日志或业务投影。
- `query({type: 'pendingAttachments', roomId, afterId?, limit?})`：只读本人未过期暂存内容，每页最多 100 条；`attachment` 查询使用房间和附件 ID。
- `dispatch({type: 'send', ..., attachmentIds})`：消息、引用、状态更新、回执与事件同事务提交。文字与附件都为空则拒绝。
- `dispatch({type: 'removeAttachment', key, schemaVersion: 1, workspaceId, roomId, attachmentId})`：删除本人未关联内容，保存不可变回执和元数据事件。
- `downloadAttachment({roomId, attachmentId})`：通过认证读取、验证长度和 SHA-256，返回 Blob 与显示名；UI 创建短期 object URL，触发明确下载后释放。

ApplicationRuntime 拥有唯一提交事务，内部 attachments Module 不自己提交。SQLite schema 6→7 新增 BLOB/元数据表及暂存/过期索引，给消息增加默认空附件引用；旧数据、回执和事件游标保持。无附件的讨论命令保留旧哈希，旧日志可以核查并显式重试。

上传的 BLOB、长度/摘要、归属、暂存期限、回执和事件原子提交。关联消息在另一次事务中检查本人、同房间、有效期、数量/总大小和内容完整性，再固定消息中的引用元数据。失败整体回滚。SSE、快照、回执和日志只含元数据，不能包含字节、base64、路径或凭据；未关联附件的读取和事件只对上传者可见。

## HTTP 与宿主

| 操作 | 路由 |
| --- | --- |
| 上传 | `POST /api/v1/rooms/:roomId/attachments` |
| 本人暂存列表 | `GET /api/v1/rooms/:roomId/attachments?limit=100&afterId=...` |
| 元数据 | `GET /api/v1/rooms/:roomId/attachments/:id` |
| 移除暂存 | `POST /api/v1/rooms/:roomId/attachments/:id/remove` |
| 下载 | `GET /api/v1/rooms/:roomId/attachments/:id/content` |

上传使用 `application/octet-stream`，头部包含 `Idempotency-Key`、`X-Workspace-Id`、百分号编码的 `X-Attachment-Name` 和 `X-Content-Sha256`。服务端重新计算实际字节长度与摘要。认证发生在接收之前；上传接收器同时最多两个请求，超出返回 busy；实际流量硬限 8 MiB，不能依赖 Content-Length。普通 JSON 上限仍为 128 KiB。

下载按房间和 ID 查询，核对内容完整性，不接受任意路径或 Range。响应强制 `Content-Type: application/octet-stream`、`Content-Disposition: attachment`（安全 ASCII 回退及 RFC 5987 UTF-8 名称）、`Content-Length`、`nosniff` 和 `no-store`。宿主只转发所需请求头和允许的下载响应头，仍使用 HttpOnly 同源会话及服务端 Bearer 凭据。旧联调后端明确拒绝附件命令，不静默丢弃附件。

## 未知结果与恢复

上传前先在既有持久命令日志记录元数据、SHA-256 和原 key。网络失败或停止已发出的上传保持 unknown；页面刷新只查原回执，不能自动上传。核查 found 后读取当前暂存状态；核查 not_found 后，用户重新选择名称、长度、摘要一致的文件，才可明确重试原 key。不能把 File、路径或字节序列化到 localStorage。

原回执不可变；例如已成功上传但后来删除或过期，再次查询原 key 仍能确认原上传曾提交，不代表附件现在还可用。后续操作以当前元数据查询为准。后端重启不重发上传或发送；打开消息后重新下载原始内容。

## 验证

- `node --test test/attachments.test.cjs`：格式、名称、大小、额度、归属、TTL、关联、损坏、幂等、回滚和二进制 HTTP。
- `node --test test/attachment-client.test.cjs`：公开 Client 双端同步、纯附件消息、无二进制日志、响应丢失后刷新只核查、停止上传、重选文件哈希匹配与下载校验。
- `node --test test/attachment-durable.test.cjs`：真实子进程分别在上传/关联提交前后强杀；重启全有或全无；两个正在接收的流、第三个 busy、chunked 超限无回执。
- `electron scripts/verify-attachments-ui.cjs --disable-gpu`：生产宿主、真实文件选择、桌面/Web 发送下载、草稿/选择刷新、取消选择、响应丢失原回执、移除、格式拒绝、重启下载、明/暗与宽/窄截图。下载 SHA-256 与原文件一致。
- `npm test`、`npm run check:chat`、`npm run check:client`、`npm run build:renderer` 和原持久讨论 UI 回归。

截图：`artifacts/attachments-light-wide.png`、`artifacts/attachments-dark-narrow.png`（本机验证产物，不提交二进制截图）。#39 表单可复用该附件模块的关联校验，在保存答复的 Runtime 事务内固定附件引用。
