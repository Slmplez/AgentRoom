# Memory / Soul 对照实验

研究日期：2026-10-30（Asia/Shanghai）。**这是独立实验，不是生产记忆或 Soul 接入，也不是完整三方语义性能排名。** 不加载应用配置、真实聊天或任务数据库。

## 已实际执行的结果

| 路径 | 结果 | 可以据此判断什么 |
| --- | --- | --- |
| SQLite + FTS5 + 中文分词 | 13 个场景中 12 通过，1 个检索质量场景失败 | 明确保存、来源字段、更正历史、范围过滤、删除 tombstone 可以用很小的本地实现完成；不同措辞的语义召回不足 |
| Mem0 OSS TypeScript 3.3.1 + DeepSeek Flash + **词法哈希向量** | 13 个场景中 10 通过，3 失败；另外新 Node 进程读取持久数据通过 | 真实 SDK、模型抽取、SQLite 存储、更新和 history 已跑通；没有验证真实语义 embedding 的质量 |
| Hindsight 1.1.0 | **安装/启动阻塞，0 个功能场景执行** | 不能据此评价 Hindsight 的召回、证据或纠错能力 |
| Soul | 应用层独立 SQLite 实验通过；另有两个真实模型回答样例 | 独立个性配置可以持续保存、单独修订，记忆提取者不能调用编辑操作；不是生产鉴权或长期个性稳定性证明 |

结果包含应用层与后端层检查，**不能把 Soul 检查计作 Mem0/Hindsight 自带功能**。完整原始结果见 [results](./results/)。

### SQLite 的实际不足

`storage technology selection` 与原记录 `The project database is SQLite` 没有足够词面重合，有三条同房间干扰记录时未召回正确决定。中文问题中有部分词重合的另一个案例通过；这不代表中文语义检索已解决。

### Mem0 的实际发现

- `mem0ai/oss` 可直接从 TypeScript 调用。实际安装的 `memory` vector provider 使用 SQLite 文件，因此不应依据旧介绍把它认定为纯内存存储。`reopen-mem0.ts` 在新 Node 进程、不调用模型的情况下通过官方 `getAll` 读取到了共享决定和来源字段。
- 来源字符串通过 metadata 保留下来；这是**来源字段传递**验证，不是 SDK 自动归档原文的证明。
- 显式 `update` 后能查询新版，`history` 返回 ADD/UPDATE 记录。没有验证自动冲突消解；本实验维护的来源 ID → SDK ID 映射仍是内存数据，不能直接搬入生产。
- `delete` 后搜索不到该条；再次 `add` 旧来源后它重新出现。**防止已删除来源重放，需应用持有 tombstone/来源版本策略**。这是原生行为观察，不在 Adapter 中偷偷过滤以制造通过结果。
- 两个检索质量场景失败。此次用的是明确选择的词法哈希向量，而且模型会将中文输入提炼为英文；不能由此推断 Mem0 配合真实多语言 embedding 的效果。
- 最新记录中五次初始写入约 0.9–3.0 秒；SQLite 明确写入约 2–3 毫秒。两者做的工作不同，前者有真实 LLM 抽取；这些是单次观察，不是吞吐量或成本结论。Mem0 调用没有采集 token 账单。

### 安装阻塞与已尝试操作

1. 本机 Node 24.4.1、Python 3.12.1、uv 0.8.2；DeepSeek `/models` 返回 200，实际回答和 Mem0 抽取成功，所以不缺模型凭据。
2. 完整 `npm install` 多次停留在本地 ML/native 依赖下载，最初真实运行返回缺少 `onnxruntime-node`。随后将 Transformers 标记为可选依赖，`npm install --omit=optional` 成功安装 Mem0 和 `better-sqlite3`，完成真实 Mem0 词法模式验证。语义模式依赖仍未装齐。
3. 单独取 registry 元数据成功；`better-sqlite3` tarball 的两次 20 秒完整下载探测超时，但 npm 的后续安装成功。说明存在下载延迟，**不能声称该包永久不可访问**。记录见 `results/preflight.json`。
4. Hindsight 最初的安装命令误用了包名 `pg0`，解析明确报不存在，已改为官方 `hindsight-api-slim[embedded-db]==1.1.0`。正确命令的依赖解析仍长时间未完成，在收尾时中断，虚拟环境只有初始化文件。没有声称它与 Windows 不兼容。
5. Hindsight 实际启动尝试返回 `.venv/Scripts/hindsight-api.exe ENOENT`。SDK 已可导入，但本地 API 服务未安装，所以没有通过任何后端场景。`hindsight.ts` 的服务配置和返回值映射尚待真实服务验证。

## Soul 在本实验中的含义

每个 Agent 有自己的持久身份与个性，示例为：

| Agent | 个性 | 表达方式 | 工作方式 |
| --- | --- | --- | --- |
| 鸢尾 / iris | 冷静、审慎 | 简洁、直接 | 先核实证据和风险 |
| 余烬 / ember | 热情、好奇 | 温暖、生动 | 先提出可能性，再做小实验 |

Soul 与个人经验、房间共享知识分别保存。Soul 不进入模糊检索，也不随记忆抽取自动覆盖。明确编辑只改变指定 Agent，并记录 revision；重启后保留。`soul-demo.ts` 将两份 Soul 和同一份共享事实交给真实 DeepSeek Flash，保留回答与 usage 在 `results/soul-demo.json`。样例仅供人工观察表达差异，两份回答有重合，尚无长期个性一致性评测。

