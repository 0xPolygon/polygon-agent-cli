// Workspace installs: the CLI installed into a folder an assistant keeps across
// restarts (<workspace>/.polygon-agent/), run through a wrapper that points
// POLYGON_AGENT_HOME at the install's own state folder.
//
//   <root>/bin/polygon-agent   wrapper the skills call
//   <root>/cli/                npm install --prefix of @polygonlabs/agent-cli
//   <root>/node/               optional Node runtime (setup.md installs it if needed)
//   <root>/state/              CLI state, including install.json
//   <root>/.gitignore          "*"

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { shellQuote } from './shell.ts';
import { cliPackageRoot } from './version.ts';

// The skill workspace init installs: the AgentPay index, with its references
// (references/<topic>.md) beside it.
export const ASSISTANT_SKILL = 'agentpay';
// Its earlier names (polygon-oms-wallet before 0.15, polygon-agent-wallet
// until AgentPay). Older skills and setup guides still ask for them.
export const LEGACY_ASSISTANT_SKILLS = ['polygon-oms-wallet', 'polygon-agent-wallet'];
const REFERENCES = 'references';
// Skills that became references of the AgentPay skill, by their old names.
const LEGACY_TOPICS: Record<string, string> = {
  'polygon-polymarket': 'polymarket',
  'polymarket-skill': 'polymarket',
  'polygon-defi': 'earn',
  'polygon-discovery': 'paid-services',
  'polygon-agent-cli': 'cli-reference'
};

const canonicalSkillName = (name: string): string =>
  LEGACY_ASSISTANT_SKILLS.includes(name) ? ASSISTANT_SKILL : name;

// Run it by its own path: a symlink to it elsewhere would resolve ROOT wrongly.
export const WRAPPER_SCRIPT = `#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
NODE="$ROOT/node/bin/node"; [ -x "$NODE" ] || NODE=node
# Node's fetch ignores HTTPS_PROXY unless asked; npm doesn't. Honor it by default.
: "\${NODE_USE_ENV_PROXY:=1}"
export POLYGON_AGENT_HOME="$ROOT/state" POLYGON_AGENT_ROOT="$ROOT" NODE_USE_ENV_PROXY
exec "$NODE" "$ROOT/cli/node_modules/@polygonlabs/agent-cli/dist/index.js" "$@"
`;

export const PLATFORMS = [
  'muse',
  'openclaw',
  'hermes',
  'claude-code',
  'cursor',
  'codex',
  'other'
] as const;
export type Platform = (typeof PLATFORMS)[number];

// Lenient on read, so a record written by another CLI version still counts.
const InstallRecord = z.object({
  root: z.string(),
  name: z.string(),
  version: z.string(),
  skillsDir: z.string().nullable().default(null),
  skillPath: z.string().nullable().default(null),
  // An unknown platform (a newer CLI's) reads as none, never as no record.
  platform: z.enum(PLATFORMS).optional().catch(undefined),
  installedAt: z.string(),
  updatedAt: z.string().optional()
});
export type InstallRecord = z.infer<typeof InstallRecord>;

export interface SkillResult {
  name: string;
  installed: boolean;
  path?: string;
  hint?: string;
}

export interface InitResult {
  root: string;
  wrapper: string;
  state: string;
  name: string;
  version: string;
  skill: SkillResult;
}

export function wrapperPath(root: string): string {
  return path.join(root, 'bin', 'polygon-agent');
}

// What a workspace install's root may hold. cli.next and cli.prev exist only
// while `update` swaps the CLI.
const ROOT_ENTRIES = new Set(['bin', 'cli', 'cli.next', 'cli.prev', 'node', 'state', '.gitignore']);

export function stateDir(root: string): string {
  return path.join(root, 'state');
}

function installRecordPath(state: string): string {
  return path.join(state, 'install.json');
}

