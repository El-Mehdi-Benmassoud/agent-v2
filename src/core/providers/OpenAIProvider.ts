import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import { Tiktoken, get_encoding } from 'tiktoken';
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
  MessageContent,
} from '../../types/index.js';
import { Provider } from './Provider.js';
import { CostEstimator } from './CostEstimator.js';

export class OpenAIProvider extends Provider {
  private client: OpenAI;
  private encoder: Tiktoken | null = null;

  constructor(config: ModelConfig) {
    super(config);
    const apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'];
    this.client = new OpenAI({
      apiKey: apiKey,
      baseURL: config.baseUrl,
    });
  }

  async validateConfig(): Promise<ValidationResult> {
    const apiKey = this.config.apiKey ?? process.env['OPENAI_API_KEY'];
    return {
      valid: Boolean(apiKey),
      errors: apiKey ? [] : ['OPENAI_API_KEY is required'],
    };
  }

  getCapabilities(): ProviderCapabilities {
    const modelId = this.getModelId();
    const isO1 = modelId.includes('o1');
    const isO3 = modelId.includes('o3');
    const isGPT4o = modelId.includes('gpt-4o');
    const isGPT4 = modelId.includes('gpt-4');

    let maxTokens = 4096;
    let maxContextTokens = 8192;
    if (isO1 || isO3) {
      maxTokens = 32768;
      maxContextTokens = 200000;
    } else if (isGPT4o) {
      maxTokens = 16384;
      maxContextTokens = 128000;
    } else if (isGPT4) {
      maxTokens = 4096;
      maxContextTokens = 128000;
    }

    return {
      supportsStreaming: !isO1, // o1-preview did not support streaming at launch
      supportsTools: !isO1 && !isO3,
      supportsThinking: isO1 || isO3,
      supportsImages: isGPT4o || modelId.includes('gpt-4-turbo'),
      supportsSystemPrompt: true,
      maxContextTokens,
      maxOutputTokens: maxTokens,
      supportedModels: [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-4',
        'gpt-3.5-turbo',
        'o1-preview',
        'o1-mini',
        'o3-mini',
      ],
    };
  }

  async countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<TokenCountResult> {
    if (!this.encoder) {
      // cl100k_base is a safe universal fallback for GPT-4-family and unknown models
      this.encoder = get_encoding('cl100k_base');
    }

    let total = 0;
    for (const msg of messages) {
      total += 4; // per-message overhead
      for (const c of msg.content) {
        switch (c.type) {
          case ContentType.TEXT:
            total += this.encoder.encode((c as TextContent).text).length;
            break;
          case ContentType.TOOL_USE: {
            const tu = c as ToolUseContent;
            total += this.encoder.encode(JSON.stringify(tu.input)).length;
            total += this.encoder.encode(tu.name).length;
            total += this.encoder.encode(tu.id).length;
            break;
          }
          case ContentType.TOOL_RESULT: {
            const tr = c as ToolResultContent;
            const text = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
            total += this.encoder.encode(text).length;
            break;
          }
          default:
            break;
        }
      }
    }
    if (tools) {
      for (const tool of tools) {
        total += this.encoder.encode(JSON.stringify(tool.inputSchema)).length;
      }
    }

    return { inputTokens: total, outputTokens: 0, totalTokens: total };
  }

