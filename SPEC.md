# SPEC.md — Claude Code-Style TypeScript AI Agent (agent-v2)

**Target:** 30–50K lines production code | 100+ source files | Buildable, testable, documented
**Stack:** TypeScript 5.5+, Node 20+, pnpm, Commander, Ink, React, Zod, Vitest, Biome
**Providers:** Anthropic (Claude), OpenAI (GPT/o1), extensible

---

## 1. Folder Structure (100+ Files)

```
agent-v2/
├── .github/workflows/ci.yml
├── biome.json
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
├── SPEC.md
├── docs/
│   ├── architecture.md
│   ├── api/
│   │   ├── types.md
│   │   ├── providers.md
│   │   ├── session.md
│   │   ├── tools.md
│   │   ├── config.md
│   │   └── hooks.md
│   └── guides/
│       ├── quick-start.md
│       ├── configuration.md
│       ├── tools.md
│       ├── mcp.md
│       └── skills.md
├── src/
│   ├── index.ts                    # Library entry + CLI bootstrap
│   ├── types/
│   │   ├── index.ts                # All shared types, enums, schemas
│   │   ├── provider.ts
│   │   ├── tool.ts
│   │   ├── session.ts
│   │   ├── config.ts
│   │   ├── hooks.ts
│   │   ├── mcp.ts
│   │   ├── skills.ts
│   │   └── agents.ts
│   ├── config/
│   │   ├── ConfigManager.ts        # Config load/save/validate/merge
│   │   ├── ConfigSchema.ts         # Zod schemas
│   │   ├── ProfileManager.ts       # Multi-profile support
│   │   └── Migration.ts            # Config version migration
│   ├── core/
│   │   ├── providers/
│   │   │   ├── Provider.ts         # Abstract base
│   │   │   ├── AnthropicProvider.ts
│   │   │   ├── OpenAIProvider.ts
│   │   │   ├── ProviderFactory.ts
│   │   │   ├── TokenCounter.ts     # tiktoken + Anthropic estimation
│   │   │   └── CostEstimator.ts
│   │   ├── session/
│   │   │   ├── SessionManager.ts   # Core loop, lifecycle
│   │   │   ├── SessionState.ts
│   │   │   ├── AgentLoop.ts        # Streaming + non-streaming turns
│   │   │   ├── ToolExecutor.ts     # Tool calling + approval
│   │   │   ├── ContextManager.ts   # Token budget, compaction
│   │   │   ├── MessageProcessor.ts # Response parsing
│   │   │   └── SessionStore.ts     # Persistence (JSONL + SQLite)
│   │   ├── hooks/
│   │   │   ├── HookRunner.ts       # Spawns commands with timeout
│   │   │   ├── HookRegistry.ts
│   │   │   └── HookTypes.ts
│   │   ├── mcp/
│   │   │   ├── McpClient.ts        # stdio transport
│   │   │   ├── McpServerManager.ts # Spawn/manage servers
│   │   │   ├── McpToolAdapter.ts   # MCP → internal tool defs
│   │   │   └── McpRegistry.ts
│   │   ├── skills/
│   │   │   ├── SkillLoader.ts      # .md files → instructions
│   │   │   ├── SkillRegistry.ts
│   │   │   └── SkillExecutor.ts
│   │   ├── agents/
│   │   │   ├── SubAgent.ts         # Nested session manager
│   │   │   ├── AgentRegistry.ts
│   │   │   ├── TaskTool.ts         # Dispatches to sub-agent
│   │   │   └── AgentConfig.ts
│   │   └── events/
│   │       ├── EventBus.ts         # Typed event emitter
│   │       └── EventTypes.ts
│   ├── tools/
│   │   ├── ToolRegistry.ts         # 40+ built-in tools
│   │   ├── ToolDefinition.ts
│   │   ├── ToolContext.ts
│   │   ├── filesystem/
│   │   │   ├── ReadTool.ts
│   │   │   ├── WriteTool.ts
│   │   │   ├── EditTool.ts
│   │   │   ├── ListTool.ts
│   │   │   ├── GlobTool.ts
│   │   │   ├── GrepTool.ts
│   │   │   ├── DeleteTool.ts
│   │   │   ├── CopyTool.ts
│   │   │   ├── MoveTool.ts
│   │   │   └── PatchTool.ts
│   │   ├── shell/
│   │   │   └── BashTool.ts
│   │   ├── search/
│   │   │   ├── SearchTool.ts
│   │   │   ├── WebSearchTool.ts    # Serper/Brave/Google
│   │   │   └── WebFetchTool.ts
│   │   ├── git/
│   │   │   ├── GitStatusTool.ts
│   │   │   ├── GitDiffTool.ts
│   │   │   ├── GitLogTool.ts
│   │   │   ├── GitCommitTool.ts
│   │   │   ├── GitBranchTool.ts
│   │   │   ├── GitCheckoutTool.ts
│   │   │   ├── GitPushTool.ts
│   │   │   └── GitPullTool.ts
│   │   ├── code/
│   │   │   ├── LintTool.ts
│   │   │   ├── FormatTool.ts
│   │   │   ├── TypecheckTool.ts
│   │   │   └── TestTool.ts
│   │   ├── task/
│   │   │   ├── TaskTool.ts         # Sub-agent dispatch
│   │   │   └── TodoTool.ts
│   │   └── mcp/
│   │       └── McpToolWrapper.ts
│   ├── cli/
│   │   ├── Cli.ts                  # Commander setup
│   │   ├── commands/
│   │   │   ├── ChatCommand.ts
│   │   │   ├── SessionCommands.ts
│   │   │   ├── ConfigCommands.ts
│   │   │   ├── ToolCommands.ts
│   │   │   ├── ModelCommands.ts
│   │   │   ├── WorkspaceCommands.ts
│   │   │   ├── SkillCommands.ts
│   │   │   ├── AgentCommands.ts
│   │   │   ├── McpCommands.ts
│   │   │   ├── DoctorCommand.ts
│   │   │   ├── UpdateCommand.ts
│   │   │   └── CompletionCommand.ts
│   │   ├── handlers/
│   │   │   ├── ApprovalHandler.ts  # Interactive prompts
│   │   │   ├── StreamingHandler.ts
│   │   │   └── EventRenderer.ts
│   │   ├── interactive/
│   │   │   ├── Repl.ts             # readline-based
│   │   │   ├── HistoryManager.ts
│   │   │   ├── CompletionProvider.ts
│   │   │   └── SlashCommands.ts
│   │   └── formatters/
│   │       ├── OutputFormatter.ts
│   │       ├── DiffFormatter.ts
│   │       └── ProgressFormatter.ts
│   ├── tui/
│   │   ├── App.tsx                 # Ink root component
│   │   ├── components/
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── InputArea.tsx
│   │   │   ├── StatusBar.tsx
│   │   │   ├── ToolCallView.tsx
│   │   │   ├── ApprovalModal.tsx
│   │   │   ├── DiffView.tsx
│   │   │   ├── HelpOverlay.tsx
│   │   │   ├── CommandPalette.tsx
│   │   │   ├── SessionTabs.tsx
│   │   │   └── TokenUsageBar.tsx
│   │   ├── hooks/
│   │   │   ├── useSessionManager.ts
│   │   │   ├── useKeybindings.ts
│   │   │   ├── useStreaming.ts
│   │   │   └── useApprovals.ts
│   │   ├── themes/
│   │   │   ├── default.ts
│   │   │   ├── dracula.ts
│   │   │   └── solarized.ts
│   │   └── renderTUI.ts
│   ├── desktop/
│   │   ├── main.ts                 # Electron main
│   │   ├── preload.ts              # Context bridge
│   │   ├── renderer.tsx            # React + Ink bridge
│   │   └── ipc/
│   │       ├── fileOps.ts
│   │       ├── shellOps.ts
│   │       └── sessionBridge.ts
│   ├── utils/
│   │   ├── fs.ts
│   │   ├── path.ts
│   │   ├── process.ts
│   │   ├── diff.ts
│   │   ├── logger.ts
│   │   └── errors.ts
│   └── scripts/
│       ├── postinstall.ts
│       └── generate-docs.ts
└── tests/
    ├── unit/
    │   ├── config/
    │   ├── providers/
    │   ├── session/
    │   ├── tools/
    │   ├── cli/
    │   └── mcp/
    ├── integration/
    │   ├── chat.test.ts
    │   ├── session.test.ts
    │   ├── tools.test.ts
    │   └── mcp.test.ts
    ├── fixtures/
    └── mocks/
        ├── provider.ts
        └── mcp.ts
```

