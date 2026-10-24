import { promises as fsPromises } from 'fs';
import { dirname, join, relative, sep } from 'path';
import type { ToolDefinition } from '../types/index.js';
import { ToolCategory } from '../types/index.js';
import {
  asRecord,
  errorMessage,
  isIgnoredDirName,
  optionalBool,
  optionalNumber,
  optionalString,
  requireString,
  resolvePath,
} from './shared.js';

// ===========================================================================
// Tree walking with default ignores
// (v1 perf lesson: grep over an unfiltered tree took 15.7s; with these
// prunes it takes 0.12s)
// ===========================================================================

export interface FileEntry {
  /** Path relative to the search root, POSIX separators. */
  path: string;
  absolutePath: string;
  isDirectory: boolean;
}

function toPosix(p: string): string {
  return sep === '\\' ? p.split(sep).join('/') : p;
}

/** Walk a directory tree, pruning the default-ignored directory names. */
export async function walkTree(root: string, options?: { maxFiles?: number }): Promise<FileEntry[]> {
  const maxFiles = options?.maxFiles ?? 10000;
  const out: FileEntry[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop();
    if (!dir) break;
    let dirents: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      dirents = (await fsPromises.readdir(dir, { withFileTypes: true })) as never;
    } catch {
      continue; // unreadable dir: skip silently
    }
    for (const dirent of dirents) {
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (isIgnoredDirName(dirent.name)) continue;
        out.push({ path: toPosix(relative(root, abs)), absolutePath: abs, isDirectory: true });
        stack.push(abs);
      } else if (dirent.isFile()) {
        out.push({ path: toPosix(relative(root, abs)), absolutePath: abs, isDirectory: false });
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

/** True when a relative (POSIX) path passes through a default-ignored dir. */
export function touchesIgnoredDir(relPath: string): boolean {
  for (const part of relPath.split('/')) {
    if (isIgnoredDirName(part)) return true;
  }
  return false;
}

/** Minimal glob matcher supporting *, ?, **, and {a,b} brace expansion. */
export function globMatch(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === undefined) break;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*'; // '**/' -> zero or more whole segments
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i += 1;
      } else {
        const alts = pattern
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else if ('\\.*+^${}()|[]'.includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// ===========================================================================
// FILE_SYSTEM tools (18)
// ===========================================================================

const readTool: ToolDefinition = {
  name: 'read',
  description: 'Read a file, optionally limited by 0-based line offset and line count.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['path'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    const offset = Math.max(0, Math.trunc(optionalNumber(rec, 'offset', 0)));
    const limitRaw = optionalNumber(rec, 'limit', Number.POSITIVE_INFINITY);
    try {
      const stat = await fsPromises.stat(target);
      if (!stat.isFile()) {
        return { success: false, error: `Not a file: ${target}` };
      }
      const content = await fsPromises.readFile(target, 'utf-8');
      const lines = content.split('\n');
      const end =
        limitRaw === Number.POSITIVE_INFINITY
          ? lines.length
          : Math.min(lines.length, offset + Math.trunc(limitRaw));
      const selected = lines.slice(offset, end);
      return {
        success: true,
        output: {
          path: target,
          content: selected.join('\n'),
          totalLines: lines.length,
          offset,
          linesRead: selected.length,
        },
        metadata: { totalLines: lines.length, bytes: stat.size },
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const readMultipleTool: ToolDefinition = {
  name: 'read_multiple',
  description: 'Read multiple files in one call, returning per-file content or error.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { paths: { type: 'array' } },
    required: ['paths'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const paths = rec['paths'];
    if (!Array.isArray(paths)) {
      return { success: false, error: 'Input must include a "paths" array' };
    }
    const files: Array<{ path: string; content?: string; error?: string }> = [];
    let failed = 0;
    for (const raw of paths) {
      if (typeof raw !== 'string') {
        failed++;
        files.push({ path: String(raw), error: 'path must be a string' });
        continue;
      }
      const target = resolvePath(context.workingDirectory, raw);
      try {
        const content = await fsPromises.readFile(target, 'utf-8');
        files.push({ path: target, content });
      } catch (error) {
        failed++;
        files.push({ path: target, error: errorMessage(error) });
      }
    }
    return {
      success: failed === 0,
      output: { files },
      error: failed > 0 ? `${failed} of ${paths.length} files could not be read` : undefined,
      metadata: { total: paths.length, failed },
    };
  },
};

const writeTool: ToolDefinition = {
  name: 'write',
  description: 'Write a file, creating parent directories, truncating or creating as needed.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    const content = requireString(rec, 'content');
    try {
      await fsPromises.mkdir(dirname(target), { recursive: true });
      await fsPromises.writeFile(target, content, 'utf-8');
      const bytes = Buffer.byteLength(content, 'utf-8');
      return { success: true, output: { path: target, bytes }, metadata: { bytes } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const writeAppendTool: ToolDefinition = {
  name: 'write_append',
  description: 'Append content to the end of a file, creating it when absent.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    const content = requireString(rec, 'content');
    try {
      await fsPromises.mkdir(dirname(target), { recursive: true });
      await fsPromises.appendFile(target, content, 'utf-8');
      return { success: true, output: { path: target, appended: content.length } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const editTool: ToolDefinition = {
  name: 'edit',
  description:
    'Replace one occurrence of oldString with newString; refuses ambiguous matches unless replaceAll is true.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldString: { type: 'string' },
      newString: { type: 'string' },
      replaceAll: { type: 'boolean' },
    },
    required: ['path', 'oldString', 'newString'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    const oldString = requireString(rec, 'oldString');
    const newString = requireString(rec, 'newString');
    const replaceAll = optionalBool(rec, 'replaceAll', false);
    try {
      const content = await fsPromises.readFile(target, 'utf-8');
      const count = countOccurrences(content, oldString);
      if (oldString.length === 0 || count === 0) {
        return { success: false, error: `oldString not found in ${target}` };
      }
      if (count > 1 && !replaceAll) {
        return {
          success: false,
          error: `oldString matches ${count} locations in ${target}; pass replaceAll: true or provide a longer unique string`,
        };
      }
      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);
      await fsPromises.writeFile(target, updated, 'utf-8');
      const replacements = replaceAll ? count : 1;
      return { success: true, output: { path: target, replacements }, metadata: { replacements } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const replaceTool: ToolDefinition = {
  name: 'replace',
  description: 'Replace occurrences of a regex pattern in a file with a replacement string.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      pattern: { type: 'string' },
      replacement: { type: 'string' },
      flags: { type: 'string' },
      all: { type: 'boolean' },
    },
    required: ['path', 'pattern', 'replacement'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    const pattern = requireString(rec, 'pattern');
    const replacement = requireString(rec, 'replacement');
    const flags = optionalString(rec, 'flags') ?? '';
    const all = optionalBool(rec, 'all', true);
    try {
      const content = await fsPromises.readFile(target, 'utf-8');
      const re = new RegExp(pattern, all ? `${flags}g` : flags);
      const updated = content.replace(re, replacement);
      await fsPromises.writeFile(target, updated, 'utf-8');
      return { success: true, output: { path: target } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const patchTool: ToolDefinition = {
  name: 'patch',
  description: 'Apply a simple line-based patch: minus/context lines are replaced by plus lines.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, patch: { type: 'string' } },
    required: ['path', 'patch'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    const patchText = requireString(rec, 'patch');
    try {
      const content = await fsPromises.readFile(target, 'utf-8');
      const updated = applySimplePatch(content, patchText);
      if (updated === null) {
        return { success: false, error: 'Patch did not apply cleanly: no hunk matched' };
      }
      await fsPromises.writeFile(target, updated, 'utf-8');
      return { success: true, output: { path: target } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

/**
 * Apply a minimal single-file patch: each hunk line is `- old`, `+ new` or
 * ` context`. All minus/context lines must appear consecutively in the file;
 * the matched block is replaced by the plus lines. Returns null on no match.
 */
function applySimplePatch(content: string, patchText: string): string | null {
  const minusLines: string[] = [];
  const plusLines: string[] = [];
  for (const rawLine of patchText.split('\n')) {
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ') || rawLine.startsWith('@@')) continue;
    if (rawLine.startsWith('-')) minusLines.push(rawLine.slice(1));
    else if (rawLine.startsWith('+')) plusLines.push(rawLine.slice(1));
    else if (rawLine.startsWith(' ')) minusLines.push(rawLine.slice(1));
  }
  if (minusLines.length === 0 && plusLines.length === 0) return null;
  const lines = content.split('\n');
  outer: for (let start = 0; start <= lines.length - minusLines.length; start++) {
    for (let j = 0; j < minusLines.length; j++) {
      const expected = minusLines[j];
      const actual = lines[start + j];
      if (expected === undefined || actual === undefined || actual !== expected) continue outer;
    }
    const before = lines.slice(0, start);
    const after = lines.slice(start + minusLines.length);
    return [...before, ...plusLines, ...after].join('\n');
  }
  return null;
}

const listTool: ToolDefinition = {
  name: 'list',
  description: 'List entries of a directory (name, type), non-recursively.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    try {
      const dirents = await fsPromises.readdir(target, { withFileTypes: true });
      const entries = dirents
        .filter((d) => !isIgnoredDirName(d.name))
        .map((d) => ({
          name: d.name,
          type: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other',
        }));
      return { success: true, output: { path: target, entries }, metadata: { count: entries.length } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const globTool: ToolDefinition = {
  name: 'glob',
  description: 'Find files matching a glob pattern, skipping default-ignored directories.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { pattern: { type: 'string' }, path: { type: 'string' } },
    required: ['pattern'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const pattern = requireString(rec, 'pattern');
    const root = resolvePath(context.workingDirectory, optionalString(rec, 'path') ?? '.');
    try {
      const entries = await walkTree(root);
      const matches = entries
        .filter((e) => !e.isDirectory)
        .filter((e) => !touchesIgnoredDir(e.path))
        .filter((e) => globMatch(pattern, e.path) || globMatch(pattern, `**/${e.path}`));
      return {
        success: true,
        output: { matches: matches.map((m) => m.path) },
        metadata: { count: matches.length },
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const grepTool: ToolDefinition = {
  name: 'grep',
  description: 'Search file contents for a pattern, returning matches with line and column numbers.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      regex: { type: 'boolean' },
      maxResults: { type: 'number' },
    },
    required: ['pattern'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const pattern = requireString(rec, 'pattern');
    const root = resolvePath(context.workingDirectory, optionalString(rec, 'path') ?? '.');
    const useRegex = optionalBool(rec, 'regex', false);
    const maxResults = Math.max(1, Math.trunc(optionalNumber(rec, 'maxResults', 200)));
    let re: RegExp | undefined;
    if (useRegex) {
      try {
        re = new RegExp(pattern);
      } catch (error) {
        return { success: false, error: `Invalid regex: ${errorMessage(error)}` };
      }
    }
    try {
      const entries = await walkTree(root);
      const matches: Array<{
        path: string;
        line: number;
        column: number;
        text: string;
        match: string;
      }> = [];
      let truncated = false;
      for (const entry of entries) {
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        if (entry.isDirectory) continue;
        if (touchesIgnoredDir(entry.path)) continue;
        let content: string;
        try {
          content = await fsPromises.readFile(entry.absolutePath, 'utf-8');
        } catch {
          continue; // binary or unreadable
        }
        const lines = content.split('\n');
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];
          if (line === undefined) continue;
          let idx: number;
          let matched: string;
          if (re) {
            const m = line.match(re);
            if (!m) continue;
            idx = m.index ?? 0;
            matched = m[0] ?? '';
          } else {
            idx = line.indexOf(pattern);
            if (idx === -1) continue;
            matched = pattern;
          }
          matches.push({
            path: entry.path,
            line: lineIdx + 1,
            column: idx + 1,
            text: line,
            match: matched,
          });
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }
        }
      }
      return {
        success: true,
        output: { matches, truncated },
        metadata: { count: matches.length, truncated },
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const findTool: ToolDefinition = {
  name: 'find',
  description: 'Find files or directories by name substring or glob, skipping ignored directories.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { pattern: { type: 'string' }, path: { type: 'string' }, type: { type: 'string' } },
    required: ['pattern'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const pattern = requireString(rec, 'pattern');
    const root = resolvePath(context.workingDirectory, optionalString(rec, 'path') ?? '.');
    const typeFilter = optionalString(rec, 'type');
    try {
      const entries = await walkTree(root);
      const matches = entries
        .filter((e) => !touchesIgnoredDir(e.path))
        .filter((e) => {
          if (typeFilter === 'file' && e.isDirectory) return false;
          if (typeFilter === 'directory' && !e.isDirectory) return false;
          return (
            e.path.includes(pattern) ||
            globMatch(pattern, e.path) ||
            globMatch(pattern, `**/${e.path}`)
          );
        })
        .map((e) => ({ path: e.path, type: e.isDirectory ? 'directory' : 'file' }));
      return { success: true, output: { matches }, metadata: { count: matches.length } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const fileInfoTool: ToolDefinition = {
  name: 'file_info',
  description: 'Get metadata about a file or directory: size, timestamps, permissions.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    try {
      const stat = await fsPromises.stat(target);
      const info = {
        path: target,
        type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        mode: (stat.mode & 0o777).toString(8),
      };
      return { success: true, output: info, metadata: { size: stat.size } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const headTool: ToolDefinition = {
  name: 'head',
  description: 'Read the first N lines of a file.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, lines: { type: 'number' } },
    required: ['path'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    const lineCount = Math.max(1, Math.trunc(optionalNumber(rec, 'lines', 10)));
    try {
      const content = await fsPromises.readFile(target, 'utf-8');
      const lines = content.split('\n').slice(0, lineCount);
      return {
        success: true,
        output: { path: target, content: lines.join('\n'), lines: lines.length },
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const mkdirTool: ToolDefinition = {
  name: 'mkdir',
  description: 'Create a directory including any missing parents.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
    required: ['path'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    const recursive = optionalBool(rec, 'recursive', true);
    try {
      await fsPromises.mkdir(target, { recursive });
      return { success: true, output: { path: target } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const touchTool: ToolDefinition = {
  name: 'touch',
  description: 'Create an empty file if absent; update timestamp when it already exists.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    try {
      const existed = await fsPromises
        .stat(target)
        .then(() => true)
        .catch(() => false);
      await fsPromises.mkdir(dirname(target), { recursive: true });
      const handle = await fsPromises.open(target, 'a');
      await handle.close();
      return { success: true, output: { path: target, created: !existed } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const deleteTool: ToolDefinition = {
  name: 'delete',
  description: 'Delete a file, or a directory tree when recursive is true.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: true,
  dangerous: true,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
    required: ['path'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const target = resolvePath(context.workingDirectory, requireString(rec, 'path'));
    const recursive = optionalBool(rec, 'recursive', false);
    try {
      const stat = await fsPromises.stat(target);
      if (stat.isDirectory() && !recursive) {
        return {
          success: false,
          error: `${target} is a directory; pass recursive: true to delete it`,
        };
      }
      await fsPromises.rm(target, { recursive, force: false });
      return { success: true, output: { path: target } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const copyTool: ToolDefinition = {
  name: 'copy',
  description: 'Copy a file or directory tree to a destination path.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { source: { type: 'string' }, destination: { type: 'string' } },
    required: ['source', 'destination'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const source = resolvePath(context.workingDirectory, requireString(rec, 'source'));
    const destination = resolvePath(context.workingDirectory, requireString(rec, 'destination'));
    try {
      const stat = await fsPromises.stat(source);
      await fsPromises.cp(source, destination, { recursive: stat.isDirectory(), force: true });
      return { success: true, output: { source, destination } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

const moveTool: ToolDefinition = {
  name: 'move',
  description: 'Move or rename a file or directory to a destination path.',
  category: ToolCategory.FILE_SYSTEM,
  requiresApproval: true,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: { source: { type: 'string' }, destination: { type: 'string' } },
    required: ['source', 'destination'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const source = resolvePath(context.workingDirectory, requireString(rec, 'source'));
    const destination = resolvePath(context.workingDirectory, requireString(rec, 'destination'));
    try {
      await fsPromises.mkdir(dirname(destination), { recursive: true });
      await fsPromises.rename(source, destination);
      return { success: true, output: { source, destination } };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

export const fileSystemTools: ToolDefinition[] = [
  readTool,
  readMultipleTool,
  writeTool,
  writeAppendTool,
  editTool,
  replaceTool,
  patchTool,
  listTool,
  globTool,
  grepTool,
  findTool,
  fileInfoTool,
  headTool,
  mkdirTool,
  touchTool,
  deleteTool,
  copyTool,
  moveTool,
];

export { readTool, globTool, grepTool };
