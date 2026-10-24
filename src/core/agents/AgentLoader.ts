import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  AgentDefinition,
  resolveAllowedTools,
} from './types.js';
import { getBuiltInAgents } from './builtInAgents.js';

/**
 * AgentLoader — discovers agent definitions from markdown files.
 *
 * File format (one file per agent, e.g. `~/.agent-v2/agents/reviewer.md`):
 *
 * ---
 * name: reviewer
 * description: Reviews code changes for correctness and security
 * tools: read, grep, bash
 * denied-tools: write, edit
 * ---
 * You are a code reviewer. Focus on correctness, security, and maintainability.
 *
 * The agent TYPE is the frontmatter `name` (falling back to the filename).
 * The `description` is the routing text the parent model reads.
 * The markdown body IS the system prompt.
 */
export class AgentLoader {
  private readonly searchPaths: string[];

  constructor(paths: string[]) {
    this.searchPaths = paths.map((p) =>
      p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
    );
  }

  /** Default search paths: project and user home. */
  static defaultPaths(): string[] {
    return ['.agent-v2/agents', '~/.agent-v2/agents'];
  }

  discover(): string[] {
    const files: string[] = [];
    for (const root of this.searchPaths) {
      if (!existsSync(root)) continue;
      collectMarkdown(root, files);
    }
    return files;
  }

  /** Load built-ins plus any file-defined agents (file agents override built-ins). */
  load(): Map<string, AgentDefinition> {
    const agents = new Map<string, AgentDefinition>();

    for (const def of getBuiltInAgents()) {
      agents.set(def.agentType, def);
    }

    for (const file of this.discover()) {
      try {
        const def = this.loadFile(file);
        agents.set(def.agentType, def);
      } catch (err) {
        console.warn(`Failed to load agent ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return agents;
  }

  loadFile(filePath: string): AgentDefinition {
    const stat = statSync(filePath);
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    const agentType = (frontmatter['name'] as string | undefined) ?? basename(filePath, extname(filePath));
    const description = frontmatter['description'] as string | undefined;

    if (!description) {
      throw new Error(`Agent ${agentType} is missing a 'description' (required for routing)`);
    }

    const tools = parseList(frontmatter['tools']);
    const deniedTools = parseList(frontmatter['denied-tools'] ?? frontmatter['deniedTools']);

    return {
      agentType,
      whenToUse: description,
      tools: tools && tools.length > 0 ? tools : ['*'],
      deniedTools: (deniedTools && deniedTools.length > 0 ? deniedTools : undefined) as string[] | undefined,
      source: 'file',
      baseDir: join(filePath, '..'),
      getSystemPrompt: () => body.trim(),
      model: parseModel(frontmatter),
    };
  }
}

/** Recursively collect .md files, skipping noisy directories. */
function collectMarkdown(root: string, out: string[]): void {
  const ignored = new Set(['node_modules', '.git', 'dist', 'build']);
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    if (dir === undefined) continue;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (extname(entry.name).toLowerCase() === '.md') {
        out.push(full);
      }
    }
  }
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: content };
  let end = 1;
  while (end < lines.length && lines[end]?.trim() !== '---') end++;
  if (end >= lines.length) return { frontmatter: {}, body: content };

  const fmText = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  return { frontmatter: parseSimpleYaml(fmText), body };
}

/**
 * Minimal YAML for frontmatter: `key: value`, comma-separated lists, and
 * block sequences (`- item`). Enough for agent config; not a general parser.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw === undefined) break;
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      i++;
      continue;
    }
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (match) {
      const key = match[1];
      const rest = (match[2] ?? '').trim();
      if (rest === '') {
        // Block sequence
        const items: string[] = [];
        i++;
        while (i < lines.length) {
          const next = lines[i]?.trim();
          if (next === undefined) break;
          if (next.startsWith('- ')) {
            items.push(next.slice(2).trim());
            i++;
          } else break;
        }
        if (key !== undefined) result[key] = items;
        continue;
      }
      if (key !== undefined) {
        result[key] = rest.replace(/^["']|["']$/g, '');
      }
    }
    i++;
  }
  return result;
}

function parseList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}

function parseModel(frontmatter: Record<string, unknown>): AgentDefinition['model'] {
  const provider = frontmatter['model'] as string | undefined;
  if (!provider || provider === 'inherit') return undefined;
  const modelId = frontmatter['model-id'] as string | undefined;
  const out: NonNullable<AgentDefinition['model']> = { apiKey: undefined };
  if (provider) (out as Record<string, unknown>)['provider'] = provider;
  if (modelId) (out as Record<string, unknown>)['modelId'] = modelId;
  return out;
}

export default AgentLoader;
