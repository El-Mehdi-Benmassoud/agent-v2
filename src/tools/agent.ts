import { randomUUID } from 'crypto';
import type { ToolDefinition, ToolResult, ToolContext } from '../types/index.js';
import { ToolCategory } from '../types/index.js';
import { asRecord, errorMessage, requireString } from './shared.js';
import { SubAgentFactory } from '../core/agents/index.js';
import { AgentRegistry } from '../core/agents/index.js';
import type { ModelConfig, ModelProvider, ModelId } from '../types/index.js';

/** The Agent tool — spawns a real sub-agent with its own session. */

export function makeAgentTool(
  agentRegistry: AgentRegistry,
  parentTools: string[],
  defaultModelConfig: { provider: ModelProvider; modelId: ModelId; apiKey: string }
): ToolDefinition {
  let subAgentFactory: SubAgentFactory | null = null;

  function getFactory(): SubAgentFactory {
    if (!subAgentFactory) {
      const { toolRegistry } = require('../index.js');
      subAgentFactory = new SubAgentFactory(
        toolRegistry.getAll(),
        {
          provider: defaultModelConfig.provider,
          modelId: defaultModelConfig.modelId,
          apiKey: defaultModelConfig.apiKey,
          maxTokens: 8192,
          temperature: 0.7,
          topP: 0.95,
          reasoningEffort: 'medium',
          maxTurns: 50,
          maxBudgetUsd: 10,
        },
        { skillRegistry: null, hooks: null, hookRunner: null }
      );
    }
    return subAgentFactory!;
  }

  return {
    name: 'task',
    description: 'Launch a new sub-agent to handle a focused task. Sub-agents have their own session, context, and tool set. Use this for parallel work, isolated experiments, or complex sub-tasks.',
    category: ToolCategory.TASK,
    requiresApproval: false,
    dangerous: false,
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: "A short description of the task (used as the sub-agent's taskId and routing hint)" },
        prompt: { type: 'string', description: 'The full task prompt/instructions for the sub-agent' },
        agent: { type: 'string', description: 'Optional agent type to use (default: general-purpose). Built-in: general-purpose, explore, plan, verification' },
      },
      required: ['description'],
    },
    async execute(input, context) {
      const rec = input as Record<string, unknown>;
      const description = requireString(rec, 'description');
      const prompt = typeof rec['prompt'] === 'string' ? rec['prompt'] : description;
      const agentType = typeof rec['agent'] === 'string' ? rec['agent'] : 'general-purpose';

      const agentDef = agentRegistry.get(agentType);
      if (!agentDef) {
        return {
          success: false,
          error: `Unknown agent type: ${agentType}. Available: ${agentRegistry.getAll().map((a: any) => a.agentType).join(', ')}`,
        };
      }

      const factory = getFactory();
      const agent = factory.create({
        parentSessionId: context.sessionId,
        taskId: description,
        inheritContext: true,
        contextSummary: undefined,
        name: agentDef.agentType,
        description: agentDef.whenToUse,
        systemPrompt: agentDef.getSystemPrompt(),
        allowedTools: agentDef.tools,
        deniedTools: agentDef.deniedTools,
        modelConfig: agentDef.model,
        permissionMode: agentDef.permissionMode,
        workingDirectory: context.workingDirectory,
      });

      const result = await agent.run();

      return {
        success: result.success,
        output: result.output,
        error: result.error,
        metadata: {
          taskId: agent.getSessionId(),
          agentType,
          turns: result.turns,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
        },
      };
    },
  };
}

export const agentTools = [];