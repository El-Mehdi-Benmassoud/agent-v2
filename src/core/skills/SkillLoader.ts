import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import {
  SkillDefinition,
  SkillFrontmatter,
  SkillDefinitionSchema,
  SkillFrontmatterSchema,
} from '../../types/index.js';

/** A skill's source file and parsed definition. */
export interface LoadedSkill {
  definition: SkillDefinition;
  filePath: string;
  /** Unix mtime of the source file for hot-reload checks. */
  mtimeMs: number;
}

/**
 * SkillLoader — discovers .md skill files from configured directories,
 * parses YAML frontmatter + markdown body, and returns validated
 * SkillDefinition objects.
 *
 * Convention (Claude Code style): each skill is a .md file with
 * frontmatter containing name, description, version, triggers (optional),
 * followed by markdown instructions. Example:
 *
 * ---
 * name: code-review
 * description: Reviews code changes for quality and security
 * version: 1.0.0
 * triggers: [ 'review', 'pr' ]
 * ---
 * # Instructions
 * When asked to review...
 */
export class SkillLoader {
  private readonly searchPaths: string[];

  constructor(paths?: string[]) {
    this.searchPaths = (paths ?? []).map((p) =>
      p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
    );
  }

  /** Discover all .md files under the search paths. */
  discover(): string[] {
    const files: string[] = [];
    for (const root of this.searchPaths) {
      if (!existsSync(root)) continue;
      files.push(...walkForMarkdown(root));
    }
    return files;
  }

  /**
   * Load and validate all skills from the search paths.
   * Returns loaded skills keyed by name; later paths override earlier.
   */
  load(): Map<string, LoadedSkill> {
    const skills = new Map<string, LoadedSkill>();
    for (const file of this.discover()) {
      try {
        const { definition, mtimeMs } = this.loadFile(file);
        skills.set(definition.name, { definition, filePath: file, mtimeMs });
      } catch (err) {
        // Invalid skill file — log and continue; don't block other skills.
        console.warn(`Failed to load skill ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return skills;
  }

  /** Load a single skill file; throws if invalid. */
  loadFile(filePath: string): LoadedSkill {
    const stat = statSync(filePath);
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    // Validate frontmatter structure.
    const parsed = SkillFrontmatterSchema.parse(frontmatter);

    // Build the full definition.
    const definition: SkillDefinition = {
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      triggers: parsed.triggers ?? [],
      instructions: body.trim(),
      examples: [], // could be parsed from body sections if needed
      metadata: {
        filePath,
        ...parsed,
      },
    };

    // Full validation (includes body constraints if any).
    SkillDefinitionSchema.parse(definition);

    return { definition, filePath, mtimeMs: stat.mtimeMs };
  }

  /**
   * Check if a loaded skill needs reloading (file changed on disk).
   * Returns true when the file's mtime is newer than the recorded one.
   */
  isStale(skill: LoadedSkill): boolean {
    try {
      const stat = statSync(skill.filePath);
      return stat.mtimeMs > skill.mtimeMs;
    } catch {
      return false;
    }
  }

  /** Reload a single skill if its file changed. */
  maybeReload(skill: LoadedSkill): LoadedSkill | null {
    if (!this.isStale(skill)) return null;
    try {
      return this.loadFile(skill.filePath);
    } catch {
      return null;
    }
  }
}

function walkForMarkdown(root: string): string[] {
  const results: string[] = [];
  const queue = [root];
  const ignored = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache']);

  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // permission error — skip
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (extname(entry.name).toLowerCase() === '.md') {
        results.push(full);
      }
    }
  }
  return results;
}

/** Parse YAML frontmatter from a markdown file. */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content };
  }
  let end = 1;
  while (end < lines.length && lines[end]?.trim() !== '---') end++;
  if (end >= lines.length) {
    return { frontmatter: {}, body: content };
  }
  const fmText = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  const frontmatter = parseYaml(fmText);
  return { frontmatter, body };
}

/** Minimal YAML parser for frontmatter (strings, arrays, primitives). */
function parseYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    if (rawLine === undefined) break;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      i++;
      continue;
    }
    // Array item
    if (line.startsWith('- ')) {
      // Arrays are not top-level in frontmatter typically; skip for simplicity.
      i++;
      continue;
    }
    // Key: value
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (match) {
      const keyStr = match[1];
      const val = match[2]?.trim() ?? '';
      // Check if next lines are array items
      if (val === '' || val === '[') {
        const arr: string[] = [];
        i++;
        while (i < lines.length) {
          const nextRaw = lines[i];
          if (nextRaw === undefined) break;
          const next = nextRaw.trim();
          if (next.startsWith('- ')) {
            arr.push(next.slice(2).trim());
            i++;
          } else {
            break;
          }
        }
        result[keyStr!] = arr;
        continue;
      }
      // Strip quotes
      if (keyStr) {
        result[keyStr] = val.replace(/^["']|["']$/g, '');
      }
    }
    i++;
  }
  return result;
}

export default SkillLoader;