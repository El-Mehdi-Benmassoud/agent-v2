import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../../src/core/session/SessionManager.js';
import { HookRunner } from '../../../src/core/hooks/HookRunner.js';
import { HookType, MessageRole, ModelProvider, PermissionMode, ToolCategory } from '../../../src/types/index.js';
import type { ProviderCapabilities, ValidationResult } from '../../../src/types/index.js';
import { ProviderFactory } from '../../../src/core/providers/ProviderFactory.js';
import { Provider } from '../../../src/core/providers/Provider.js';
import type { HookConfig, HookOutcome, HookDecision } from '../../../src/core/hooks/HookRunner.js';
import type { HooksConfig, Message, ModelOptions, ModelResponse, ModelStreamChunk, ToolDefinition } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Minimal fake provider (same registration pattern as session.test.ts)
// ---------------------------------------------------------------------------

class ScriptedProvider extends Provider {
  public calls = 0;
  private mode: 'text' | 'tool' = 'text';

  constructor(config: ConstructorParameters<typeof Provider>[0]) {
    super(config);
  }

  /** Script the next turn's behavior. */
  script(mode: 'text' | 'tool'): void {
    this.mode = mode;
  }

  async validateConfig(): Promise<ValidationResult> {
    return { valid: true, errors: [] };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      supportsTools: true,
      supportsThinking: false,
      supportsImages: false,
      supportsSystemPrompt: true,
      maxContextTokens: 200000,
      maxOutputTokens: 8192,
      supportedModels: ['fake-model'],
    };
  }

  async sendMessage(_messages: Message[], _tools: ToolDefinition[], _options: ModelOptions): Promise<ModelResponse> {
    this.calls += 1;
    if (this.mode === 'tool' && this.calls === 1) {
      return {
        content: [{ type: 'tool_use', id: 'tu1', name: 'echo', input: { text: 'hi' } } as never],
        usage: zeroUsage(),
        stopReason: 'tool_use' as never,
        modelId: 'fake-model',
        provider: undefined as never,
      };
    }
    return {
      content: [{ type: 'text', text: `reply-${this.calls}` } as never],
      usage: zeroUsage(),
      stopReason: 'end_turn' as never,
      modelId: 'fake-model',
      provider: undefined as never,
    };
  }

  async *streamMessage(_messages: Message[], _tools: ToolDefinition[], _options: ModelOptions): AsyncIterable<ModelStreamChunk> {
    this.calls += 1;
    if (this.mode === 'tool' && this.calls === 1) {
      yield { type: 'tool_use', toolUse: { id: 'tu1', name: 'echo', input: { text: 'hi' }, partial: false } };
      yield { type: 'complete', usage: zeroUsage(), stopReason: 'tool_use' as never };
      return;
    }
    yield { type: 'content', delta: 'final answer' };
    yield { type: 'complete', usage: zeroUsage(), stopReason: 'end_turn' as never };
  }
}

function zeroUsage() {
  return { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0 };
}

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'echo input',
  category: ToolCategory.TASK,
  inputSchema: { type: 'object' },
  execute: async (input) => ({ success: true, output: input }),
};

// ---------------------------------------------------------------------------
// Fake HookRunner recording events; optional scripted decision
// ---------------------------------------------------------------------------

class RecordingRunner extends HookRunner {
  public events: Array<{ type: HookType; input: Record<string, unknown> }> = [];
  constructor(private readonly decisionFor?: (type: HookType, input: Record<string, unknown>) => HookDecision) {
    super({ spawner: async (_c, _i, _t, h) => ({ hook: h, exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }) });
  }
  override async run(type: HookType, hooks: HookConfig[] | undefined, input: Omit<{ hookType: HookType; sessionId: string }, 'hookType'>): Promise<HookOutcome[]> {
    const record = { type, input: input as Record<string, unknown> };
    this.events.push(record);
    return [];
  }
  override async runPre(type: HookType, hooks: HookConfig[] | undefined, input: Omit<{ hookType: HookType; sessionId: string }, 'hookType'>): Promise<{ outcomes: HookOutcome[]; decision: HookDecision }> {
    const record = { type, input: input as Record<string, unknown> };
    this.events.push(record);
    if (this.decisionFor) {
      return { outcomes: [], decision: this.decisionFor(type, record.input) };
    }
    return { outcomes: [], decision: {} };
  }
}

const anyHooks: HooksConfig = {
  [HookType.PRE_MESSAGE]: [{ type: HookType.PRE_MESSAGE, command: 'true' }],
  [HookType.PRE_TOOL_USE]: [{ type: HookType.PRE_TOOL_USE, command: 'true' }],
};

// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-v2-hooks-'));
  ProviderFactory.clearCache();
  ProviderFactory.register(ModelProvider.CUSTOM, ScriptedProvider as unknown as new (config: never) => Provider);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  ProviderFactory.clearCache();
});

