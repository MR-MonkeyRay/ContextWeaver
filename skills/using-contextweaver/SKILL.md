---
name: using-contextweaver
description: >-
  需要理解代码库中功能如何实现、定位相关代码、建立代码地图、分析调用关系、
  或在非 trivial 修改前摸清上下文时主动使用。用户问"X 怎么实现的"、
  "帮我定位 Y 的逻辑"、收到 bug 需要定位、接手不熟悉项目/模块、
  或需要判断 ContextWeaver 检索/索引前置条件时使用。仅在已知精确文件行号、
  需要穷举文本匹配、或任务明确要求 grep/read 时跳过。
---

# 使用 ContextWeaver

## 定位

ContextWeaver 是给 AI coding agent 用的本地代码库上下文引擎。CLI 与 stdio MCP 复用同一套确认式索引、检索和 Prompt Context 应用层；这个 Skill 负责选择当前 agent 可用的接入面，读取证据后再转向精确文件阅读或修改。

优先使用它来回答"怎么实现"、"逻辑在哪里"、"哪些文件相关"、"改动前影响面是什么"。不要把它当成全文枚举工具；需要统计全部出现位置、逐个替换、或已经知道文件和行号时，直接用 `rg`/read。


## 接入选择

1. 当前工具列表存在 `codebase-retrieval` 时优先使用 MCP；它避免为每次查询启动 agent shell 命令，并把首次索引授权、Roots 校验与结构化结果放在同一协议链路中。
2. 需要为模糊请求准备证据且存在 `prepare-prompt-context` 时使用该工具；传入 `repo_path` 才会检索仓库，不传时只做本地 Prompt 分析。
3. MCP 工具不可用时，再调用本 Skill 的 `search-context.mjs`。不要为一次查询手动运行 `contextweaver mcp`；stdio 服务器应由 MCP 客户端注册并管理。


## 前置条件

先确认目标仓库已经可搜索。CLI 脚本不会自动首次索引；遇到未确认仓库时，Agent 必须主动执行初始化恢复。MCP 也只会在兼容客户端通过 Form Elicitation 返回 `accept` 且 `approve=true` 后索引；没有 Elicitation 能力时返回结构化 CLI 回退命令，不扫描仓库。

- 全局配置：运行过 `contextweaver init` 或已有 `~/.contextweaver/.env`。
- 必要环境变量：`EMBEDDINGS_API_KEY`、`EMBEDDINGS_BASE_URL`、`EMBEDDINGS_MODEL`、`RERANK_API_KEY`、`RERANK_BASE_URL`、`RERANK_MODEL`。缺失时检索会创建示例 `.env` 后报错，不能继续声称已完成语义检索。
- 项目配置：目标仓库根目录通常有 `cwconfig.json`。缺失时直接运行 `contextweaver index /abs/path/to/repo`；该命令会先创建推荐配置；若 `src/**` 未匹配文件，则回退到受忽略规则和文件类型白名单约束的仓库范围，并在同一次执行中展示预览后请求确认。
- 确认式索引：目标仓库已经成功运行过 `contextweaver index`。首次索引会预览范围并要求确认；非交互环境只有在范围已被当前任务授权且已经检查过时才使用 `contextweaver index /abs/path --yes`。

常见失败处理：

| 现象 | 处理 |
| --- | --- |
| `当前仓库尚未完成确认式索引，请先运行 cw index` | Agent 立即进入下方“初始化恢复”流程；完成后自动重试原检索。 |
| MCP `status: authorization_required` | 未发生扫描；优先以 `authorization.cliExecutable` + `authorization.cliArgs` 启动进程；POSIX 可信终端也可执行展示用 `authorization.cliCommand`，确认预览后重试原工具。 |
| MCP `status: declined` | 用户拒绝、取消或授权响应无效；停止索引，不要改用 `--yes` 绕过。 |
| MCP Roots / `repo_path` 校验失败 | 使用真实存在的仓库绝对路径，并保持在客户端声明的 `file://` Roots 内；不要扩大到 HOME 或文件系统根。 |
| `ContextWeaver 环境变量未配置` | 编辑 `~/.contextweaver/.env` 或设置对应环境变量后重试。 |
| 脚本退出 1，且无法找到/启动 `contextweaver` | 安装 CLI，或设置 `CONTEXTWEAVER_BIN=/abs/path/to/contextweaver`。 |
| 输出 JSON 前有日志行 | 忽略日志行，从第一个 `{` 开始解析 JSON；人工排查可改用 `--format text`。 |

