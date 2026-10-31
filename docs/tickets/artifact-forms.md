# #39 实施票：真实 Agent 表单答复与明确继续原任务

Parent: #24。依赖：#37 的实际执行等待与调度完成并交接，#29 已合入，附件 #38 切片完成后开工。规则依据 docs/ARTIFACT-ACTIONS-ATTACHMENTS-PLAN.md。规则已冻结；ready-for-agent 表示明确，附件 #38 与 #37 合入前不得实施。

## 完整行为

已启用能力的真实 Pi 发布受限 form 产物并等待本机用户；用户在报告侧栏填写多类型字段，保存真实答复，随后单独点击继续，把冻结的答复仅投递到原 Task/Run/incarnation，使原工具继续。提交本身绝不启动下一步执行。

## 固定范围

- form v1 独立于 report v1；最多 64 KiB 定义/值、6 分组、20 字段，仅 text/textarea/number/select/multiselect/checkbox/date/attachments；无模型代码、任意绑定、动态 URL 或任意 action handler。
- 固定命名动作 record_response / resume_task；宿主 --agent-forms 要求 --agent-workspace 和 --agent-reports，默认关闭。
- 字段规则、选项和任务归属在发布版本时冻结，源于存活执行绑定；模型和页面均不能选择其他执行目标。
- 表单定义、引用、等待、答复修订、继续意图、事件和回执由 ApplicationRuntime 统一事务管理。期望产物版本、答复修订和等待修订分别校验。
- 一次等待只投递一次；同 key 返回原回执，内容不同冲突。保存与投递状态分开；旧回执不恢复过期等待。
- 引擎/宿主中断标明 expired/unknown；重启不启动新 CLI、不重放原 Task。复用 #23 调度，不另写第二套后台队列。
- 附件字段只能关联同 Room、可访问且完整的附件 ID；不自动读取文件内容进入模型或执行文件。

## 验收清单

- [ ] 真实 Pi + 本机推理发布 form；仅保存时保持等待且推理计数不增加；明确继续后原工具得到正确修订值，同一 Task 继续。
- [ ] 双客户端不同类型字段与约束、额外字段、旧版本/修订冲突、附件范围、重复提交、重复继续均有真实 HTTP 测试。
- [ ] 产物/答复/继续意图提交前后强杀；已提交回执可查，unknown 不重放，旧 incarnation 不能满足新等待。
- [ ] 新版本不覆盖草稿；已保存值与未提交编辑区分；冲突、权限、失效、网络中断和响应未知可见且可核查。
- [ ] 简短/完整报告预览、原只读报告 DTO、Diff 侧栏、设置中的记忆入口保持；Mock 不冒充真实表单。
- [ ] 桌面/Web、刷新/重启、焦点/Escape/IME/键盘、窄屏/主题及 reduced-motion 验收通过。
- [ ] 最终结果不自动标记 Task 验收完成；提供准确源提交、真实 CLI 证据与明确外部供应商验证边界。

文件责任：表单契约与内部模块、#23 交接后的执行等待/工具桥接、artifacts/public Client、独立 form UI 与报告入口；迁移号按实际合入数据库版本递增。父票由监督统一验收，不直接关闭。

Parent: https://github.com/Slmplez/AgentRoom/issues/24
Blocked by: https://github.com/Slmplez/AgentRoom/issues/38
Blocked by: https://github.com/Slmplez/AgentRoom/issues/37