async function newManager(hooks: HooksConfig | undefined, runner?: HookRunner) {
  const manager = new SessionManager({
    baseDir: tmpDir,
    hooks,
    hookRunner: runner,
  });
  const state = await manager.createSession(
    { provider: ModelProvider.CUSTOM, modelId: 'fake-model', apiKey: 'test-key' },
    [echoTool],
    { workingDirectory: tmpDir, permissionMode: PermissionMode.BYPASS }
  );
  return { manager, state };
}

async function fakeOf(_manager: SessionManager): Promise<ScriptedProvider> {
  const provider = await ProviderFactory.create({
    provider: ModelProvider.CUSTOM,
    modelId: 'fake-model',
    apiKey: 'test-key',
  });
  return provider as ScriptedProvider;
}

describe('SessionManager hook integration', () => {
  it('fires no hooks when none are configured', async () => {
    const runner = new RecordingRunner();
    const { manager } = await newManager(undefined, runner);
    await manager.sendMessage('hello');
    expect(runner.events).toHaveLength(0);
  });

  it('fires PRE_MESSAGE and POST_MESSAGE around a turn', async () => {
    const runner = new RecordingRunner();
    const { manager } = await newManager(anyHooks, runner);
    await manager.sendMessage('hello');
    const types = runner.events.map((e) => e.type);
    expect(types).toContain(HookType.PRE_MESSAGE);
    expect(types).toContain(HookType.POST_MESSAGE);
    expect(types).toContain(HookType.TURN_START);
    expect(types).toContain(HookType.TURN_END);
    // PRE before POST
    expect(types.indexOf(HookType.PRE_MESSAGE)).toBeLessThan(types.indexOf(HookType.POST_MESSAGE));
  });

  it('PRE_MESSAGE block vetoes the turn with zero cost', async () => {
    const runner = new RecordingRunner((type, input) =>
      type === HookType.PRE_MESSAGE && input['message'] === 'forbidden'
        ? { block: true, reason: 'blocked by policy' }
        : {}
    );
    const { manager, state } = await newManager(anyHooks, runner);
    const result = await manager.sendMessage('forbidden');
    expect(result.turns).toBe(0);
    expect(result.costUsd).toBe(0);
    // No user message entered history
    expect(state.messages.some((m) => m.role === 'user')).toBe(false);
  });

  it('PRE_MESSAGE modifiedMessage rewrites what the model sees', async () => {
    const runner = new RecordingRunner((type) =>
      type === HookType.PRE_MESSAGE ? { modifiedMessage: 'rewritten text' } : {}
    );
    const { manager, state } = await newManager(anyHooks, runner);
    await manager.sendMessage('original text');
    const userMsg = state.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    const text = JSON.stringify(userMsg?.content);
    expect(text).toContain('rewritten text');
    expect(text).not.toContain('original text');
  });

  it('fires PRE_TOOL_USE and vetoes the tool call', async () => {
    const runner = new RecordingRunner((type, input) =>
      type === HookType.PRE_TOOL_USE && input['toolName'] === 'echo'
        ? { block: true, reason: 'tool blocked' }
        : {}
    );
    const { manager, state } = await newManager(anyHooks, runner);
    // Script turn 1 to emit a tool_use; the veto must produce an
    // error tool result instead of executing echo.
    const fake = await fakeOf(manager);
    fake.script('tool');
    await manager.sendMessage('use the tool');
    const toolResult = state.messages.find((m) => m.role === 'tool');
    expect(toolResult).toBeDefined();
    const resultText = JSON.stringify(toolResult?.content);
    expect(resultText).toContain('tool blocked');
    // echo never ran: its success output would be the input object
    expect(resultText).not.toContain('"success":true');
  });

  it('PRE_TOOL_USE allow: the tool executes normally', async () => {
    const runner = new RecordingRunner(() => ({}));
    const { manager, state } = await newManager(anyHooks, runner);
    const fake = await fakeOf(manager);
    fake.script('tool');
    await manager.sendMessage('use the tool');
    const toolResult = state.messages.find((m) => m.role === 'tool');
    expect(toolResult).toBeDefined();
    expect(JSON.stringify(toolResult?.content)).toContain('hi');
  });

  it('fires SESSION_START on create and SESSION_END on delete', async () => {
    const runner = new RecordingRunner();
    const { manager, state } = await newManager(anyHooks, runner);
    expect(runner.events.some((e) => e.type === HookType.SESSION_START)).toBe(true);
    manager.deleteSession(state.config.id);
    expect(runner.events.some((e) => e.type === HookType.SESSION_END)).toBe(true);
  });

  it('hook commands failing never break the turn (fireHooks swallows)', async () => {
    const brokenHooks: HooksConfig = {
      [HookType.PRE_MESSAGE]: [{ type: HookType.PRE_MESSAGE, command: 'definitely-not-a-command-xyz' }],
    };
    // Real runner with real spawner — command does not exist.
    const { manager } = await newManager(brokenHooks, new HookRunner());
    const result = await manager.sendMessage('hello');
    expect(result.turns).toBeGreaterThan(0);
  });
});
