import { spawnSync } from 'child_process';
import { accessSync, constants as fsConstants } from 'fs';
import { delimiter, join } from 'path';
import type { ToolDefinition } from '../types/index.js';
import { ToolCategory } from '../types/index.js';
import { asRecord, errorMessage, optionalNumber, optionalString, requireString } from './shared.js';

/** Truncate a buffer to ~100KB of text for tool results. */
const MAX_OUTPUT_BYTES = 100 * 1024;

function truncateOutput(buf: Buffer): string {
  if (buf.length <= MAX_OUTPUT_BYTES) return buf.toString('utf-8');
  const head = buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf-8');
  return `${head}\n... [truncated ${buf.length - MAX_OUTPUT_BYTES} bytes]`;
}

// ===========================================================================
// SHELL tools (3)
// ===========================================================================

const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Run a shell command with a timeout, capturing stdout, stderr, and exit code.',
  category: ToolCategory.SHELL,
  requiresApproval: true,
  dangerous: true,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'number' },
      cwd: { type: 'string' },
      env: { type: 'object' },
    },
    required: ['command'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const command = requireString(rec, 'command');
    const timeout = Math.max(1000, Math.trunc(optionalNumber(rec, 'timeout', 120000)));
    const cwd = optionalString(rec, 'cwd')
      ? join(context.workingDirectory, optionalString(rec, 'cwd') as string)
      : context.workingDirectory;
    const extraEnv: Record<string, string> = {};
    if (typeof rec['env'] === 'object' && rec['env'] !== null && !Array.isArray(rec['env'])) {
      for (const [key, value] of Object.entries(rec['env'] as Record<string, unknown>)) {
        if (typeof value === 'string') extraEnv[key] = value;
      }
    }
    try {
      const result = spawnSync(command, {
        shell: true,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'buffer',
        cwd,
        env: { ...process.env, ...extraEnv },
      });
      const stdout = result.stdout ? truncateOutput(result.stdout) : '';
      const stderr = result.stderr ? truncateOutput(result.stderr) : '';
      const exitCode = result.status ?? -1;
      const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      return {
        success: exitCode === 0 && !timedOut,
        output: { stdout, stderr, exitCode, timedOut },
        error:
          timedOut
            ? `Command timed out after ${timeout}ms`
            : exitCode !== 0
              ? stderr || `Command exited with code ${exitCode}`
              : undefined,
        metadata: { exitCode, timedOut },
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const envTool: ToolDefinition = {
  name: 'env',
  description: 'Read environment variables: all, one by name, or those matching a prefix.',
  category: ToolCategory.SHELL,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      prefix: { type: 'string' },
      all: { type: 'boolean' },
    },
  },
  async execute(input) {
    const rec = asRecord(input);
    const name = optionalString(rec, 'name');
    const prefix = optionalString(rec, 'prefix');
    const wantAll = rec['all'] === true;
    if (name) {
      const value = process.env[name];
      if (value === undefined) {
        return { success: false, error: `Environment variable not set: ${name}` };
      }
      return { success: true, output: { name, value } };
    }
    // default: a safe filtered listing unless explicitly all
    const includeAll = wantAll && prefix === undefined;
    if (includeAll) {
      return { success: true, output: { variables: { ...process.env } } };
    }
    if (prefix !== undefined) {
      const filtered: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith(prefix) && value !== undefined) filtered[key] = value;
      }
      return { success: true, output: { variables: filtered } };
    }
    // no args and not all: list only non-sensitive common vars
    const safeKeys = ['PATH', 'HOME', 'SHELL', 'USER', 'PWD', 'LANG', 'TERM'];
    const variables: Record<string, string> = {};
    for (const key of safeKeys) {
      const value = process.env[key];
      if (value !== undefined) variables[key] = value;
    }
    return { success: true, output: { variables } };
  },
};

const whichTool: ToolDefinition = {
  name: 'which',
  description: 'Resolve a command name to its executable path using PATH lookup.',
  category: ToolCategory.SHELL,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  async execute(input) {
    const rec = asRecord(input);
    const command = requireString(rec, 'command');
    try {
      const pathEnv = process.env['PATH'] ?? '';
      const ext = process.platform === 'win32' ? '.exe' : '';
      for (const dir of pathEnv.split(delimiter)) {
        if (dir.length === 0) continue;
        const candidate = join(dir, `${command}${ext}`);
        try {
          accessSync(candidate, fsConstants.X_OK);
          return { success: true, output: { command, path: candidate } };
        } catch {
          continue;
        }
      }
      return { success: false, error: `Command not found on PATH: ${command}` };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

export const shellTools: ToolDefinition[] = [bashTool, envTool, whichTool];
