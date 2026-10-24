import {
  TokenUsage,
  ModelProvider,
  PricingTier,
  ModelPricing,
  CostBreakdown,
  BudgetStatus,
} from '../../types/index.js';

export class CostEstimator {
  private static pricing: ModelPricing = {
    // Anthropic models (per million tokens)
    'claude-opus-4-20250514': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
    'claude-sonnet-4-20250514': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
    'claude-3-opus-20240229': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
    'claude-3-sonnet-20240229': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    'claude-3-haiku-20240307': { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 },

    // OpenAI models (per million tokens)
    'gpt-4o': { input: 2.50, output: 10.00, cacheRead: 1.25 },
    'gpt-4o-mini': { input: 0.15, output: 0.60, cacheRead: 0.075 },
    'gpt-4-turbo': { input: 10.00, output: 30.00 },
    'gpt-4': { input: 30.00, output: 60.00 },
    'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
    'o1-preview': { input: 15.00, output: 60.00 },
    'o1-mini': { input: 3.00, output: 12.00 },
  };

  private static defaultPricing: PricingTier = { input: 2.50, output: 10.00 };

  static calculateCost(
    usage: TokenUsage,
    modelId: string,
    provider: ModelProvider
  ): CostBreakdown {
    const pricing = this.getPricing(modelId);

    const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
    const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
    const cacheReadCost = ((usage.cacheReadTokens || 0) / 1_000_000) * (pricing.cacheRead || pricing.input * 0.5);
    const cacheWriteCost = ((usage.cacheWriteTokens || 0) / 1_000_000) * (pricing.cacheWrite || pricing.input * 1.25);

    return {
      inputCost: Math.round(inputCost * 10000) / 10000,
      outputCost: Math.round(outputCost * 10000) / 10000,
      cacheReadCost: Math.round(cacheReadCost * 10000) / 10000,
      cacheWriteCost: Math.round(cacheWriteCost * 10000) / 10000,
      totalCost: Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 10000) / 10000,
      currency: 'USD',
      model: modelId,
      provider,
    };
  }

  static estimateCost(
    estimatedInputTokens: number,
    estimatedOutputTokens: number,
    modelId: string,
    provider: ModelProvider,
    estimatedCacheReadTokens: number = 0,
    estimatedCacheWriteTokens: number = 0
  ): CostBreakdown {
    const usage: TokenUsage = {
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      cacheReadTokens: estimatedCacheReadTokens,
      cacheWriteTokens: estimatedCacheWriteTokens,
      totalTokens: estimatedInputTokens + estimatedOutputTokens + estimatedCacheReadTokens + estimatedCacheWriteTokens,
    };

    return this.calculateCost(usage, modelId, provider);
  }

  static getPricing(modelId: string): PricingTier {
    const normalizedId = modelId.toLowerCase();

    for (const [key, pricing] of Object.entries(this.pricing)) {
      if (normalizedId.includes(key.toLowerCase()) || key.toLowerCase().includes(normalizedId)) {
        return pricing;
      }
    }

    if (normalizedId.includes('opus')) {
      return this.pricing['claude-opus-4-20250514'] ?? this.defaultPricing;
    }
    if (normalizedId.includes('sonnet')) {
      return this.pricing['claude-sonnet-4-20250514'] ?? this.defaultPricing;
    }
    if (normalizedId.includes('haiku')) {
      return this.pricing['claude-3-5-haiku-20241022'] ?? this.defaultPricing;
    }
    if (normalizedId.includes('gpt-4o-mini')) {
      return this.pricing['gpt-4o-mini'] ?? this.defaultPricing;
    }
    if (normalizedId.includes('gpt-4o')) {
      return this.pricing['gpt-4o'] ?? this.defaultPricing;
    }
    if (normalizedId.includes('gpt-4')) {
      return this.pricing['gpt-4-turbo'] ?? this.defaultPricing;
    }
    if (normalizedId.includes('gpt-3.5')) {
      return this.pricing['gpt-3.5-turbo'] ?? this.defaultPricing;
    }
    if (normalizedId.includes('o1')) {
      return this.pricing['o1-preview'] ?? this.defaultPricing;
    }

    return this.defaultPricing;
  }

  static checkBudget(
    currentSpend: number,
    budgetLimit: number
  ): BudgetStatus {
    const remaining = Math.max(0, budgetLimit - currentSpend);
    const percentage = budgetLimit > 0 ? (currentSpend / budgetLimit) * 100 : 0;

    return {
      used: currentSpend,
      limit: budgetLimit,
      remaining,
      percentage: Math.round(percentage * 100) / 100,
      warning: percentage >= 75,
      critical: percentage >= 95,
    };
  }

  static formatCost(cost: number, currency: 'USD' = 'USD'): string {
    if (cost < 0.0001) return `$${cost.toFixed(6)}`;
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  }

  static formatCostBreakdown(breakdown: CostBreakdown): string {
    const lines = [
      `Model: ${breakdown.model} (${breakdown.provider})`,
      `Input:  ${this.formatCost(breakdown.inputCost)} (${breakdown.inputCost.toFixed(6)} per 1M)`,
      `Output: ${this.formatCost(breakdown.outputCost)} (${breakdown.outputCost.toFixed(6)} per 1M)`,
    ];

    if (breakdown.cacheReadCost > 0) {
      lines.push(`Cache Read:  ${this.formatCost(breakdown.cacheReadCost)}`);
    }
    if (breakdown.cacheWriteCost > 0) {
      lines.push(`Cache Write: ${this.formatCost(breakdown.cacheWriteCost)}`);
    }

    lines.push(`Total: ${this.formatCost(breakdown.totalCost)}`);

    return lines.join('\n');
  }

  static updatePricing(modelId: string, pricing: PricingTier): void {
    this.pricing[modelId] = pricing;
  }

  static getAllPricing(): ModelPricing {
    return { ...this.pricing };
  }

  static getPricingForModel(modelId: string): PricingTier | undefined {
    return this.pricing[modelId];
  }
}