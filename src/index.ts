/**
 * agent-v2 — library entry point.
 *
 * Use programmatically:
 *   import { AgentCLI } from 'agent-v2';
 *   await new AgentCLI().run(['chat', 'hello']);
 *
 * From the command line, the bin entry (src/cli/main.ts) is what runs.
 */

// Core layers
export { Provider } from './core/providers/Provider.js';
export { ProviderFactory } from './core/providers/ProviderFactory.js';
export { AnthropicProvider } from './core/providers/AnthropicProvider.js';
export { OpenAIProvider } from './core/providers/OpenAIProvider.js';
export { TokenCounter } from './core/providers/TokenCounter.js';
export { CostEstimator } from './core/providers/CostEstimator.js';

export { SessionManager } from './core/session/SessionManager.js';
export { AgentLoop } from './core/session/AgentLoop.js';
export { ToolExecutor } from './core/session/ToolExecutor.js';
export { ContextManager } from './core/session/ContextManager.js';
export { SessionStore } from './core/session/SessionStore.js';

export { HookRunner } from './core/hooks/HookRunner.js';
export { SkillRegistry, getSkillRegistry, setSkillRegistry } from './core/skills/SkillRegistry.js';

export { ToolRegistry } from './tools/ToolRegistry.js';

export { ConfigManager } from './config/ConfigManager.js';
export { ProfileManager } from './config/ProfileManager.js';

export { AgentCLI } from './cli/main.js';

export { renderTUI } from './tui/render.js';

// Full type surface
export * from './types/index.js';