import type {
  ModelConfig,
  ModelProvider,
  Message,
  ToolDefinition,
  ModelOptions,
  ModelStreamChunk,
  ModelResponse,
  ProviderCapabilities,
  TokenUsage,
  TokenCountResult,
  ValidationResult,
} from '../../types/index.js';

export abstract class Provider {
  protected config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
  }

  abstract sendMessage(messages: Message[], tools: ToolDefinition[], options: ModelOptions): Promise<ModelResponse>;

  abstract streamMessage(messages: Message[], tools: ToolDefinition[], options: ModelOptions): AsyncIterable<ModelStreamChunk>;

  abstract validateConfig(): Promise<ValidationResult>;

  abstract getCapabilities(): ProviderCapabilities;

  abstract countTokens(messages: Message[], tools?: ToolDefinition[]): Promise<TokenCountResult>;

  getConfig(): ModelConfig {
    return this.config;
  }

  getProviderType(): ModelProvider {
    return this.config.provider;
  }

  getModelId(): string {
    return typeof this.config.modelId === 'string' ? this.config.modelId : String(this.config.modelId);
  }

  protected buildTokenUsage(
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens?: number,
    cacheWriteTokens?: number
  ): TokenUsage {
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheReadTokens ?? 0,
      cacheWriteTokens: cacheWriteTokens ?? 0,
      totalTokens: inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
    };
  }

  protected handleError(error: unknown, operation: string): never {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${this.config.provider} ${operation} failed: ${message}`);
  }

  protected isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      const record = error as unknown as Record<string, unknown>;
      const status = record['status'];
      if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
        return true;
      }
      const code = record['code'];
      if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
        return true;
      }
    }
    return false;
  }
}