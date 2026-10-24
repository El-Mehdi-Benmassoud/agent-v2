import { existsSync, readdirSync, rmSync, cpSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { ConfigManager } from './ConfigManager.js';
import { Config } from '../types/index.js';

/**
 * ProfileManager — create, list, clone, rename, and delete configuration
 * profiles. Each profile is a directory under `<baseDir>/profiles/<name>/`
 * containing its own `config.json`.
 */
export class ProfileManager {
  private readonly baseDir: string;
  private activeProfile: string;

  constructor(baseDir?: string, activeProfile = 'default') {
    this.baseDir = baseDir ?? join(homedir(), '.agent-v2');
    this.activeProfile = activeProfile;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getActiveProfile(): string {
    return this.activeProfile;
  }

  setActiveProfile(name: string): void {
    this.activeProfile = name;
  }

  private profilesDir(): string {
    return join(this.baseDir, 'profiles');
  }

  private profileDir(name: string): string {
    return join(this.profilesDir(), name);
  }

  private configFile(name: string): string {
    return join(this.profileDir(name), 'config.json');
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /** All profile names that have a config.json on disk. */
  list(): string[] {
    const dir = this.profilesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'config.json')))
      .map((entry) => entry.name)
      .sort();
  }

  exists(name: string): boolean {
    return existsSync(this.configFile(name));
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Create a profile. When `from` is given, the source profile's config is
   * copied instead of generating defaults.
   */
  create(name: string, from?: string): Config {
    if (name === 'default' && this.exists('default')) {
      throw new Error("The 'default' profile always exists");
    }
    if (this.exists(name)) {
      throw new Error(`Profile '${name}' already exists`);
    }
    if (from !== undefined && !this.exists(from)) {
      throw new Error(`Source profile '${from}' does not exist`);
    }

    const dir = this.profileDir(name);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (from !== undefined) {
      copyFileSync(this.configFile(from), this.configFile(name));
    }

    const manager = new ConfigManager(name, this.baseDir);
    const config = manager.load();
    // The copied file carries the SOURCE profile's identity; force ours
    // before anything else reads it (same class of bug as v1's import).
    if (config.profile !== name) {
      return manager.set('profile', name);
    }
    manager.save();
    return config;
  }

  delete(name: string): boolean {
    if (name === 'default') {
      throw new Error('Cannot delete the default profile');
    }
    if (!this.exists(name)) {
      throw new Error(`Profile '${name}' does not exist`);
    }
    if (name === this.activeProfile) {
      throw new Error(`Cannot delete the active profile '${name}'`);
    }
    rmSync(this.profileDir(name), { recursive: true, force: true });
    return true;
  }

  rename(oldName: string, newName: string): Config {
    if (!this.exists(oldName)) {
      throw new Error(`Profile '${oldName}' does not exist`);
    }
    if (this.exists(newName)) {
      throw new Error(`Profile '${newName}' already exists`);
    }
    if (newName === 'default') {
      throw new Error('Cannot rename to the default profile');
    }

    const sourceDir = this.profileDir(oldName);
    const targetDir = this.profileDir(newName);
    cpSync(sourceDir, targetDir, { recursive: true });

    // Fix the profile identity inside the copied config.
    const manager = new ConfigManager(newName, this.baseDir);
    const config = manager.set('profile', newName);
    manager.save();

    rmSync(sourceDir, { recursive: true, force: true });

    if (this.activeProfile === oldName) {
      this.activeProfile = newName;
    }
    return config;
  }

  /** Clone an existing profile to a new name (source is preserved). */
  clone(sourceName: string, targetName: string): Config {
    if (!this.exists(sourceName)) {
      throw new Error(`Source profile '${sourceName}' does not exist`);
    }
    return this.create(targetName, sourceName);
  }

  // ------------------------------------------------------------------
  // Import / export
  // ------------------------------------------------------------------

  /** Export a profile's config to a file. */
  exportToFile(name: string, filePath: string): void {
    if (!this.exists(name)) {
      throw new Error(`Profile '${name}' does not exist`);
    }
    const targetDir = dirname(filePath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    copyFileSync(this.configFile(name), filePath);
  }

  /** Import a profile from an exported config file. */
  importFromFile(filePath: string, name: string): Config {
    if (!existsSync(filePath)) {
      throw new Error(`Import file not found: ${filePath}`);
    }
    if (this.exists(name)) {
      throw new Error(`Profile '${name}' already exists`);
    }

    const dir = this.profileDir(name);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    copyFileSync(filePath, this.configFile(name));

    const manager = new ConfigManager(name, this.baseDir);
    const config = manager.load();
    // Imported files carry the source profile's identity; force ours (the
    // v1 import-clobbers-profile bug — Zod defaults don't apply to keys
    // that are merely WRONG, only to ABSENT ones).
    if (config.profile !== name) {
      return manager.set('profile', name);
    }
    return config;
  }

  /** Totals for the config directory of one profile. */
  stats(name: string): { exists: boolean; sizeBytes: number; modifiedAt: Date | null } {
    const file = this.configFile(name);
    if (!existsSync(file)) {
      return { exists: false, sizeBytes: 0, modifiedAt: null };
    }
    const stats = statSync(file);
    return { exists: true, sizeBytes: stats.size, modifiedAt: stats.mtime };
  }
}

export default ProfileManager;