// Write via a temp file and rename, so a reader (or the running wrapper) never
// sees a half-written file.
function writeFileAtomic(params: { file: string; content: string; mode: number }): void {
  const tmp = `${params.file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, params.content, { mode: params.mode });
    fs.chmodSync(tmp, params.mode);
    fs.renameSync(tmp, params.file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function readInstallRecord(state: string): InstallRecord | null {
  try {
    const parsed = InstallRecord.safeParse(
      JSON.parse(fs.readFileSync(installRecordPath(state), 'utf8'))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeInstallRecord(params: { state: string; record: InstallRecord }): void {
  writeFileAtomic({
    file: installRecordPath(params.state),
    content: `${JSON.stringify(params.record, null, 2)}\n`,
    mode: 0o600
  });
}

// Skills ship in dist/skills/<name>/SKILL.md. In development (running from the
// repo, not node_modules) the repo's skills/ folder wins over a stale build.
export function bundledSkillsDir(): string | null {
  const pkgRoot = cliPackageRoot();
  if (!pkgRoot.split(path.sep).includes('node_modules')) {
    const repo = path.resolve(pkgRoot, '..', '..', 'skills');
    if (fs.existsSync(repo)) return repo;
  }
  const dist = path.join(pkgRoot, 'dist', 'skills');
  return fs.existsSync(dist) ? dist : null;
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

// The AgentPay skill's reference topics, e.g. ['connect', 'polymarket', …].
export function listTopics(sourceDir: string | null): string[] {
  if (!sourceDir) return [];
  try {
    return fs
      .readdirSync(path.join(sourceDir, ASSISTANT_SKILL, REFERENCES))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -'.md'.length))
      .sort();
  } catch {
    return [];
  }
}

// What `skills show` accepts: each skill, then the AgentPay reference topics.
export function listSkills(sourceDir: string | null): string[] {
  if (!sourceDir) return [];
  const skills = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(sourceDir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
  return [...skills, ...listTopics(sourceDir)];
}

// A skill's SKILL.md by name (or an earlier name), else an AgentPay reference by
// topic (or the old skill it replaced).
export function readSkill(params: { sourceDir: string | null; name: string }): string | null {
  if (!params.sourceDir || !SKILL_NAME.test(params.name)) return null;
  const read = (file: string): string | null => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const topic = LEGACY_TOPICS[params.name] ?? params.name;
  return (
    read(path.join(params.sourceDir, canonicalSkillName(params.name), 'SKILL.md')) ??
    read(path.join(params.sourceDir, ASSISTANT_SKILL, REFERENCES, `${topic}.md`))
  );
}

// Points a skill at this install's CLI. Skills say `polygon-agent …` or
// `agent …`, which only work for a global install, so a note goes right after
// the frontmatter. A skill that defines `POLYGON_AGENT=<placeholder>` on a line
// of its own also gets that line set to the wrapper's absolute path.
const POLYGON_AGENT_LINE = /^POLYGON_AGENT=.*$/m;

export function renderSkill(params: { markdown: string; wrapper: string }): string {
  const note =
    `> **This install's CLI:** \`${params.wrapper}\`. Run it wherever this skill says ` +
    '`polygon-agent` or `agent`. If that file is missing, the workspace was reset: ' +
    'set it up again with https://agents.polygon.technology/setup.md.\n\n';
  // A callback, so `$&` and the like in the path aren't replacement patterns.
  const markdown = params.markdown.replace(
    POLYGON_AGENT_LINE,
    () => `POLYGON_AGENT=${shellQuote(params.wrapper)}`
  );
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
  if (!match) return note + markdown;
  const end = match[0].length;
  return `${markdown.slice(0, end)}\n${note}${markdown.slice(end).replace(/^\r?\n/, '')}`;
}

// Removes the assistant skill installed under an old name, so the assistant
// doesn't load both. Only a folder holding nothing but that skill's SKILL.md.
function removeLegacySkills(skillsDir: string): void {
  for (const name of LEGACY_ASSISTANT_SKILLS) {
    const dir = path.join(skillsDir, name);
    try {
      if (fs.readdirSync(dir).join() !== 'SKILL.md') continue;
      const markdown = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      if (!markdown.startsWith(`---\nname: ${name}\n`)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // not there, or not ours
    }
  }
}

// Writes the skill's references/<topic>.md beside its SKILL.md, replacing the
// folder so a topic dropped from the CLI goes too. References say `polygon-agent`
// or `agent`, and the rendered SKILL.md says where that CLI is.
function installReferences(params: { sourceDir: string; name: string; dir: string }): void {
  const source = path.join(params.sourceDir, params.name, REFERENCES);
  const target = path.join(params.dir, REFERENCES);
  if (!fs.existsSync(source)) return;
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(source)) {
    if (!file.endsWith('.md')) continue;
    fs.copyFileSync(path.join(source, file), path.join(target, file));
    fs.chmodSync(path.join(target, file), 0o644);
  }
}

