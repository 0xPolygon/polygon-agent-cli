import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildSkillIndex, SKILL_INDEX_PATH, writeSkillIndex } from './skills-index.ts';

const REPO_SKILLS = path.resolve(import.meta.dirname, '..', '..', 'skills');

const made: string[] = [];
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function skillsDir(files: Record<string, string>): string {
  const dir = tmpDir('skills-index-');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

const skill = (name: string, description = 'Does a thing.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

describe('skill index', () => {
  it("lists the repo's setup.md and every skill, by the paths they're served at", () => {
    const index = buildSkillIndex(REPO_SKILLS);
    expect(index.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
    expect(index.skills.map((s) => [s.name, s.url])).toEqual([
      ['polygon-oms-setup', '/setup.md'],
      ['polygon-agent-cli', '/polygon-agent-cli/SKILL.md'],
      ['polygon-defi', '/polygon-defi/SKILL.md'],
      ['polygon-discovery', '/polygon-discovery/SKILL.md'],
      ['polygon-oms-wallet', '/polygon-oms-wallet/SKILL.md'],
      ['polymarket-skill', '/polygon-polymarket/SKILL.md']
    ]);
    for (const entry of index.skills) {
      expect(entry.type).toBe('skill-md');
      expect(entry.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(1024);
    }
  });

  it('reads folded descriptions, and digests the exact bytes served', () => {
    const dir = skillsDir({
      'a-skill/SKILL.md': '---\nname: a-skill\ndescription: >-\n  One line,\n  folded.\n---\nBody\n'
    });
    const [entry] = buildSkillIndex(dir).skills;
    expect(entry.description).toBe('One line, folded.');
    // From sha256sum of the same bytes.
    expect(entry.digest).toBe(
      'sha256:ffb51729891b7a451b464e24e5328ad175735e45697e99cf650f67a8b48d5f51'
    );
  });

  it('refuses a skill whose name breaks the naming rule', () => {
    for (const name of ['Bad_Name', '-a', 'a--b', 'a'.repeat(65)]) {
      expect(() => buildSkillIndex(skillsDir({ 'a/SKILL.md': skill(name) }))).toThrow(
        /invalid name/
      );
    }
  });

  it('refuses a skill without a description, or without frontmatter', () => {
    expect(() => buildSkillIndex(skillsDir({ 'a/SKILL.md': '---\nname: a\n---\n' }))).toThrow(
      /missing description/
    );
    expect(() => buildSkillIndex(skillsDir({ 'a/SKILL.md': '# a\n' }))).toThrow(/no frontmatter/);
    expect(() =>
      buildSkillIndex(skillsDir({ 'a/SKILL.md': skill('a', 'x'.repeat(1025)) }))
    ).toThrow(/over 1024/);
    expect(
      buildSkillIndex(skillsDir({ 'a/SKILL.md': skill('a', 'x'.repeat(1024)) })).skills
    ).toHaveLength(1);
  });

  it('refuses two skills with the same name', () => {
    expect(() =>
      buildSkillIndex(skillsDir({ 'setup.md': skill('a'), 'a/SKILL.md': skill('a') }))
    ).toThrow(/Two skills are named a/);
  });

  it('writes the index under .well-known', () => {
    const out = tmpDir('skills-out-');
    const file = writeSkillIndex({
      skillsDir: skillsDir({ 'a/SKILL.md': skill('a') }),
      outDir: out
    });
    expect(file).toBe(path.join(out, SKILL_INDEX_PATH));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).skills).toHaveLength(1);
  });
});
