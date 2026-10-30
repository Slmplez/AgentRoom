# Memory / Soul 对照实验

研究日期：2026-10-31（Asia/Shanghai）。**这是独立实验，不是生产记忆或 Soul 接入，也不是完整三方性能排名。** 仅使用合成数据，不加载应用配置或真实聊天。

## 本轮决策

建议 **SQLite 保存原始来源、修订、删除状态和每个 Agent 独立的 Soul；语义检索采用可替换的 Implementation，暂不把 Mem0 设为必需依赖**。Memory Module 对调用方隐藏抽取、检索和修订策略；Soul 保持明确编辑、独立持久化，不通过模糊召回决定个性。

真实语义模型已经跑通，但本次并未证明 Mem0 的额外复杂度有独占收益：完整 10 个固定问题中，Mem0 + 语义向量与直接对原文做向量检索都是 9/10，失败问题不同。后者只是四条记录的精确余弦排序对照，**不是已实现的 SQLite 向量后端**。Mem0 可以保留为抽取/检索 Adapter 候选；Hindsight 尚未完成服务验证，不能据此排除它。

## 实际结果

| 路径 | 功能场景 | 10 个固定问题的 Top-1 |
| --- | --- | --- |
| SQLite + FTS5 + 中文分词 | 14 项：12 通过，2 个检索质量场景失败 | 6/10 |
| Mem0 OSS TS 3.3.1 + DeepSeek Flash + 词法哈希向量 | 14 项：11 通过，3 失败 | 6/10 |
| Mem0 OSS TS 3.3.1 + DeepSeek Flash + 多语言 ONNX 向量 | 14 项：12 通过，2 失败 | 9/10 |
| 相同模型直接检索原文，无 LLM 抽取 | 仅排序对照，无后端功能测试 | 9/10 |
| 相同模型直接检索本轮 Mem0 抽取文本 | 仅排序对照，无后端功能测试 | 9/10 |
| Hindsight 1.1.0 | 前轮安装/启动阻塞，0 项执行；本轮未重试 | 未测 |

14 项中包含应用层 Soul 检查，**不能将其计作 Mem0/Hindsight 自带能力**。源码与原始结果在本目录，结果目录为 [results](./results/)。

本轮把原中文改写检查收紧为 Top-1，并在首次语义运行前固定 8 个补充问题，输入见 `fixtures.ts` / `run.ts`。此前 13 项报告不可与本轮总分直接比较。8 个补充问题中，FTS5 与词法 Mem0 各 5/8，语义 Mem0 8/8，原文向量对照 7/8。上表完整 10 题还包括原中文改写和 `storage technology selection`，避免只报告有利子集。每种配置仅一次完整运行；Mem0 抽取文字可能改变，小样本分数不构成统计结论。

### 失败与证据

- FTS5 对不同措辞的召回不足，完整 10 题中错 4 题；有中文字面重合时命中不代表具备中文语义理解。
- 语义 Mem0 将 `storage technology selection` 的会议记忆排在数据库选择之前。新进程将 threshold 从默认 0.1 降至 0，错误排序不变。见 `results/mem0-semantic-reopen.json`，没有通过调整门槛改写主实验结果。
- 原文向量对照在该短语上成功，却在 `Which technology keeps our records on disk?` 上失败。使用本轮 Mem0 抽取文本的纯向量对照与完整 Mem0 链路错题一致。见 `results/embedding-control.json`。需要分别评估抽取改写、向量模型和排序策略，不能只比较框架名。
- Mem0 显式 `update` 后能查询新版，`history` 返回修订；`delete` 后搜索不到该条，但重新 `add` 旧来源会恢复记忆。**防删除重放应由应用持有 tombstone/来源版本策略**。本实验没有在 Adapter 中过滤以制造通过。
- 抽取将原文的 `Friday` 扩展成 `Friday, October 30, 2026`；合成来源没有事件参考日期或时区。metadata 留有原文和来源，但这不证明抽取内容完全忠于来源；具体日期应视为推导信息，不能覆盖原文。
- 实际安装的 Mem0 `memory` vector provider 使用 SQLite 文件。词法和语义路径均通过新 Node 进程 `getAll` 持久读取验证；`reopen-mem0.ts semantic` 还用本地模型重查了失败问题，没有发出外部推理请求。
- 来源字符串由 Adapter 传给 metadata，不等于 SDK 自动归档原文。本实验的来源 ID → SDK ID 映射仍在内存中，尚不满足生产重启后更新/删除的要求。
- 语义模型本轮冷加载约 742 毫秒，五次初始 Mem0 写入约 0.9–2.6 秒。SQLite 明确写入为毫秒级；两者工作不同，前者调用 LLM 抽取。这是单次观察，不是吞吐量或成本结论；未采集 Mem0 token 账单。

## 每个 Agent 独立的 Soul

| Agent | 个性 | 表达方式 | 工作方式 |
| --- | --- | --- | --- |
| 鸢尾 / iris | 冷静、审慎 | 简洁、直接 | 先核实证据和风险 |
| 余烬 / ember | 热情、好奇 | 温暖、生动 | 先提出可能性，再做小实验 |

Soul、个人经验和房间共享知识分别保存。Soul 不随记忆抽取自动覆盖；明确编辑只改变指定 Agent，记录 revision，重启后保留。`verify.ts` 的三项测试覆盖持久化/范围隔离、幂等/修订/删除重放和 Soul 独立编辑。`soul-demo.ts` 的前轮真实模型样例仅供观察表达差异，不证明长期个性稳定。

`human-owner` 是可信测试输入，**不是生产鉴权**。本实验没有产品设置页、成员配置、引擎提示注入或登录授权，没有修改领域文档宣布未确认策略。

## 安装问题已解决的部分

