# Magpie 实机验证（2026-10-31）

关联任务：[#25](https://github.com/Slmplez/AgentRoom/issues/25)。开发基线 `30c8f1c`，仅增加验证脚本和记录，不修改 Runtime、Client 或 UI。

## 结论与范围

已使用官方 Windows CLI **Magpie 0.1.2286** 运行实际网关，而非模拟 Magpie 的 HTTP 响应。

| 路径 | 已验证 | 边界 |
| --- | --- | --- |
| AgentRoom 模型目录及认证转发 → Magpie → 受控上游 | 模型列表、Chat SSE、工具调用与结果续接、422 错误透传、取消到达上游 socket | 上游为本地确定性夹具，不是外部模型推理 |
| 同上，Anthropic Messages / OpenAI Responses → Chat 上游 | 两种协议的文本流转换和结束事件 | 不代表所有供应商或这两种协议的真实模型工具行为 |
| AgentRoom → Magpie → 本机凭据转发器 → 官方 DeepSeek | 模型发现、真实文本流、模型生成的 echo 工具调用、工具结果续接 | 使用 `deepseek-flash`，Chat Completions；没有把外部供应商的算力停止或计费停止作为取消验收 |

外部推理共 **3 次请求**，每次 `max_tokens: 64`、关闭思考，供应商报告总量 **398 tokens**（输入 365，输出 33）。echo 只返回测试字符串，不执行文件、网络或系统操作。

## 可复现来源

- [官方发布 v0.1.2286](https://github.com/yetone/magpie-releases/releases/tag/v0.1.2286)
- 资产：`magpie-cli-windows-amd64.exe`，64,662,528 bytes。
- SHA-256：`e545e079d55086d798c19f567e536e94355a64564d530210f8dfcb8f081bb29a`，与 GitHub release asset digest 一致。
- `--version` 返回 `magpie 0.1.2286`；`go version -m` 模块为 `github.com/yetone/magpie v0.1.2286`。
- [Magpie 配置与网关说明](https://github.com/yetone/magpie/blob/main/docs/reference.md)
- [DeepSeek 官方入口与模型说明](https://api-docs.deepseek.com/)

## 本机检查与凭据处理

初始未发现 PATH 中的 Magpie、对应运行进程、默认 3425 监听、常见配置目录或本机 Ollama / LM Studio 进程。已检查仓库 `.data` 及 Roaming 下 `Agent Room`、`AgentRoom-persistent-ui` 的连接记录，没有找到 `connections.json`。

Pi 的 `settings.json` 指向 `deepseek/deepseek-flash`，`models-store.json` 有官方 `https://api.deepseek.com` 的模型缓存。Pi `auth.json` 为空，但当前环境已有 `DEEPSEEK_API_KEY`；对官方模型目录的认证读取返回 HTTP 200。没有输出或复制密钥到文档。

官方 CLI 仅下载到任务副本的忽略目录 `artifacts/magpie/`，没有安装系统服务、修改 PATH 或修改现有 Agent 配置。每次脚本启动使用独立 `XDG_CONFIG_HOME` / `XDG_CACHE_HOME`、随机回环端口和 `MAGPIE_NO_STATS=1`。

外部测试通过本机临时 relay 将现有密钥仅注入 `api.deepseek.com` 的请求；Magpie 配置中只保存无敏感性的本地 relay 占位凭据。不会把真实 API Key 交给 CLI 参数或写入磁盘。脚本不输出 Magpie 原始启动日志，因为日志可能包含本机访问令牌。测试结束关闭本次网关、relay 和 CLI，已核实无剩余 Magpie 进程。

## 运行方法

先从上述官方发布获取 CLI 并核对哈希。依赖使用项目现有 Node，无需 npm 新依赖。

```powershell
$env:MAGPIE_TEST_BINARY = 'E:/path/to/verified/magpie.exe'
node scripts/verify-magpie-real.cjs
```

真实供应商测试需要已有的 `DEEPSEEK_API_KEY` 环境变量，并显式接受最多三次推理请求：

```powershell
node scripts/verify-magpie-external.cjs --allow-billable
```

两份脚本均输出证据文件的绝对路径。受控与外部证据分别标记 `real-magpie-controlled-upstream`、`real-magpie-external-deepseek`，不能互换。没有外部凭据时，前者仍可独立运行；不能据此宣称外部推理通过。

本轮证据保存在 `docs/verification/magpie-controlled-2026-10-31.json` 和 `docs/verification/magpie-external-2026-10-31.json`。另已通过两份脚本的 Node 语法检查和 `test/model-catalog.test.cjs` 六项回归。
