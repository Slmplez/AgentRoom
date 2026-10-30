# 聊天展示层

## 本机真实任务（#28）

持久服务通过可信启动参数 `--agent-workspace <目录>` 明确启用只读 Pi 时，真实界面显示“本机只读任务”。Task/Run、原生问题、答复投递及待验收结果通过同一 AgentRoomClient 的快照/SSE 投影；创建与答复沿用持久提交日志、原 key 核查和显式重试。默认持久讨论仍无任务入口，原 Mock 问题/建议仍是独立模拟能力。

草稿按后端/数据库/真人/房间/问题版本隔离；重启后原输入失效并保留草稿，不自动重跑。讨论输入和任务请求独立，未知任务请求不阻止普通讨论。真实验收命令为 `npx electron scripts/verify-local-agent-ui.cjs --disable-gpu`（受控原生管道）及加 `--real-pi`（已安装 Pi + 一次回环推理，0 付费）；详见 docs/LOCAL-AGENT-QUESTIONS.md。

## 协作问题 Mock（#21）

模拟场景提供“协作问题/多选问题”，消息内点击展开后可只选、只写或选择并补充。答复经 AgentRoomClient 和版本化问题契约写入 Mock 投影，原生审批不变。场景包含答复失败/未知、原 key 核查、版本变化、过期/撤销和他人已答复；草稿仅在本页按实例/用户/房间/问题隔离。真实旧后端及持久讨论模式的新能力默认为不可用，不执行模型或本机操作。

验证：`node --test test/questions.test.cjs`、`npx electron scripts/verify-questions-ui.cjs --disable-gpu`；后者输出 `artifacts/questions-light.png` 与 `questions-narrow-dark.png`。

## Agent 建议 Mock（#22）

问题展开后可“请 Agent 提供建议”，按稳定成员 ID 选择一位或多位 Agent 并填写分析要求。建议独立关联原问题，保持真人待决定；“采用建议”产生真人决定，“输入其他方案”回到原答复输入。重新指派产生新的咨询轮次，晚到旧建议、失败、未知、离房成员的建议不能被当前轮次采纳；审批权限与任务 Owner 不受影响。

模拟场景的“推进建议答复/建议失败/建议未知/晚到旧建议/建议成员离开”控制确定性结果，未启动引擎、未实现真实协作等待恢复。`artifacts/questions-advice-light.png` 展示关联建议；咨询提交超时同样按原请求核查。真实能力依旧等待 #23。

此目录负责 React 界面和本地交互。保持现有暖灰、陶土强调、头像和双主题；业务命令通过注入的 `ChatClient` 发出，不在组件中解析引擎协议。

管理、审批和工具详情均通过统一 Client；桌面操作由 PlatformClient 提供。界面与后端契约由主集成会话完成整合。

- 会话列表：简化 Markdown 摘要；搜索会话及成员，支持清除空结果。
- 输入区：展示已选择的参与者，移除时同步更新文本与其余提及位置；无匹配项时 Enter 关闭候选，避免误发送。
- 确认中心：显示 Agent、所属会话、授权范围；问题说明可折叠；答复结果未知或已提交时禁止重复提交，稍后重新打开也保留状态。
- 结果面板：仅 Mock 模式显示“结果示例”。json-render 按固定组件目录渲染概览、表格和表单；不接受模型输出，不发送业务命令。表单草稿按会话保留在本页，刷新清除。正式产物和表单提交等待后续业务契约。

2026-10-30，U1 群聊层级已实现：有工具记录的消息通过“更多 → 查看过程”访问详情，工具失败/未知/中断提示保持外露，已有文件变更可直接打开。群聊执行状态汇总后可展开并停止指定 Run；单 Agent 保留详细工具概览。分栏宽度按 Mock/真实模式分别保存，支持刷新恢复及原有键盘/撤销；不将这些 UI 能力计作新的协作问题或持久运行时实现。

前端验证：

```text
npm run check:chat
npm run verify:chat-ui
npx electron scripts/verify-chat-polish.cjs --disable-gpu
```

运行验证前需要构建前端资源。新脚本验证搜索、提及移除后的接收者、结果面板、草稿隔离、键盘与焦点、双主题文字对比度、窄屏以及未知确认结果。脚本使用静态 Mock 页面和独立确认组件夹具，不启动生产后端。截图输出到 `artifacts/chat-polish-*.png`。

使用现有 `npm run dev:ui` 查看模拟前端；这不代表真实模型或完整解耦迁移已验收。

结果示例使用 `@json-render/core` 与 `@json-render/react` 0.21.3（Apache-2.0），完整许可证见本目录 `LICENSE.json-render.txt`。它们现在会按需打包进入 Mock 结果面板；根级 THIRD_PARTY_NOTICES.md 已同步说明。