---

## 2. Module Boundaries & Interfaces

### Core Types (`src/types/index.ts`)

```typescript
// Provider
enum ModelProvider { ANTHROPIC, OPENAI, CODEX, OLLAMA, CUSTOM }
enum ModelId { CLAUDE_OPUS_4, CLAUDE_SONNET_4, GPT_4O, GPT_4O_MINI, O1_PREVIEW, O1_MINI, CUSTOM }
interface ModelConfig { provider, modelId, apiKey?, baseUrl?, maxTokens?, temperature?, topP?, reasoningEffort?, thinkingBudget?, maxTurns?, maxBudgetUsd?, fallbackModel? }

// Session
enum SessionStatus { INITIALIZING, ACTIVE, RUNNING_TOOL, WAITING_FOR_APPROVAL, WAITING_FOR_INPUT, COMPACTING, COMPLETED, ERROR }
enum MessageRole { SYSTEM, USER, ASSISTANT, TOOL }
enum ContentType { TEXT, IMAGE, TOOL_USE, TOOL_RESULT, THINKING }
interface Message { role, content: MessageContent[], timestamp, metadata? }
type MessageContent = TextContent | ImageContent | ToolUseContent | ToolResultContent | ThinkingContent

// Tools
enum ToolCategory { FILE_SYSTEM, SHELL, SEARCH, GIT, CODE, TASK, MCP, WEB }
interface ToolDefinition { name, description, category, inputSchema: ZodSchema|JSONSchema, requiresApproval?, dangerous?, execute }
interface ToolResult { success, output?, error?, metadata? }
interface ToolContext { workingDirectory, sessionId, messageId, approvalCallback, progressCallback, abortSignal }

// Config
interface Config { version, profile, model, workspace, permissions, ui, hooks, skills, agents, mcpServers }
enum PermissionMode { DEFAULT, ACCEPT_EDITS, PLAN, AUTO, BYPASS, DONT_ASK }

// MCP
interface McpServerConfig { name, command, args, env, transport }

// Skills
interface SkillDefinition { name, description, version, triggers, instructions, examples }

// Agents
interface AgentConfig { name, description, systemPrompt, modelConfig, allowedTools, maxTurns, maxBudgetUsd }

// Hooks
enum HookType { PRE_TOOL_USE, POST_TOOL_USE, PRE_MESSAGE, POST_MESSAGE, SESSION_START, SESSION_END, ERROR, BUDGET_EXCEEDED, TURN_START, TURN_END }
interface HookConfig { type, command, description?, timeout?, env? }
```

