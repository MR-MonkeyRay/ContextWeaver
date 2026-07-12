<div align="center">
  <h1>ContextWeaver</h1>
  <strong>🧵 A Context Weaving Engine for AI Agents</strong>
</div>

<p align="center">
  <em>Hybrid Search • Graph Expansion • Token-Aware Packing • Prompt Context Preparation</em>
</p>

<p align="center">
  English | <a href="./README.md">中文</a>
</p>

---

**ContextWeaver** is a repository context engine built around **CLI + Skills + MCP**: the CLI provides deterministic local indexing, retrieval, and evidence-preparation commands; Skills teach agents when and how to consume that evidence; and the stdio MCP adapter exposes the same retrieval capabilities to compatible clients.

<p align="center">
  <img src="assets/architecture.png" alt="ContextWeaver architecture overview" width="800" />
</p>

## Highlights

- **Hybrid retrieval**: vector recall + lexical recall + RRF fusion + rerank
- **Three-phase context expansion**: neighbors, breadcrumbs, imports
- **Explicit indexing scope**: the first index run must preview the scope and require explicit confirmation
- **Skills**: ships distributable `using-contextweaver` and `enhancing-prompts` skill assets
- **MCP stdio adapter**: exposes code retrieval and prompt-context tools, with Elicitation before the first index run
- **Prompt context preparation (Prompt Enhancement)**: converts vague requests into repository-grounded evidence so the agent can refine the task description on its own

## Install

```bash
npm install -g @monkeyray/contextweaver
```

Windows installs normally use available prebuilt native dependencies; see [Windows install notes](./docs/WINDOWS_INSTALL.md) for build-tool fallback and advanced no-build options.

## Initialize

```bash
contextweaver init

# Or `cw` for short
cw init
```

Edit `~/.contextweaver/.env` with embedding and reranker settings:

```bash
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_DIMENSIONS=1024

RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20
```

## Project Indexing Config

Use a repository-root `cwconfig.json` to scope indexing:

```bash
contextweaver init-project
```

Example:

```json
{
  "indexing": {
    "includePatterns": ["src/**"],
    "ignorePatterns": ["**/generated/**", "**/__snapshots__/**"]
  }
}
```

The indexer matches `includePatterns` first, then excludes any matched paths covered by `ignorePatterns`. Index scope directly affects semantic search quality, so it is worth tuning carefully for each repository.

## Common Commands

```bash
# Build or refresh the index
contextweaver index

# Semantic search (plain text by default)
contextweaver search [--format json] --information-request "How is prompt enhancement implemented?"

# Prepare repo-aware evidence for prompt enhancement (plain text by default)
contextweaver prompt-context [--format json] "Align prompt enhancement with Skills"

# Start the stdio MCP server
contextweaver mcp

# Install bundled skills into a custom directory (`--dir` is required)
contextweaver install-skills --dir ./agent-skills

# Clean stale indexes
contextweaver clean
```

> CLI output defaults to a human-friendly format: both `search` and `prompt-context` use `text` unless you explicitly pass `--format json` in skill scripts.
> `search` and `prompt-context` both require the repository to have completed at least one `contextweaver index` run.

## MCP Integration

MCP is a stdio adapter over the existing `retrieval` and `promptContext` application layers; it does not maintain a second indexing or search implementation. Register it in a compatible MCP client:

```json
{
  "mcpServers": {
    "contextweaver": {
      "command": "contextweaver",
      "args": ["mcp"]
    }
  }
}
```

You may use `cw` as the command instead. Configuration location and first-use approval behavior vary by client, so follow the relevant client documentation. The server currently exposes exactly two tools:

| Tool | Purpose |
| --- | --- |
| `codebase-retrieval` | Retrieve repository code context from a natural-language request and optional technical terms |
| `prepare-prompt-context` | Prepare an evidence package; retrieve the repository only when `repo_path` is supplied |

Repository-backed calls from both tools share the same first-index authorization flow:

```text
Tool call → validate repository path and MCP Roots → check confirmed index
  ├─ Confirmed: run retrieval / prompt-context preparation
  └─ Unconfirmed: check the client's Elicitation capability first
       ├─ Supports Form Elicitation: generate and show a local-only preview, then request authorization
       │    ├─ accept and approve=true: index, then resume the original tool call
       │    └─ decline / cancel: do not index or call external model services
       └─ Client lacks Elicitation: return authorization_required
            with cliExecutable + cliArgs; cliCommand is POSIX display text only
```

Authorization and runtime boundaries:

- Authorization comes from the Elicitation response in the current MCP session. `cwconfig.json` scopes indexing but cannot authorize it on the user's behalf. This trusts a compliant client's response; it is not cryptographic proof that a physical human clicked the control.
- After first approval, `confirmedAt` acts as durable authorization for that repository path across MCP sessions, so later calls do not Elicit on every request. It is not yet bound to `cwconfig.json` contents or model-provider settings; later scope or provider changes do not automatically trigger approval again, so review and re-index after such changes.
- When a client advertises Roots, the repository must be under a usable `file://` Root. A failed Roots request, an empty Roots list, or no usable file Root fails closed. Without advertised Roots, ContextWeaver only accepts an existing absolute directory and rejects the filesystem root and the user's HOME directory. This is a compatibility fallback, not a session-scoped filesystem sandbox; clients requiring strict session boundaries should advertise Roots.
- The initial preview does not call external model services. After approval, matching code chunks are sent to the configured Embedding service during indexing. Retrieval also sends the query and candidate chunks to the configured Embedding/Reranker services. Review `cwconfig.json`, service endpoints, data policy, and cost boundaries before approval.
- If the request carries an MCP progress token, long-running indexing emits best-effort, strictly increasing progress notifications. Notification failures do not fail indexing. MCP Tasks are not currently implemented, and progress notifications do not guarantee that a client or host request timeout will be reset.
- A client launches the stdio MCP server as a child process, which may avoid a `bwrap` network-namespace failure triggered by running every command through an agent shell. MCP itself cannot guarantee that the client will not sandbox the server again or that external APIs are reachable.

