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

import { cliPackageRoot } from './version.ts';

// The assistant skill workspace init installs.
export const ASSISTANT_SKILL = 'polygon-oms-wallet';

// Run it by its own path: a symlink to it elsewhere would resolve ROOT wrongly.
export const WRAPPER_SCRIPT = `#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
NODE="$ROOT/node/bin/node"; [ -x "$NODE" ] || NODE=node
# Node's fetch ignores HTTPS_PROXY unless asked; npm doesn't. Honor it by default.
: "\${NODE_USE_ENV_PROXY:=1}"
export POLYGON_AGENT_HOME="$ROOT/state" POLYGON_AGENT_ROOT="$ROOT" NODE_USE_ENV_PROXY
exec "$NODE" "$ROOT/cli/node_modules/@polygonlabs/agent-cli/dist/index.js" "$@"
`;

// Lenient on read, so a record written by another CLI version still counts.
const InstallRecord = z.object({
  root: z.string(),
  name: z.string(),
  version: z.string(),
  skillsDir: z.string().nullable().default(null),
  skillPath: z.string().nullable().default(null),
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

export function listSkills(sourceDir: string | null): string[] {
  if (!sourceDir) return [];
  return fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(sourceDir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

export function readSkill(params: { sourceDir: string | null; name: string }): string | null {
  if (!params.sourceDir || !SKILL_NAME.test(params.name)) return null;
  try {
    return fs.readFileSync(path.join(params.sourceDir, params.name, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}

// Points a skill at this install's CLI. Skills say `polygon-agent …` or
// `agent …`, which only work for a global install, so a note goes right after
// the frontmatter. A skill that defines `POLYGON_AGENT=<placeholder>` on a line
// of its own also gets that line set to the wrapper's absolute path.
const POLYGON_AGENT_LINE = /^POLYGON_AGENT=.*$/m;

// POSIX single quotes: nothing inside is expanded. A quote becomes '\''.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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

// Writes <skillsDir>/<name>/SKILL.md, rendered for the wrapper when there is one.
export function installSkill(params: {
  sourceDir: string | null;
  name: string;
  skillsDir: string;
  wrapper?: string;
}): string {
  const markdown = readSkill({ sourceDir: params.sourceDir, name: params.name });
  if (markdown === null) {
    throw new Error(`Skill not found: ${params.name}`);
  }
  const content = params.wrapper ? renderSkill({ markdown, wrapper: params.wrapper }) : markdown;
  const dir = path.join(path.resolve(params.skillsDir), params.name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  writeFileAtomic({ file, content, mode: 0o644 });
  return file;
}

// Creates or refreshes a workspace install. Safe to re-run: without --skills-dir
// or --name it reuses what install.json recorded, and installedAt is kept.
export function initWorkspace(params: {
  root: string;
  version: string;
  skillsDir?: string;
  name?: string;
  sourceDir?: string | null;
}): InitResult {
  const root = path.resolve(params.root);
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
      skillPath: skill.installed && skill.path ? skill.path : (previous?.skillPath ?? null),
      installedAt: previous?.installedAt ?? now,
      updatedAt: now
    }
  });

  return { root, wrapper, state, name, version: params.version, skill };
}
