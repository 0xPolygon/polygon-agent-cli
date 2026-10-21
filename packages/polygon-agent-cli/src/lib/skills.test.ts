import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASSISTANT_SKILL } from './workspace.ts';

// The repo's skills/ tree: one skill, Open Money Agent, whose SKILL.md is a short index
// and whose references/ hold each use case, loaded only when a task needs it.
const SKILLS = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'skills');
const SKILL_DIR = path.join(SKILLS, ASSISTANT_SKILL);
const REFERENCES = path.join(SKILL_DIR, 'references');
// The index is read in full by every agent, every time: keep it small.
const MAX_INDEX_BYTES = 12_000;

const index = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const references = fs.readdirSync(REFERENCES).filter((f) => f.endsWith('.md'));
const read = (file: string): string => fs.readFileSync(path.join(REFERENCES, file), 'utf8');
// Relative markdown links: [text](target.md) or [text](references/target.md).
const links = (markdown: string): string[] =>
  [...markdown.matchAll(/\]\(((?!https?:)[^)#\s]+\.md)\)/g)].map((m) => m[1]);

describe('the Open Money Agent skill', () => {
  it('is the only skill in the repo', () => {
    const skills = fs
      .readdirSync(SKILLS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS, d.name, 'SKILL.md')))
      .map((d) => d.name);
    expect(skills).toEqual([ASSISTANT_SKILL]);
  });

  it('has an index small enough to read every time', () => {
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(MAX_INDEX_BYTES);
    expect(index).toMatch(/^---\nname: open-money-agent\ndescription: /);
  });

  it('links only to references that exist, and to every reference', () => {
    const linked = links(index);
    for (const link of linked) {
      expect(link.startsWith('references/'), link).toBe(true);
      expect(fs.existsSync(path.join(SKILL_DIR, link)), link).toBe(true);
    }
    const linkedFiles = new Set(linked.map((link) => path.basename(link)));
    expect(references.filter((f) => !linkedFiles.has(f))).toEqual([]);
  });

  it('defines POLYGON_AGENT once, for the install to point at its wrapper', () => {
    expect(index.match(/^POLYGON_AGENT=/gm)).toHaveLength(1);
  });

  describe.each(references)('reference %s', (file) => {
    const markdown = read(file);

    it('has no frontmatter of its own, so only the index is a skill', () => {
      expect(markdown.startsWith('---')).toBe(false);
    });

    it('opens with a title and when to use it', () => {
      const [title, , when] = markdown.split('\n');
      expect(title).toMatch(/^# \S/);
      expect(when).toMatch(/^\*\*When to use:\*\*/);
    });

    it('links only to references that exist', () => {
      for (const link of links(markdown)) {
        expect(fs.existsSync(path.join(REFERENCES, link)), `${file} → ${link}`).toBe(true);
      }
    });
  });
});