本机 Node 24.4.1。旧 npm 锁文件有 26 个无 version 的条目，导致 `npm ci` 报 `Invalid Version:`。在空目录按原依赖声明重建锁文件后，全量 `npm ci --include=optional` 成功安装 151 个包，Transformers 4.3.2 可以导入和推理。

Node 直连 Hugging Face 超时，使用本机已有代理后下载成功。仅设置运行进程的代理环境变量，没有改系统配置。`download-model.ts` 使用 curl 下载固定 revision，并记录 SHA-256；留存文件清单为 `results/model-manifest.json`。

模型为 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`，revision `2c4055b12046f11709e9df2c122e59ffbdc2f900`，q8、CPU、384 维。模型准备完毕后采用 local-files-only；模型缺失或推理失败会直接报错，不静默切换为词法模式。

Hindsight 的前轮问题仍单独记录：正确依赖为 `hindsight-api-slim[embedded-db]==1.1.0`，早期错误包名 `pg0` 已纠正。正确安装的依赖解析当时未完成，启动返回 `.venv/Scripts/hindsight-api.exe ENOENT`。这不是 Windows 不兼容证据；TS SDK 已可导入，但 launcher、服务配置和返回值映射尚未实跑验证。

## 复跑

以下命令均在本目录运行。无需 npm 安装、Python、API key 或联网的基线：

```powershell
node --test verify.ts
node run.ts sqlite
```

真实 Mem0 语义验证：

```powershell
# 如果网络需要代理，使用当前环境已配置的代理设置 HTTPS_PROXY / HTTP_PROXY。
# 不要在仓库或命令参数中写入凭据。
$env:ONNXRUNTIME_NODE_INSTALL_CUDA = 'skip'
npm ci --include=optional --no-audit --no-fund
node download-model.ts
# 在调用进程环境提供 DEEPSEEK_API_KEY。
Remove-Item Env:MEMORY_EMBEDDING_MODE -ErrorAction SilentlyContinue
node run.ts mem0
node reopen-mem0.ts semantic
node embedding-control.ts
```

`download-model.ts` 需要 curl（Windows 自带 curl.exe），下载固定模型文件到 `runtime/models/`，生成完整清单后启用本地加载。也可不运行下载脚本，让 Transformers 尝试联网下载到 `runtime/model-cache/`；Node 直连不可达时应采用显式下载流程。

词法集成对照：

```powershell
npm ci --omit=optional --no-audit --no-fund
$env:MEMORY_EMBEDDING_MODE = 'lexical'
node run.ts mem0
node reopen-mem0.ts
Remove-Item Env:MEMORY_EMBEDDING_MODE
```

词法模式仍使用真实 SDK、LLM 和 SQLite，仅 embedding 是明确选择的词法哈希向量，不能冒充语义结果。`npm ci --omit=optional` 会移除语义依赖；要再运行语义模式，需重新 include optional。

`run.ts` 的退出码：2=设置阻塞，1=非检索质量检查失败，0=其余；质量失败保存在 JSON，不能只看退出码。当前两种 Mem0 模式都因为删除重放失败而返回非零。每次使用独立 `runtime/<backend>-<timestamp>`，不读取生产数据；同名 `results/*.json` 会被覆盖。后台 embedding 仅绑定 loopback 随机端口。虚拟环境、数据库、模型和日志均在 .gitignore 内。

Hindsight 后续可复跑：

```powershell
uv venv .venv --python 3.12
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
node run.ts hindsight
```

也可将 `HINDSIGHT_URL` 指向专属实验服务；此时配置由外部服务负责，不能假设与本地一致，合成 bank 会保留。原型尚未接入外部服务认证。本地 launcher 通过子进程环境传凭据，使用独立 pg0 名称，结束时仅停止自己启动的进程树。配置为同步 retain、RRF、关闭自动 consolidation；observations/reflect 的更正和删除传播需另测。Python 顶层版本固定，尚无完整 Python lock。

## 交付范围与后续门槛

- `sqlite.ts`：明确记忆、修订、FTS5、删除 tombstone。forget 阻止召回但保留历史，不等于彻底擦除。
- `soul.ts` / `soul-demo.ts`：独立 Soul 存储和真实回答样例。
- `external.ts` / `hindsight.ts`：候选 Adapter，未提供完整成员 ACL、授权撤销或备份删除。
- `embeddings.ts` / `download-model.ts`：固定语义模型、本地下载与显式词法模式。
- `fixtures.ts` / `run.ts`：合成输入和 14 项场景；fixture 来源指向这些固定输入。
- `embedding-control.ts`：原文和已抽取文本的纯向量对照；运行前须完成语义 Mem0 与语义 reopen。
- `verify.ts` / `reopen-mem0.ts`：可运行验证；`preflight.ts` 留存前轮导入和下载诊断。

下一步若进入生产实现，先完善 SQLite 来源事实、持久 ID 映射、版本/删除策略、真实身份授权和独立 Soul 注入。语义检索可保留小 Interface，待更大独立数据集证明收益后再决定采用直接本地模型还是 Mem0 Adapter。当前没有实现生产向量索引，也不能声称 Mem0 优于 Hindsight。

本轮 worktree：`E:/Repo/ASCET/agent-chat-desktop-memory-comparison`，分支 `codex/memory-semantic`，基线 `a6556b6938d46f728e0bcab5704d5c6720fcba16`。仅修改 `experiments/memory-comparison/`；未修改主目录的未提交领域文档。

一手参考：[Mem0 TypeScript](https://github.com/mem0ai/mem0/tree/main/mem0-ts)、[多语言模型](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)、[Hindsight 安装](https://hindsight.vectorize.io/developer/installation)、[Hindsight TS SDK](https://hindsight.vectorize.io/sdks/typescript)。结论以本目录实跑 JSON 为准。
