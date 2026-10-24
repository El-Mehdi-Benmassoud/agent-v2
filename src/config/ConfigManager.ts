import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import {
  Config,
  ConfigSchema,
  ModelConfig,
  ModelProvider,
  ModelId,
  PermissionMode,
} from '../types/index.js';

/**
 * ConfigManager — loads, validates, and mutates configuration.
 *
 * Profiles live at `~/.agent-v2/profiles/<profile>/config.json`. The
 * constructor is I/O-free; the first get()/load() call reads (and, when the
 * file is absent, writes) the config. Mutations through set()/update()
 * persist immediately.
 */
export class ConfigManager {
  private config: Config | null = null;
  private readonly configPath: string;
  private readonly profile: string;

  constructor(profile: string = 'default', baseDir?: string) {
    this.profile = profile;
    const root = baseDir ?? join(homedir(), '.agent-v2');
    this.configPath = join(root, 'profiles', profile, 'config.json');
  }

  // ------------------------------------------------------------------
  // Paths
  // ------------------------------------------------------------------

  getProfile(): string {
    return this.profile;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getConfigDir(): string {
    return dirname(this.configPath);
  }

  // ------------------------------------------------------------------
  // Load / save
  // ------------------------------------------------------------------

  /**
   * Load configuration from disk. Missing file → defaults are generated and
   * written immediately (so first use creates the profile). A malformed
   * file is caught, warned about, and replaced by defaults — the original
   * bytes are lost, so back up before debugging.
   */
  load(): Config {
    if (this.config) return this.config;

    if (!existsSync(this.configPath)) {
      this.config = this.getDefaultConfig();
      this.save();
      return this.config;
    }

    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      this.config = ConfigSchema.parse(JSON.parse(raw));
      return this.config;
    } catch (error) {
      console.warn(`Failed to load config at ${this.configPath}, using defaults:`, error);
      this.config = this.getDefaultConfig();
      this.save();
      return this.config;
    }
  }

  /** Persist the in-memory config. Throws when nothing is loaded. */
  save(): void {
    if (!this.config) {
      throw new Error('No configuration to save');
    }
    const dir = this.getConfigDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // 0o600: the config carries the API key; keep it owner-only.
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  /** Current config, loading on first use. Does NOT re-read on later calls. */
  get(): Config {
    if (!this.config) this.load();
    return this.config as Config;
  }

  /** Discard the in-memory cache and re-read from disk. */
  reload(): Config {
    this.config = null;
    return this.load();
  }

  // ------------------------------------------------------------------
  // Mutation
  // ------------------------------------------------------------------

  /** Shallow merge at the top level (nested objects are REPLACED). */
  update(partial: Partial<Config>): Config {
    const current = this.get();
    this.config = { ...current, ...partial };
    this.save();
    return this.config;
  }

  /**
   * Dot-notation setter: set('model.temperature', 0.2).
   *
   * Path validation: intermediate keys must address existing objects, and
   * single-segment keys must be known roots — typos like 'modelx.temperature'
   * throw instead of silently persisting a key the next load() strips. The
   * FINAL key of a dotted path may be new: records (mcpServers.<name>,
   * hooks.<event>) and optional fields (model.apiKey) are legitimately
   * created on first set.
   *
   * Walks a copy-on-write path so the pre-mutation object held by any other
   * caller stays clean; assigns the ROOT at the end (the v1 bug assigned
   * the deepest leaf as the whole config).
   */
  set(path: string, value: unknown): Config {
    const current = this.get();
    const keys = path.split('.');

    if (keys.length === 1) {
      const key = keys[0];
      if (!key || !(key in current)) {
        throw new Error(`Unknown config key '${path}'`);
      }
    } else {
      let probe: unknown = current;
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!key) {
          throw new Error(`Invalid config path '${path}'`);
        }
        if (typeof probe !== 'object' || probe === null || !(key in probe)) {
          throw new Error(`Unknown config path '${keys.slice(0, i + 1).join('.')}'`);
        }
        probe = (probe as Record<string, unknown>)[key];
      }
    }

    const root: Record<string, unknown> = { ...current };