// Writes <skillsDir>/<name>/SKILL.md, rendered for the wrapper when there is one,
// and its references.
export function installSkill(params: {
  sourceDir: string | null;
  name: string;
  skillsDir: string;
  wrapper?: string;
}): string {
  const name = canonicalSkillName(params.name);
  // A whole skill only: a reference topic prints with `skills show` instead.
  const markdown =
    params.sourceDir && fs.existsSync(path.join(params.sourceDir, name, 'SKILL.md'))
      ? readSkill({ sourceDir: params.sourceDir, name })
      : null;
  if (markdown === null) {
    throw new Error(`Skill not found: ${params.name}`);
  }
  const content = params.wrapper ? renderSkill({ markdown, wrapper: params.wrapper }) : markdown;
  const skillsDir = path.resolve(params.skillsDir);
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  writeFileAtomic({ file, content, mode: 0o644 });
  if (params.sourceDir) installReferences({ sourceDir: params.sourceDir, name, dir });
  if (name === ASSISTANT_SKILL) removeLegacySkills(skillsDir);
  return file;
}

// Creates or refreshes a workspace install. Safe to re-run: without --skills-dir
// or --name it reuses what install.json recorded, and installedAt is kept.
export function initWorkspace(params: {
  root: string;
  version: string;
  skillsDir?: string;
  name?: string;
  platform?: Platform;
  sourceDir?: string | null;
}): InitResult {
  const root = path.resolve(params.root);
  // The path is written into the skill's text (and a shell line): control
  // characters or backticks would let a folder name rewrite what it says.
  if (/[\u0000-\u001f\u007f`]/.test(root)) {
    throw new Error('--root may not contain control characters or backticks.');
  }
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
    throw new Error(`--root is not a directory: ${root}`);
  }
  const state = stateDir(root);
  // Refuse a folder that holds anything else (the workspace itself, or $HOME):
  // init would replace its .gitignore with "*". ~/.polygon-agent is the
  // exception: a $HOME workspace install shares it with the global CLI's state,
  // which ignoring everything suits.
  const globalHome = path.join(os.homedir(), '.polygon-agent');
  if (fs.existsSync(root) && root !== globalHome && !fs.existsSync(installRecordPath(state))) {
    const foreign = fs.readdirSync(root).filter((entry) => !ROOT_ENTRIES.has(entry));
    if (foreign.length > 0) {
      throw new Error(
        `--root ${root} already holds other files (${foreign.slice(0, 5).join(', ')}). ` +
          'Use a folder of its own, such as <workspace>/.polygon-agent.'
      );
    }
  }
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.chmodSync(state, 0o700);
  writeFileAtomic({ file: path.join(root, '.gitignore'), content: '*\n', mode: 0o644 });

  const wrapper = wrapperPath(root);
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  writeFileAtomic({ file: wrapper, content: WRAPPER_SCRIPT, mode: 0o755 });

  const previous = readInstallRecord(state);
  const skillsDir = params.skillsDir
    ? path.resolve(params.skillsDir)
    : (previous?.skillsDir ?? null);
  // A recorded folder that's gone (say, the workspace moved) isn't recreated.
  const skillsDirGone = !params.skillsDir && skillsDir !== null && !fs.existsSync(skillsDir);
  const name = params.name?.trim() || previous?.name || os.hostname();

  let skill: SkillResult;
  const sourceDir = params.sourceDir === undefined ? bundledSkillsDir() : params.sourceDir;
  if (!skillsDir) {
    skill = {
      name: ASSISTANT_SKILL,
      installed: false,
      hint: `Pass --skills-dir, or print it with: ${wrapper} skills show ${ASSISTANT_SKILL}`
    };
  } else if (skillsDirGone) {
    skill = {
      name: ASSISTANT_SKILL,
      installed: false,
      hint: `The recorded skills folder ${skillsDir} no longer exists. Pass --skills-dir.`
    };
  } else if (readSkill({ sourceDir, name: ASSISTANT_SKILL }) === null) {
    skill = {
      name: ASSISTANT_SKILL,
      installed: false,
      hint: `This CLI version doesn't include the ${ASSISTANT_SKILL} skill yet`
    };
  } else {
    const file = installSkill({ sourceDir, name: ASSISTANT_SKILL, skillsDir, wrapper });
    skill = { name: ASSISTANT_SKILL, installed: true, path: file };
  }

  const now = new Date().toISOString();
  writeInstallRecord({
    state,
    record: {
      root,
      name,
      version: params.version,
      skillsDir,
      platform: params.platform ?? previous?.platform,
      skillPath: skill.installed && skill.path ? skill.path : (previous?.skillPath ?? null),
      installedAt: previous?.installedAt ?? now,
      updatedAt: now
    }
  });

  return { root, wrapper, state, name, version: params.version, skill };
}
