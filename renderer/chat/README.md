# 聊天展示层

## 消息内生成式报告（#40）

真实 Agent 的 `publish_report` 产物引用进入阅读区域后，消息内自动查询并展示 report v1 组件预览。消息与侧栏复用 `report-content.tsx` 的只读 json-render 注册表；消息预览最多展示 3 个内容块、4 项指标/条形、5 行 × 4 列表格，保留对应分组标题与说明、完整报告与历史版本入口。固定预览高度避免异步读取影响历史阅读位置。

预览通过公共 Client 按精确版本读取，旧查询、错误房间和非法组件均不能进入显示；不新增 SSE 正文或业务缓存。Mock 明确标注模拟报告，生产发布仍需可信宿主启用 `--agent-reports`。本项不包含 #39 表单提交或继续任务，后者仍依赖 #37/#38。

验证：`npx electron scripts/verify-inline-artifact.cjs --disable-gpu`、`npx electron scripts/verify-artifact-ui.cjs --disable-gpu`、`npx electron scripts/verify-artifact-mock-ui.cjs --disable-gpu`。真实 Pi 测试使用本机回环推理，不调用付费供应商；截图为 `artifacts/report-inline-light.png`。

## 富文本消息

消息启用 GFM 表格、任务列表和删除线。`mermaid` 围栏按需使用本地 Mermaid 绘制，支持明暗主题、源码查看；流式内容短暂防抖，语法错误保留源码，后续更新可恢复。普通 HTML 不作为可执行界面处理。

生成式 UI 有两个入口：Mock 的“结果示例”展示概览、表格和本地表单；消息的“查看报告”展示通过契约校验的结构化只读产物。面板默认简短视图，选择“完整”查看组件。普通 Markdown 或任意 JSON 不自动执行交互动作。

验证：`npx electron scripts/verify-rich-messages.cjs --disable-gpu`；结构化面板验证使用 `scripts/verify-preview-modes.cjs`。

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
## 真实多 Agent 咨询（#37）

生产持久模式通过独立 `consultations` 能力和同一 AgentRoomClient 展示注册 Agent、问题与执行队列。`consultations.tsx` 提供显式发起、采纳/自行答复、取消和恢复/核查/放弃；不直接请求网络或创建第二份服务端状态。可信配置、恢复边界和真实双 Pi UI 验证见 [REAL-AGENT-CONSULTATIONS.md](../../docs/REAL-AGENT-CONSULTATIONS.md)。
