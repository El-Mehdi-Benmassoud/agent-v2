import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Provider } from '../providers/Provider.js';
import type {
  HooksConfig,
  Message,
  MessageContent,
  ModelConfig,
  ToolDefinition,
  TokenUsage,
  ContentType,
  TextContent,
} from '../../types/index.js';
import { HookType } from '../../types/index.js';
import { HookRunner } from '../hooks/HookRunner.js';
import type { HookInput, HookOutcome, HookDecision } from '../hooks/HookRunner.js';
import { SkillRegistry } from '../skills/SkillRegistry.js';
import type { SkillsConfig } from '../../types/index.js';
import { MessageRole as Role, ContentType as CT, SessionStatus as Status } from '../../types/index.js';
import { ProviderFactory } from '../providers/ProviderFactory.js';
import { TokenCounter } from '../providers/TokenCounter.js';
import { ToolExecutor } from './ToolExecutor.js';
import { ContextManager } from './ContextManager.js';
import { AgentLoop } from './AgentLoop.js';
import { SessionStore } from './SessionStore.js';
import type {
  ApprovalCallback,
  ApprovalRequest,
  PersistedSession,
  SendMessageOptions,
  SessionConfig,
  SessionEventName,
  SessionEventPayloads,
  SessionRuntimeConfig,
  SessionState,
  SessionSummary,
  TurnResult,
} from './types.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are an AI coding agent operating in a terminal. Use the available tools to read, write, and search files, run commands, and manage git. Be direct and concise.';

export interface SessionManagerOptions {
  /** Async approval callback for DEFAULT permission mode (CLI/TUI wiring). */
  requestApproval?: ApprovalCallback;
  /** Persistence backend; pass null to disable persistence. */
  store?: SessionStore | null;
  /** Directory for the default SessionStore. */
  baseDir?: string;
  /** Hook configuration (from Config.hooks); enables lifecycle hooks. */
  hooks?: HooksConfig;
  /** Custom hook command runner (tests inject a fake spawner here). */
  hookRunner?: HookRunner;
  /** Skills configuration (from Config.skills); enables skill loading. */
  skills?: SkillsConfig;
  /** Custom skill registry (tests inject a fake here). */
  skillRegistry?: SkillRegistry | null;
}