If the client lacks Elicitation support, inspect the preview shown by the CLI and complete indexing in a trusted terminal:

Programmatic fallback should spawn `authorization.cliExecutable` with `authorization.cliArgs`; `authorization.cliCommand` is only a POSIX shell display string.

```bash
cw index '/absolute/path/to/repository'
```

Then retry the original MCP tool call. Do not treat agent-supplied `--yes` as implicit authorization for an unknown indexing scope or external transfer.

## Skill Assets

The repository ships distributable skills under `skills/`:

- `skills/using-contextweaver/`
  - semantic retrieval and code location workflow
  - helper script: `scripts/search-context.mjs`
- `skills/enhancing-prompts/`
  - vague request -> repo-aware task interpretation -> optional single Question -> final task prompt
  - helper script: `scripts/prepare-enhancement-context.mjs`
  - prompt templates under `templates/`

When installed from npm, bundled skills ship with the package. `contextweaver install-skills` requires an explicit `--dir` target and does not assume any default install location. If the full target path does not exist, the CLI asks for confirmation before creating it in interactive mode.

## Architecture

```text
       Indexing: Crawler → Processor → SemanticSplitter → Indexer → VectorStore / SQLite
       Search: Query → Vector + FTS Recall → RRF Fusion → Rerank → GraphExpander → ContextPacker
Adapter boundary: CLI / Skills / MCP → retrieval + promptContext → shared search and indexing infrastructure
```

Key modules:

| Module          | Location                      | Responsibility                                            |
| --------------- | ----------------------------- | --------------------------------------------------------- |
| `SearchService` | `src/search/SearchService.ts` | hybrid retrieval core                                     |
| `GraphExpander` | `src/search/GraphExpander.ts` | three-phase context expansion                             |
| `ContextPacker` | `src/search/ContextPacker.ts` | segment packing and token budgeting                       |
| `retrieval`     | `src/retrieval/index.ts`      | structured search output and CLI rendering                |
| `promptContext` | `src/promptContext/index.ts`  | prompt evidence preparation and technical-term extraction |
| `mcp`           | `src/mcp/`                    | stdio protocol, Roots validation, and first-index authorization |

## Multi-Language Support

ContextWeaver uses Tree-sitter to provide native AST parsing support for the following languages. When a native grammar cannot be loaded in the current Node/platform environment, listed fallback languages are still indexed with line-based chunks.

| Language   | AST Parsing | Import Resolution | File Extensions               |
| ---------- | ----------- | ----------------- | ----------------------------- |
| TypeScript | Yes         | Yes               | `.ts`, `.tsx`                 |
| JavaScript | Yes         | Yes               | `.js`, `.jsx`, `.mjs`         |
| Python     | Yes         | Yes               | `.py`                         |
| Go         | Yes         | Yes               | `.go`                         |
| Java       | Yes         | Yes               | `.java`                       |
| Rust       | Yes         | Yes               | `.rs`                         |
| Kotlin     | Conditional* | Yes               | `.kt`, `.kts`                 |
| PHP        | Yes         | Yes               | `.php`                        |
| Ruby       | Yes         | Yes               | `.rb`                         |
| Swift      | Conditional* | Yes               | `.swift`                      |
| Dart       | Conditional* | Yes               | `.dart`                       |
| C          | Yes         | Yes               | `.c`, `.h`                    |
| C++        | Yes         | Yes               | `.cpp`, `.hpp`, `.cc`, `.cxx` |
| C#         | Yes         | Yes               | `.cs`, `.csx`                 |
| Shell      | Line chunks | No             | `.sh`, `.bash`, `.zsh`        |
| YAML/Ansible | Line chunks | No          | `.yaml`, `.yml`               |

* Kotlin/Swift/Dart AST parsing depends on the `tree-sitter-kotlin` / `tree-sitter-swift` / `tree-sitter-dart` native bindings being present and loading for the current Node ABI and install environment. These conditional grammar packages are not part of the default install graph; if they are missing or cannot load, the scanner automatically falls back to line-based chunks while import resolution remains available.

## Acknowledgements

- [Linux DO](https://linux.do/) - An amazing technical community inspired this project
- [hsingjui/ContextWeaver](https://github.com/hsingjui/ContextWeaver) - original project
- [lyy0709/ContextWeaver](https://github.com/lyy0709/ContextWeaver) - community fork that added Prompt Enhancement
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) - high-performance syntax parsing
- [LanceDB](https://lancedb.com/) - embedded vector database

## License

[MIT](./LICENSE)
