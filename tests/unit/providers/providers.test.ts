import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderFactory } from '../../../src/core/providers/ProviderFactory.js';
import { AnthropicProvider } from '../../../src/core/providers/AnthropicProvider.js';
import { OpenAIProvider } from '../../../src/core/providers/OpenAIProvider.js';
import { TokenCounter } from '../../../src/core/providers/TokenCounter.js';
import { CostEstimator } from '../../../src/core/providers/CostEstimator.js';
import {
  ModelConfig,
  ModelProvider,
  Message,
  MessageRole,
  ContentType,
  ToolDefinition,
  TokenUsage,
} from '../../../src/types/index.js';

const TEST_KEY = 'test-key-for-unit-tests';

function makeConfig(provider: ModelProvider, modelId: string): ModelConfig {
  return { provider, modelId, apiKey: TEST_KEY };
}

function makeMessages(): Message[] {
  return [
    {
      role: MessageRole.USER,
      content: [{ type: ContentType.TEXT, text: 'Hello, world!' }],
      timestamp: new Date(),
    },
    {
      role: MessageRole.ASSISTANT,
      content: [{ type: ContentType.TEXT, text: 'Hi there! How can I help?' }],
      timestamp: new Date(),
    },
  ];
}

const tools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    category: 'file_system' as never, // category unused by TokenCounter
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute: async () => ({ success: true }),
  },
];

describe('ProviderFactory', () => {
  beforeEach(() => {
    ProviderFactory.clearCache();
  });

  it('should create AnthropicProvider', async () => {
    const provider = await ProviderFactory.create(makeConfig(ModelProvider.ANTHROPIC, 'claude-3-5-sonnet-20241022'));
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.getProviderType()).toBe(ModelProvider.ANTHROPIC);
  });

  it('should create OpenAIProvider', async () => {
    const provider = await ProviderFactory.create(makeConfig(ModelProvider.OPENAI, 'gpt-4o'));
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.getProviderType()).toBe(ModelProvider.OPENAI);
  });

  it('should cache provider instances', async () => {
    const config = makeConfig(ModelProvider.ANTHROPIC, 'claude-3-5-sonnet-20241022');
    const provider1 = await ProviderFactory.create(config);
    const provider2 = await ProviderFactory.create(config);
    expect(provider1).toBe(provider2);
  });

  it('should throw for unknown provider', async () => {
    const config = makeConfig('unknown' as ModelProvider, 'test-model');
    await expect(ProviderFactory.create(config)).rejects.toThrow('Unknown provider');
  });

  it('should reject a config with no API key', async () => {
    const previous = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const config: ModelConfig = {
        provider: ModelProvider.ANTHROPIC,
        modelId: 'claude-3-5-sonnet-20241022',
      };
      await expect(ProviderFactory.create(config)).rejects.toThrow('ANTHROPIC_API_KEY is required');
    } finally {
      if (previous !== undefined) process.env['ANTHROPIC_API_KEY'] = previous;
    }
  });

  it('should get capabilities', async () => {
    const capabilities = await ProviderFactory.getCapabilities(
      makeConfig(ModelProvider.ANTHROPIC, 'claude-3-5-sonnet-20241022')
    );
    expect(capabilities.supportsStreaming).toBe(true);
    expect(capabilities.supportsTools).toBe(true);
    expect(capabilities.maxContextTokens).toBe(200000);
    expect(capabilities.supportedModels).toContain('claude-3-5-sonnet-20241022');
  });

  it('should return registered providers', () => {
    const providers = ProviderFactory.getRegisteredProviders();
    expect(providers).toContain(ModelProvider.ANTHROPIC);
    expect(providers).toContain(ModelProvider.OPENAI);
  });
});

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider(makeConfig(ModelProvider.ANTHROPIC, 'claude-3-5-sonnet-20241022'));
  });

  it('should validate config', async () => {
    const result = await provider.validateConfig();
    expect(result.valid).toBe(true);
  });

  it('should report capabilities', () => {
    const caps = provider.getCapabilities();
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsTools).toBe(true);
    expect(caps.maxOutputTokens).toBe(8192);
    expect(caps.maxContextTokens).toBe(200000);
  });

  it('should get model ID', () => {
    expect(provider.getModelId()).toBe('claude-3-5-sonnet-20241022');
  });

  it('should get provider type', () => {
    expect(provider.getProviderType()).toBe(ModelProvider.ANTHROPIC);
  });

  it('should estimate tokens without network', async () => {
    const result = await provider.countTokens(makeMessages());
    expect(result.totalTokens).toBeGreaterThan(0);
  });
});

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider(makeConfig(ModelProvider.OPENAI, 'gpt-4o'));
  });

  it('should validate config', async () => {
    const result = await provider.validateConfig();
    expect(result.valid).toBe(true);
  });

  it('should report capabilities', () => {
    const caps = provider.getCapabilities();
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsTools).toBe(true);
    expect(caps.maxOutputTokens).toBe(16384);
    expect(caps.maxContextTokens).toBe(128000);
  });

  it('should get model ID', () => {
    expect(provider.getModelId()).toBe('gpt-4o');
  });

  it('should get provider type', () => {
    expect(provider.getProviderType()).toBe(ModelProvider.OPENAI);
  });

  it('should count tokens with tiktoken', async () => {
    const result = await provider.countTokens(makeMessages(), tools);
    expect(result.totalTokens).toBeGreaterThan(0);
  });
});

