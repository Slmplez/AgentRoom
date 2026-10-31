# 真实 Agent 表单与明确继续

实现票：[#39](https://github.com/Slmplez/AgentRoom/issues/39)。本机单用户、真实 Pi CLI；扩展既有持久任务、报告、附件和 Client。没有第二套执行队列，也不引入 hcom 兼容入口。

## 启用与边界

使用现有持久宿主启动入口，显式添加 `--agent-workspace <只读工作目录> --agent-reports --agent-forms`。例如：

```powershell
node scripts/serve-persistence.cjs --data-dir .data/persistent --agent-workspace E:/Work/ReadOnlyProject --agent-reports --agent-forms
```

`--agent-forms` 默认关闭，要求同时指定工作目录和报告能力。关闭动作能力后仍可查询已有定义与答复历史。生产模型配置沿用当前 Pi 配置；验证脚本另用隔离的回环推理配置，不改全局配置。

Agent 获得固定工具 `request_form({ key, artifactId?, expectedVersion, title, spec })`。它发布不可变 `kind: form` 产物及消息引用，并在原工具内等待。宿主绑定 Task、Run 和 incarnation；模型不能传入替代身份、执行目标、路径或任意处理函数。相同发布 key 返回原回执，不附加第二个等待，也不再次投递旧答复。

表单目录 v1 仅支持 text、textarea、number、select、multiselect、checkbox、date、attachments。最多 6 个平铺分组、20 个字段；定义与答复各最多 64 KiB UTF-8。字段 ID、唯一选项、文本长度、有限数值、整数/上下界、Gregorian 日期和默认值由共享契约校验。必填文本不能仅有空白，保存时保留原文。禁止代码、HTML 控件、动态 URL、嵌套表单、表达式及任意 actions。

## 两个独立动作

| 产品动作 | Client 命令 | 持久行为 |
| --- | --- | --- |
| 提交答复（record_response） | `submitForm` | 核对产物版本和 expectedResponseRevision，保存不可变答复修订、摘要消息、附件引用、事件及回执；不继续执行 |
| 继续原任务（resume_task） | `continueForm` | 核对当前产物版本、responseRevision、expectedWaitRevision 和存活原工具，原子记录固定修订的继续意图 |

`POST /api/v1/forms/commands` 使用认证和 `Idempotency-Key` 请求头；JSON 不重复携带 key。`POST /api/v1/forms/query` 提供 `formState` 和分页 `formResponses`。定义沿用按房间/产物/版本的 artifact 查询。页面仅调用 AgentRoomClient；HTTP、凭据、SSE、原请求日志和核查都在 Adapter 内。

SQLite schema 8 为产物增加 kind（旧数据默认 report），增加 form_waits、form_responses。ApplicationRuntime 独占事务，内部 forms 模块不自行提交。提交答复时沿用附件关联校验：同 Room、可访问、完整、未过期；每次答复最多 5 个不同附件、合计 20 MiB。工具收到冻结值和附件元数据，不收到二进制、本机路径或自动写入工作目录的权限。

## 投递与恢复语义

状态依次为 `waiting → pending → attempting → submitted`。`submitted` 表示原工具回调已解析交付并通过私有接收标识确认；不代表模型已处理完毕，不代表 Task 通过验收，也不宣称外部副作用 exactly-once。私有接收标识不进入公开事件、Client DTO 或模型结果。

等待和原生输入互斥：未收到表单工具 ACK 前拒绝新的原生输入，不能删除尚待确认的表单引用。明确继续只投递一次，始终使用已保存的指定修订；UI 未保存编辑不能随继续命令传给模型。

重启后 waiting 变 expired，pending/attempting 变 unknown，已确认 submitted 保持历史事实；不启动新 CLI，不恢复过期工具，不重放未知请求。正常关闭先停止原 CLI，关闭中的工具请求不返回可触发新模型轮次的错误结果。执行最后仍只进入 reviewing，未自动验收。

命令结果未知时先查原 key；not_found 后用户可以明确重试原请求，不能用新 key 绕过待核查操作。原回执不可变，查到原回执不意味着当前等待仍有效。公开状态查询和 SSE 提供当前事实。

## 界面行为

消息中的“填写表单”打开独立侧栏；报告仍保留原只读 DTO 和简短/完整显示。草稿按后端、数据库、用户、Room、产物和版本隔离。切版本时必须等新版本定义及状态匹配，不能把旧版修订写入新版草稿。冲突和晚到查询不覆盖编辑；用服务器答复替换草稿需要明确点击。

保存与继续分开，只有草稿与当前已保存修订一致且等待存活时才能继续。旧版、过期、未知及离线状态保留内容但禁用动作。历史答复分页只读。附件控件的添加、移除、分页、核查、重试和下载均为非 submit 按钮，不得隐式保存表单。

## 验证记录

- `test/forms.test.cjs`：固定文法/字节上限、默认值、发布幂等、答复 CAS、跨房间附件、精确修订投递、原生等待互斥、重启失效/未知及 schema 7 迁移保留附件事实。
- `test/forms-client.test.cjs`：真实认证 HTTP 与公开双 Client、查询范围、错误响应范围、响应丢失核查、不可变历史分页、显式重试继续、不重复交付。
- `test/forms-durable.test.cjs`：9 个真实子进程强杀点，覆盖发布/答复/继续意图提交前后、交付前后和 ACK 提交之后；重启保留全有或全无事实，不自动重放。
- `electron scripts/verify-forms-ui.cjs --disable-gpu`：真实已安装 Pi CLI、生产宿主、独立桌面/Web 存储、8 种控件、双端冲突/草稿、新版本、丢失响应、真实附件、核查/分页不提交、历史、IME/Escape/焦点、明暗宽窄和 reduced-motion；正常关闭/重启无额外推理。共 4 次回环推理，0 次外部付费调用。
- 既有报告、附件、持久讨论、双 Agent 咨询、记忆设置和 Diff 工作区 UI 回归通过；截图位于忽略目录 `artifacts/forms-light-wide.png`、`artifacts/forms-dark-narrow.png`。

这些证据验证真实 CLI 与本机推理协议续接，不声称完成外部供应商表单推理验证。最终测试数量和源提交以 #39 交接评论为准；主线集成由监督串行完成。
