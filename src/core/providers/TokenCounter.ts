import { Tiktoken, get_encoding, encoding_for_model } from 'tiktoken';
import type { TiktokenEncoding } from 'tiktoken';
import {
  Message,
  ToolDefinition,
  ContentType,
  TextContent,
  ImageContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
} from '../../types/index.js';

export interface TokenCountResult {
  totalTokens: number;
  breakdown: {
    messages: number;
    tools: number;
    system: number;
    overhead: number;
  };
  model: string;
  encoding: string;
}

export class TokenCounter {
  private static encodings = new Map<string, Tiktoken>();
  private static defaultEncoding: TiktokenEncoding = 'cl100k_base';

  private static getEncoding(modelId: string): Tiktoken {
    const encodingName = this.getEncodingName(modelId);

    const cached = this.encodings.get(encodingName);
    if (cached) return cached;

    let encoding: Tiktoken;
    try {
      // encoding_for_model accepts known OpenAI model names only
      encoding = encoding_for_model(modelId as Parameters<typeof encoding_for_model>[0]);
    } catch {
      encoding = get_encoding(encodingName);
    }

    this.encodings.set(encodingName, encoding);
    return encoding;
  }

  static countTokens(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    modelId: string = 'gpt-4o'
  ): TokenCountResult {
    const encoding = this.getEncoding(modelId);

    let messageTokens = 0;
    let systemTokens = 0;
    let toolTokens = 0;

    for (const message of messages) {
      messageTokens += 4; // per-message overhead

      for (const content of message.content) {
        messageTokens += this.countContentTokens(content, encoding);
      }
    }

    if (systemPrompt) {
      systemTokens = encoding.encode(systemPrompt).length;
    }

    if (tools) {
      for (const tool of tools) {
        toolTokens += encoding.encode(tool.name).length;
        toolTokens += encoding.encode(tool.description).length;
        toolTokens += encoding.encode(JSON.stringify(tool.inputSchema)).length;
      }
    }

    const overhead = 2; // reply-primer overhead
    const totalTokens = messageTokens + systemTokens + toolTokens + overhead;

    return {
      totalTokens,
      breakdown: {
        messages: messageTokens,
        tools: toolTokens,
        system: systemTokens,
        overhead,
      },
      model: modelId,
      encoding: this.getEncodingName(modelId),
    };
  }

  static countTextTokens(text: string, modelId: string = 'gpt-4o'): number {
    const encoding = this.getEncoding(modelId);
    return encoding.encode(text).length;
  }

  static countMessageTokens(message: Message, modelId: string = 'gpt-4o'): number {
    const encoding = this.getEncoding(modelId);
    let tokens = 4;
    for (const content of message.content) {
      tokens += this.countContentTokens(content, encoding);
    }
    return tokens;
  }

  /**
   * Fast, dependency-free estimation (~4 chars per token). Used when the
   * tiktoken WASM bundle should not be loaded, and for Anthropic models
   * which have no public tokenizer.
   */
  static estimateTokens(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string
  ): TokenCountResult {
    let messageTokens = 0;
    let systemTokens = 0;
    let toolTokens = 0;

    for (const message of messages) {
      messageTokens += 4;

      for (const content of message.content) {
        switch (content.type) {
          case ContentType.TEXT:
            messageTokens += Math.ceil((content as TextContent).text.length / 4);
            break;
          case ContentType.IMAGE:
            messageTokens += 85;
            break;
          case ContentType.TOOL_USE: {
            const tu = content as ToolUseContent;
            messageTokens += Math.ceil(JSON.stringify(tu.input).length / 4);
            messageTokens += Math.ceil(tu.name.length / 4);
            messageTokens += Math.ceil(tu.id.length / 4);
            break;
          }
          case ContentType.TOOL_RESULT: {
            const tr = content as ToolResultContent;
            const text = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
            messageTokens += Math.ceil(text.length / 4);
            messageTokens += Math.ceil(tr.toolUseId.length / 4);
            break;
          }
          case ContentType.THINKING: {
            const th = content as ThinkingContent;
            messageTokens += Math.ceil(th.thinking.length / 4);
            if (th.signature) messageTokens += Math.ceil(th.signature.length / 4);
            break;
          }
        }
      }
    }

    if (systemPrompt) {
      systemTokens = Math.ceil(systemPrompt.length / 4);
    }

    if (tools) {
      for (const tool of tools) {
        toolTokens += Math.ceil(tool.name.length / 4);
        toolTokens += Math.ceil(tool.description.length / 4);
        toolTokens += Math.ceil(JSON.stringify(tool.inputSchema).length / 4);
      }
    }

    const overhead = 2;

    return {
      totalTokens: messageTokens + systemTokens + toolTokens + overhead,
      breakdown: {
        messages: messageTokens,
        tools: toolTokens,
        system: systemTokens,
        overhead,
      },
      model: 'estimated',
      encoding: 'character-estimation',
    };
  }

  private static countContentTokens(content: Message['content'][number], encoding: Tiktoken): number {
    switch (content.type) {
      case ContentType.TEXT:
        return encoding.encode((content as TextContent).text).length;
      case ContentType.IMAGE:
        return this.countImageTokens(content as ImageContent);
      case ContentType.TOOL_USE: {
        const tu = content as ToolUseContent;
        return (
          encoding.encode(JSON.stringify(tu.input)).length +
          encoding.encode(tu.name).length +
          encoding.encode(tu.id).length
        );
      }
      case ContentType.TOOL_RESULT: {
        const tr = content as ToolResultContent;
        const text = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
        return encoding.encode(text).length + encoding.encode(tr.toolUseId).length;
      }
      case ContentType.THINKING: {
        const th = content as ThinkingContent;
        let tokens = encoding.encode(th.thinking).length;
        if (th.signature) tokens += encoding.encode(th.signature).length;
        return tokens;
      }
      default:
        return 0;
    }
  }

  private static countImageTokens(content: ImageContent): number {
    if (content.source.type === 'base64' && content.source.data) {
      const bytes = Math.ceil(content.source.data.length * 0.75);
      const megapixels = bytes / (1024 * 1024);
      if (megapixels <= 0.25) return 85;
      if (megapixels <= 1) return 170;
      if (megapixels <= 4) return 340;
      if (megapixels <= 16) return 680;
      return 1360;
    }
    return 85;
  }

  static getEncodingName(modelId: string): TiktokenEncoding {
    if (modelId.includes('gpt-4o') || modelId.includes('o1') || modelId.includes('o3')) {
      return 'o200k_base';
    }
    if (modelId.includes('gpt-4') || modelId.includes('gpt-3.5')) {
      return 'cl100k_base';
    }
    // Claude and unknown models: cl100k_base is the closest public approximation
    return this.defaultEncoding;
  }

  static clearCache(): void {
    for (const encoding of this.encodings.values()) {
      encoding.free();
    }
    this.encodings.clear();
  }

  static getMaxTokensForModel(modelId: string): number {
    if (modelId.includes('o1')) return 200000;
    if (modelId.includes('gpt-4o')) return 128000;
    if (modelId.includes('gpt-4')) return 128000;
    if (modelId.includes('gpt-3.5')) return 16384;
    if (modelId.includes('claude')) return 200000;
    return 128000;
  }
}