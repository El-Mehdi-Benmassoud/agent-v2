import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
} from '@anthropic-ai/sdk/resources/messages';
import {
  ModelConfig,
  Message,
  ToolDefinition,
  ModelOptions,
  ModelResponse,
  ModelStreamChunk,
  ProviderCapabilities,
  TokenUsage,
  ModelProvider,
  ContentType,
  StopReason,
  TokenCountResult,
  ValidationResult,
  MessageRole,
  TextContent,
  ImageContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
  MessageContent,
} from '../../types/index.js';
import { Provider } from './Provider.js';
import { TokenCounter } from './TokenCounter.js';
import { CostEstimator } from './CostEstimator.js';

export class AnthropicProvider extends Provider {
  private client: Anthropic;

  constructor(config: ModelConfig) {
    super(config);
    const apiKey = config.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    this.client = new Anthropic({
      apiKey: apiKey,
      baseURL: config.baseUrl,
    });
  }

  async validateConfig(): Promise<ValidationResult> {
    const apiKey = this.config.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    return {
      valid: Boolean(apiKey),
      errors: apiKey ? [] : ['ANTHROPIC_API_KEY is required'],
    };
  }

  getCapabilities(): ProviderCapabilities {
    const modelId = this.getModelId();
    const isSonnet4 = modelId.includes('sonnet-4');
    const isOpus4 = modelId.includes('opus-4');
    const isSonnet35 = modelId.includes('3-5-sonnet');
    const isHaiku35 = modelId.includes('3-5-haiku');

    const maxTokens = isOpus4 || isSonnet4 || isSonnet35 || isHaiku35 ? 8192 : 4096;

    return {
      supportsStreaming: true,
      supportsTools: true,
      supportsThinking: false, // SDK 0.27 has no thinking blocks
      supportsImages: true,
      supportsSystemPrompt: true,
      maxContextTokens: 200000,
      maxOutputTokens: maxTokens,
      supportedModels: [
        'claude-opus-4-20250514',
        'claude-sonnet-4-20250514',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
      ],
    };
  }

  async countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<TokenCountResult> {
    // Anthropic has no public token-count endpoint; use shared estimation.
    const estimate = TokenCounter.estimateTokens(messages, tools);
    return {
      inputTokens: estimate.totalTokens,
      outputTokens: 0,
      totalTokens: estimate.totalTokens,
    };
  }