## 查询规则

### `information-request`

写完整自然语言，描述要理解的行为、流程或关联关系。把问题写成"这件事在仓库里怎么工作"，不要只塞文件名或零散关键词。

好例子：

- `提示词增强相关逻辑目前是如何触发、拼装模板并返回结果的？`
- `当前 CLI 搜索命令如何检查索引前置条件，并将结果格式化输出？`
- `索引确认流程如何从 cwconfig.json 生成预览并记录 confirmedAt？`

避免：

- 只写 `src/index.ts`、`SearchService` 这类孤立词。
- 一次询问多个互不相关的功能。
- 把完整聊天记录塞进查询。

### `technical-terms`

把它当作查询增强词，不要当作硬过滤器。只放少量确定存在的符号、类名、函数名、配置键或命令名；这些词会与 `information-request` 拼接后参与检索。

可以放：

- `SearchService`
- `ensureSearchableProject`
- `cwconfig.json`

不要放：

- 猜测的符号名。
- 文件路径，如 `src/index.ts`。
- 过多普通词或整句描述。

## 调用方式

### MCP 工具（优先）

`codebase-retrieval` 的核心输入：

```json
{
  "repo_path": "/absolute/path/to/repo",
  "information_request": "当前 CLI 搜索命令如何检查索引前置条件？",
  "technical_terms": ["ensureSearchableProject", "SearchService"]
}
```

`prepare-prompt-context` 接收 `prompt`，以及可选的 `repo_path`、`paths`、`symbols`。两种工具都把同一业务 JSON 同时放入 TextContent 与 `structuredContent`：

- `status: ok`：读取 `result`。
- `status: authorization_required`：读取 `authorization.message`、`authorization.cliExecutable` 与 `authorization.cliArgs`；`authorization.cliCommand` 仅为 POSIX 展示字符串，没有发生首次扫描。
- `status: declined`：授权未接受；停止，不要自动重试或绕过。
- `isError: true`：协议、路径、配置或执行失败；错误文本已经脱敏，但仍需按错误内容修复或降级。

### CLI / Skill 脚本回退

调用本 Skill 自带脚本，并把脚本路径按当前 `SKILL.md` 所在目录解析；不要假设目标仓库根目录一定有 `skills/using-contextweaver`。

```bash
node /abs/path/to/using-contextweaver/scripts/search-context.mjs \
  --repo-path /abs/path/to/repo \
  --information-request "当前 CLI 搜索命令如何检查索引前置条件，并将结果格式化输出？" \
  --technical-terms ensureSearchableProject,SearchService
```

在 ContextWeaver 包源码根目录内，也可以使用相对路径：

```bash
node skills/using-contextweaver/scripts/search-context.mjs \
  --repo-path /abs/path/to/repo \
  --information-request "提示词增强相关逻辑目前是如何触发、拼装模板并返回结果的？"
```

脚本行为：

- 默认转发为 `contextweaver search --format json ...`。
- 显式文本输出用分离参数：`--format text`。不要写 `--format=text`，脚本只识别独立的 `--format` token。
- 二进制解析顺序是 `CONTEXTWEAVER_BIN` -> 当前包的 `dist/index.js` -> PATH 里的 `contextweaver`。
- 在本地源码包调试时，如果 `dist/index.js` 不存在，先运行 `pnpm build` 或设置 `CONTEXTWEAVER_BIN`。