### Data Flow

```
User Input (CLI/TUI)
       │
       ▼
SessionManager.createSession() → ConfigManager.get() → ProviderFactory.create()
       │
       ▼
AgentLoop.runTurn()
  ├─→ prepareMessages() → ContextManager.compactIfNeeded()
  ├─→ getAvailableTools() → ToolRegistry.getAll() + filter
  ├─→ Provider.sendMessage/streamMessage()
  │       │
  │       ▼
  │   ModelResponse (text + tool_use[])
  │       │
  │       ▼
  ├─→ ToolExecutor.executeTools()
  │       ├─→ approval check (permissionMode + tool.requiresApproval)
  │       ├─→ HookRunner.run(PRE_TOOL_USE)
  │       ├─→ ToolRegistry.execute() → ToolResult
  │       ├─→ HookRunner.run(POST_TOOL_USE)
  │       └─→ ToolResultMessage added to history
  │
  ├─→ ContextManager.updateTokens() + CostEstimator
  ├─→ SessionStore.persist()
  └─→ EventBus.emit(turnEnd)
```

---

## 3. 50+ Features Matrix

| # | Feature | Module | Status | Claude Code Parity |
|---|---------|--------|--------|-------------------|
| 1 | Multi-profile config | ConfigManager | ✅ Spec | ✅ |
| 2 | Dot-notation config get/set | ConfigManager | ✅ Spec | ✅ |
| 3 | Config validation (Zod) | ConfigSchema | ✅ Spec | ✅ |
| 4 | Config import/export | ConfigManager | ✅ Spec | ✅ |
| 5 | Config migration | Migration | ✅ Spec | 🔧 |
| 6 | Anthropic provider | AnthropicProvider | ✅ Spec | ✅ |
| 7 | OpenAI provider | OpenAIProvider | ✅ Spec | ✅ |
| 8 | Streaming + non-streaming | Provider base | ✅ Spec | ✅ |
| 9 | Tool calling (both) | Provider base | ✅ Spec | ✅ |
| 10 | Token counting (tiktoken) | TokenCounter | ✅ Spec | ✅ |
| 11 | Cost estimation | CostEstimator | ✅ Spec | ✅ |
| 12 | Reasoning effort (OpenAI) | OpenAIProvider | ✅ Spec | ✅ |
| 13 | Thinking budget (Anthropic) | AnthropicProvider | ✅ Spec | ✅ |
| 14 | Fallback model | ProviderFactory | ✅ Spec | ✅ |
| 15 | Session lifecycle | SessionManager | ✅ Spec | ✅ |
| 16 | Agent loop (turns) | AgentLoop | ✅ Spec | ✅ |
| 17 | Streaming agent loop | AgentLoop | ✅ Spec | ✅ |
| 18 | Tool execution | ToolExecutor | ✅ Spec | ✅ |
| 19 | Approval prompts | ApprovalHandler | ✅ Spec | ✅ |
| 20 | Permission modes (6) | ToolExecutor | ✅ Spec | ✅ |
| 21 | Context window management | ContextManager | ✅ Spec | ✅ |
| 22 | Auto-compaction | ContextManager | ✅ Spec | ✅ |
| 23 | Manual compaction | SessionManager | ✅ Spec | ✅ |
| 24 | Session persistence (JSONL) | SessionStore | ✅ Spec | ✅ |
| 25 | Session persistence (SQLite) | SessionStore | ✅ Spec | 🔧 |
| 26 | Session resume | SessionManager | ✅ Spec | ✅ |
| 27 | Session export/import | SessionManager | ✅ Spec | ✅ |
| 28 | 40+ built-in tools | ToolRegistry | ✅ Spec | ✅ |
| 29 | File read/write/edit | filesystem/ | ✅ Spec | ✅ |
| 30 | Glob/grep/search | filesystem/ | ✅ Spec | ✅ |
| 31 | Bash execution | shell/BashTool | ✅ Spec | ✅ |
| 32 | Git operations (8) | git/ | ✅ Spec | ✅ |
| 33 | Code quality (4) | code/ | ✅ Spec | ✅ |
| 34 | Web search/fetch | search/ | ✅ Spec | 🔧 |
| 35 | Task/Sub-agent tool | task/TaskTool | ✅ Spec | ✅ |
| 36 | Todo management | task/TodoTool | ✅ Spec | ✅ |
| 37 | MCP client (stdio) | McpClient | ✅ Spec | ✅ |
| 38 | MCP server manager | McpServerManager | ✅ Spec | ✅ |
| 39 | MCP tool adapter | McpToolAdapter | ✅ Spec | ✅ |
| 40 | Skill loader (.md) | SkillLoader | ✅ Spec | ✅ |
| 41 | Sub-agent spawning | SubAgent | ✅ Spec | ✅ |
| 42 | Hook runner (10 types) | HookRunner | ✅ Spec | ✅ |
| 43 | CLI (15+ commands) | Cli | ✅ Spec | ✅ |
| 44 | Interactive REPL | Repl | ✅ Spec | ✅ |
| 45 | Slash commands | SlashCommands | ✅ Spec | ✅ |
| 46 | History navigation | HistoryManager | ✅ Spec | ✅ |
| 47 | Tab completion | CompletionProvider | ✅ Spec | ✅ |
| 48 | Ink TUI | App.tsx + components | ✅ Spec | ✅ |
| 49 | Vim keybindings | useKeybindings | ✅ Spec | ✅ |
| 50 | Command palette | CommandPalette | ✅ Spec | ✅ |
| 51 | Diff view | DiffView | ✅ Spec | ✅ |
| 52 | Approval modal | ApprovalModal | ✅ Spec | ✅ |
| 53 | Session tabs | SessionTabs | ✅ Spec | 🔧 |
| 54 | Token usage bar | TokenUsageBar | ✅ Spec | ✅ |
| 55 | Electron desktop app | desktop/ | ✅ Spec | ✅ |
| 56 | Doctor health check | DoctorCommand | ✅ Spec | ✅ |
| 57 | Shell completion | CompletionCommand | ✅ Spec | ✅ |
| 58 | Self-update check | UpdateCommand | ✅ Spec | 🔧 |
| 59 | Plugin system | PluginManager | ✅ Spec | 🔧 |
| 60 | Themes (3+) | themes/ | ✅ Spec | 🔧 |

