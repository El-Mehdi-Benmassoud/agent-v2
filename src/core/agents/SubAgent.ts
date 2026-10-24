import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  AgentConfig,
  SubAgentConfig,
  AgentState,
  AgentResult,
  ToolDefinition,
  Message,
  ModelConfig,
  ModelProvider,
  ModelId,
  TokenUsage,
  ModelResponse,
  ContentType,
  MessageRole,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  SubAgentSessionConfig,
} from '../../types/index.js';
import { MessageRole as Role, ContentType as CT, StopReason as SR } from '../../types/index.js';
import { ProviderFactory } from '../providers/ProviderFactory.js';
import { TokenCounter } from '../providers/TokenCounter.js';
import { SkillRegistry } from '../skills/SkillRegistry.js';
import { HookRunner } from '../hooks/HookRunner.js';
import type { HookConfig, HookType, HookInput } from '../../types/index.js';
import type { HookDecision } from '../hooks/HookRunner.js';
import { HookType as HookTypeEnum } from '../../types/index.js';

/**
 * SubAgent — runs a scoped task with its own session, tools, and context,
 * then returns a structured result to the parent. Designed for:
 *  - Parallel independent work (file search, refactoring, test generation)
 *  - Isolated experimentation (spike branches that can be discarded)
 *  - Context-limited operations (large file analysis without polluting parent)
 *
 * The sub-agent inherits the parent's model config by default but can override.
 * It receives a task prompt and optional context summary, runs to completion,
 * and returns { success, output, costUsd, usage, turns, artifacts }.
 */
export class SubAgent extends EventEmitter {
  private readonly config: SubAgentConfig;
  private readonly parentSessionId: string;
  private readonly skillRegistry: SkillRegistry | null;
  private readonly hooks: HookConfig[] | null;
  private readonly hookRunner: HookRunner | null;
  private readonly tools: ToolDefinition[];

  // Internal state
  private sessionId: string | null = null;
  private sessionConfig: SubAgentSessionConfig | null = null;
  private state: AgentState | null = null;
  private abortController: AbortController | null = null;

  constructor(
    config: SubAgentConfig,
    tools: ToolDefinition[],
    options: {
      skillRegistry?: SkillRegistry | null;
      hooks?: HookConfig[] | null;
      hookRunner?: HookRunner | null;
    } = {}
  ) {
    super();
    this.config = config;
    this.parentSessionId = config.parentSessionId;
    this.tools = tools;
    this.skillRegistry = options.skillRegistry ?? null;
    this.hooks = options.hooks ?? null;
    this.hookRunner = options.hookRunner ?? null;
  }

