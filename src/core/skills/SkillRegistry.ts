import { EventEmitter } from 'node:events';
import { SkillLoader, type LoadedSkill } from './SkillLoader.js';
import { SkillsConfig } from '../../types/index.js';
import type { SkillDefinition } from '../../types/index.js';

/**
 * SkillRegistry — owns skill discovery/loading, caches loaded skills,
 * and provides lookup by name or trigger. Emits 'skillLoaded' and
 * 'skillReloaded' events for hot-reload awareness.
 */
export class SkillRegistry extends EventEmitter {
  private readonly loader: SkillLoader;
  private readonly skills = new Map<string, LoadedSkill>();

  constructor(config: SkillsConfig) {
    super();
    this.loader = new SkillLoader(config.paths);
    if (config.autoLoad) {
      this.reloadAll();
    }
  }

  /** Discover, load, and cache all skills from configured paths. */
  reloadAll(): Map<string, LoadedSkill> {
    this.skills.clear();
    const loaded = this.loader.load();
    for (const [name, skill] of loaded) {
      const key = name.toLowerCase();
      this.skills.set(key, skill);
      this.emit('skillLoaded', skill);
    }
    return this.skills;
  }

  /** Check for changed files and reload stale skills. */
  checkReload(): LoadedSkill[] {
    const reloaded: LoadedSkill[] = [];
    for (const [name, skill] of this.skills) {
      const fresh = this.loader.maybeReload(skill);
      if (fresh) {
        const key = name.toLowerCase();
        this.skills.set(key, fresh);
        this.emit('skillReloaded', fresh);
        reloaded.push(fresh);
      }
    }
    return reloaded;
  }

  /** Get a skill by name (case-insensitive). */
  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name.toLowerCase());
  }

  /** Get all loaded skills. */
  getAll(): LoadedSkill[] {
    return [...this.skills.values()];
  }

  /** Find skills whose triggers include the given word. */
  findByTrigger(word: string): LoadedSkill[] {
    const lower = word.toLowerCase();
    return [...this.skills.values()].filter((s) =>
      s.definition.triggers.some((t) => t.toLowerCase() === lower)
    );
  }

  /** Get the SkillDefinition for injection into prompts. */
  getDefinition(name: string): SkillDefinition | undefined {
    return this.get(name)?.definition;
  }

  /** Get all definitions as a prompt-ready string. */
  toPromptBlock(): string {
    if (this.skills.size === 0) return '';
    const blocks = [...this.skills.values()].map((s) => {
      const d = s.definition;
      const triggers = d.triggers.length > 0 ? ` (triggers: ${d.triggers.join(', ')})` : '';
      return `## Skill: ${d.name}${triggers}\n${d.description}\n${d.instructions}`;
    });
    return blocks.join('\n\n');
  }

  /** Whether a skill with this name exists. */
  has(name: string): boolean {
    return this.skills.has(name.toLowerCase());
  }
}

/** Global singleton registry (configured at SessionManager startup). */
let globalRegistry: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry | null {
  return globalRegistry;
}

export function setSkillRegistry(reg: SkillRegistry): void {
  globalRegistry = reg;
}

export default SkillRegistry;