---

## 4. Implementation Priority (Phases)

### Phase 1: Foundation (Week 1) — ~8K lines
- Types, ConfigManager, Provider base + Anthropic/OpenAI
- ToolRegistry + 15 core tools (read, write, edit, list, glob, grep, bash, git_status, git_diff, git_log, lint, format, typecheck, test, todo)
- SessionManager + AgentLoop (non-streaming)
- CLI with chat, session, config, tools, model, doctor
- Tests + CI green

### Phase 2: Streaming & Tools (Week 2) — ~8K lines
- Streaming agent loop + tool_use accumulation
- Remaining 25 tools (git_commit, git_branch, git_checkout, git_push, git_pull, copy, move, delete, search, web_search, web_fetch, task, + MCP wrapper)
- Approval system + 6 permission modes
- Hook runner (10 event types)

### Phase 3: Context & Persistence (Week 3) — ~6K lines
- ContextManager (token budget, auto-compact)
- SessionStore (JSONL + SQLite)
- Session resume, export/import
- MCP client + server manager + tool adapter

### Phase 4: Advanced Features (Week 4) — ~8K lines
- Sub-agents + TaskTool
- Skills loader (.md files)
- Interactive REPL (history, completion, slash commands)
- Ink TUI (full component suite, vim keys, command palette, diff view)
- Electron desktop shell

