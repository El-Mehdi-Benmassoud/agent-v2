import { spawn } from 'node:child_process';
import { HookType, HookConfig } from '../../types/index.js';

/**
 * Input shape delivered to every hook command via stdin (JSON).
 */
export interface HookInput {
  hookType: HookType;
  sessionId: string;
  /** Tool name for PRE/POST_TOOL_USE hooks. */
  toolName?: string;
  /** Tool input for PRE_TOOL_USE; tool result for POST_TOOL_USE. */
  input?: unknown;
  result?: unknown;
  /** Message text for PRE_MESSAGE/POST_MESSAGE hooks. */
  message?: string;
  /** Turn number for TURN_START/TURN_END. */
  turnNumber?: number;
  /** Error text for the ERROR hook. */
  error?: string;
  /** Environment-style extras the caller wants the hook to see. */
  extra?: Record<string, unknown>;
}

/**
 * Outcome of one hook command.
 */
export interface HookOutcome {
  hook: HookConfig;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when the process was killed for exceeding its timeout. */
  timedOut: boolean;
}

/**
 * A single hook's decision payload for PRE hooks, parsed from the last
 * non-empty JSON-object line on stdout. Absent fields keep the agent's
 * default behavior.
 */
export interface HookDecision {
  /** PRE_TOOL_USE: block the tool call. */
  block?: boolean;
  /** Human-readable reason shown when blocking. */
  reason?: string;
  /** PRE_MESSAGE: modified message text to send instead. */
  modifiedMessage?: string;
}

/** Injectable command runner: (command, jsonInput, timeoutMs) -> outcome. */
export type HookSpawner = (
  command: string,
  input: string,
  timeoutMs: number,
  hook: HookConfig
) => Promise<HookOutcome>;

/**
 * HookRunner — executes user-configured shell commands at agent lifecycle
 * points (the 10 HookTypes). Commands receive the event as JSON on stdin
 * and may answer PRE hooks with a JSON decision on stdout.
 *
 * Design rules:
 *  - A hook crash or non-zero exit NEVER kills the turn; it is recorded
 *    and surfaced. PRE hooks that fail are treated as "no decision".
 *  - Timeouts escalate SIGTERM -> SIGKILL so a wedged hook cannot wedge
 *    the agent.
 *  - stdout without a JSON decision line is treated as log output, not an
 *    error.
 */
export class HookRunner {
  private readonly defaultTimeoutMs: number;
  private readonly spawner: HookSpawner;

  constructor(options: { defaultTimeoutMs?: number; spawner?: HookSpawner } = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
    this.spawner = options.spawner ?? realSpawn;
  }

  /**
   * Run every hook configured for an event, in order. Returns all outcomes;
   * empty array when none are configured.
   */
  async run(type: HookType, hooks: HookConfig[] | undefined, input: Omit<HookInput, 'hookType'>): Promise<HookOutcome[]> {
    if (!hooks || hooks.length === 0) return [];
    const outcomes: HookOutcome[] = [];
    for (const hook of hooks) {
      outcomes.push(await this.executeOne(hook, { ...input, hookType: type }));
    }
    return outcomes;
  }

  /**
   * Run PRE hooks and fold their decisions: the first blocking hook wins;
   * message modification is last-writer-wins. Hooks that exited non-zero
   * or emitted no JSON contribute no decision.
   */
  async runPre(
    type: HookType,
    hooks: HookConfig[] | undefined,
    input: Omit<HookInput, 'hookType'>
  ): Promise<{ outcomes: HookOutcome[]; decision: HookDecision }> {
    const outcomes = await this.run(type, hooks, input);
    const decision: HookDecision = {};
    for (const outcome of outcomes) {
      if (outcome.exitCode !== 0) continue;
      const parsed = HookRunner.parseDecision(outcome.stdout);
      if (!parsed) continue;
      if (parsed.block === true) {
        return { outcomes, decision: { block: true, reason: parsed.reason } };
      }
      if (parsed.modifiedMessage !== undefined) {
        decision.modifiedMessage = parsed.modifiedMessage;
      }
    }
    return { outcomes, decision };
  }

  /**
   * Parse a JSON decision object from a hook's stdout: the LAST non-empty
   * line that is a JSON object wins. Unknown keys are ignored.
   */
  static parseDecision(stdout: string): HookDecision | null {
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = (lines[i] ?? '').trim();
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as HookDecision;
        }
      } catch {
        // not JSON — keep scanning upward
      }
    }
    return null;
  }

  private async executeOne(hook: HookConfig, input: HookInput): Promise<HookOutcome> {
    const timeoutSec = hook.timeout ?? Math.round(this.defaultTimeoutMs / 1000);
    const timeoutMs = timeoutSec * 1000;
    return this.spawner(hook.command, JSON.stringify(input), timeoutMs, hook);
  }
}

/**
 * The real spawner: runs the command with shell semantics, feeds the
 * event JSON on stdin, and enforces the timeout with TERM->KILL.
 */
const realSpawn: HookSpawner = (command, input, timeoutMs, hook) => {
  return new Promise<HookOutcome>((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      shell: true,
      env: { ...process.env, ...(hook.env ?? {}) },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled && child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 1_000);
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          hook,
          exitCode: null,
          stdout,
          stderr: err.message,
          durationMs: Date.now() - started,
          timedOut: false,
        });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          hook,
          exitCode: code,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
        });
      }
    });

    // Feed the hook its JSON input and close stdin so it can read EOF.
    child.stdin?.on('error', () => {
      // EPIPE when the hook exits without reading stdin — not fatal.
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
};

export default HookRunner;