    let target: Record<string, unknown> = root;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!key) continue;

      const existing = target[key];
      if (typeof existing !== 'object' || existing === null) {
        target[key] = {};
      } else {
        target[key] = { ...(existing as Record<string, unknown>) };
      }
      target = target[key] as Record<string, unknown>;
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey) {
      target[lastKey] = value;
    }

    this.config = root as unknown as Config;
    this.save();
    return this.config;
  }

  /** Read a dot-notation path; undefined for any missing branch. */
  getValue<T>(path: string): T | undefined {
    const config = this.get();
    const keys = path.split('.');
    let current: unknown = config;
    for (const key of keys) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current as T | undefined;
  }

  /** Reset to defaults and persist (destroys the API key — no confirmation). */
  reset(): Config {
    this.config = this.getDefaultConfig();
    this.save();
    return this.config;
  }

  // ------------------------------------------------------------------
  // Validation
  // ------------------------------------------------------------------

  /** Validate the in-memory config against the schema. */
  validate(): { valid: boolean; errors: string[] } {
    try {
      ConfigSchema.parse(this.get());
      return { valid: true, errors: [] };
    } catch (error) {
      return validationError(error);
    }
  }

  /**
   * Validate the on-disk FILE without loading it — load() would silently
   * replace a malformed file with defaults, hiding the damage. Use this
   * from doctor/audit paths.
   */
  validateFile(): { valid: boolean; exists: boolean; errors: string[] } {
    if (!existsSync(this.configPath)) {
      return { valid: true, exists: false, errors: [] };
    }
    try {
      ConfigSchema.parse(JSON.parse(readFileSync(this.configPath, 'utf-8')));
      return { valid: true, exists: true, errors: [] };
    } catch (error) {
      const result = validationError(error);
      return { valid: result.valid, exists: true, errors: result.errors };
    }
  }

  // ------------------------------------------------------------------
  // Export / import
  // ------------------------------------------------------------------

  export(): string {
    return JSON.stringify(this.get(), null, 2);
  }

  /**
   * Import a config. The receiver's profile identity always wins over the
   * file's `profile` field (the v1 import-clobbers-profile bug: Zod's
   * default only applies to ABSENT keys, and exports always include one).
   */
  import(json: string): Config {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const merged = { ...parsed, profile: this.profile };
    this.config = ConfigSchema.parse(merged);
    this.save();
    return this.config;
  }

  // ------------------------------------------------------------------
  // Defaults
  // ------------------------------------------------------------------

  /** Whether the config file exists on disk. */
  exists(): boolean {
    return existsSync(this.configPath);
  }

  private getDefaultConfig(): Config {
    return {
      version: 1,
      profile: this.profile,
      model: {
        provider: ModelProvider.ANTHROPIC,
        modelId: ModelId.CLAUDE_SONNET_4,
        maxTokens: 8192,
        temperature: 0.7,
        topP: 0.95,
        reasoningEffort: 'medium',
        maxTurns: 50,
        maxBudgetUsd: 5,
      },
      workspace: {
        rootPath: process.cwd(),
        maxFileSize: 1024 * 1024,
      },
      permissions: {
        mode: PermissionMode.DEFAULT,
        allowedTools: [],
        deniedTools: [],
      },
      ui: {
        theme: 'default',
        showTokenUsage: true,
        showCost: true,
        compactMode: false,
        vimMode: false,
        showLineNumbers: true,
        wrapLongLines: true,
      },
      hooks: {},
      skills: {
        enabled: true,
        paths: ['.agent-v2/skills', '~/.agent-v2/skills'],
        autoLoad: true,
      },
      agents: {
        enabled: true,
        defaultMaxTurns: 50,
        defaultMaxBudgetUsd: 10,
      },
      mcpServers: {},
    };
  }
}

function validationError(error: unknown): { valid: boolean; errors: string[] } {
  if (error instanceof z.ZodError) {
    return {
      valid: false,
      errors: error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  if (error instanceof Error) {
    return { valid: false, errors: [error.message] };
  }
  return { valid: false, errors: ['Unknown validation error'] };
}

/** Convenience helper: model config block for provider construction. */
export function toModelConfig(config: Config): ModelConfig {
  return { ...config.model };
}

export default ConfigManager;
