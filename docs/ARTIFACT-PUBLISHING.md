# 真实 Agent 报告发布（#27）

本实现扩展 #26 的单机执行：真实 Pi 调用 `publish_report` 后，ApplicationRuntime 在同一 SQLite 事务保存不可变版本、Agent 交付消息、事件和幂等回执。发布不等于验收；正常执行结束仍进入 `reviewing`。普通讨论和默认只读执行不会获得发布工具。

## 宿主启用

可信宿主在创建 Runtime 时显式装配，HTTP 请求不能传递可执行文件、环境、路径或发布身份：

```js
import { createApplicationRuntime } from '../lib/application-runtime/index.mjs';
import { createPiArtifactEngine } from '../lib/pi-artifact-engine.mjs';

const runtime = await createApplicationRuntime({
  directory: databaseDirectory,
  execution: {
    agentId: 'local-pi',
    artifacts: true,
    createEngine: ({ publishArtifact }) => createPiArtifactEngine({
      publishArtifact,
      directory: trustedWorkingDirectory,
      args: trustedProviderArgs,
      env: trustedProviderEnvironment,
    }),
  },
});
```

以上变量由宿主配置产生。#29 在正式启动入口增加 `--agent-reports`，必须同时指定 `--agent-workspace`；详见 [真实报告界面](ARTIFACT-VIEW.md)。默认不启用报告发布。发布适配器保留 `read/grep/find/ls`，显式增加 `publish_report`，不授予 shell 或文件写入工具。

每次执行创建独立的回环桥接和短期凭证，仅生成的 Pi 扩展持有；关闭时释放监听器并删除扩展。桥接只接受正确 Host、Bearer 和 JSON POST，拒绝 Origin、重复 JSON 键与原型键。外部 CLI 异常退出时 Runtime 关闭适配器；宿主被强杀时 OS 回收监听器，可能残留的临时扩展凭证无法授权新执行。不要把扩展源文件或桥接凭证写入消息、日志或产物。

## 工具与校验

输入为 `{ key, artifactId?, expectedVersion, title, catalogVersion: 1, spec }`。首次发布省略 artifactId、expectedVersion 为 0；更新必须传已存在的 artifactId 和当前版本。Task、Run、房间、Agent、执行代次均从宿主闭包读取，额外身份字段被拒绝。只有当前正在运行的代次能新建版本；结束后的重复请求只能取得已提交的原回执。

`contracts/artifacts.mjs` 同时提供运行时校验和模型工具 JSON Schema：Section、Metrics、Bars、Table 四种组件，不含动作、表达式或 HTML。报告最多 256 KiB、100 节点、8 层；严格限制属性、文本、表格行列、条形图数值，要求所有节点恰好可达一次。

回执 key 按 `runId:key` 隔离。相同 key 和规范化内容返回原回执，改变内容返回 `idempotency_conflict`；版本过期返回 `conflict`。发布接口不自动重试。结果未知时先查询回执，不重跑 CLI。

## 前端读取契约

所有路由沿用已有 Bearer 鉴权，并校验房间可访问性：

| 路由 | 结果 |
| --- | --- |
| `GET /api/v1/rooms/:roomId/artifacts/:artifactId/versions?limit=20&beforeVersion=N` | 倒序版本元数据及下一页 beforeVersion |
| `GET /api/v1/rooms/:roomId/artifacts/:artifactId/versions/:version` | 精确版本元数据与 spec |
| `GET /api/v1/operations?workspaceId=…&commandType=publishArtifact&key=runId%3Akey` | 原发布回执 |

消息和 `message.created` 事件仅携带 `artifactRefs: [{ artifactId, version, title, catalogVersion }]`，没有报告正文。快照/历史仍返回相同引用。正文必须按引用中的精确版本读取，不能隐式替换为最新版。DTO 使用 artifactMetadataSchema、artifactVersionSchema、artifactVersionsSchema；消息作者类型扩展为 agent，旧消息得到空引用数组。

Bootstrap 声明 `readOnlyArtifacts: true`；`artifactPublishing` 反映宿主是否显式启用发布。关闭发布不影响历史报告读取。跨房间/不存在为 404，内容损坏为 `artifact_unavailable`/409，未知目录为 `unsupported_catalog`/422。返回数据不包含私有执行代次、本机路径、凭证或原生协议 ID。

SQLite 从 v2 迁移到 v3，扩展作者类型和消息引用，新增 artifact_versions。升级保存既有数据库身份、消息序号、回复关系、事件游标、回执与任务；旧后端拒绝打开更高版本数据库，不能降级覆盖。

## 验证

`node --test test/artifacts.test.cjs` 覆盖发布、幂等与版本冲突、越权、身份伪造、树/大小约束、内容损坏、真实 v2 迁移，以及事务提交前后强杀子进程。重启只恢复事实并把未确认执行标为 unknown，不启动第二个 CLI。

`node scripts/verify-artifact-agent.cjs` 使用已安装的真实 Pi、真实发布扩展、持久 HTTP API 和 SQLite；本机模型端点发出工具调用，Pi 发布后继续第二次推理。它验证真实 CLI/工具协议，不代表外部模型供应商的可用性或自动生成质量，也不会调用付费供应商。

#29 提供真实报告的前端入口、历史版本和交互验收；本文记录 #27 的后端行为。未实现表单动作、文件导入、多人身份或自动重试。