`human-owner` 是可信测试输入，**不是生产权限校验**。没有新增产品设置页、成员配置、引擎提示注入或真人登录授权，也没有修改 GLOSSARY/ADR 来宣布未确认的产品策略已采纳。

## 无依赖复跑基线

在本目录，Node >=24.4.1：

```powershell
node --test verify.ts
node run.ts sqlite
```

无需 `npm install`、Python、API key 或联网。三项自动测试覆盖持久重开与范围隔离、版本幂等/纠错/删除重放、Soul 权限与独立修订。场景程序另输出 13 项结果。`run.ts` 的退出码：2=设置阻塞，1=非检索质量检查失败，0=其余；检索质量失败保留在 JSON，不能只看退出码。PowerShell 外层可能将原生命令的非零退出统一显示为 1，应以 JSON 状态为准。

每次运行使用新的 `runtime/<backend>-<timestamp>`，不会重用生产数据。`results/*.json` 是最近一次结果；重复执行会覆盖同名报告。后台服务绑定随机 loopback 端口。虚拟环境、数据库、模型缓存和运行日志均被本目录 `.gitignore` 排除。

## 复跑真实 Mem0 词法集成

```powershell
npm ci --omit=optional --no-audit --no-fund
# 在调用进程环境提供 DEEPSEEK_API_KEY；不要写入脚本、命令参数或提交。
$env:MEMORY_EMBEDDING_MODE = 'lexical'
node run.ts mem0
node reopen-mem0.ts
Remove-Item Env:MEMORY_EMBEDDING_MODE
```

词法模式使用真实 SDK、真实 LLM 和真实 SQLite，仅用可检查的 384 维词哈希替代语义模型，**不是静默 fallback**。默认不启用它。删除重放场景预期暴露失败，因此此命令返回非零；不要改成“通过”。

完整语义模式需要成功安装 optional dependencies，并下载 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` 的量化 ONNX 模型：

```powershell
npm ci --include=optional --no-audit --no-fund
node run.ts mem0
```

模型缓存保存在本地 `runtime/model-cache`，仅 CPU 推理；没有语义模型时直接报告 blocked，不伪造成功。首次模型下载与 Windows native 运行依赖是尚未完成的实际门槛。

## 继续 Hindsight 验证

```powershell
uv venv .venv --python 3.12
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
# 使用相同 DEEPSEEK_API_KEY；先可显式选择 lexical 隔离服务安装问题。
$env:MEMORY_EMBEDDING_MODE = 'lexical'
node run.ts hindsight
Remove-Item Env:MEMORY_EMBEDDING_MODE
```

也可设置 `HINDSIGHT_URL` 指向专供该实验的可访问服务。此时不启动/停止外部服务，模型与 embedding 配置由外部服务负责，不能假设它与本地配置一致；服务上的合成 bank 会保留。当前未支持外部服务认证配置，需该环境单独接入后才能测试受保护服务。

本地 launcher 通过子进程环境传模型凭据，不放到命令参数。每次使用独立 pg0 数据库名称；测试后关闭自己启动的进程树。Hindsight 原型配置为 RRF、同步 retain、关闭自动 consolidation、只召回原始事实；因此即便未来这些场景通过，也还要另测 observations/reflect 的纠错和删除传播。Python 顶层版本固定，但依赖解析尚未成功，**尚无完整 Python lock**。

## 文件与后续采纳门槛

- `run.ts`：共同合成输入和场景；`fixture://...` 来源指向其中的固定输入，不是真实聊天。
- `sqlite.ts`：FTS5 基线，保留修订和删除 tombstone。forget 只阻止召回，历史仍保留，不能称为彻底擦除。
- `soul.ts`：独立 Soul 实验存储；`soul-demo.ts`：真实模型样例。
- `external.ts` / `hindsight.ts`：候选 Adapter。它们还不是生产 Module，不提供完整成员 ACL、授权撤销或备份删除。
- `embeddings.ts`：显式词法模式与待完成的真实多语言 ONNX 模式。
- `verify.ts` / `reopen-mem0.ts`：可运行验证；`preflight.ts`：导入、安装与下载诊断。

下一步先让真实语义 embedding 和 Hindsight 服务运行起来，再用更多中英文数据验证相关性、证据保真、权限撤销、后台整合和删除传播。不能根据本轮有限结果决定“Mem0 优于 Hindsight”。

独立 worktree：`E:/Repo/ASCET/agent-chat-desktop-memory-comparison`，分支 `codex/memory-comparison`，基线 `76ca09b68d02bb7ca3562a493e394c579daddd6c`。仅修改 `experiments/memory-comparison/`，主分支整合交由协调聊天串行执行。

一手参考：[Mem0 TypeScript](https://github.com/mem0ai/mem0/tree/main/mem0-ts)、[Hindsight 安装](https://hindsight.vectorize.io/developer/installation)、[Hindsight TS SDK](https://hindsight.vectorize.io/sdks/typescript)、[Hindsight 配置](https://hindsight.vectorize.io/developer/configuration)、[DeepSeek 模型接口](https://api-docs.deepseek.com/)。本轮结论以上述实跑 JSON 为准。
