import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { ProfileManager } from '../../../src/config/ProfileManager.js';

/** Fresh isolated baseDir per test — hermetic, no real ~/.agent-v2 touched. */
function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), 'agentv2-cfg-'));
}

describe('ConfigManager', () => {
  let base: string;

  beforeEach(() => {
    base = tmpBase();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('lazily creates the profile dir and config on first load', () => {
    const cm = new ConfigManager('default', base);
    const cfg = cm.load();
    expect(cfg.profile).toBe('default');
    expect(cfg.model.provider).toBe('anthropic');
    expect(existsSync(join(base, 'profiles', 'default', 'config.json'))).toBe(true);
  });

  it('get() returns the same instance without re-reading disk', () => {
    const cm = new ConfigManager('default', base);
    expect(cm.get()).toBe(cm.get());
  });

  it('set() persists immediately to disk', () => {
    const cm = new ConfigManager('default', base);
    cm.set('model.temperature', 0.2);
    const raw = JSON.parse(readFileSync(join(base, 'profiles', 'default', 'config.json'), 'utf-8'));
    expect(raw.model.temperature).toBe(0.2);
  });

  it('set() with a root key reference updates the whole object', () => {
    const cm = new ConfigManager('default', base);
    const model = cm.get().model;
    cm.set('model', model);
    expect(cm.get().model.modelId).toBe(model.modelId);
  });

  it('set() on an unknown top-level key is rejected', () => {
    const cm = new ConfigManager('default', base);
    expect(() => cm.set('nonexistent.key', 1)).toThrow();
  });

  it('get() after external file change still returns the cached config (reload() re-reads)', () => {
    const cm = new ConfigManager('default', base);
    cm.load();
    const file = join(base, 'profiles', 'default', 'config.json');
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    raw.model.temperature = 0.9;
    writeFileSync(file, JSON.stringify(raw));
    // get() serves the cache — same object as before
    expect(cm.get().model.temperature).toBe(0.7);
    // reload() re-reads and picks up the change
    expect(cm.reload().model.temperature).toBe(0.9);
  });

  it('validateFile() reports errors for a corrupt file without loading it', () => {
    const cm = new ConfigManager('default', base);
    cm.load();
    const file = join(base, 'profiles', 'default', 'config.json');
    writeFileSync(file, JSON.stringify({ version: 1, profile: 'default', model: { provider: 42 } }));
    const v = cm.validateFile();
    expect(v.exists).toBe(true);
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('reset() restores defaults and persists', () => {
    const cm = new ConfigManager('default', base);
    cm.set('model.temperature', 0.9);
    cm.reset();
    const raw = JSON.parse(readFileSync(join(base, 'profiles', 'default', 'config.json'), 'utf-8'));
    expect(raw.model.temperature).toBeGreaterThan(0.2);
    expect(raw.model.temperature).not.toBe(0.9);
  });

  it('getValue() resolves dotted paths', () => {
    const cm = new ConfigManager('default', base);
    expect(cm.getValue('model.modelId')).toBe(cm.get().model.modelId);
    expect(cm.getValue('permissions.mode')).toBe(cm.get().permissions.mode);
    expect(cm.getValue('model.nonexistent')).toBeUndefined();
  });
});

describe('ProfileManager', () => {
  let base: string;

  beforeEach(() => {
    base = tmpBase();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('list() shows default once created', () => {
    const pm = new ProfileManager(base);
    new ConfigManager('default', base).load();
    expect(pm.list()).toEqual(['default']);
  });

  it('create() clones from an existing profile', () => {
    const src = new ConfigManager('default', base);
    src.set('model.temperature', 0.42);
    const pm = new ProfileManager(base);
    const cfg = pm.create('work', 'default');
    expect(cfg.model.temperature).toBe(0.42);
    expect(pm.list()).toContain('work');
  });

  it('create() rejects duplicates', () => {
    const pm = new ProfileManager(base);
    pm.create('default');
    pm.create('work');
    expect(() => pm.create('work')).toThrow(/already exists/);
  });

  it('delete() refuses the default profile and the active profile', () => {
    const pm = new ProfileManager(base, 'scratch');
    pm.create('default');
    pm.create('scratch');
    expect(() => pm.delete('default')).toThrow(/Cannot delete the default/);
    expect(() => pm.delete('scratch')).toThrow(/active/);
    // A non-active, non-default profile deletes fine
    pm.create('temp');
    expect(pm.delete('temp')).toBe(true);
    expect(pm.exists('temp')).toBe(false);
  });

  it('rename() moves the directory and updates identity', () => {
    const pm = new ProfileManager(base, 'default');
    pm.create('default');
    pm.create('old');
    const cfg = pm.rename('old', 'new');
    expect(cfg.profile).toBe('new');
    expect(pm.exists('old')).toBe(false);
    expect(pm.exists('new')).toBe(true);
  });

  it('export/import round-trips a profile and forces the new identity', () => {
    const pm = new ProfileManager(base);
    const src = pm.create('default');
    src.model.temperature = 0.55;
    // Persist the mutation through the manager, not the in-memory object
    new ConfigManager('default', base).set('model.temperature', 0.55);
    const out = join(base, 'exported.json');
    pm.exportToFile('default', out);
    const cfg = pm.importFromFile(out, 'imported');
    expect(cfg.model.temperature).toBe(0.55);
    // The imported profile's identity is forced to the new name
    expect(cfg.profile).toBe('imported');
  });
});
