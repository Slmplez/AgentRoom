# #38 实施票：认证上传、关联消息与下载真实附件

Parent: #24。依赖：#29 已合入；#37 共享 runtime/http/contracts/Client 交接并合入后开工。规则依据 docs/ARTIFACT-ACTIONS-ATTACHMENTS-PLAN.md。规则已冻结；ready-for-agent 表示明确，依赖合入前不得实施。

## 完整行为

本机用户在桌面/Web 选择文件，上传到指定 Room 的暂存区，显式发送成消息；另一客户端和后端重启后可认证下载原始字节。生产流程使用 ApplicationRuntime + SQLite BLOB，不使用示例文件或本机路径回读。

## 固定范围

- 每文件 1 byte–8 MiB，每消息最多 5 个且总计 20 MiB，数据库内容额度 256 MiB；待发送内容保留 24 小时，linked 不自动清理。
- 支持 UTF-8 txt/md/csv/json/log，以及签名匹配的 pdf/png/jpg/jpeg/webp；其他格式明确拒绝。
- 安全显示名，不使用文件名作为存储路径；内容/元数据/回执原子保存，消息/表单引用另一次原子关联。
- 默认本机认证权限，所有上传/查询/下载/删除检查 Room 与身份。下载强制 attachment/octet-stream/nosniff，无任意路径、远程下载、inline 执行或工具执行。
- 公共 Client 处理二进制与凭据。日志只存元数据、摘要和原 key；unknown 查原回执，未找到后用户重新选择一致文件才显式重试。
- 默认顺序上传、后端同时接收最多 2 个体；actual bytes 硬限额，不能只信请求头。

## 验收清单

- [ ] 桌面/Web 两客户端真实上传、消息引用、下载内容 SHA-256 一致；只有附件的消息可发送。
- [ ] 每个支持类型有正例；错误签名、UTF-8、扩展名、路径/CRLF/保留名、过大/额度/个数/总大小负例无部分内容或引用。
- [ ] 同 key 原回执、改内容冲突、跨 Room 拒绝、未关联内容身份保护、重复引用策略有测试。
- [ ] 上传/绑定各事务提交前后强杀，重启全部或无；响应丢失只查原 key，不自动上传/发送。
- [ ] 过期和删除只影响未关联内容；已发布下载、缺失/损坏、未知结果状态明确；后台回收有界。
- [ ] SSE/快照/日志不含 bytes/base64/路径/凭据；宿主下载头与认证代理有端到端测试。
- [ ] 生产 UI 文件选择、取消、失败重试、暂存恢复、移除、发送与下载；聊天草稿和阅读位置不被覆盖。
- [ ] 旧消息、任务、报告、记忆迁移和回归通过；提交 SHA、文档、截图可枚举。

文件责任：新增附件契约/内部模块、已交接的 storage/runtime/http/host、Client 传输、composer/thread 和独立附件 UI。不得在 #23 占用期间写共享文件，不改 main、不推送、不关闭父票。

Parent: https://github.com/Slmplez/AgentRoom/issues/24
Blocked by: https://github.com/Slmplez/AgentRoom/issues/37