### Phase 5: Polish & Docs (Week 5) — ~4K lines
- Themes, shell completion, update check
- Comprehensive API docs (auto-generated)
- User guides, architecture docs
- Performance optimization, edge cases

---

## 5. Extension Points

| Extension Point | Mechanism | Example |
|-----------------|-----------|---------|
| Custom Provider | Implement `Provider` abstract class | OllamaProvider |
| Custom Tool | `ToolRegistry.register(def, handler)` | `npm run tool:generate` |
| Custom Agent | `AgentRegistry.register(config)` | CodeReviewAgent |
| Custom Skill | `.claude/skills/*.md` files | `debugging.md` |
| MCP Server | `mcpServers` in config | `{"filesystem": {"command": "npx", "args": ["@modelcontextprotocol/server-filesystem"]}}` |
| Hooks | `hooks` array in config | `{"type": "POST_TOOL_USE", "command": "git add -A"}` |
| Themes | `themes/*.ts` + `ui.theme` config | `dracula` |
| Plugins | `plugins` directory + `PluginManager` | `github-pr-review` |

---

## 6. Testing Strategy

| Layer | Tool | Coverage Target |
|-------|------|-----------------|
| Unit | Vitest | 90%+ per module |
| Integration | Vitest | All CLI commands, tool executions |
| E2E | Custom harness | Full chat sessions |
| Property-based | fast-check | Tool input validation |
| Contract | Pact-style | Provider interfaces |

---

## 7. Build & CI

```yaml
# .github/workflows/ci.yml
jobs:
  lint: biome check
  typecheck: tsc --noEmit
  test: vitest run --coverage
  build: tsc
  desktop-build: electron-builder (on release)
```

---

## 8. Acceptance Criteria

- [ ] `npm run build` → clean TypeScript strict build
- [ ] `npm test` → 100% unit + integration pass
- [ ] `doctor` → all green on clean machine with API key
- [ ] `chat "create a hello world node project"` → works end-to-end
- [ ] Streaming + tool calls work in both CLI and TUI
- [ ] Session persist/resume across restarts
- [ ] MCP server spawns and tools appear in registry
- [ ] Sub-agent dispatched via `task` tool completes and returns
- [ ] Skills loaded from `.claude/skills/*.md` inject into system prompt
- [ ] All 6 permission modes enforce correctly
- [ ] GitHub Actions CI passes on push/PR