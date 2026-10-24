import type {
  Message,
  MessageContent,
  MessageRole,
  ModelOptions,
  ModelResponse,
  ModelStreamChunk,
  ToolDefinition,
  ToolResult,
  TokenUsage,
  ContentType,
  StopReason,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
} from '../../types/index.js';
import type { Provider } from '../providers/Provider.js';
import { MessageRole as Role, ContentType as CT, StopReason as SR } from '../../types/index.js';
import type { ToolExecutionOutcome } from './ToolExecutor.js';
import type { SessionState, SendMessageOptions, TurnResult, ApprovalCallback, ApprovalRequest } from './types.js';
import { ToolExecutor } from './ToolExecutor.js';
import { ContextManager } from './ContextManager.js';

/** Events the loop emits upward (SessionManager re-emits with sessionId). */
export interface AgentLoopEvents {
  messageAdded: (message: Message) => void;
  turnStart: (turnNumber: number) => void;
  turnEnd: (turnNumber: number, result: TurnResult) => void;
  toolStart: (toolName: string, toolUseId: string, input: unknown) => void;
  toolComplete: (toolName: string, toolUseId: string, success: boolean, output?: unknown, error?: string) => void;
  streamDelta: (delta: string) => void;
  thinking: (delta: string) => void;
  approvalRequested: (request: ApprovalRequest) => number;
  error: (message: string) => void;
  budgetExceeded: (used: number, limit: number) => void;
  maxTurnsReached: (maxTurns: number) => void;
  compactionStart: (messageCount: number) => void;
  compactionComplete: (beforeCount: number, afterCount: number) => void;
}

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_BUDGET_USD = 5;

/**
 * The agent turn loop. One sendMessage() = one run() of this loop, which may
 * involve several model round-trips while tool calls are pending.
 *
 * Streaming accumulation contract (the v1 predecessor dropped tool calls in
 * streaming mode — this implementation must not):
 *  - OpenAI shape: the first tool_call chunk carries id+name; the arguments
 *    string arrives split across many chunks. We buffer the argument text per
 *    toolUseId and only materialize the ToolUseContent when the arguments
 *    parse as a complete JSON object (or at stream end).
 *  - Anthropic shape: content_block_start announces {id, name}; argument
 *    fragments arrive as partial JSON deltas. Same buffering applies.
 * The final assistant message pushed to history contains text + thinking +
 * fully-parsed tool_use blocks, so the model sees its own tool calls on the
 * next round-trip.
 */
export class AgentLoop {
  constructor(
    private readonly provider: Provider,
    private readonly tools: ToolDefinition[],
    private readonly contextManager: ContextManager,
    private readonly toolExecutor: ToolExecutor,
    private readonly events: AgentLoopEvents
  ) {}

