import {
  GoogleGenerativeAI,
  FunctionCallingMode,
  SchemaType,
  type Content,
  type GenerateContentResult,
  type Tool,
  type FunctionDeclaration,
  type FunctionDeclarationSchema,
  type FunctionDeclarationSchemaProperty,
} from '@google/generative-ai';
import {
  ModelProvider,
  ContentType,
  StopReason,
  MessageRole,
  type ModelConfig,
  type Message,
  type ToolDefinition,
  type ModelOptions,
  type ModelResponse,
  type ModelStreamChunk,
  type ProviderCapabilities,
  type TokenUsage,
  type TokenCountResult,
  type ValidationResult,
  type TextContent,
  type ToolUseContent,
  type ToolResultContent,
  type MessageContent,
} from '../../types/index.js';
import { randomUUID } from 'node:crypto';
import { Provider } from './Provider.js';
import { CostEstimator } from './CostEstimator.js';

/**
 * GoogleProvider — Google Gemini provider using @google/generative-ai.
 *
 * Ground-truth SDK notes (verified against generative-ai.d.ts):
 * - Content = { role: string; parts: Part[] }.
 * - FunctionCall has NO `id` (name + args only) → we synthesize one with randomUUID.
 * - FinishReason enum: STOP, MAX_TOKENS, SAFETY, RECITATION, LANGUAGE, BLOCKLIST,
 *   PROHIBITED_CONTENT, SPII, MALFORMED_FUNCTION_CALL, OTHER.
 * - usageMetadata: promptTokenCount, candidatesTokenCount, totalTokenCount.
 * - countTokens({ contents: Content[] }) → { totalTokens }.
 * - toolConfig.functionCallingConfig.mode needs the FunctionCallingMode enum.
 * - FunctionDeclarationSchema: { type: SchemaType, properties, required? }.
 */
export class GoogleProvider extends Provider {
  private client: GoogleGenerativeAI;
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>;

  constructor(config: ModelConfig) {
    super(config);
    const apiKey = config.apiKey ?? process.env['GOOGLE_API_KEY'] ?? process.env['GEMINI_API_KEY'];
    this.client = new GoogleGenerativeAI(apiKey ?? '');
    this.model = this.client.getGenerativeModel({
      model: this.getModelId(),
      generationConfig: {
        temperature: this.config.temperature ?? 0.7,
      },
    });
  }

