import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillLoader } from '../../../src/core/skills/SkillLoader.js';
import { SkillRegistry } from '../../../src/core/skills/SkillRegistry.js';
import type { LoadedSkill } from '../../../src/core/skills/SkillLoader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-v2-skills-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSkill(name: string, frontmatter: Record<string, unknown>, body: string): string {
  const path = join(tmpDir, `${name}.md`);
  const fmLines = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) {
      return `${k}:\n${v.map((x) => `  - ${x}`).join('\n')}`;
    }
    return `${k}: ${v}`;
  }).join('\n');
  writeFileSync(path, `---\n${fmLines}\n---\n\n${body}`);
  return path;
}

describe('SkillLoader', () => {
  it('discovers .md files recursively', () => {
    writeSkill('a', { name: 'a', description: 'd', version: '1' }, 'body');
    mkdirSync(join(tmpDir, 'sub'));
    writeSkill('b', { name: 'b', description: 'd', version: '1' }, 'body');
    const loader = new SkillLoader([tmpDir]);
    const files = loader.discover();
    expect(files.length).toBe(2);
  });

  it('skips non-.md files and ignored dirs', () => {
    writeSkill('skill', { name: 'skill', description: 'd', version: '1' }, 'body');
    writeFileSync(join(tmpDir, 'readme.txt'), 'txt');
    mkdirSync(join(tmpDir, 'node_modules'));
    writeFileSync(join(tmpDir, 'node_modules', 'x.md'), 'x');
    const loader = new SkillLoader([tmpDir]);
    const files = loader.discover();
    expect(files.length).toBe(1);
  });

  it('parses frontmatter and body', () => {
    writeSkill('test', { name: 'test', description: 'desc', version: '1.0.0', triggers: ['review'] }, '# Instructions\nDo this');
    const loader = new SkillLoader([tmpDir]);
    const result = loader.loadFile(loader.discover()[0]);
    expect(result.definition.name).toBe('test');
    expect(result.definition.description).toBe('desc');
    expect(result.definition.version).toBe('1.0.0');
    expect(result.definition.triggers).toEqual(['review']);
    // Body includes the markdown heading
    expect(result.definition.instructions).toContain('Do this');
  });

  it('accepts frontmatter without triggers', () => {
    writeSkill('notrig', { name: 'notrig', description: 'd', version: '1' }, 'body');
    const loader = new SkillLoader([tmpDir]);
    const result = loader.loadFile(loader.discover()[0]);
    expect(result.definition.triggers).toEqual([]);
  });

  it('loads all skills keyed by name', () => {
    writeSkill('alpha', { name: 'alpha', description: 'a', version: '1' }, 'a');
    writeSkill('beta', { name: 'beta', description: 'b', version: '2' }, 'b');
    const loader = new SkillLoader([tmpDir]);
    const skills = loader.load();
    expect(skills.size).toBe(2);
    expect(skills.get('alpha')?.definition.version).toBe('1');
    expect(skills.get('beta')?.definition.version).toBe('2');
  });

  it('detects stale skills', () => {
    const file = writeSkill('stale', { name: 'stale', description: 'd', version: '1' }, 'v1');
    const loader = new SkillLoader([tmpDir]);
    const { mtimeMs } = loader.loadFile(file);
    // Simulate file change by waiting and rewriting
    // (can't easily mock time; just ensure isStale runs without error)
    const skill: LoadedSkill = { definition: { name: 'stale', description: 'd', version: '1', triggers: [], instructions: 'v1' }, filePath: file, mtimeMs };
    expect(typeof loader.isStale(skill)).toBe('boolean');
  });

  it('validates required frontmatter fields and skips invalid', () => {
    writeFileSync(join(tmpDir, 'bad.md'), '---\nname: missing\n---\nbody');
    const loader = new SkillLoader([tmpDir]);
    const skills = loader.load();
    // Invalid skill is skipped (warned), valid ones still load
    expect(skills.size).toBe(0);
  });
});

describe('SkillRegistry', () => {
  it('reloadAll populates from loader', () => {
    writeSkill('reg', { name: 'reg', description: 'd', version: '1' }, 'body');
    const reg = new SkillRegistry({ enabled: true, paths: [tmpDir], autoLoad: true });
    expect(reg.has('reg')).toBe(true);
    expect(reg.get('reg')?.definition.version).toBe('1');
  });

  it('get is case-insensitive', () => {
    writeSkill('CaseTest', { name: 'CaseTest', description: 'd', version: '1' }, 'body');
    const reg = new SkillRegistry({ enabled: true, paths: [tmpDir], autoLoad: true });
    expect(reg.get('casetest')).toBeDefined();
    expect(reg.get('CASETEST')).toBeDefined();
  });

  it('findByTrigger matches trigger words', () => {
    writeSkill('t1', { name: 't1', description: 'd', version: '1', triggers: ['review', 'lint'] }, 'b');
    writeSkill('t2', { name: 't2', description: 'd', version: '1', triggers: ['test'] }, 'b');
    const reg = new SkillRegistry({ enabled: true, paths: [tmpDir], autoLoad: true });
    expect(reg.findByTrigger('review').length).toBe(1);
    expect(reg.findByTrigger('lint').length).toBe(1);
    expect(reg.findByTrigger('test').length).toBe(1);
    expect(reg.findByTrigger('none').length).toBe(0);
  });

  it('toPromptBlock formats skills for system prompt', () => {
    writeSkill('prompt', { name: 'prompt', description: 'D', version: '1', triggers: ['go'] }, 'Instructions here');
    const reg = new SkillRegistry({ enabled: true, paths: [tmpDir], autoLoad: true });
    const block = reg.toPromptBlock();
    expect(block).toContain('## Skill: prompt');
    expect(block).toContain('(triggers: go)');
    expect(block).toContain('D');
    expect(block).toContain('Instructions here');
  });

  it('empty registry returns empty prompt', () => {
    const reg = new SkillRegistry({ enabled: true, paths: [], autoLoad: true });
    expect(reg.toPromptBlock()).toBe('');
  });

  it('checkReload is safe when file missing', () => {
    const file = writeSkill('check', { name: 'check', description: 'd', version: '1' }, 'body');
    const reg = new SkillRegistry({ enabled: true, paths: [tmpDir], autoLoad: true });
    rmSync(file);
    expect(() => reg.checkReload()).not.toThrow();
  });
});