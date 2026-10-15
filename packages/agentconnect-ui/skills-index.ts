// The skill index served at /.well-known/agent-skills/index.json, so agents
// that discover skills by index find ours (Agent Skills discovery, schema
// 0.2.0: https://github.com/cloudflare/agent-skills-discovery-rfc). It lists
// setup.md and every skills/<name>/SKILL.md, each by the path it's served at
// and the SHA-256 of its bytes. Names come from the frontmatter (the
// Polymarket skill's differs from its folder).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

export const SKILL_INDEX_PATH = path.join('.well-known', 'agent-skills', 'index.json');
const SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';
// The discovery spec's naming rule: lowercase words joined by single hyphens.
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
// setup.md isn't a SKILL.md (so `npx skills add` doesn't offer it), but it has
// the same frontmatter and is listed too.
const SETUP_FILE = 'setup.md';

export interface SkillIndexEntry {
  name: string;
  type: 'skill-md';
  description: string;
  url: string;
  digest: string;
}

export interface SkillIndex {
  $schema: string;
  skills: SkillIndexEntry[];
}

function frontmatter(params: { file: string; markdown: string }): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(params.markdown);
  if (!match) throw new Error(`${params.file}: no frontmatter`);
  const data: unknown = parse(match[1]);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${params.file}: frontmatter isn't a mapping`);
  }
  return Object.fromEntries(Object.entries(data));
}

function entry(params: { file: string; url: string }): SkillIndexEntry {
  const bytes = fs.readFileSync(params.file);
  const meta = frontmatter({ file: params.file, markdown: bytes.toString('utf8') });
  const { name, description } = meta;
  if (typeof name !== 'string' || !NAME.test(name) || name.length > MAX_NAME) {
    throw new Error(`${params.file}: invalid name ${JSON.stringify(name)}`);
  }
  const text = typeof description === 'string' ? description.trim() : '';
  if (!text) {
    throw new Error(`${params.file}: missing description`);
  }
  if (text.length > MAX_DESCRIPTION) {
    throw new Error(`${params.file}: description over ${MAX_DESCRIPTION} characters`);
  }
  return {
    name,
    type: 'skill-md',
    description: text,
    url: params.url,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  };
}

// URLs are path-absolute, so the index works on whichever host serves it.
export function buildSkillIndex(skillsDir: string): SkillIndex {
  const skills: SkillIndexEntry[] = [];
  const setup = path.join(skillsDir, SETUP_FILE);
  if (fs.existsSync(setup)) skills.push(entry({ file: setup, url: `/${SETUP_FILE}` }));
  const dirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    skills.push(entry({ file: path.join(skillsDir, dir, 'SKILL.md'), url: `/${dir}/SKILL.md` }));
  }
  const names = skills.map((skill) => skill.name);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) throw new Error(`Two skills are named ${duplicate}`);
  return { $schema: SCHEMA, skills };
}

export function writeSkillIndex(params: { skillsDir: string; outDir: string }): string {
  const file = path.join(params.outDir, SKILL_INDEX_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(buildSkillIndex(params.skillsDir), null, 2)}\n`);
  return file;
}