  async run(session: SessionState, userOptions: SendMessageOptions = {}): Promise<TurnResult> {
    const maxTurns = userOptions.maxTurns ?? session.config.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxBudgetUsd = userOptions.maxBudgetUsd ?? session.config.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
    const permissionMode = userOptions.permissionMode ?? session.config.permissionMode;
    const stream = userOptions.stream ?? false;

    const startCost = session.totalCostUsd;
    const startUsage: TokenUsage = { ...session.totalUsage };
    let turns = 0;
    let aborted = false;
    let budgetExceeded = false;
    let maxTurnsHit = false;
    let lastResponse: ModelResponse | undefined;

    while (true) {
      if (session.abortController.signal.aborted) {
        aborted = true;
        break;
      }

      if (turns >= maxTurns) {
        maxTurnsHit = true;
        this.events.maxTurnsReached(maxTurns);
        break;
      }

      const spent = session.totalCostUsd - startCost;
      if (maxBudgetUsd > 0 && spent >= maxBudgetUsd) {
        budgetExceeded = true;
        this.events.budgetExceeded(spent, maxBudgetUsd);
        break;
      }

      turns += 1;
      session.turnCount += 1;
      session.config.updatedAt = new Date().toISOString();
      this.events.turnStart(session.turnCount);

      let response: ModelResponse;
      try {
        const history = this.prepareHistory(session);
        response = stream
          ? await this.runStreamingTurn(session, userOptions, history)
          : await this.runOneShotTurn(session, userOptions, history);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.events.error(message);
        session.status = 'error' as never;
        break;
      }

      lastResponse = response;

      // Record usage/cost.
      session.totalCostUsd += response.usage.costUsd ?? 0;
      session.totalUsage = mergeUsage(session.totalUsage, response.usage);
      session.lastResponse = response;

      // Check budget AFTER each model response (not just at loop top).
      if (maxBudgetUsd > 0 && session.totalCostUsd - startCost >= maxBudgetUsd) {
        budgetExceeded = true;
        this.events.budgetExceeded(session.totalCostUsd - startCost, maxBudgetUsd);
        break;
      }

      // Assistant message enters history.
      const assistantMessage: Message = {
        role: Role.ASSISTANT,
        content: response.content,
        timestamp: new Date(),
        metadata: {
          usage: {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
          },
          costUsd: response.usage.costUsd,
          turnNumber: session.turnCount,
        } as never,
      };
      session.messages.push(assistantMessage);
      this.events.messageAdded(assistantMessage);

      const toolUses = response.content.filter(
        (c): c is ToolUseContent => c.type === (CT.TOOL_USE as ContentType)
      );

      // No tool calls → the model is done talking.
      if (
        toolUses.length === 0 ||
        response.stopReason === SR.END_TURN ||
        response.stopReason === SR.MAX_TOKENS ||
        response.stopReason === SR.BUDGET_EXCEEDED ||
        response.stopReason === SR.TURN_LIMIT
      ) {
        // Even if we're stopping due to END_TURN, check if we've hit the turn limit.
        if (turns >= maxTurns) {
          maxTurnsHit = true;
          this.events.maxTurnsReached(maxTurns);
        }
        if (toolUses.length > 0) {
          // Model ended with pending tool calls; still execute them so the
          // results land in history, but do not continue the loop.
          await this.executeToolCalls(session, toolUses, permissionMode, userOptions);
        }
        break;
      }

      // Execute tools, then loop for the model's reaction.
      await this.executeToolCalls(session, toolUses, permissionMode, userOptions);
    }

    const result: TurnResult = {
      response:
        lastResponse ?? {
          content: [],
          usage: zeroUsage(),
          stopReason: SR.END_TURN,
          modelId: '',
          provider: undefined as never,
        },
      turns,
      costUsd: session.totalCostUsd - startCost,
      usage: diffUsage(session.totalUsage, startUsage),
      aborted,
      budgetExceeded,
      maxTurnsReached: maxTurnsHit,
    };

    this.events.turnEnd(session.turnCount, result);
    return result;
  }

  // ------------------------------------------------------------------
  // Model turns
  // ------------------------------------------------------------------

  private prepareHistory(session: SessionState): Message[] {
    const stats = this.contextManager.getStats(session.messages);
    if (stats.needsCompaction && session.messages.length > 4) {
      this.events.compactionStart(session.messages.length);
      const { messages, result } = this.contextManager.compactIfNeeded(session.messages);
      if (result.performed) {
        session.messages = messages;
        this.events.compactionComplete(result.beforeCount, result.afterCount);
      }
    }
    return session.messages;
  }

  private async runOneShotTurn(
    session: SessionState,
    options: SendMessageOptions,
    history: Message[]
  ): Promise<ModelResponse> {
    const modelOptions: ModelOptions = {
      ...options.modelOptions,
      systemPrompt: options.systemPrompt ?? session.config.systemPrompt,
    };
    return this.provider.sendMessage(history, this.tools, modelOptions);
  }

