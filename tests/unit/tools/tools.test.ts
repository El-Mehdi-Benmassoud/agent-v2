import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolCategory } from '../../../src/types/index.js';
import { toolRegistry } from '../../../src/tools/index.js';
import type { ToolContext, ToolDefinition } from '../../../src/types/index.js';

let fixtureRoot: string;

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDirectory: fixtureRoot,
    sessionId: 'test-session',
    messageId: 'test-message',
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-v2-tools-'));
  // default-ignored dir that must never be searched
  mkdirSync(join(fixtureRoot, 'node_modules'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'node_modules', 'leaked.txt'), 'SECRET needle');
  // a normal source tree
  mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'src', 'a.ts'), 'line1: hello\nline2: needle here\nline3: done\n');
  writeFileSync(join(fixtureRoot, 'src', 'b.md'), '# Title\nneedle in markdown\n');
  writeFileSync(join(fixtureRoot, 'root.txt'), 'needle at root\n');
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('registry: all 40 built-ins registered exactly once', () => {
  it('registers exactly 40 tools', () => {
    expect(toolRegistry.getAll()).toHaveLength(40);
  });

  it('has no duplicate names', () => {
    const names = toolRegistry.getAll().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('contains every expected tool name', () => {
    const expected = [
      'read', 'read_multiple', 'write', 'write_append', 'edit', 'replace', 'patch',
      'list', 'glob', 'grep', 'find', 'file_info', 'head', 'mkdir', 'touch',
      'delete', 'copy', 'move',
      'bash', 'env', 'which',
      'search', 'web_search', 'web_fetch',
      'git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch',
      'git_checkout', 'git_push', 'git_pull', 'git_add', 'git_show',
      'lint', 'format', 'typecheck', 'test',
      'task', 'todo',
    ];
    for (const name of expected) {
      expect(toolRegistry.has(name), `missing tool: ${name}`).toBe(true);
    }
  });

  it('category sizes: 18 fs, 3 shell, 3 search, 10 git, 4 code, 2 task', () => {
    expect(toolRegistry.getByCategory(ToolCategory.FILE_SYSTEM)).toHaveLength(18);
    expect(toolRegistry.getByCategory(ToolCategory.SHELL)).toHaveLength(3);
    expect(toolRegistry.getByCategory(ToolCategory.SEARCH)).toHaveLength(3);
    expect(toolRegistry.getByCategory(ToolCategory.GIT)).toHaveLength(10);
    expect(toolRegistry.getByCategory(ToolCategory.CODE)).toHaveLength(4);
    expect(toolRegistry.getByCategory(ToolCategory.TASK)).toHaveLength(2);
  });

  it('every tool has a description and an object inputSchema', () => {
    for (const tool of toolRegistry.getAll()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTypeOf('object');
    }
  });
});

describe('registry: approval and danger flags', () => {
  it('marks mutating tools requiresApproval=true', () => {
    const requiring = [
      'write', 'write_append', 'edit', 'replace', 'patch', 'mkdir', 'touch',
      'delete', 'copy', 'move', 'bash', 'env', 'format',
      'git_commit', 'git_checkout', 'git_push',
    ];
    for (const name of requiring) {
      const tool = toolRegistry.get(name);
      expect(tool?.requiresApproval, `${name} should require approval`).toBe(true);
    }
  });

  it('marks dangerous tools dangerous=true', () => {
    for (const name of ['delete', 'bash', 'git_push']) {
      const tool = toolRegistry.get(name);
      expect(tool?.dangerous, `${name} should be dangerous`).toBe(true);
    }
    const others = toolRegistry.getAll().filter((t) => !['delete', 'bash', 'git_push'].includes(t.name));
    for (const tool of others) {
      expect(tool.dangerous ?? false, `${tool.name} should not be dangerous`).toBe(false);
    }
  });
});

describe('registry: execute error containment', () => {
  it('rejects unknown tool names', async () => {
    const result = await toolRegistry.execute('no_such_tool', {}, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects schema-invalid input (missing required key)', async () => {
    const result = await toolRegistry.execute('write', { path: 'x.txt' }, makeContext()); // missing content
    expect(result.success).toBe(false);
    expect(result.error).toContain('content');
  });

  it('rejects input with wrong property type', async () => {
    const result = await toolRegistry.execute('read', { path: 123 }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('path');
  });

  it('catches handler throws into ToolResult failures', async () => {
    const throwing: ToolDefinition = {
      name: 'throwing',
      description: 'always throws',
      category: ToolCategory.TASK,
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        throw new Error('boom');
      },
    };
    toolRegistry.register(throwing);
    try {
      const result = await toolRegistry.execute('throwing', {}, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('boom');
    } finally {
      toolRegistry.unregister('throwing');
    }
  });

  it('supports zod-style schemas with .parse', async () => {
    const fakeZod = {
      parse: (input: unknown) => {
        if (typeof input === 'object' && input !== null && 'ok' in input) return input;
        throw new Error('zod says no');
      },
    };
    const zodTool: ToolDefinition = {
      name: 'zody',
      description: 'zod-style',
      category: ToolCategory.TASK,
      inputSchema: fakeZod as never,
      execute: async () => ({ success: true, output: 'ran' }),
    };
    toolRegistry.register(zodTool);
    try {
      const bad = await toolRegistry.execute('zody', {}, makeContext());
      expect(bad.success).toBe(false);
      const good = await toolRegistry.execute('zody', { ok: true }, makeContext());
      expect(good.success).toBe(true);
    } finally {
      toolRegistry.unregister('zody');
    }
  });
});

describe('fs tools on fixtures', () => {
  it('read returns file content with line info', async () => {
    const result = await toolRegistry.execute('read', { path: 'src/a.ts' }, makeContext());
    expect(result.success).toBe(true);
    const output = result.output as { content: string; totalLines: number };
    expect(output.content).toContain('needle here');
    expect(output.totalLines).toBe(4); // trailing newline
  });

  it('read with offset and limit windows the file', async () => {
    const result = await toolRegistry.execute('read', { path: 'src/a.ts', offset: 1, limit: 1 }, makeContext());
    expect(result.success).toBe(true);
    const output = result.output as { content: string };
    expect(output.content).toBe('line2: needle here');
  });

  it('read errors on missing file', async () => {
    const result = await toolRegistry.execute('read', { path: 'nope.txt' }, makeContext());
    expect(result.success).toBe(false);
  });

  it('read_multiple returns per-file results', async () => {
    const result = await toolRegistry.execute(
      'read_multiple',
      { paths: ['src/a.ts', 'missing.txt'] },
      makeContext(),
    );
    expect(result.success).toBe(false); // one failed
    const output = result.output as { files: Array<{ path: string; content?: string; error?: string }> };
    expect(output.files).toHaveLength(2);
    expect(output.files[0]?.content).toContain('needle here');
    expect(output.files[1]?.error).toBeTruthy();
  });

  it('write then read round-trips content', async () => {
    const writeResult = await toolRegistry.execute(
      'write',
      { path: 'new/dir/file.txt', content: 'round trip\n' },
      makeContext(),
    );
    expect(writeResult.success).toBe(true);
    const readResult = await toolRegistry.execute('read', { path: 'new/dir/file.txt' }, makeContext());
    expect(readResult.success).toBe(true);
    expect((readResult.output as { content: string }).content).toBe('round trip\n');
  });

  it('write_append appends without truncating', async () => {
    await toolRegistry.execute('write', { path: 'log.txt', content: 'first\n' }, makeContext());
    const appendResult = await toolRegistry.execute('write_append', { path: 'log.txt', content: 'second\n' }, makeContext());
    expect(appendResult.success).toBe(true);
    const read = await toolRegistry.execute('read', { path: 'log.txt' }, makeContext());
    expect((read.output as { content: string }).content).toBe('first\nsecond\n');
  });

  it('edit replaces a unique string', async () => {
    await toolRegistry.execute('write', { path: 'e.txt', content: 'alpha beta gamma\n' }, makeContext());
    const result = await toolRegistry.execute(
      'edit',
      { path: 'e.txt', oldString: 'beta', newString: 'BETA' },
      makeContext(),
    );
    expect(result.success).toBe(true);
    const read = await toolRegistry.execute('read', { path: 'e.txt' }, makeContext());
    expect((read.output as { content: string }).content).toBe('alpha BETA gamma\n');
  });

  it('edit refuses ambiguous matches without replaceAll', async () => {
    await toolRegistry.execute('write', { path: 'amb.txt', content: 'x dup x\n' }, makeContext());
    const result = await toolRegistry.execute(
      'edit',
      { path: 'amb.txt', oldString: 'x', newString: 'y' },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('replaceAll');
    // and with replaceAll it succeeds
    const ok = await toolRegistry.execute(
      'edit',
      { path: 'amb.txt', oldString: 'x', newString: 'y', replaceAll: true },
      makeContext(),
    );
    expect(ok.success).toBe(true);
  });

  it('delete refuses a directory without recursive, allows with it', async () => {
    mkdirSync(join(fixtureRoot, 'dirtree'));
    writeFileSync(join(fixtureRoot, 'dirtree', 'f.txt'), 'x');
    const refused = await toolRegistry.execute('delete', { path: 'dirtree' }, makeContext());
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('recursive');
    const ok = await toolRegistry.execute('delete', { path: 'dirtree', recursive: true }, makeContext());
    expect(ok.success).toBe(true);
  });

  it('copy and move operate on files', async () => {
    await toolRegistry.execute('write', { path: 'm.txt', content: 'data' }, makeContext());
    const copy = await toolRegistry.execute('copy', { source: 'm.txt', destination: 'm2.txt' }, makeContext());
    expect(copy.success).toBe(true);
    const move = await toolRegistry.execute('move', { source: 'm2.txt', destination: 'sub/m3.txt' }, makeContext());
    expect(move.success).toBe(true);
    const gone = await toolRegistry.execute('read', { path: 'm2.txt' }, makeContext());
    expect(gone.success).toBe(false);
    const moved = await toolRegistry.execute('read', { path: 'sub/m3.txt' }, makeContext());
    expect(moved.success).toBe(true);
  });
});

describe('grep/glob/find: line numbers and default ignores', () => {
  it('grep reports line and column numbers and matched text', async () => {
    const result = await toolRegistry.execute('grep', { pattern: 'needle' }, makeContext());
    expect(result.success).toBe(true);
    const output = result.output as {
      matches: Array<{ path: string; line: number; column: number; match: string }>;
    };
    const aTs = output.matches.find((m) => m.path === 'src/a.ts');
    expect(aTs?.line).toBe(2);
    expect(aTs?.column).toBeGreaterThanOrEqual(1);
    expect(aTs?.match).toBe('needle');
  });

  it('grep never searches node_modules', async () => {
    const result = await toolRegistry.execute('grep', { pattern: 'SECRET' }, makeContext());
    expect(result.success).toBe(true);
    const output = result.output as { matches: Array<{ path: string }> };
    expect(output.matches.some((m) => m.path.includes('node_modules'))).toBe(false);
  });

  it('glob matches files but skips ignored dirs', async () => {
    const result = await toolRegistry.execute('glob', { pattern: '**/*.txt' }, makeContext());
    expect(result.success).toBe(true);
    const output = result.output as { matches: string[] };
    expect(output.matches).toContain('root.txt');
    expect(output.matches.some((m) => m.includes('node_modules'))).toBe(false);
  });

  it('find locates files by name substring, ignoring node_modules', async () => {
    const result = await toolRegistry.execute('find', { pattern: 'a.ts' }, makeContext());
    expect(result.success).toBe(true);
    const output = result.output as { matches: Array<{ path: string; type: string }> };
    expect(output.matches.some((m) => m.path === 'src/a.ts')).toBe(true);
    const leaked = await toolRegistry.execute('find', { pattern: 'leaked' }, makeContext());
    const leakedOut = leaked.output as { matches: Array<{ path: string }> };
    expect(leakedOut.matches.some((m) => m.path.includes('node_modules'))).toBe(false);
  });

  it('search dispatches content to grep and files to glob', async () => {
    const content = await toolRegistry.execute('search', { pattern: 'needle', type: 'content' }, makeContext());
    const contentOut = content.output as { matches: unknown[] };
    expect(contentOut.matches.length).toBeGreaterThanOrEqual(2);
    const files = await toolRegistry.execute('search', { pattern: '**/*.md', type: 'files' }, makeContext());
    const filesOut = files.output as { matches: string[] };
    expect(filesOut.matches).toContain('src/b.md');
  });

  it('search rejects unknown types', async () => {
    const result = await toolRegistry.execute('search', { pattern: 'x', type: 'bogus' }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown search type');
  });
});

describe('shell tools', () => {
  it('bash echoes and reports exit code 0', async () => {
    const result = await toolRegistry.execute('bash', { command: 'echo hello' }, makeContext());
    expect(result.success).toBe(true);
    const output = result.output as { stdout: string; exitCode: number };
    expect(output.exitCode).toBe(0);
    expect(output.stdout.trim()).toBe('hello');
  });

  it('bash reports nonzero exit codes as failure', async () => {
    const result = await toolRegistry.execute('bash', { command: 'false' }, makeContext());
    expect(result.success).toBe(false);
    const output = result.output as { exitCode: number };
    expect(output.exitCode).not.toBe(0);
  });

  it('env reads a variable by name', async () => {
    process.env['AGENT_V2_TEST_VAR'] = 'zzz';
    try {
      const result = await toolRegistry.execute('env', { name: 'AGENT_V2_TEST_VAR' }, makeContext());
      expect(result.success).toBe(true);
      expect((result.output as { value: string }).value).toBe('zzz');
    } finally {
      delete process.env['AGENT_V2_TEST_VAR'];
    }
  });

  it('which resolves git on PATH', async () => {
    const result = await toolRegistry.execute('which', { command: 'git' }, makeContext());
    expect(result.success).toBe(true);
    expect((result.output as { path: string }).path).toContain('git');
  });
});

describe('git tools on a fresh temp repo', () => {
  it('git_status works after git init', async () => {
    const result = await toolRegistry.execute('git_status', {}, makeContext());
    // may fail if fixtureRoot is not a repo; git init then retry
    if (!result.success) {
      const init = await toolRegistry.execute('bash', { command: 'git init -q' }, makeContext());
      expect(init.success).toBe(true);
      const status = await toolRegistry.execute('git_status', {}, makeContext());
      expect(status.success).toBe(true);
      const output = status.output as { stdout: string };
      expect(output.stdout).toContain('No commits yet');
    } else {
      const output = result.output as { stdout: string };
      expect(output.stdout.length).toBeGreaterThan(0);
    }
  });

  it('git_log fails cleanly on a repo with no commits', async () => {
    const init = await toolRegistry.execute('bash', { command: 'git init -q 2>/dev/null || true' }, makeContext());
    expect(init.success).toBe(true);
    const log = await toolRegistry.execute('git_log', { limit: 5 }, makeContext());
    // no commits yet: git log exits nonzero
    expect(log.success).toBe(false);
  });
});

describe('code tools: registry wiring and command construction', () => {
  it('lint builds the npm run lint command', async () => {
    const result = await toolRegistry.execute('lint', {}, makeContext());
    expect(result.success).toBe(true);
    const output = result.output as { command: string; npmScript: string };
    expect(output.command).toBe('npm run lint');
    expect(output.npmScript).toBe('lint');
  });

  it('format builds the npm run format command', async () => {
    const result = await toolRegistry.execute('format', {}, makeContext());
    expect(result.success).toBe(true);
    expect((result.output as { command: string }).command).toBe('npm run format');
  });

  it('typecheck builds the npm run build command', async () => {
    const result = await toolRegistry.execute('typecheck', {}, makeContext());
    expect(result.success).toBe(true);
    expect((result.output as { command: string }).command).toBe('npm run build');
  });

  it('test builds the npm run test command', async () => {
    const result = await toolRegistry.execute('test', {}, makeContext());
    expect(result.success).toBe(true);
    expect((result.output as { command: string }).command).toBe('npm run test');
  });
});

describe('task tools', () => {
  it('task stub returns a sha256-derived id and created status', async () => {
    const result = await toolRegistry.execute('task', { description: 'do a thing' }, makeContext());
    expect(result.success).toBe(true);
    const output = result.output as { taskId: string; status: string };
    expect(output.taskId).toMatch(/^task-[0-9a-f]{12}$/);
    expect(output.status).toBe('created');
    // deterministic for identical inputs
    const again = await toolRegistry.execute('task', { description: 'do a thing' }, makeContext());
    expect((again.output as { taskId: string }).taskId).toBe(output.taskId);
  });

  it('todo lifecycle: add, list, complete, remove', async () => {
    const ctx = makeContext({ sessionId: 'todo-session-1' });
    await toolRegistry.execute('todo', { action: 'clear' }, ctx);
    const add = await toolRegistry.execute('todo', { action: 'add', content: 'write tests' }, ctx);
    expect(add.success).toBe(true);
    const id = (add.output as { item: { id: string } }).item.id;

    const list = await toolRegistry.execute('todo', { action: 'list' }, ctx);
    expect(((list.output as { todos: unknown[] }).todos)).toHaveLength(1);

    const complete = await toolRegistry.execute('todo', { action: 'complete', id }, ctx);
    expect(complete.success).toBe(true);
    expect((complete.output as { item: { status: string } }).item.status).toBe('completed');

    const remove = await toolRegistry.execute('todo', { action: 'remove', id }, ctx);
    expect(remove.success).toBe(true);
    const empty = await toolRegistry.execute('todo', { action: 'list' }, ctx);
    expect(((empty.output as { todos: unknown[] }).todos)).toHaveLength(0);
  });

  it('todo lists are isolated per session', async () => {
    const ctxA = makeContext({ sessionId: 'sess-A' });
    const ctxB = makeContext({ sessionId: 'sess-B' });
    await toolRegistry.execute('todo', { action: 'clear' }, ctxA);
    await toolRegistry.execute('todo', { action: 'clear' }, ctxB);
    await toolRegistry.execute('todo', { action: 'add', content: 'A only' }, ctxA);
    const listB = await toolRegistry.execute('todo', { action: 'list' }, ctxB);
    expect(((listB.output as { todos: unknown[] }).todos)).toHaveLength(0);
  });
});

describe('web tools (hermetic stubs)', () => {
  it('web_search fails honestly without configuration', async () => {
    const result = await toolRegistry.execute('web_search', { query: 'anything' }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('SEARCH_API_KEY');
  });
});