  /** Execute the sub-agent task. Returns result; throws on config/initialization errors. */
  async run(): Promise<AgentResult> {
    const startTime = Date.now();
    this.abortController = new AbortController();

    try {
      // Build the model config (parent + overrides)
            const modelConfig: ModelConfig = {
              provider: this.config.modelConfig?.provider ?? ModelProvider.ANTHROPIC,
              modelId: this.config.modelConfig?.modelId ?? ModelId.CLAUDE_SONNET_4,
              apiKey: this.config.modelConfig?.apiKey,
              maxTokens: this.config.modelConfig?.maxTokens ?? 8192,
              temperature: this.config.modelConfig?.temperature ?? 0.7,
              maxTurns: this.config.maxTurns ?? 50,
              maxBudgetUsd: this.config.maxBudgetUsd ?? 10,
              ...this.config.modelConfig,
            };

      // Create session with inherited or new tools
      const sessionTools = this.config.allowedTools?.length
        ? this.tools.filter((t) => this.config.allowedTools!.includes(t.name))
        : this.tools.filter((t) => !this.config.deniedTools?.includes(t.name));

      const provider = await ProviderFactory.createAndValidate(modelConfig);

      // Build system prompt with task + optional context summary
      const systemPrompt = this.buildSystemPrompt();

      // Initialize runtime state
      this.sessionId = randomUUID();
      this.sessionConfig = {
        id: this.sessionId,
        title: `SubAgent: ${this.config.taskId}`,
        model: modelConfig,
        workingDirectory: this.config.workingDirectory ?? process.cwd(),
        permissionMode: this.config.permissionMode ?? 'default',
        systemPrompt,
        maxTurns: this.config.maxTurns ?? 50,
        maxBudgetUsd: this.config.maxBudgetUsd ?? 10,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Initialize runtime state
      this.state = {
        config: this.config,
        status: 'active' as never,
        messages: [
          { role: Role.SYSTEM, content: [{ type: CT.TEXT, text: systemPrompt } as TextContent], timestamp: new Date() },
        ],
        turnCount: 0,
        totalCostUsd: 0,
        totalUsage: zeroUsage(),
        abortController: this.abortController,
        busy: false,
        sessionConfig: this.sessionConfig,
      };

      // Inject skills if available
      if (this.skillRegistry) {
        const skillBlock = this.skillRegistry.toPromptBlock();
        if (skillBlock) {
          const skillMsg: Message = {
            role: Role.SYSTEM,
            content: [{ type: CT.TEXT, text: skillBlock } as TextContent],
            timestamp: new Date(),
          };
          this.state.messages.push(skillMsg);
        }
      }

      // Run the turn loop (similar to AgentLoop but simpler - no streaming UI)
      const result = await this.runTurnLoop(provider, sessionTools);

      const durationMs = Date.now() - startTime;
      return {
        success: result.success,
        output: result.output,
        error: result.error,
        costUsd: this.state.totalCostUsd,
        usage: this.state.totalUsage,
        turns: this.state.turnCount,
        durationMs,
        artifacts: result.artifacts,
      };
    } finally {
      this.abortController = null;
    }
  }

  private buildSystemPrompt(): string {
    const parts = [
      'You are a sub-agent executing a focused task.',
      `Task: ${this.config.task}`,
    ];

    if (this.config.contextSummary) {
      parts.push(`Context from parent:\n${this.config.contextSummary}`);
    }

    if (this.config.inheritContext && this.config.contextSummary) {
      parts.push('You have full context from the parent session. Use it to avoid re-reading files.');
    }

    parts.push(`
Guidelines:
- Complete the task efficiently; prefer tool use over long explanations.
- Return structured results when possible (JSON, file paths, diffs).
- If you cannot complete the task, explain why and what would be needed.
- Stay within the allowed tools and budget.
`);

    return parts.join('\n\n');
  }

  private async runTurnLoop(
    provider: any,
    tools: ToolDefinition[]
  ): Promise<{ success: boolean; output?: unknown; error?: string; artifacts?: Record<string, unknown> }> {
    const maxTurns = this.config.maxTurns ?? 50;
    const maxBudget = this.config.maxBudgetUsd ?? 10;
    let consecutiveNoToolTurns = 0;

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (this.abortController?.signal.aborted) {
        return { success: false, error: 'Sub-agent aborted by parent' };
      }

      // Budget check
      if (this.state!.totalCostUsd >= maxBudget) {
        return { success: false, error: `Budget exceeded: $${this.state!.totalCostUsd.toFixed(4)} >= $${maxBudget}` };
      }

      this.state!.turnCount = turn;
      this.sessionConfig!.updatedAt = new Date().toISOString();

      // Prepare history
      const history = this.prepareHistory();

      // Call model
      let response;
      try {
        response = await provider.sendMessage(history, tools, { systemPrompt: this.state!.config.systemPrompt });
      } catch (err) {
        return { success: false, error: `Model error: ${err instanceof Error ? err.message : String(err)}` };
      }

      // Record usage
      this.state!.totalCostUsd += response.usage.costUsd ?? 0;
      this.state!.totalUsage = mergeUsage(this.state!.totalUsage, response.usage);

      // Add assistant message
      const assistantMsg: Message = {
        role: Role.ASSISTANT,
        content: response.content,
        timestamp: new Date(),
        metadata: { usage: response.usage, turnNumber: turn } as never,
      };
      this.state!.messages.push(assistantMsg);

      // Extract tool calls
      const toolUses = response.content.filter(
        (c: any) => c.type === CT.TOOL_USE
      ) as ToolUseContent[];

      if (toolUses.length === 0) {
        consecutiveNoToolTurns++;
        if (consecutiveNoToolTurns >= 2) {
          // Model is done talking
          return { success: true, output: this.extractFinalOutput(response.content) };
        }
        continue;
      }
      consecutiveNoToolTurns = 0;

      // Execute tools
      const toolResults = await this.executeTools(toolUses, provider);

      // Check if any tool produced a final result marker
      const finalArtifact = toolResults.find((r) => r.isFinal);
      if (finalArtifact) {
        return { success: true, output: finalArtifact.output, artifacts: finalArtifact.artifacts };
      }
    }

    return { success: false, error: `Max turns (${maxTurns}) reached` };
  }

  private prepareHistory(): Message[] {
    // Simple: return all messages (no compaction for sub-agents)
    return this.state!.messages;
  }