  async sendMessage(
    messages: Message[],
    tools: ToolDefinition[],
    options: ModelOptions
  ): Promise<ModelResponse> {
    const openaiMessages = this.convertMessages(messages, options.systemPrompt);
    const openaiTools = this.convertTools(tools);

    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.getModelId(),
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 4096,
      temperature: options.temperature ?? this.config.temperature ?? 0.7,
      top_p: options.topP ?? this.config.topP ?? 0.95,
      stop: options.stopSequences,
      reasoning_effort: this.isReasoningModel() ? options.reasoningEffort : undefined,
    };

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];
    if (!choice) {
      throw new Error('OpenAI returned no choices');
    }

    const content: MessageContent[] = [];
    if (choice.message.content) {
      content.push({ type: ContentType.TEXT, text: choice.message.content });
    }
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (tc.type !== 'function') continue;
        content.push({
          type: ContentType.TOOL_USE,
          id: tc.id,
          name: tc.function.name,
          input: this.parseArguments(tc.function.arguments),
        });
      }
    }

    return {
      content,
      usage: this.buildUsage(
        response.usage?.prompt_tokens ?? 0,
        response.usage?.completion_tokens ?? 0
      ),
      stopReason: this.mapStopReason(choice.finish_reason),
      modelId: response.model,
      provider: ModelProvider.OPENAI,
    };
  }

  async *streamMessage(
    messages: Message[],
    tools: ToolDefinition[],
    options: ModelOptions
  ): AsyncIterable<ModelStreamChunk> {
    const openaiMessages = this.convertMessages(messages, options.systemPrompt);
    const openaiTools = this.convertTools(tools);

    const params: ChatCompletionCreateParamsStreaming = {
      model: this.getModelId(),
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 4096,
      temperature: options.temperature ?? this.config.temperature ?? 0.7,
      top_p: options.topP ?? this.config.topP ?? 0.95,
      stop: options.stopSequences,
      reasoning_effort: this.isReasoningModel() ? options.reasoningEffort : undefined,
      stream: true,
    };

    const stream = await this.client.chat.completions.create(params);

    let currentToolId = '';
    let currentToolName = '';
    let argumentsBuffer = '';

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        yield { type: 'content', delta: choice.delta.content };
      }

      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.id) currentToolId = tc.id;
          if (tc.function?.name) currentToolName = tc.function.name;
          if (tc.function?.arguments) argumentsBuffer += tc.function.arguments;

          yield {
            type: 'tool_use',
            toolUse: {
              id: currentToolId,
              name: currentToolName,
              input: this.parseArguments(argumentsBuffer),
              partial: true,
            },
          };
        }
      }

      if (choice.finish_reason) {
        if (argumentsBuffer && currentToolId) {
          // Emit the final, fully-parsed tool call once more
          yield {
            type: 'tool_use',
            toolUse: {
              id: currentToolId,
              name: currentToolName,
              input: this.parseArguments(argumentsBuffer),
            },
          };
        }
        yield {
          type: 'complete',
          stopReason: this.mapStopReason(choice.finish_reason),
        };
      }
    }
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private isReasoningModel(): boolean {
    const modelId = this.getModelId();
    return modelId.includes('o1') || modelId.includes('o3');
  }

  private convertMessages(
    messages: Message[],
    systemPromptOverride?: string
  ): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];

    // System prompt: explicit override, else first SYSTEM message in history
    if (systemPromptOverride) {
      result.push({ role: 'system', content: systemPromptOverride });
    } else {
      const sysMsg = messages.find((m) => m.role === MessageRole.SYSTEM);
      if (sysMsg) {
        const text = sysMsg.content
          .filter((c): c is TextContent => c.type === ContentType.TEXT)
          .map((c) => c.text)
          .join('\n');
        if (text) result.push({ role: 'system', content: text });
      }
    }

    for (const msg of messages) {
      if (msg.role === MessageRole.SYSTEM) continue;

      if (msg.role === MessageRole.TOOL) {
        // TOOL-role messages become one OpenAI `tool` message per result block
        for (const c of msg.content) {
          if (c.type === ContentType.TOOL_RESULT) {
            const tr = c as ToolResultContent;
            const text = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
            result.push({
              role: 'tool',
              tool_call_id: tr.toolUseId,
              content: text,
            });
          }
        }
        continue;
      }

      if (msg.role === MessageRole.USER) {
        const text = msg.content
          .map((c) => {
            if (c.type === ContentType.TEXT) return (c as TextContent).text;
            if (c.type === ContentType.IMAGE) {
              const img = c as ImageContent;
              return `[image: ${img.source.mediaType}]`;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n');
        if (text) result.push({ role: 'user', content: text });
        continue;
      }

      // ASSISTANT: split into text + tool_calls
      const textParts: string[] = [];
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      for (const c of msg.content) {
        if (c.type === ContentType.TEXT) {
          textParts.push((c as TextContent).text);
        } else if (c.type === ContentType.TOOL_USE) {
          const tu = c as ToolUseContent;
          toolCalls.push({
            id: tu.id,
            type: 'function',
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          });
        }
      }
      if (textParts.length > 0 || toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: textParts.join('\n') || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        } as ChatCompletionMessageParam);
      }
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): ChatCompletionTool[] {
    return tools.map((tool) => {
      const schema = tool.inputSchema as Record<string, unknown>;
      return {
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties: (schema['properties'] as Record<string, unknown>) ?? {},
            required: schema['required'] as string[] | undefined,
          },
        },
      };
    });
  }

  private parseArguments(args: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(args);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private buildUsage(inputTokens: number, outputTokens: number): TokenUsage {
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + outputTokens,
      costUsd: CostEstimator.estimateCost(
        inputTokens,
        outputTokens,
        this.getModelId(),
        ModelProvider.OPENAI
      ).totalCost,
    };
  }

  private mapStopReason(reason: string | null): StopReason {
    switch (reason) {
      case 'stop':
        return StopReason.END_TURN;
      case 'length':
        return StopReason.MAX_TOKENS;
      case 'tool_calls':
        return StopReason.TOOL_USE;
      case 'content_filter':
        return StopReason.ERROR;
      default:
        return StopReason.END_TURN;
    }
  }
}