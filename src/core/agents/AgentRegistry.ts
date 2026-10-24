import { EventEmitter } from 'node:events';
import {
  AgentDefinition,
  formatAgentLine,
  resolveAllowedTools,
} from './types.js';
import { AgentLoader } from './AgentLoader.js';

/**
 * AgentRegistry — the agent catalog. Holds built-in plus file-defined
 * agents and provides lookup plus the parent-facing prompt block.
 */
export class AgentRegistry extends EventEmitter {
  private readonly loader: AgentLoader;
  private readonly agents = new Map<string, AgentDefinition>();

  constructor(searchPaths?: string[]) {
    super();
    this.loader = new AgentLoader(searchPaths ?? AgentLoader.defaultPaths());
    this.reloadAll();
  }

  /** (Re)load built-ins and file agents. */
  reloadAll(): Map<string, AgentDefinition> {
    this.agents.clear();
    for (const def of this.loader.load().values()) {
      this.agents.set(def.agentType, def);
    }
    return this.agents;
  }

  get(agentType: string): AgentDefinition | undefined {
    return this.agents.get(agentType);
  }

  getAll(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  has(agentType: string): boolean {
    return this.agents.has(agentType);
  }

  /** Tool names this agent may use, given the tools that exist. */
  resolveTools(agentType: string, availableToolNames: string[]): string[] | null {
    const def = this.get(agentType);
    if (!def) return null;
    return resolveAllowedTools(def, availableToolNames);
  }

  /**
   * The agent-list block injected into the parent's system prompt, so the
   * model knows what it can spawn and when.
   */
  toPromptBlock(): string {
    if (this.agents.size === 0) return '';
    const lines = [...this.agents.values()].map(formatAgentLine);
    return `Available agents (spawn via the Agent tool when a task fits one):\n${lines.join('\n')}`;
  }
}

export default AgentRegistry;
