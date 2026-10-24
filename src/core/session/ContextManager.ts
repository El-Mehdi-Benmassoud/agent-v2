import type { Message, ToolDefinition } from '../../types/index.js';
import { ContentType, MessageRole, StopReason, TextContent } from '../../types/index.js';
import { TokenCounter } from '../providers/TokenCounter.js';

export interface ContextStats {
  totalTokens: number;
  maxContextTokens: number;
  utilization: number;
  needsCompaction: boolean;
}

export interface CompactionResult {
  performed: boolean;
  beforeCount: number;
  afterCount: number;
  beforeTokens: number;
  afterTokens: number;
  summarizedTurns: number;
}

export interface CompactionOptions {
  /** Fraction of maxContextTokens above which compaction triggers. */
  threshold?: number;
  /** Keep this many most-recent messages after the system message, never summarized. */
  keepRecent?: number;
}

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_KEEP_RECENT = 8;
const COMPACT_PLACEHOLDER = 'CONTEXT_SUMMARY';

/**
 * Tracks the token budget for a session's message history and compacts it
 * when it exceeds the provider's context window.
 *
 * Compaction is purely mechanical (no model call): system messages are kept,
 * the most recent turns are kept, and everything older is replaced by a
 * single summary-placeholder message.
 */
export class ContextManager {
  private readonly maxContextTokens: number;
  private readonly tools: ToolDefinition[];
  private readonly systemPrompt: string;
  private readonly threshold: number;
  private readonly keepRecent: number;

  constructor(
    maxContextTokens: number,
    tools: ToolDefinition[] = [],
    systemPrompt = '',
    options: CompactionOptions = {}
  ) {
    this.maxContextTokens = maxContextTokens;
    this.tools = tools;
    this.systemPrompt = systemPrompt;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
  }

  /** Current token estimate for the given history. */
  countTokens(messages: Message[]): number {
    return TokenCounter.estimateTokens(messages, this.tools, this.systemPrompt || undefined).totalTokens;
  }

  /** Snapshot of budget state for the given history. */
  getStats(messages: Message[]): ContextStats {
    const totalTokens = this.countTokens(messages);
    const limitTokens = Math.floor(this.maxContextTokens * this.threshold);
    return {
      totalTokens,
      maxContextTokens: this.maxContextTokens,
      utilization: this.maxContextTokens > 0 ? totalTokens / this.maxContextTokens : 0,
      needsCompaction: totalTokens > limitTokens,
    };
  }

  /**
   * Compact the history when over the threshold. Mutates nothing: returns a
   * new message array (or the original array reference when unchanged).
   */
  compactIfNeeded(messages: Message[]): { messages: Message[]; result: CompactionResult } {
    const beforeTokens = this.countTokens(messages);
    const limitTokens = Math.floor(this.maxContextTokens * this.threshold);
    if (beforeTokens <= limitTokens || messages.length === 0) {
      return {
        messages,
        result: {
          performed: false,
          beforeCount: messages.length,
          afterCount: messages.length,
          beforeTokens,
          afterTokens: beforeTokens,
          summarizedTurns: 0,
        },
      };
    }

    const compacted = this.compact(messages);
    return {
      messages: compacted,
      result: {
        performed: true,
        beforeCount: messages.length,
        afterCount: compacted.length,
        beforeTokens,
        afterTokens: this.countTokens(compacted),
        summarizedTurns: compacted.length,
      },
    };
  }

  /**
   * Build the compacted history: all system messages first, then a
   * summary-placeholder message, then the most recent messages.
   */
  compact(messages: Message[]): Message[] {
    const systemMessages = messages.filter((m) => m.role === MessageRole.SYSTEM);

    // Index of the first message eligible for summarization: everything after
    // the kept tail (and skipping system messages, which are always kept).
    const nonSystem = messages.filter((m) => m.role !== MessageRole.SYSTEM);
    const summarizedCount = Math.max(0, nonSystem.length - this.keepRecent);
    if (summarizedCount === 0) return messages;

    const summarized = nonSystem.slice(0, summarizedCount);
    const keptTail = nonSystem.slice(summarizedCount);

    const placeholder: Message = {
      role: MessageRole.USER,
      content: [
        {
          type: ContentType.TEXT,
          text: [
            `${COMPACT_PLACEHOLDER}: ${summarizedCount} earlier messages were summarized to fit the context window.`,
            this.summarize(summarized),
          ].join('\n'),
        } as TextContent,
      ],
      timestamp: summarized[0]?.timestamp ?? new Date(),
      metadata: { compaction: true, summarizedMessages: summarizedCount } as unknown as Message['metadata'],
    };

    return [...systemMessages, placeholder, ...keptTail];
  }

  /** Derive a mechanical summary of the dropped messages. */
  private summarize(messages: Message[]): string {
    const roleCounts = new Map<string, number>();
    let toolUses = 0;
    const snippets: string[] = [];

    for (const msg of messages) {
      roleCounts.set(msg.role, (roleCounts.get(msg.role) ?? 0) + 1);
      for (const content of msg.content) {
        if (content.type === ContentType.TOOL_USE) toolUses++;
        if (content.type === ContentType.TEXT && snippets.length < 5) {
          const text = (content as TextContent).text.trim();
          if (text) snippets.push(text.slice(0, 120));
        }
      }
    }

    const parts: string[] = [`Roles: ${[...roleCounts.entries()].map(([r, n]) => `${r}=${n}`).join(', ')}.`];
    parts.push(`Tool uses: ${toolUses}.`);
    if (snippets.length > 0) {
      parts.push(`Key excerpts:\n${snippets.map((s) => `- ${s}`).join('\n')}`);
    }
    return parts.join(' ');
  }
}

export { StopReason };