describe('TokenCounter', () => {
  const messages = makeMessages();

  it('should count tokens for messages', () => {
    const result = TokenCounter.countTokens(messages, tools, 'System prompt', 'gpt-4o');
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.breakdown.messages).toBeGreaterThan(0);
    expect(result.breakdown.tools).toBeGreaterThan(0);
    expect(result.breakdown.system).toBeGreaterThan(0);
  });

  it('should count tokens for Claude models', () => {
    const result = TokenCounter.countTokens(messages, tools, 'System prompt', 'claude-3-5-sonnet-20241022');
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.encoding).toBe('cl100k_base');
  });

  it('should count text tokens', () => {
    const tokens = TokenCounter.countTextTokens('Hello world', 'gpt-4o');
    expect(tokens).toBeGreaterThan(0);
  });

  it('should count single message tokens', () => {
    const message = messages[0];
    if (!message) throw new Error('missing test message');
    const tokens = TokenCounter.countMessageTokens(message, 'gpt-4o');
    expect(tokens).toBeGreaterThan(0);
  });

  it('should estimate tokens without tiktoken', () => {
    const result = TokenCounter.estimateTokens(messages, tools, 'System prompt');
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.encoding).toBe('character-estimation');
  });

  it('should get max tokens for model', () => {
    expect(TokenCounter.getMaxTokensForModel('gpt-4o')).toBe(128000);
    expect(TokenCounter.getMaxTokensForModel('claude-3-5-sonnet-20241022')).toBe(200000);
    expect(TokenCounter.getMaxTokensForModel('o1-preview')).toBe(200000);
  });

  afterEach(() => {
    TokenCounter.clearCache();
  });
});

describe('CostEstimator', () => {
  const usage: TokenUsage = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    totalTokens: 1650,
  };

  it('should calculate cost for Anthropic model', () => {
    const breakdown = CostEstimator.calculateCost(usage, 'claude-3-5-sonnet-20241022', ModelProvider.ANTHROPIC);
    expect(breakdown.totalCost).toBeGreaterThan(0);
    expect(breakdown.inputCost).toBeGreaterThan(0);
    expect(breakdown.outputCost).toBeGreaterThan(0);
    expect(breakdown.provider).toBe(ModelProvider.ANTHROPIC);
  });

  it('should calculate cost for OpenAI model', () => {
    const breakdown = CostEstimator.calculateCost(usage, 'gpt-4o', ModelProvider.OPENAI);
    expect(breakdown.totalCost).toBeGreaterThan(0);
    expect(breakdown.provider).toBe(ModelProvider.OPENAI);
  });

  it('should estimate cost', () => {
    const breakdown = CostEstimator.estimateCost(1000, 500, 'gpt-4o', ModelProvider.OPENAI);
    expect(breakdown.totalCost).toBeGreaterThan(0);
  });

  it('should check budget', () => {
    const status = CostEstimator.checkBudget(5.0, 10.0);
    expect(status.used).toBe(5.0);
    expect(status.limit).toBe(10.0);
    expect(status.remaining).toBe(5.0);
    expect(status.percentage).toBe(50);
    expect(status.warning).toBe(false);
    expect(status.critical).toBe(false);
  });

  it('should show warning at 75%', () => {
    const status = CostEstimator.checkBudget(8.0, 10.0);
    expect(status.warning).toBe(true);
    expect(status.critical).toBe(false);
  });

  it('should show critical at 95%', () => {
    const status = CostEstimator.checkBudget(9.6, 10.0);
    expect(status.warning).toBe(true);
    expect(status.critical).toBe(true);
  });

  it('should format cost', () => {
    expect(CostEstimator.formatCost(0.00005)).toBe('$0.000050');
    expect(CostEstimator.formatCost(0.005)).toBe('$0.0050');
    expect(CostEstimator.formatCost(1.5)).toBe('$1.50');
  });

  it('should format cost breakdown', () => {
    const breakdown = CostEstimator.calculateCost(usage, 'gpt-4o', ModelProvider.OPENAI);
    const formatted = CostEstimator.formatCostBreakdown(breakdown);
    expect(formatted).toContain('gpt-4o');
    expect(formatted).toContain('Input:');
    expect(formatted).toContain('Output:');
    expect(formatted).toContain('Total:');
  });

  it('should get pricing for model', () => {
    const pricing = CostEstimator.getPricing('gpt-4o');
    expect(pricing.input).toBe(2.5);
    expect(pricing.output).toBe(10.0);
  });

  it('should return default pricing for unknown model', () => {
    const pricing = CostEstimator.getPricing('unknown-model');
    expect(pricing.input).toBe(2.5);
    expect(pricing.output).toBe(10.0);
  });
});