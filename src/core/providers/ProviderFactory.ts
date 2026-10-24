import { Provider } from './Provider.js';
import { AnthropicProvider } from './AnthropicProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { GoogleProvider } from './GoogleProvider.js';
import {
  ModelConfig,
  ModelProvider,
  ProviderCapabilities,
  ValidationResult,
} from '../../types/index.js';

export type ProviderClass = new (config: ModelConfig) => Provider;

export class ProviderFactory {
  private static providers = new Map<ModelProvider, ProviderClass>([
    [ModelProvider.ANTHROPIC, AnthropicProvider],
    [ModelProvider.OPENAI, OpenAIProvider],
    [ModelProvider.GOOGLE, GoogleProvider],
  ]);

  private static instances = new Map<string, Provider>();

  static register(provider: ModelProvider, providerClass: ProviderClass): void {
    this.providers.set(provider, providerClass);
  }

  static async create(config: ModelConfig): Promise<Provider> {
    const cacheKey = `${config.provider}:${config.modelId}:${config.apiKey?.slice(0, 8) || 'env'}:${config.baseUrl || 'default'}`;

    if (this.instances.has(cacheKey)) {
      return this.instances.get(cacheKey)!;
    }

    const ProviderClass = this.providers.get(config.provider);
    if (!ProviderClass) {
      throw new Error(`Unknown provider: ${config.provider}`);
    }

    const provider = new ProviderClass(config);

    const validation = await provider.validateConfig();
    if (!validation.valid) {
      throw new Error(`Invalid configuration for provider: ${config.provider}: ${validation.errors.join(', ')}`);
    }

    this.instances.set(cacheKey, provider);
    return provider;
  }

  static async createAndValidate(config: ModelConfig): Promise<Provider> {
    const provider = await this.create(config);
    return provider;
  }

  static async createWithFallback(config: ModelConfig): Promise<Provider> {
    try {
      return this.create(config);
    } catch (primaryError) {
      if (config.fallbackModel) {
        console.warn(`Primary provider failed, trying fallback: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);
        return this.create(config.fallbackModel);
      }
      throw primaryError;
    }
  }

  static async getCapabilities(config: ModelConfig): Promise<ProviderCapabilities> {
    const provider = await this.create(config);
    return provider.getCapabilities();
  }

  static clearCache(): void {
    this.instances.clear();
  }

  static getRegisteredProviders(): ModelProvider[] {
    return Array.from(this.providers.keys());
  }

  static isProviderRegistered(provider: ModelProvider): boolean {
    return this.providers.has(provider);
  }
}