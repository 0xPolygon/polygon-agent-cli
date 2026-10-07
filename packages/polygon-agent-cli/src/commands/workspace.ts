import type { CommandModule } from 'yargs';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { STORAGE_ROOT } from '../lib/storage.ts';
import { cliVersion, getLatestVersion, isNewerVersion, PACKAGE_NAME } from '../lib/version.ts';
import {
  ASSISTANT_SKILL,
  bundledSkillsDir,
  initWorkspace,
  installSkill,
  listSkills,
  readInstallRecord,
  readSkill,
  renderSkill,
  wrapperPath,
  writeInstallRecord
} from '../lib/workspace.ts';

function jsonOut(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(error: unknown): never {
  console.error(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
  process.exit(1);
}

// Set by the wrapper; unset for a global install.
function workspaceRoot(): string | undefined {
  return process.env.POLYGON_AGENT_ROOT || undefined;
}

// --- workspace init ---
interface InitArgs {
  root: string;
  'skills-dir'?: string;
  name?: string;
}

const initCommand: CommandModule<object, InitArgs> = {
  command: 'init',
  describe: 'Set up a workspace install: wrapper, state folder, .gitignore, assistant skill',
  builder: (y) =>
    y
      .option('root', {
        type: 'string',
        demandOption: true,
        describe: 'Install folder, e.g. <workspace>/.polygon-agent'
      })
      .option('skills-dir', {
        type: 'string',
        describe: `Assistant skills folder to install the ${ASSISTANT_SKILL} skill into`
      })
      .option('name', {
        type: 'string',
        describe: 'Install name shown to the wallet owner (default: the host name)'
      }),
  handler: (argv) => {
    try {
      const result = initWorkspace({
        root: argv.root,
        skillsDir: argv['skills-dir'],
        name: argv.name,
        version: cliVersion()
      });
      jsonOut({ ok: true, ...result });
    } catch (error) {
      fail(error);
    }
  }
};

export const workspaceCommand: CommandModule = {
  command: 'workspace',
  describe: 'Manage a workspace install (an install inside an assistant workspace)',
  builder: (yargs) => yargs.command(initCommand).demandCommand(1, '').showHelpOnFail(true),
  handler: () => {}
};

// --- skills show | install ---
interface ShowArgs {
  name: string;
}

const showCommand: CommandModule<object, ShowArgs> = {
  command: 'show <name>',
  describe: 'Print a bundled skill (rendered for this install when run through its wrapper)',
  builder: (y) => y.positional('name', { type: 'string', demandOption: true }),
  handler: (argv) => {
    const sourceDir = bundledSkillsDir();
    const markdown = readSkill({ sourceDir, name: argv.name });
    if (markdown === null) {
      fail(`Skill not found: ${argv.name}. Available: ${listSkills(sourceDir).join(', ')}`);
    }
    const root = workspaceRoot();
    process.stdout.write(root ? renderSkill({ markdown, wrapper: wrapperPath(root) }) : markdown);
  }
};

interface InstallArgs {
  name: string;
  dir: string;
}

const installCommand: CommandModule<object, InstallArgs> = {
  command: 'install [name]',
  describe: 'Write a bundled skill to <dir>/<name>/SKILL.md',
  builder: (y) =>
    y
      .positional('name', { type: 'string', default: ASSISTANT_SKILL })
      .option('dir', { type: 'string', demandOption: true, describe: 'Skills folder' }),
  handler: (argv) => {
    try {
      const root = workspaceRoot();
      const file = installSkill({
        sourceDir: bundledSkillsDir(),
        name: argv.name,
        skillsDir: argv.dir,
        wrapper: root ? wrapperPath(root) : undefined
      });
      // Remember where the assistant skill lives, so `update` refreshes it.
      const record = root ? readInstallRecord(STORAGE_ROOT) : null;
      if (record && argv.name === ASSISTANT_SKILL) {
        writeInstallRecord({
          state: STORAGE_ROOT,
          record: {
            ...record,
            skillsDir: path.resolve(argv.dir),
            skillPath: file,
            updatedAt: new Date().toISOString()
          }
        });
      }
      jsonOut({ ok: true, skill: argv.name, path: file });
    } catch (error) {
      fail(error);
    }
  }
};

export const skillsCommand: CommandModule = {
  command: 'skills',
  describe: 'Show or install the skills bundled with this CLI',
  builder: (yargs) =>
    yargs.command(showCommand).command(installCommand).demandCommand(1, '').showHelpOnFail(true),
  handler: () => {}
};

// --- update ---
const InitOutput = z.object({
  version: z.string(),
  skill: z.object({ name: z.string(), installed: z.boolean(), path: z.string().optional() })
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// npm from the install's own Node runtime when it has one (its npm script needs
// that node, which may not be on PATH), else the system npm.
function npmCommand(root: string): { file: string; args: string[] } {
  const npmCli = path.join(root, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(npmCli)
    ? { file: process.execPath, args: [npmCli] }
    : { file: 'npm', args: [] };
}

// Keys the CLI loads into its environment; npm and package install scripts
// don't need them.
const SECRET_ENV = [
  'OMS_PUBLISHABLE_KEY',
  'SEQUENCE_OMS_PROJECT_ID',
  'SEQUENCE_PROJECT_ACCESS_KEY',
  'TRAILS_API_KEY'
];

function npmEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !SECRET_ENV.includes(key))
  );
}

function runInit(root: string): z.infer<typeof InitOutput> | null {
  const init = spawnSync(wrapperPath(root), ['workspace', 'init', '--root', root], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 2]
  });
  const parsed = InitOutput.safeParse(init.status === 0 ? parseJson(init.stdout) : undefined);
  return parsed.success ? parsed.data : null;
}