/**
 * Owns session lifecycle, wires providers/executors/loop per session, and
 * re-emits loop events with the sessionId attached. The manager never calls
 * a model API itself — that is the loop's job.
 */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionState>();
  private currentSessionId: string | null = null;
  private readonly store: SessionStore | null;
  private readonly options: SessionManagerOptions;
  private readonly hookRunner: HookRunner | null;
  private readonly hooksConfig: HooksConfig | null;
  private readonly skillRegistry: SkillRegistry | null;

  constructor(options: SessionManagerOptions = {}) {
    super();
    this.options = options;
    this.store = options.store === null ? null : (options.store ?? new SessionStore(options.baseDir));
    this.hooksConfig = options.hooks ?? null;
    this.hookRunner = options.hooks
      ? options.hookRunner ?? new HookRunner()
      : null;
    this.skillRegistry = options.skills
      ? options.skillRegistry ?? new SkillRegistry(options.skills)
      : null;
  }

  // ------------------------------------------------------------------
  // Hooks
  // ------------------------------------------------------------------

  /** Fire a lifecycle hook group. Never throws; failures are surfaced. */
  private async fireHooks(
    type: HookType,
    input: Omit<HookInput, 'hookType' | 'sessionId'>
  ): Promise<HookOutcome[]> {
    if (!this.hookRunner || !this.hooksConfig) return [];
    try {
      return await this.hookRunner.run(type, this.hooksConfig[type], {
        ...input,
        sessionId: this.currentSessionId ?? '',
      });
    } catch (err) {
      this.emitTyped('error', {
        sessionId: this.currentSessionId ?? '',
        error: `Hook '${type}' failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return [];
    }
  }

  /**
   * Fire PRE hooks and return the folded decision (blocking veto or
   * message modification). No hooks configured → allow.
   */
  private async firePreHooks(
    type: HookType,
    input: Omit<HookInput, 'hookType' | 'sessionId'>
  ): Promise<HookDecision> {
    if (!this.hookRunner || !this.hooksConfig) return {};
    try {
      const { decision } = await this.hookRunner.runPre(type, this.hooksConfig[type], {
        ...input,
        sessionId: this.currentSessionId ?? '',
      });
      return decision;
    } catch (err) {
      this.emitTyped('error', {
        sessionId: this.currentSessionId ?? '',
        error: `Hook '${type}' failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return {};
    }
  }

  // ------------------------------------------------------------------
  // Typed event helper
  // ------------------------------------------------------------------

  private emitTyped<K extends SessionEventName>(event: K, payload: SessionEventPayloads[K]): void {
    this.emit(event, payload);
  }

  private listenerCountFor(event: SessionEventName): number {
    return this.listenerCount(event);
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async createSession(
    modelConfig: ModelConfig,
    tools: ToolDefinition[] = [],
    runtime: SessionRuntimeConfig = {}
  ): Promise<SessionState> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const config: SessionConfig = {
      id,
      title: runtime.title,
      model: { ...modelConfig, ...(runtime.model ?? {}) },
      workingDirectory: runtime.workingDirectory ?? process.cwd(),
      permissionMode: runtime.permissionMode ?? ('default' as never),
      systemPrompt: runtime.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      maxTurns: runtime.maxTurns ?? 50,
      maxBudgetUsd: runtime.maxBudgetUsd ?? 5,
      createdAt: now,
      updatedAt: now,
    };

    const provider = await ProviderFactory.createAndValidate(config.model);

    const state: SessionState = {
      config,
      status: Status.INITIALIZING as never,
      messages: config.systemPrompt
        ? [
            {
              role: Role.SYSTEM,
              content: [{ type: CT.TEXT, text: config.systemPrompt } as TextContent],
              timestamp: new Date(),
            },
          ]
        : [],
      turnCount: 0,
      totalCostUsd: 0,
      totalUsage: zeroUsage(),
      abortController: new AbortController(),
      busy: false,
    };

    this.sessions.set(id, state);
    this.currentSessionId = id;
    state.status = Status.ACTIVE as never;

    this.persist(state);
    this.emitTyped('sessionCreated', { sessionId: id, config });

    // SESSION_START fires once the session exists; failures never block.
    void this.fireHooks(HookType.SESSION_START, {});

    // Inject skills into the system prompt for this session.
    if (this.skillRegistry) {
      const skillBlock = this.skillRegistry.toPromptBlock();
      if (skillBlock) {
        const skillMsg: Message = {
          role: Role.SYSTEM,
          content: [{ type: CT.TEXT, text: skillBlock } as TextContent],
          timestamp: new Date(),
        };
        state.messages.push(skillMsg);
        this.emitTyped('messageAdded', { sessionId: id, message: skillMsg });
      }
    }

    // Warm the tool-token estimate so the first turn is not slow.
    TokenCounter.estimateTokens(state.messages, tools, config.systemPrompt);

    // Attach the loop lazily via a per-session closure provider below.
    this.loops.set(id, this.buildLoop(state, provider, tools));

    return state;
  }

  private readonly loops = new Map<string, { loop: AgentLoop; tools: ToolDefinition[]; provider: Provider }>();

  private buildLoop(state: SessionState, provider: Provider, tools: ToolDefinition[]): {
    loop: AgentLoop;
    tools: ToolDefinition[];
    provider: Provider;
  } {
    const contextManager = new ContextManager(
      provider.getCapabilities().maxContextTokens,
      tools,
      state.config.systemPrompt ?? ''
    );

    const events = {
      messageAdded: (message: Message) => {
        this.emitTyped('messageAdded', { sessionId: state.config.id, message });
        this.persist(state);
      },
      turnStart: (turnNumber: number) => {
        this.emitTyped('turnStart', { sessionId: state.config.id, turnNumber });
        void this.fireHooks(HookType.TURN_START, { turnNumber });
      },
      turnEnd: (turnNumber: number, result: TurnResult) => {
        this.emitTyped('turnEnd', { sessionId: state.config.id, turnNumber, result });
        void this.fireHooks(HookType.TURN_END, { turnNumber, result });
        this.persist(state);
      },
      toolStart: (toolName: string, toolUseId: string, input: unknown) => {
        this.emitTyped('toolStart', { sessionId: state.config.id, toolName, toolUseId, input });
      },
      toolComplete: (toolName: string, toolUseId: string, success: boolean, output?: unknown, error?: string) => {
        this.emitTyped('toolComplete', { sessionId: state.config.id, toolName, toolUseId, success, output, error });
      },
      streamDelta: (delta: string) => {
        this.emitTyped('streamDelta', { sessionId: state.config.id, delta });
      },
      thinking: (delta: string) => {
        this.emitTyped('thinking', { sessionId: state.config.id, delta });
      },
      approvalRequested: (request: ApprovalRequest) => {
        this.emitTyped('approvalRequested', { ...request });
        return this.listenerCountFor('approvalRequested');
      },
      error: (message: string) => {
        this.emitTyped('error', { sessionId: state.config.id, error: message });
        void this.fireHooks(HookType.ERROR, { error: message });
      },
      budgetExceeded: (used: number, limit: number) => {
        this.emitTyped('budgetExceeded', { sessionId: state.config.id, used, limit });
        void this.fireHooks(HookType.BUDGET_EXCEEDED, { extra: { used, limit } });
      },
      maxTurnsReached: (maxTurns: number) => {
        this.emitTyped('maxTurnsReached', { sessionId: state.config.id, maxTurns });
      },
      compactionStart: (messageCount: number) => {
        this.emitTyped('compactionStart', { sessionId: state.config.id, messageCount });
      },
      compactionComplete: (beforeCount: number, afterCount: number) => {
        this.emitTyped('compactionComplete', { sessionId: state.config.id, beforeCount, afterCount });
      },
    };

    const toolExecutor = new ToolExecutor(
      {
        requestApproval: this.options.requestApproval,
        emitApprovalRequest: events.approvalRequested,
      },
      this.hookRunner && this.hooksConfig
        ? {
            runPreToolUse: async (toolName, input) => {
              const pre = this.hooksConfig?.[HookType.PRE_TOOL_USE];
              if (!pre || pre.length === 0) return {};
              const { decision } = (await this.hookRunner!.runPre(HookType.PRE_TOOL_USE, pre, {
                toolName,
                input,
                sessionId: state.config.id,
              })) as { decision: HookDecision };
              return decision;
            },
            runPostToolUse: async (toolName, result) => {
              const post = this.hooksConfig?.[HookType.POST_TOOL_USE];
              if (!post || post.length === 0) return [];
              return this.hookRunner!.run(HookType.POST_TOOL_USE, post, {
                toolName,
                result,
                sessionId: state.config.id,
              });
            },
          }
        : null
    );

    const loop = new AgentLoop(provider, tools, contextManager, toolExecutor, events);
    return { loop, tools, provider };
  }

  // ------------------------------------------------------------------
  // Accessors
  // ------------------------------------------------------------------

  getCurrentSession(): SessionState | null {
    return this.currentSessionId ? (this.sessions.get(this.currentSessionId) ?? null) : null;
  }

  getSession(id: string): SessionState | null {
    return this.sessions.get(id) ?? null;
  }

  listSessions(): SessionState[] {
    return [...this.sessions.values()];
  }

  setCurrentSession(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.currentSessionId = id;
    return true;
  }

  deleteSession(id: string): boolean {
    const existed = this.sessions.delete(id);
    this.loops.delete(id);
    if (existed) {
      this.store?.deleteSession(id);
      // SESSION_END fires before the id leaves currentSessionId scope.
      void this.fireHooks(HookType.SESSION_END, {});
    }
    if (this.currentSessionId === id) {
      const next = this.sessions.keys().next();
      this.currentSessionId = next.value ?? null;
    }
    return existed;
  }

  // ------------------------------------------------------------------
  // Messaging
  // ------------------------------------------------------------------

  async sendMessage(content: string, options: SendMessageOptions = {}): Promise<TurnResult> {
    const session = this.getCurrentSession();
    if (!session) throw new Error('No active session');

    const entry = this.loops.get(session.config.id);
    if (!entry) throw new Error('Session loop not initialized');

    if (session.busy) throw new Error('A turn is already in flight for this session');
    if (
      session.status !== ('active' as never) &&
      session.status !== ('waiting_for_input' as never) &&
      session.status !== ('completed' as never)
    ) {
      throw new Error(`Session is not accepting messages (status: ${session.status as string})`);
    }

    session.busy = true;
    session.status = Status.ACTIVE as never;

    // PRE_MESSAGE hooks may modify the message text or veto it entirely.
    const preDecision = await this.firePreHooks(HookType.PRE_MESSAGE, { message: content });
    if (preDecision.block === true) {
      session.busy = false;
      session.status = 'waiting_for_input' as never;
      this.persist(session);
      return {
        response: {
          content: [],
          usage: zeroUsage(),
          stopReason: 'end_turn' as never,
          modelId: '',
          provider: undefined as never,
        },
        turns: 0,
        costUsd: 0,
        usage: zeroUsage(),
        aborted: false,
        budgetExceeded: false,
        maxTurnsReached: false,
      };
    }
    const effectiveContent =
      preDecision.modifiedMessage !== undefined ? preDecision.modifiedMessage : content;

    try {
      const userMessage: Message = {
        role: Role.USER,
        content: [{ type: CT.TEXT, text: effectiveContent } as TextContent],
        timestamp: new Date(),
      };
      session.messages.push(userMessage);
      this.emitTyped('messageAdded', { sessionId: session.config.id, message: userMessage });
      this.persist(session);

      const tools = options.tools ?? entry.tools;
      const loop =
        tools === entry.tools
          ? entry.loop
          : this.buildLoop(session, entry.provider, tools).loop;

      const result = await loop.run(session, options);
      session.status = (result.aborted ? 'completed' : 'active') as never;

      // POST_MESSAGE fires once the turn completes — after it, not before.
      void this.fireHooks(HookType.POST_MESSAGE, { message: effectiveContent, result });
      return result;
    } finally {
      session.busy = false;
      this.persist(session);
    }
  }

  abort(): void {
    const session = this.getCurrentSession();
    if (session) {
      session.abortController.abort();
      // Fresh controller for the next turn.
      const fresh = new AbortController();
      (session as { abortController?: AbortController }).abortController = fresh;
      const entry = this.loops.get(session.config.id);
      if (entry) {
        // Rebuild the loop so future turns use the fresh controller.
        this.loops.set(session.config.id, this.buildLoop(session, entry.provider, entry.tools));
      }
    }
  }

  // ------------------------------------------------------------------
  // Compaction
  // ------------------------------------------------------------------

  /**
   * Manually compact a session's message history to fit the context window.
   * Keeps the system message and the most recent turns; replaces older
   * messages with a summary placeholder. Returns true when compaction ran.
   */
  compactSession(sessionId: string, focus?: string): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return false;

    this.emitTyped('compactionStart', { sessionId, messageCount: state.messages.length });

    const entry = this.loops.get(sessionId);
    const contextManager = entry
      ? new ContextManager(
          entry.provider.getCapabilities().maxContextTokens,
          entry.tools,
          state.config.systemPrompt ?? ''
        )
      : null;

    const compacted = contextManager
      ? contextManager.compact(state.messages)
      : state.messages;

    if (compacted.length >= state.messages.length) {
      this.emitTyped('compactionComplete', {
        sessionId,
        beforeCount: state.messages.length,
        afterCount: state.messages.length,
      });
      return false;
    }

    const before = state.messages.length;
    state.messages = compacted;
    this.persist(state);
    this.emitTyped('compactionComplete', { sessionId, beforeCount: before, afterCount: compacted.length });
    return true;
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  private persist(state: SessionState): void {
    try {
      this.store?.saveSession(state);
    } catch {
      // Persistence is best-effort; a write failure must not kill a turn.
    }
  }

  resumeSession(sessionId: string): SessionState | null {
    const persisted = this.store?.loadSession(sessionId);
    if (!persisted) return null;

    const state = reviveState(persisted);
    this.sessions.set(sessionId, state);
    this.currentSessionId = sessionId;
    return state;
  }

  /** List persisted sessions on disk (not just in-memory ones). */
  listPersisted(): SessionSummary[] {
    if (!this.store) return [];
    const summaries: SessionSummary[] = [];
    for (const id of this.store.listSessions()) {
      const summary = this.store.getSummary(id);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  /** Re-initialize the loop for a resumed session. Requires the tools. */
  attachResumedSession(sessionId: string, tools: ToolDefinition[]): SessionState | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    void ProviderFactory.createAndValidate(state.config.model)
      .then((provider) => {
        this.loops.set(sessionId, this.buildLoop(state, provider, tools));
      })
      .catch(() => {
        this.emitTyped('error', { sessionId, error: 'Failed to re-initialize provider for resumed session' });
      });
    return state;
  }

  exportSession(sessionId: string): string | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return JSON.stringify(
      {
        meta: {
          config: state.config,
          status: state.status,
          turnCount: state.turnCount,
          totalCostUsd: state.totalCostUsd,
          totalUsage: state.totalUsage,
          savedAt: new Date().toISOString(),
        },
        messages: state.messages,
      } satisfies PersistedSession,
      null,
      2
    );
  }

  importSession(json: string): SessionState {
    const parsed = JSON.parse(json) as PersistedSession;
    const state = reviveState(parsed);
    this.sessions.set(state.config.id, state);
    this.currentSessionId = state.config.id;
    return state;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

/** Rebuild a live SessionState from a persisted shape (dates revived). */
function reviveState(persisted: PersistedSession): SessionState {
  const messages = persisted.messages.map((m) => ({
    ...m,
    timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
  }));

  return {
    config: persisted.meta.config,
    status: persisted.meta.status,
    messages,
    turnCount: persisted.meta.turnCount,
    totalCostUsd: persisted.meta.totalCostUsd,
    totalUsage: persisted.meta.totalUsage,
    abortController: new AbortController(),
    busy: false,
  };
}