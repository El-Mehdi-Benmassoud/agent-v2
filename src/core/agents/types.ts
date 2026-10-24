import type { ModelConfig, ModelProvider, ModelId } from '../../types/index.js';
import type { PermissionMode } from '../../types/index.js';

/**
 * AgentDefinition — a configurable sub-agent. Built-ins are compiled in
 * (builtInAgents.ts); user agents are loaded from markdown files with
 * frontmatter (loadAgentsDir.ts).
 */
export interface AgentDefinition {
  /** Unique identifier; the value passed to the Agent tool. */
  agentType: string;
  /**
   * When-to-use description the parent model reads to decide spawning.
   * This is the most important field: it is the router.
   */
  whenToUse: string;
  /** Tool allowlist; ['*'] means all tools. */
  tools?: string[];
  /** Tool denylist applied after the allowlist. */
  deniedTools?: string[];
  /** Optional model override; absent = inherit the parent's model. */
  model?: Partial<ModelConfig> & { provider?: ModelProvider; modelId?: ModelId };
  /** Optional permission mode override for this agent's session. */
  permissionMode?: PermissionMode;
  /** Where the definition came from. */
  source: 'built-in' | 'file' | 'plugin';
  /** Directory the definition was loaded from (file/plugin agents). */
  baseDir?: string;
  /** System prompt. Either a static string or a lazy getter. */
  getSystemPrompt: () => string;
}

/** Built-in variant: source is always 'built-in'. */
export interface BuiltInAgentDefinition extends AgentDefinition {
  source: 'built-in';
}

/** Effective tool allowlist for an agent (allowlist minus denylist). */
export function resolveAllowedTools(
  agent: AgentDefinition,
  availableToolNames: string[]
): string[] {
  const allow = agent.tools ?? ['*'];
  const deny = new Set(agent.deniedTools ?? []);

  const base =
    allow.includes('*') ? availableToolNames : availableToolNames.filter((n) => allow.includes(n));

  return deny.size === 0 ? base : base.filter((n) => !deny.has(n));
}

/** Human-readable tools description for the parent model. */
export function describeTools(agent: AgentDefinition): string {
  const allow = agent.tools ?? ['*'];
  const deny = agent.deniedTools ?? [];
  if (allow.includes('*') && deny.length === 0) return 'All tools';
  if (deny.length > 0) {
    const base = allow.includes('*') ? 'all tools' : allow.join(', ');
    return `${base} except ${deny.join(', ')}`;
  }
  return allow.join(', ');
}

/** Format one agent line for the parent's system prompt. */
export function formatAgentLine(agent: AgentDefinition): string {
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${describeTools(agent)})`;
}