  async validateConfig(): Promise<ValidationResult> {
    const apiKey = this.config.apiKey ?? process.env['GOOGLE_API_KEY'] ?? process.env['GEMINI_API_KEY'];
    return {
      valid: Boolean(apiKey),
      errors: apiKey ? [] : ['GOOGLE_API_KEY or GEMINI_API_KEY is required'],
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      supportsTools: true,
      supportsThinking: false,
      supportsImages: true,
      supportsSystemPrompt: true,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 8192,
      supportedModels: [
        'gemini-1.5-pro',
        'gemini-1.5-flash',
        'gemini-1.5-pro-latest',
        'gemini-1.5-flash-latest',
        'gemini-2.0-flash-exp',
        'gemini-2.0-pro-exp',
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Message conversion
  // ---------------------------------------------------------------------------

  /** Convert agent Messages to Google SDK Content[] (dropping system messages). */
  private convertMessages(messages: Message[]): Content[] {
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === MessageRole.SYSTEM) continue;

      if (msg.role === MessageRole.TOOL) {
        for (const c of msg.content) {
          if (c.type === ContentType.TOOL_RESULT) {
            const tr = c as ToolResultContent;
            contents.push({
              role: 'function',
              parts: [{ functionResponse: { name: tr.toolUseId, response: { content: tr.content } } }],
            });
          }
        }
        continue;
      }

      const parts: Array<{ text: string } | { functionCall: { name: string; args: Record<string, unknown> } }> = [];
      for (const c of msg.content) {
        if (c.type === ContentType.TEXT) {
          parts.push({ text: (c as TextContent).text });
        } else if (c.type === ContentType.TOOL_USE) {
          const tu = c as ToolUseContent;
          parts.push({ functionCall: { name: tu.name, args: tu.input } });
        }
      }
      if (parts.length > 0) {
        contents.push({
          role: msg.role === MessageRole.USER ? 'user' : 'model',
          parts,
        });
      }
    }

    return contents;
  }

  /** Extract system prompt from message list. */
  private extractSystemPrompt(messages: Message[]): string | undefined {
    const sysMsg = messages.find((m) => m.role === MessageRole.SYSTEM);
    if (!sysMsg) return undefined;
    return this.textContentToString(sysMsg);
  }

  /** Last user text, or ' ' if none (Gemini rejects empty strings). */
  private lastUserText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === MessageRole.USER) {
        const text = this.textContentToString(msg);
        if (text.trim()) return text;
      }
    }
    return ' ';
  }

  /** Render a message's text content into a single string. */
  private textContentToString(msg: Message): string {
    return msg.content
      .filter((c): c is TextContent => c.type === ContentType.TEXT)
      .map((c) => c.text)
      .join('\n');
  }

  // ---------------------------------------------------------------------------
  // Tool conversion
  // ---------------------------------------------------------------------------

  /** Convert agent ToolDefinitions to Google SDK Tool[] format. */
  private convertTools(tools: ToolDefinition[]): Tool[] {
    const declarations: FunctionDeclaration[] = tools.map((tool) => {
      const rawSchema = tool.inputSchema;
      const schema =
        rawSchema instanceof Object && !(rawSchema instanceof Function)
          ? (rawSchema as Record<string, unknown>)
          : {};
      return {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: SchemaType.OBJECT,
          properties: (schema['properties'] as Record<string, FunctionDeclarationSchemaProperty>) ?? {},
          required: (schema['required'] as string[] | undefined) ?? undefined,
        } as FunctionDeclarationSchema,
      };
    });

    // One Tool per declaration — matches the SDK's FunctionDeclarationsTool shape
    // (functionDeclarations is an array but the SDK accepts single-element arrays).
    return declarations.map((decl) => ({ functionDeclarations: [decl] }));
  }

  // ---------------------------------------------------------------------------
  // Core API
  // ---------------------------------------------------------------------------

  async countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<TokenCountResult> {
    try {
      const model = this.client.getGenerativeModel({ model: this.getModelId() });
      const contents = this.convertMessages(messages);
      const result = await model.countTokens({ contents });
      return {
        inputTokens: result.totalTokens,
        outputTokens: 0,
        totalTokens: result.totalTokens,
      };
    } catch {
      // Fallback: chars/4 estimate when the API is unreachable.
      let total = 0;
      for (const msg of messages) {
        for (const c of msg.content) {
          if (c.type === ContentType.TEXT) {
            total += (c as TextContent).text.length / 4;
          }
        }
      }
      if (tools) {
        for (const tool of tools) {
          total += JSON.stringify(tool.inputSchema).length / 4;
        }
      }
      return { inputTokens: Math.ceil(total), outputTokens: 0, totalTokens: Math.ceil(total) };
    }
  }

  private buildModelParams(tools: ToolDefinition[], options: ModelOptions, messages: Message[]) {
    return {
      model: this.getModelId(),
      generationConfig: {
        temperature: options.temperature ?? this.config.temperature ?? 0.7,
        topP: options.topP ?? this.config.topP ?? 0.95,
        maxOutputTokens: options.maxTokens ?? this.config.maxTokens ?? 8192,
        stopSequences: options.stopSequences,
      },
      tools: tools.length > 0 ? this.convertTools(tools) : undefined,
      toolConfig: tools.length > 0
        ? { functionCallingConfig: { mode: FunctionCallingMode.AUTO } }
        : undefined,
      systemInstruction: options.systemPrompt ?? this.extractSystemPrompt(messages),
    };
  }

  async sendMessage(
    messages: Message[],
    tools: ToolDefinition[],
    options: ModelOptions
  ): Promise<ModelResponse> {
    const model = this.client.getGenerativeModel(this.buildModelParams(tools, options, messages));
    const chat = model.startChat({ history: this.convertMessages(messages) });
    const lastUserMsg = this.lastUserText(messages);
    const result = await chat.sendMessage(lastUserMsg);
    return this.parseResponse(result);
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  async *streamMessage(
    messages: Message[],
    tools: ToolDefinition[],
    options: ModelOptions
  ): AsyncIterable<ModelStreamChunk> {
    const model = this.client.getGenerativeModel(this.buildModelParams(tools, options, messages));
    const chat = model.startChat({ history: this.convertMessages(messages) });
    const lastUserMsg = this.lastUserText(messages);
    const result = await chat.sendMessageStream(lastUserMsg);

    for await (const chunk of result.stream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;

      if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            yield { type: 'content', delta: part.text };
          }
          if (part.functionCall) {
            yield {
              type: 'tool_use',
              toolUse: {
                id: randomUUID(),
                name: part.functionCall.name,
                input: (part.functionCall.args as Record<string, unknown>) ?? {},
                partial: false,
              },
            };
          }
        }
      }

      if (candidate.finishReason) {
        yield {
          type: 'complete',
          stopReason: this.mapStopReason(candidate.finishReason),
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  private parseResponse(result: GenerateContentResult): ModelResponse {
    const response = result.response;
    const candidate = response.candidates?.[0];
    if (!candidate) throw new Error('No candidates in Google response');

    const content: MessageContent[] = [];
    if (candidate.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          content.push({ type: ContentType.TEXT, text: part.text });
        }
        if (part.functionCall) {
          content.push({
            type: ContentType.TOOL_USE,
            id: randomUUID(),
            name: part.functionCall.name,
            input: (part.functionCall.args as Record<string, unknown>) ?? {},
          } as ToolUseContent);
        }
      }
    }

    const usage = response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;

    return {
      content,
      usage: this.buildUsage(inputTokens, outputTokens),
      stopReason: candidate.finishReason
        ? this.mapStopReason(candidate.finishReason)
        : StopReason.END_TURN,
      modelId: this.getModelId(),
      provider: ModelProvider.GOOGLE,
    };
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
        ModelProvider.GOOGLE
      ).totalCost,
    };
  }

  private mapStopReason(reason: string): StopReason {
    switch (reason) {
      case 'STOP':
        return StopReason.END_TURN;
      case 'MAX_TOKENS':
        return StopReason.MAX_TOKENS;
      case 'SAFETY':
      case 'RECITATION':
      case 'LANGUAGE':
      case 'BLOCKLIST':
      case 'PROHIBITED_CONTENT':
      case 'SPII':
      case 'MALFORMED_FUNCTION_CALL':
        return StopReason.ERROR;
      case 'OTHER':
        return StopReason.END_TURN;
      default:
        return StopReason.END_TURN;
    }
  }
}

export default GoogleProvider;