  private async executeTools(
    toolUses: ToolUseContent[],
    provider: any
  ): Promise<Array<{ isFinal: boolean; output?: unknown; artifacts?: Record<string, unknown> }>> {
    const results = [];

    for (const toolUse of toolUses) {
      if (this.abortController?.signal.aborted) break;

      const tool = this.tools.find((t) => t.name === toolUse.name);
      if (!tool) {
        this.addToolResult(toolUse.id, { success: false, error: `Tool not found: ${toolUse.name}` });
        continue;
      }

      // PRE_TOOL_USE hook
      const preDecision = await this.runPreHooks(HookTypeEnum.PRE_TOOL_USE, { toolName: tool.name, input: toolUse.input });
      if (preDecision.block) {
        this.addToolResult(toolUse.id, { success: false, error: preDecision.reason ?? 'Blocked by hook' });
        continue;
      }

      let result: any;
      try {
        result = await tool.execute(toolUse.input, {
          workingDirectory: this.sessionConfig!.workingDirectory,
          sessionId: this.sessionId!,
          messageId: toolUse.id,
          abortSignal: this.abortController!.signal,
        });
      } catch (err) {
        result = { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      this.addToolResult(toolUse.id, result);

      // POST_TOOL_USE hook
      await this.runPostHooks(HookTypeEnum.POST_TOOL_USE, { toolName: tool.name, result });

      // Check for final result convention
      if (result.success && result.output && typeof result.output === 'object' && (result.output as any).isFinalResult) {
        results.push({ isFinal: true, output: (result.output as any).value, artifacts: (result.output as any).artifacts });
      }
    }

    return results;
  }

  private addToolResult(toolUseId: string, result: any): void {
    const outputText = result.output === undefined
      ? (result.error ?? '')
      : typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

    const content: ToolResultContent = {
      type: CT.TOOL_RESULT,
      toolUseId,
      content: outputText,
      isError: !result.success || undefined,
    };

    const toolMsg: Message = {
      role: Role.TOOL,
      content: [content],
      timestamp: new Date(),
      metadata: result.metadata as never,
    };
    this.state!.messages.push(toolMsg);
  }

  private extractFinalOutput(content: any[]): string {
    const textParts = content.filter((c) => c.type === CT.TEXT).map((c) => c.text);
    return textParts.join('\n');
  }

  /** Abort the sub-agent mid-execution. */
  abort(): void {
    this.abortController?.abort();
  }

  /** Get current session ID for parent tracking. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  // ========== Hook helpers ==========

  private async runPreHooks(type: HookType, input: Omit<HookInput, 'hookType' | 'sessionId'>): Promise<HookDecision> {
    if (!this.hookRunner || !this.hooks) return {};
    const { decision } = await this.hookRunner.runPre(type, this.hooks, { ...input, sessionId: this.sessionId! });
    return decision;
  }

  private async runPostHooks(type: HookType, input: Omit<HookInput, 'hookType' | 'sessionId'>): Promise<void> {
    if (!this.hookRunner || !this.hooks) return;
    await this.hookRunner.run(type, this.hooks, { ...input, sessionId: this.sessionId! });
  }
}

/** Factory for spawning sub-agents with consistent wiring. */
export class SubAgentFactory {
  private readonly parentTools: ToolDefinition[];
  private readonly defaultModelConfig: ModelConfig;
  private readonly skillRegistry: SkillRegistry | null;
  private readonly hooks: HookConfig[] | null;
  private readonly hookRunner: HookRunner | null;

  constructor(
    tools: ToolDefinition[],
    defaultModelConfig: ModelConfig,
    options: { skillRegistry?: SkillRegistry | null; hooks?: HookConfig[] | null; hookRunner?: HookRunner | null } = {}
  ) {
    this.parentTools = tools;
    this.defaultModelConfig = defaultModelConfig;
    this.skillRegistry = options.skillRegistry ?? null;
    this.hooks = options.hooks ?? null;
    this.hookRunner = options.hookRunner ?? null;
  }

  create(config: Omit<SubAgentConfig, 'parentSessionId' | 'taskId'> & { parentSessionId: string; taskId: string }): SubAgent {
    return new SubAgent(
      { ...config, parentSessionId: config.parentSessionId, taskId: config.taskId },
      this.parentTools,
      { skillRegistry: this.skillRegistry, hooks: this.hooks, hookRunner: this.hookRunner }
    );
  }
}

// ========== Helpers ==========

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
}

function mergeUsage(base: TokenUsage, add: TokenUsage): TokenUsage {
  return {
    inputTokens: base.inputTokens + add.inputTokens,
    outputTokens: base.outputTokens + add.outputTokens,
    cacheReadTokens: (base.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0),
    cacheWriteTokens: (base.cacheWriteTokens ?? 0) + (add.cacheWriteTokens ?? 0),
    totalTokens: base.totalTokens + add.totalTokens,
    costUsd: (base.costUsd ?? 0) + (add.costUsd ?? 0),
  };
}

export default SubAgent;