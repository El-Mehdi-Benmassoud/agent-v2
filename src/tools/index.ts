import type { ToolDefinition } from '../types/index.js';
import { fileSystemTools } from './fs.js';
import { shellTools } from './shell.js';
import { searchTools } from './search.js';
import { gitTools } from './git.js';
import { codeTools } from './code.js';
import { taskTools } from './task.js';
import { makeAgentTool } from './agent.js';
import { ToolRegistry } from './ToolRegistry.js';
import { AgentRegistry } from '../core/agents/index.js';

/**
 * The singleton tool registry with all 40 built-in tools registered.
 */
export const toolRegistry = new ToolRegistry();

let agentRegistry: AgentRegistry | null = null;

export function setAgentRegistry(registry: AgentRegistry): void {
  agentRegistry = registry;
}

const allTools: ToolDefinition[] = [
  ...fileSystemTools, // 18
  ...shellTools, // 3
  ...searchTools, // 3
  ...gitTools, // 10
  ...codeTools, // 4
  ...taskTools, // 2
];

for (const tool of allTools) {
  toolRegistry.register(tool);
}

export { ToolRegistry } from './ToolRegistry.js';
export { fileSystemTools } from './fs.js';
export { shellTools } from './shell.js';
export { searchTools } from './search.js';
export { gitTools } from './git.js';
export { codeTools } from './code.js';
export { taskTools } from './task.js';
export { makeAgentTool } from './agent.js';