  async sendMessage(
    messages: Message[],
    tools: ToolDefinition[],
    options: ModelOptions
  ): Promise<ModelResponse> {
    const params = this.buildParams(messages, tools, options, false) as MessageCreateParamsNonStreaming;
    const response = await this.client.messages.create(params);

    const content: MessageContent[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        content.push({ type: ContentType.TEXT, text: block.text });
      } else if (block.type === 'tool_use') {
        content.push({
          type: ContentType.TOOL_USE,
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    const usage = this.buildUsage(response.usage);
    return {
      content,
      usage,
      stopReason: this.mapStopReason(response.stop_reason),
      modelId: response.model,
      provider: ModelProvider.ANTHROPIC,
    };
  }

  async *streamMessage(
    messages: Message[],
    tools: ToolDefinition[],
    options: ModelOptions
  ): AsyncIterable<ModelStreamChunk> {
    const params = this.buildParams(messages, tools, options, true) as MessageCreateParamsStreaming;
    const stream = await this.client.messages.create(params);

    let currentToolId = '';
    let currentToolName = '';

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          yield { type: 'content', content: { type: ContentType.TEXT, text: '' } };
          break;
        }

        case 'content_block_start': {
          if (event.content_block.type === 'tool_use') {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            yield {
              type: 'tool_use',
              toolUse: { id: currentToolId, name: currentToolName, input: {}, partial: true },
            };
          }
          break;
        }

        case 'content_block_delta': {
          if (event.delta.type === 'text_delta') {
            yield { type: 'content', delta: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            yield {
              type: 'tool_use',
              toolUse: {
                id: currentToolId,
                name: currentToolName,
                input: this.parsePartialJson(event.delta.partial_json),
                partial: true,
              },
            };
          }
          break;
        }

        case 'message_delta': {
          const outputTokens = event.usage?.output_tokens ?? 0;
          yield {
            type: 'usage',
            usage: this.buildUsage({ input_tokens: 0, output_tokens: outputTokens }),
          };
          if (event.delta.stop_reason) {
            yield {
              type: 'complete',
              stopReason: this.mapStopReason(event.delta.stop_reason),
            };
          }
          break;
        }

        case 'message_stop': {
          yield { type: 'complete' };
          break;
        }

        default:
          break;
      }
    }
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private buildParams(
    messages: Message[],
    tools: ToolDefinition[],
    options: ModelOptions,
    stream: boolean
  ): MessageCreateParamsNonStreaming | MessageCreateParamsStreaming {
    const systemPrompt = options.systemPrompt ?? this.extractSystemPrompt(messages);
    const anthropicTools = this.convertTools(tools);

    const base = {
      model: this.getModelId(),
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 4096,
      temperature: options.temperature ?? this.config.temperature ?? 0.7,
      top_p: options.topP ?? this.config.topP ?? 0.95,
      stop_sequences: options.stopSequences,
      system: systemPrompt,
      messages: this.convertMessages(messages),
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      ...(anthropicTools.length > 0 ? { tool_choice: { type: 'auto' as const } } : {}),
      ...(stream ? { stream: true as const } : {}),
    };
    return base as MessageCreateParamsNonStreaming | MessageCreateParamsStreaming;
  }

  private extractSystemPrompt(messages: Message[]): string | undefined {
    const sysMsg = messages.find((m) => m.role === MessageRole.SYSTEM);
    if (!sysMsg) return undefined;
    if (typeof sysMsg.content === 'string') return sysMsg.content;
    return sysMsg.content
      .filter((c): c is TextContent => c.type === ContentType.TEXT)
      .map((c) => c.text)
      .join('\n') || undefined;
  }

  private convertMessages(messages: Message[]): MessageParam[] {
    const result: MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === MessageRole.SYSTEM) continue; // sent as top-level `system`

      if (msg.role === MessageRole.TOOL) {
        // Tool results go in as user-role tool_result blocks
        const blocks: MessageParam['content'] = [];
        for (const c of msg.content) {
          if (c.type === ContentType.TOOL_RESULT) {
            const tr = c as ToolResultContent;
            blocks.push({
              type: 'tool_result' as const,
              tool_use_id: tr.toolUseId,
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
              is_error: tr.isError,
            });
          }
        }
        if (blocks.length > 0) result.push({ role: 'user', content: blocks });
        continue;
      }

      const blocks: MessageParam['content'] = [];
      for (const c of msg.content) {
        switch (c.type) {
          case ContentType.TEXT:
            blocks.push({ type: 'text' as const, text: (c as TextContent).text });
            break;
          case ContentType.IMAGE: {
            const img = c as ImageContent;
            if (img.source.type === 'base64' && img.source.data) {
              blocks.push({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: img.source.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                  data: img.source.data,
                },
              });
            }
            break;
          }
          case ContentType.TOOL_USE: {
            const tu = c as ToolUseContent;
            blocks.push({
              type: 'tool_use' as const,
              id: tu.id,
              name: tu.name,
              input: tu.input,
            });
            break;
          }
          case ContentType.THINKING:
            // SDK 0.27 does not support thinking blocks — skip on send
            break;
          default:
            break;
        }
      }
      if (blocks.length > 0) {
        result.push({
          role: msg.role === MessageRole.USER ? 'user' : 'assistant',
          content: blocks,
        });
      }
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): Array<{
    name: string;
    description: string;
    input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  }> {
    return tools.map((tool) => {
      const schema = tool.inputSchema as Record<string, unknown>;
      return {
        name: tool.name,
        description: tool.description,
        input_schema: {
          type: 'object',
          properties: (schema['properties'] as Record<string, unknown>) ?? {},
          required: schema['required'] as string[] | undefined,
        },
      };
    });
  }

  private parsePartialJson(partial: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(partial);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private buildUsage(usage: { input_tokens: number; output_tokens: number }): TokenUsage {
    const total = usage.input_tokens + usage.output_tokens;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: total,
      costUsd: CostEstimator.estimateCost(
        usage.input_tokens,
        usage.output_tokens,
        this.getModelId(),
        ModelProvider.ANTHROPIC
      ).totalCost,
    };
  }

  private mapStopReason(reason: string | null): StopReason {
    switch (reason) {
      case 'end_turn':
        return StopReason.END_TURN;
      case 'max_tokens':
        return StopReason.MAX_TOKENS;
      case 'tool_use':
        return StopReason.TOOL_USE;
      case 'stop_sequence':
        return StopReason.STOP_SEQUENCE;
      default:
        return StopReason.END_TURN;
    }
  }
}