底层 `contextweaver search` 参数：

| 参数 | 要求 |
| --- | --- |
| `--repo-path <path>` | 目标仓库路径；建议传绝对路径，相对路径会按当前工作目录解析，省略时用当前工作目录。 |
| `--information-request <text>` | 必填。自然语言检索意图。 |
| `--technical-terms <a,b>` | 可选。逗号分隔的查询增强词。 |
| `--format <json|text>` | CLI 默认 `text`；本脚本默认补 `json`。 |

## 读取结果

JSON 结果的主要字段：

- `summary.query`：实际组合后的查询。
- `summary.seedCount`、`expandedCount`、`fileCount`、`totalSegments`：判断召回规模。
- `files[].path`：优先阅读的文件。
- `files[].segments[]`：包含 `startLine`、`endLine`、`breadcrumb`、`score`、`text`。

处理方式：

1. 先看 `files[].path` 和高分 `segments[].breadcrumb`，确定相关模块。
2. 再用 read/sed 打开命中文件的上下文，不要只依赖片段就改代码。
3. 如果结果不相关，改写 `information-request`，减少或替换 `technical-terms` 后重试一次。
4. 如果仍失败，说明索引可能过窄、过旧或问题更适合文本搜索；检查 `cwconfig.json`/重新索引，或退回 `rg`。

## 初始化恢复

当检索提示项目尚未确认索引时，按当前接入面恢复：

- MCP：先让原工具完成 Elicitation。只有 `accept + approve=true` 才会在同一调用内索引并继续原请求；`authorization_required` 时优先按返回的 executable + args 启动 CLI，POSIX 终端可使用展示命令；`declined` 时停止。
- CLI / Skill 脚本：进入以下初始化流程：

1. 检查全局 API 配置。缺失凭据时，`contextweaver init` 只能创建示例文件，不能生成真实密钥；此时说明凭据阻塞并降级到 `rg`/read。
2. 运行 `contextweaver index /abs/path/to/repo`。项目配置缺失时，该命令会创建推荐的 `cwconfig.json`，随后继续展示实际文件范围并请求确认。
3. 交互环境读取预览后确认；非交互环境先读取新生成的 `cwconfig.json` 并核对范围，只有范围已获当前任务授权时才使用 `--yes`。
4. 索引成功后，自动重试原始检索调用一次，不要要求用户重新发起任务。

非交互执行时：

```bash
contextweaver index /abs/path/to/repo --yes
```

只在已确认索引范围不会扫入无关大目录、密钥、生成物或用户不希望发送到 Embedding/Reranker API 的内容后使用 `--yes`。索引会调用配置的外部模型服务；如果凭据、网络或费用边界不清楚，报告阻塞原因并使用 `rg`/read 做降级分析。

## 何时跳过或降级

- 已知精确文件和行号：直接 read。
- 要找所有出现位置、统计次数、批量替换：用 `rg`。
- 没有可用 API 凭据、不能索引、或索引范围未经确认：说明无法使用 ContextWeaver，改用 `rg`/read，不要伪造语义检索结论。
- 需要把模糊需求整理成可执行任务 prompt：使用 `enhancing-prompts`；本 Skill 只负责代码语义检索。
- agent shell 报 `bwrap ... RTM_NEWADDR` 时，若 MCP 工具可用可改走 MCP；它可能避开逐命令 shell 沙箱，但不保证 MCP 子进程或外部网络未被宿主限制。仍失败则降级到 `rg`/read。

## 快速判断

```text
不确定要看哪些文件？ -> ContextWeaver
MCP 工具可见？ -> codebase-retrieval / prepare-prompt-context
MCP 不可用？ -> Skill 脚本 -> CLI
新项目未索引？ -> MCP Elicitation；不支持则 authorization.cliExecutable + cliArgs
100% 知道文件+行号？ -> read
要统计/穷举/全替换？ -> rg
授权、凭据或网络阻塞？ -> 明确说明 -> rg/read 降级
```