export const updateCommand: CommandModule = {
  command: 'update',
  describe: 'Update a workspace install to the latest CLI and refresh its skill',
  handler: async () => {
    try {
      const current = cliVersion();
      const root = workspaceRoot();
      const latest = await getLatestVersion({ maxAgeMs: 0 });
      if (!root) {
        jsonOut({
          ok: true,
          updated: false,
          version: current,
          latest,
          hint: 'Not a workspace install. Update a global install with npm.',
          command: `npm install -g ${PACKAGE_NAME}@latest`
        });
        return;
      }

      if (latest && !isNewerVersion({ candidate: latest, current })) {
        jsonOut({ ok: true, updated: false, version: current, latest });
        return;
      }

      // Install beside the current CLI and swap folders only once it's complete,
      // so a failed or partial install never breaks the wrapper.
      const cliDir = path.join(root, 'cli');
      const nextDir = `${cliDir}.next`;
      const prevDir = `${cliDir}.prev`;
      fs.rmSync(nextDir, { recursive: true, force: true });
      const npm = npmCommand(root);
      // stdout stays reserved for this command's JSON.
      const install = spawnSync(
        npm.file,
        [...npm.args, 'install', '--prefix', nextDir, `${PACKAGE_NAME}@latest`],
        { stdio: ['ignore', 2, 2], env: npmEnv() }
      );
      if (install.error) throw install.error;
      if (install.status !== 0) throw new Error(`npm install exited with ${install.status}`);
      if (!fs.existsSync(path.join(nextDir, 'node_modules', PACKAGE_NAME, 'dist', 'index.js'))) {
        throw new Error(`npm install finished without ${PACKAGE_NAME} in ${nextDir}`);
      }

      fs.rmSync(prevDir, { recursive: true, force: true });
      fs.renameSync(cliDir, prevDir);
      fs.renameSync(nextDir, cliDir);

      // The new CLI re-runs init: a fresh wrapper, install.json and skill. If
      // that fails, put the previous CLI back and restore its workspace files.
      const refreshed = runInit(root);
      if (!refreshed) {
        fs.rmSync(cliDir, { recursive: true, force: true });
        fs.renameSync(prevDir, cliDir);
        initWorkspace({ root, version: current });
        throw new Error(
          `The latest CLI installed, but its workspace init failed, so the update was rolled ` +
            `back to ${current}.`
        );
      }
      fs.rmSync(prevDir, { recursive: true, force: true });

      jsonOut({
        ok: true,
        updated: refreshed.version !== current,
        from: current,
        to: refreshed.version,
        skill: refreshed.skill
      });
    } catch (error) {
      fail(error);
    }
  }
};
