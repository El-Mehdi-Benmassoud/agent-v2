import { describe, it, expect, vi } from 'vitest';
import { HookRunner } from '../../../src/core/hooks/HookRunner.js';
import { HookType } from '../../../src/types/index.js';
import type { HookConfig, HookOutcome } from '../../../src/core/hooks/HookRunner.js';

/** Build a fake spawner recording calls and returning scripted outcomes. */
function fakeSpawner(script: (command: string, input: string) => Partial<HookOutcome> | null) {
  const calls: Array<{ command: string; input: unknown; timeoutMs: number }> = [];
  const spawner = async (command: string, input: string, timeoutMs: number, hook: HookConfig) => {
    calls.push({ command, input: JSON.parse(input), timeoutMs });
    const scripted = script(command, input);
    return {
      hook,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 5,
      timedOut: false,
      ...scripted,
    } as HookOutcome;
  };
  return { spawner, calls };
}

const hook = (command: string, timeout?: number): HookConfig => ({
  type: HookType.PRE_TOOL_USE,
  command,
  timeout,
});

describe('HookRunner', () => {
  it('runs nothing when no hooks are configured', async () => {
    const runner = new HookRunner({ spawner: fakeSpawner(() => null).spawner });
    const outcomes = await runner.run(HookType.PRE_TOOL_USE, undefined, { sessionId: 's1' });
    expect(outcomes).toEqual([]);
  });

  it('delivers JSON event on stdin and collects outcomes', async () => {
    const { spawner, calls } = fakeSpawner(() => ({ stdout: 'log line\n' }));
    const runner = new HookRunner({ spawner });
    const outcomes = await runner.run(
      HookType.PRE_TOOL_USE,
      [hook('echo hi')],
      { sessionId: 's1', toolName: 'write' }
    );
    expect(outcomes).toHaveLength(1);
    expect(calls[0]?.command).toBe('echo hi');
    const input = calls[0]?.input as Record<string, unknown>;
    expect(input['hookType']).toBe('pre_tool_use');
    expect(input['sessionId']).toBe('s1');
    expect(input['toolName']).toBe('write');
  });

  it('uses hook.timeout (seconds) and falls back to the default', async () => {
    const { spawner, calls } = fakeSpawner(() => null);
    const runner = new HookRunner({ spawner, defaultTimeoutMs: 15_000 });
    await runner.run(HookType.PRE_TOOL_USE, [hook('a', 3), hook('b')], { sessionId: 's1' });
    expect(calls[0]?.timeoutMs).toBe(3000);
    expect(calls[1]?.timeoutMs).toBe(15000);
  });

  it('fold decisions: first blocking hook wins', async () => {
    const { spawner } = fakeSpawner((cmd) => {
      if (cmd === 'blocker') return { stdout: '{"block": true, "reason": "not allowed"}\n' };
      return { stdout: '{"block": false}\n' };
    });
    const runner = new HookRunner({ spawner });
    const { outcomes, decision } = await runner.runPre(
      HookType.PRE_TOOL_USE,
      [hook('passer'), hook('blocker'), hook('never-reached-should-still-run')],
      { sessionId: 's1', toolName: 'rm' }
    );
    // run() executes ALL hooks (no short-circuit inside runPre's run call)
    expect(outcomes).toHaveLength(3);
    expect(decision.block).toBe(true);
    expect(decision.reason).toBe('not allowed');
  });

  it('fold decisions: modifiedMessage is last-writer-wins', async () => {
    const { spawner } = fakeSpawner((cmd) => {
      if (cmd === 'first') return { stdout: '{"modifiedMessage": "A"}\n' };
      return { stdout: '{"modifiedMessage": "B"}\n' };
    });
    const runner = new HookRunner({ spawner });
    const { decision } = await runner.runPre(
      HookType.PRE_MESSAGE,
      [hook('first'), hook('second')],
      { sessionId: 's1', message: 'original' }
    );
    expect(decision.modifiedMessage).toBe('B');
  });

  it('ignores decisions from failed hooks (non-zero exit)', async () => {
    const { spawner } = fakeSpawner(() => ({ exitCode: 1, stdout: '{"block": true}\n' }));
    const runner = new HookRunner({ spawner });
    const { decision } = await runner.runPre(
      HookType.PRE_TOOL_USE,
      [hook('failing')],
      { sessionId: 's1' }
    );
    expect(decision.block).toBeUndefined();
  });

  it('ignores stdout that is not a JSON object decision', async () => {
    const { spawner } = fakeSpawner(() => ({ stdout: 'plain text output\n' }));
    const runner = new HookRunner({ spawner });
    const { decision } = await runner.runPre(
      HookType.PRE_TOOL_USE,
      [hook('noisy')],
      { sessionId: 's1' }
    );
    expect(decision.block).toBeUndefined();
  });

  it('parseDecision picks the LAST JSON line when several are printed', () => {
    const stdout = '{"block": false}\nsome log\n{"block": true, "reason": "second"}\n';
    const parsed = HookRunner.parseDecision(stdout);
    expect(parsed?.block).toBe(true);
    expect(parsed?.reason).toBe('second');
  });

  it('parseDecision returns null for non-JSON stdout', () => {
    expect(HookRunner.parseDecision('hello world')).toBeNull();
    expect(HookRunner.parseDecision('')).toBeNull();
  });

  it('parseDecision tolerates logs before the decision object', () => {
    const parsed = HookRunner.parseDecision('doing stuff...\n{"modifiedMessage": "edited"}');
    expect(parsed?.modifiedMessage).toBe('edited');
  });
});

describe('HookRunner real spawner (hermetic command)', () => {
  it('executes a real shell command and captures stdout', async () => {
    const runner = new HookRunner();
    const outcomes = await runner.run(
      HookType.PRE_TOOL_USE,
      [hook('printf "hello from hook"')],
      { sessionId: 's1' }
    );
    expect(outcomes[0]?.exitCode).toBe(0);
    expect(outcomes[0]?.stdout).toContain('hello from hook');
    expect(outcomes[0]?.timedOut).toBe(false);
  });

  it('captures non-zero exit codes without throwing', async () => {
    const runner = new HookRunner();
    const outcomes = await runner.run(
      HookType.PRE_TOOL_USE,
      [hook('exit 3')],
      { sessionId: 's1' }
    );
    expect(outcomes[0]?.exitCode).toBe(3);
  });

  it('reads the JSON event from stdin', async () => {
    const runner = new HookRunner();
    const outcomes = await runner.run(
      HookType.PRE_MESSAGE,
      [hook('node -e "const d=require(\'fs\').readFileSync(0,\'utf8\'); const j=JSON.parse(d); process.stdout.write(j.sessionId)"')],
      { sessionId: 'abc-123' }
    );
    expect(outcomes[0]?.stdout).toContain('abc-123');
  });

  it('kills a hook that exceeds its timeout', async () => {
    const runner = new HookRunner();
    const outcomes = await runner.run(
      HookType.PRE_TOOL_USE,
      [hook('sleep 30', 1)],
      { sessionId: 's1' }
    );
    expect(outcomes[0]?.timedOut).toBe(true);
    expect(outcomes[0]?.exitCode).not.toBe(0);
  }, 15_000);
});
