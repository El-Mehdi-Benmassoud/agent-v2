import { spawnSync } from 'child_process';
import type { ToolDefinition } from '../types/index.js';
import { ToolCategory } from '../types/index.js';
import { asRecord, errorMessage, optionalNumber, optionalString, requireString, resolvePath } from './shared.js';

// ===========================================================================
// GIT tools (10) — all use spawnSync('git', args, { cwd }) WITHOUT shell:true
// ===========================================================================

interface GitOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run git in the working directory, returning trimmed output. */
function runGit(args: string[], cwd: string): GitOutput {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60000,
  });
  return {
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
    exitCode: result.status ?? -1,
  };
}

function gitResult(out: GitOutput, contextDescription: string) {
  if (out.exitCode !== 0) {
    return {
      success: false,
      error: `git ${contextDescription} failed (exit ${out.exitCode}): ${out.stderr.trim() || out.stdout.trim()}`,
    };
  }
  return { success: true, output: { stdout: out.stdout.trimEnd(), stderr: out.stderr.trimEnd(), exitCode: out.exitCode } };
}

function gitCwd(context: { workingDirectory: string }, rec: Record<string, unknown>): string {
  const sub = optionalString(rec, 'path');
  return sub === undefined ? context.workingDirectory : resolvePath(context.workingDirectory, sub);
}

const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description: 'Show the working-tree status (porcelain v1 plus a branch line).',
  category: ToolCategory.GIT,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const cwd = gitCwd(context, rec);
    const out = runGit(['status', '--porcelain=v1', '-b'], cwd);
    const result = gitResult(out, 'status');
    if (!result.success) return result;
    const lines = (result.output as { stdout: string }).stdout.split('\n').filter((l) => l.length > 0);
    return { ...result, output: { ...result.output, lines } };
  },
};

const gitDiffTool: ToolDefinition = {
  name: 'git_diff',
  description: 'Show changes: working tree, staged, or a specific commit range.',
  category: ToolCategory.GIT,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      staged: { type: 'boolean' },
      ref: { type: 'string' },
      file: { type: 'string' },
    },
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const cwd = gitCwd(context, rec);
    const args = ['diff'];
    if (rec['staged'] === true) args.push('--staged');
    const ref = optionalString(rec, 'ref');
    if (ref !== undefined) args.push(ref);
    const file = optionalString(rec, 'file');
    if (file !== undefined) args.push('--', file);
    return gitResult(runGit(args, cwd), 'diff');
  },
};

const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description: 'Show commit history with an optional count and format.',
  category: ToolCategory.GIT,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      limit: { type: 'number' },
      oneline: { type: 'boolean' },
      file: { type: 'string' },
    },
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const cwd = gitCwd(context, rec);
    const limit = Math.max(1, Math.trunc(optionalNumber(rec, 'limit', 20)));
    const args = ['log', `-${limit}`];
    if (rec['oneline'] !== false) args.push('--oneline');
    const file = optionalString(rec, 'file');
    if (file !== undefined) args.push('--', file);
    return gitResult(runGit(args, cwd), 'log');
  },
};

const gitAddTool: ToolDefinition = {
  name: 'git_add',
  description: 'Stage files by pathspec ("." for everything).',
  category: ToolCategory.GIT,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, files: { type: 'string' } },
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const cwd = gitCwd(context, rec);
    const files = optionalString(rec, 'files') ?? '.';
    return gitResult(runGit(['add', '--', files], cwd), 'add');
  },
};

const gitCommitTool: ToolDefinition = {
  name: 'git_commit',
  description: 'Create a commit from staged changes with a message.',
  category: ToolCategory.GIT,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' }, path: { type: 'string' }, all: { type: 'boolean' } },
    required: ['message'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const cwd = gitCwd(context, rec);
    const message = requireString(rec, 'message');
    const args = ['commit', '-m', message];
    if (rec['all'] === true) args.push('--all');
    return gitResult(runGit(args, cwd), 'commit');
  },
};

const gitBranchTool: ToolDefinition = {
  name: 'git_branch',
  description: 'List branches, or create one when a name is given.',
  category: ToolCategory.GIT,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, name: { type: 'string' } },
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const cwd = gitCwd(context, rec);
    const name = optionalString(rec, 'name');
    if (name === undefined) {
      return gitResult(runGit(['branch'], cwd), 'branch list');
    }
    return gitResult(runGit(['branch', name], cwd), 'branch create');
  },
};

const gitCheckoutTool: ToolDefinition = {
  name: 'git_checkout',
  description: 'Switch branches or restore a file at a ref.',
  category: ToolCategory.GIT,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, ref: { type: 'string' }, file: { type: 'string' }, create: { type: 'boolean' } },
    required: ['ref'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const cwd = gitCwd(context, rec);
    const ref = requireString(rec, 'ref');
    const file = optionalString(rec, 'file');
    const create = rec['create'] === true;
    if (file !== undefined) {
      return gitResult(runGit(['checkout', ref, '--', file], cwd), 'checkout file');
    }
    if (create) {
      return gitResult(runGit(['checkout', '-b', ref], cwd), 'checkout -b');
    }
    return gitResult(runGit(['checkout', ref], cwd), 'checkout');
  },
};

const gitPushTool: ToolDefinition = {
  name: 'git_push',
  description: 'Push commits to a remote and optional branch.',
  category: ToolCategory.GIT,
  requiresApproval: true,
  dangerous: true,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, remote: { type: 'string' }, branch: { type: 'string' } },
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const cwd = gitCwd(context, rec);
    const remote = optionalString(rec, 'remote') ?? 'origin';
    const branch = optionalString(rec, 'branch');
    const args = ['push', remote];
    if (branch !== undefined) args.push(branch);
    return gitResult(runGit(args, cwd), 'push');
  },
};

const gitPullTool: ToolDefinition = {
  name: 'git_pull',
  description: 'Pull from a remote and optional branch.',
  category: ToolCategory.GIT,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, remote: { type: 'string' }, branch: { type: 'string' } },
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const cwd = gitCwd(context, rec);
    const remote = optionalString(rec, 'remote') ?? 'origin';
    const branch = optionalString(rec, 'branch');
    const args = ['pull', remote];
    if (branch !== undefined) args.push(branch);
    return gitResult(runGit(args, cwd), 'pull');
  },
};

const gitShowTool: ToolDefinition = {
  name: 'git_show',
  description: 'Show a commit (or other object) by ref.',
  category: ToolCategory.GIT,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, ref: { type: 'string' } },
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const cwd = gitCwd(context, rec);
    const ref = optionalString(rec, 'ref') ?? 'HEAD';
    return gitResult(runGit(['show', ref], cwd), 'show');
  },
};

export const gitTools: ToolDefinition[] = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitAddTool,
  gitCommitTool,
  gitBranchTool,
  gitCheckoutTool,
  gitPushTool,
  gitPullTool,
  gitShowTool,
];