  private async runStreamingTurn(
    session: SessionState,
    options: SendMessageOptions,
    history: Message[]
  ): Promise<ModelResponse> {
    const modelOptions: ModelOptions = {
      ...options.modelOptions,
      systemPrompt: options.systemPrompt ?? session.config.systemPrompt,
    };

    const content: MessageContent[] = [];
    let textBuffer = '';
    let usage: TokenUsage | undefined;
    let stopReason: StopReason = SR.END_TURN;

    // Buffered tool assembly: toolUseId -> { id, name, argsText }
    const toolBuffers = new Map<string, { id: string; name: string; argsText: string }>();
    let nextToolIndex = 0;

    const flushText = (): void => {
      if (textBuffer) {
        content.push({ type: CT.TEXT, text: textBuffer } as TextContent);
        textBuffer = '';
      }
    };

    const materializeTools = (): void => {
      // Emit tool_use blocks in first-seen order with best-effort parsing.
      const ordered = [...toolBuffers.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
      for (const [, buf] of ordered) {
        content.push({
          type: CT.TOOL_USE,
          id: buf.id,
          name: buf.name,
          input: parseJsonObjectSafe(buf.argsText),
        } as ToolUseContent);
      }
      toolBuffers.clear();
    };

    for await (const chunk of this.provider.streamMessage(history, this.tools, modelOptions)) {
      if (session.abortController.signal.aborted) break;

      switch (chunk.type) {
        case 'content': {
          if (chunk.delta) {
            this.events.streamDelta(chunk.delta);
            textBuffer += chunk.delta;
          }
          // Complete content blocks (non-delta path) pass through directly.
          if (chunk.content) {
            flushText();
            content.push(chunk.content);
          }
          break;
        }

        case 'tool_use': {
          const tu = chunk.toolUse;
          if (!tu) break;
          flushText();
          if (tu.partial) {
            // Argument fragment. Buffer by id; synthesize an id when the
            // provider omits it (OpenAI first-chunk edge cases).
            const key = tu.id || `__t${nextToolIndex}`;
            let buf = toolBuffers.get(key);
            if (!buf) {
              nextToolIndex += 1;
              buf = { id: tu.id || `toolu_${nextToolIndex}`, name: tu.name, argsText: '' };
              toolBuffers.set(key, buf);
            } else {
              if (tu.id && buf.id !== tu.id) buf.id = tu.id;
              if (tu.name && buf.name !== tu.name) buf.name = tu.name;
            }
            if (tu.input && Object.keys(tu.input).length > 0) {
              // Some providers deliver partial objects; merge keys.
              const merged = { ...parseJsonObjectSafe(buf.argsText), ...tu.input };
              buf.argsText = JSON.stringify(merged);
            }
          } else {
            // A complete tool call arrived in one chunk.
            content.push({
              type: CT.TOOL_USE,
              id: tu.id,
              name: tu.name,
              input: tu.input,
            } as ToolUseContent);
          }
          break;
        }

        case 'thinking': {
          flushText();
          if (chunk.thinking) this.events.thinking(chunk.thinking);
          content.push({ type: CT.THINKING, thinking: chunk.thinking ?? '' } as ThinkingContent);
          break;
        }

        case 'usage': {
          if (chunk.usage) usage = chunk.usage;
          break;
        }

        case 'error': {
          throw new Error(chunk.error ?? 'Streaming error');
        }

        case 'complete': {
          if (chunk.usage) usage = chunk.usage;
          if (chunk.stopReason) stopReason = chunk.stopReason;
          break;
        }
      }
    }

    flushText();
    materializeTools();

    if (session.abortController.signal.aborted) {
      stopReason = SR.END_TURN;
    }

    return {
      content,
      usage: usage ?? zeroUsage(),
      stopReason,
      modelId: '',
      provider: undefined as never,
    };
  }

  // ------------------------------------------------------------------
  // Tool execution
  // ------------------------------------------------------------------

  private async executeToolCalls(
    session: SessionState,
    toolUses: ToolUseContent[],
    permissionMode: SessionState['config']['permissionMode'],
    options: SendMessageOptions
  ): Promise<void> {
    session.status = 'running_tool' as never;

    const known = new Map(this.tools.map((t) => [t.name, t]));

    for (const toolUse of toolUses) {
      if (session.abortController.signal.aborted) break;

      const tool = known.get(toolUse.name);
      this.events.toolStart(toolUse.name, toolUse.id, toolUse.input);

      let outcome: ToolExecutionOutcome;
      if (!tool) {
        const result: ToolResult = {
          success: false,
          error: `Tool not found: ${toolUse.name}`,
        };
        outcome = {
          result,
          message: ToolExecutor.buildResultMessage(toolUse, result),
          approved: false,
        };
      } else {
        outcome = await this.toolExecutor.execute(tool, toolUse, {
          workingDirectory: options.workingDirectory ?? session.config.workingDirectory,
          sessionId: session.config.id,
          messageId: `${toolUse.id}`,
          abortSignal: session.abortController.signal,
          permissionMode: options.permissionMode ?? permissionMode,
        });
      }

      session.messages.push(outcome.message);
      this.events.messageAdded(outcome.message);
      this.events.toolComplete(
        toolUse.name,
        toolUse.id,
        outcome.result.success,
        outcome.result.output,
        outcome.result.error
      );
    }

    session.status = 'active' as never;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonObjectSafe(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // partial or invalid JSON — fall through to the raw-string fallback
  }
  if (text && text.trim()) {
    return { _raw: text };
  }
  return {};
}

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

function diffUsage(current: TokenUsage, start: TokenUsage): TokenUsage {
  return {
    inputTokens: current.inputTokens - start.inputTokens,
    outputTokens: current.outputTokens - start.outputTokens,
    cacheReadTokens: (current.cacheReadTokens ?? 0) - (start.cacheReadTokens ?? 0),
    cacheWriteTokens: (current.cacheWriteTokens ?? 0) - (start.cacheWriteTokens ?? 0),
    totalTokens: current.totalTokens - start.totalTokens,
    costUsd: (current.costUsd ?? 0) - (start.costUsd ?? 0),
  };
}

// Re-exported for the barrel.
export type {
  Message,
  MessageContent,
  MessageRole,
  ModelResponse,
  ToolDefinition,
  TokenUsage,
  ContentType,
  StopReason,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
  ApprovalCallback,
  ApprovalRequest,
};