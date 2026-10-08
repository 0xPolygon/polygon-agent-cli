import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ASSISTANT_SKILL,
  initWorkspace,
  installSkill,
  readInstallRecord,
  readSkill,
  renderSkill,
  shellQuote,
  WRAPPER_SCRIPT
} from './workspace.ts';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const SKILL =
  '---\nname: polygon-oms-wallet\ndescription: test\n---\n\n# Wallet\n\nRun `polygon-agent wallet status`.\n';

// A bundled-skills folder holding the assistant skill.
function skillSource(): string {
  const dir = tmpDir('pa-skills-src-');
  fs.mkdirSync(path.join(dir, ASSISTANT_SKILL));
  fs.writeFileSync(path.join(dir, ASSISTANT_SKILL, 'SKILL.md'), SKILL);
  return dir;
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe('initWorkspace', () => {
  it('writes the wrapper, state folder, .gitignore and install.json', () => {
    const root = path.join(tmpDir('pa-ws-'), '.polygon-agent');
    const result = initWorkspace({ root, version: '1.0.0', name: 'Muse', sourceDir: null });

    expect(result.wrapper).toBe(path.join(root, 'bin', 'polygon-agent'));
    expect(fs.readFileSync(result.wrapper, 'utf8')).toBe(WRAPPER_SCRIPT);
    expect(mode(result.wrapper)).toBe(0o755);
    expect(mode(result.state)).toBe(0o700);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('*\n');

    const record = readInstallRecord(result.state);
    expect(record).toMatchObject({
      root,
      name: 'Muse',
      version: '1.0.0',
      skillsDir: null,
      skillPath: null
    });
    expect(mode(path.join(result.state, 'install.json'))).toBe(0o600);
    expect(result.skill).toMatchObject({ name: ASSISTANT_SKILL, installed: false });
  });

  it('installs the assistant skill rendered with the wrapper path', () => {
    const root = path.join(tmpDir('pa-ws-'), '.polygon-agent');
    const skillsDir = tmpDir('pa-skills-');
    const result = initWorkspace({ root, version: '1.0.0', skillsDir, sourceDir: skillSource() });

    const skillPath = path.join(skillsDir, ASSISTANT_SKILL, 'SKILL.md');
    expect(result.skill).toEqual({ name: ASSISTANT_SKILL, installed: true, path: skillPath });
    const installed = fs.readFileSync(skillPath, 'utf8');
    expect(installed.startsWith('---\nname: polygon-oms-wallet\n')).toBe(true);
    expect(installed).toContain(`\`${result.wrapper}\``);
    expect(readInstallRecord(result.state)).toMatchObject({ skillsDir, skillPath });
  });

  it('reports a skill this version does not bundle', () => {
    const root = path.join(tmpDir('pa-ws-'), '.polygon-agent');
    const result = initWorkspace({
      root,
      version: '1.0.0',
      skillsDir: tmpDir('pa-skills-'),
      sourceDir: tmpDir('pa-empty-')
    });
    expect(result.skill.installed).toBe(false);
    expect(result.skill.hint).toContain("doesn't include");
  });

  it('is idempotent and reuses the recorded name and skills folder', () => {
    const root = path.join(tmpDir('pa-ws-'), '.polygon-agent');
    const skillsDir = tmpDir('pa-skills-');
    const sourceDir = skillSource();
    const first = initWorkspace({ root, version: '1.0.0', name: 'Muse', skillsDir, sourceDir });
    const firstRecord = readInstallRecord(first.state);
    const skillBefore = fs.readFileSync(path.join(skillsDir, ASSISTANT_SKILL, 'SKILL.md'), 'utf8');

    const second = initWorkspace({ root, version: '1.1.0', sourceDir });
    const secondRecord = readInstallRecord(second.state);

    expect(second.name).toBe('Muse');
    expect(second.skill.installed).toBe(true);
    expect(secondRecord?.installedAt).toBe(firstRecord?.installedAt);
    expect(secondRecord?.version).toBe('1.1.0');
    expect(fs.readFileSync(path.join(skillsDir, ASSISTANT_SKILL, 'SKILL.md'), 'utf8')).toBe(
      skillBefore
    );
    expect(fs.readdirSync(path.join(root, 'bin'))).toEqual(['polygon-agent']);
  });

  it('defaults the install name to the host name', () => {
    const root = path.join(tmpDir('pa-ws-'), '.polygon-agent');
    expect(initWorkspace({ root, version: '1.0.0', sourceDir: null }).name).toBe(os.hostname());
  });

  it('refuses a root that already holds other files, such as the workspace itself', () => {
    const workspace = tmpDir('pa-ws-');
    fs.writeFileSync(path.join(workspace, '.gitignore'), 'node_modules\n');
    fs.writeFileSync(path.join(workspace, 'notes.md'), '');
    expect(() => initWorkspace({ root: workspace, version: '1.0.0', sourceDir: null })).toThrow(
      /already holds other files \(\.gitignore|already holds other files \(notes\.md/
    );
    expect(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });

  it("shares ~/.polygon-agent with the global CLI's state ($HOME workspaces)", () => {
    const home = tmpDir('pa-home-');
    const root = path.join(home, '.polygon-agent');
    fs.mkdirSync(path.join(root, 'wallets'), { recursive: true });
    fs.writeFileSync(path.join(root, '.encryption-key'), 'k');
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      expect(initWorkspace({ root, version: '1.0.0', sourceDir: null }).state).toBe(
        path.join(root, 'state')
      );
    } finally {
      spy.mockRestore();
    }
    // The global CLI's files are untouched.
    expect(fs.readFileSync(path.join(root, '.encryption-key'), 'utf8')).toBe('k');
  });

  it('accepts a root holding only the npm install, as setup.md leaves it', () => {
    const root = path.join(tmpDir('pa-ws-'), '.polygon-agent');
    fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
    expect(initWorkspace({ root, version: '1.0.0', sourceDir: null }).root).toBe(root);
  });

  it('resolves a relative root against the working directory', () => {
    const cwd = tmpDir('pa-cwd-');
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      const result = initWorkspace({ root: '.polygon-agent', version: '1.0.0', sourceDir: null });
      expect(result.root).toBe(path.join(cwd, '.polygon-agent'));
    } finally {
      spy.mockRestore();
    }
  });

  it('skips a recorded skills folder that no longer exists instead of recreating it', () => {
    const root = path.join(tmpDir('pa-ws-'), '.polygon-agent');
    const skillsDir = path.join(tmpDir('pa-skills-'), 'skills');
    fs.mkdirSync(skillsDir);
    const sourceDir = skillSource();
    initWorkspace({ root, version: '1.0.0', skillsDir, sourceDir });
    fs.rmSync(skillsDir, { recursive: true });

    const again = initWorkspace({ root, version: '1.0.0', sourceDir });
    expect(again.skill.installed).toBe(false);
    expect(again.skill.hint).toContain('no longer exists');
    expect(fs.existsSync(skillsDir)).toBe(false);
  });

  it('reads an install.json missing the optional fields', () => {
    const root = path.join(tmpDir('pa-ws-'), '.polygon-agent');
    const { state } = initWorkspace({ root, version: '1.0.0', name: 'Old', sourceDir: null });
    fs.writeFileSync(
      path.join(state, 'install.json'),
      JSON.stringify({ root, name: 'Old', version: '0.9.0', installedAt: 'then', extra: 1 })
    );
    expect(readInstallRecord(state)).toMatchObject({
      name: 'Old',
      skillsDir: null,
      skillPath: null,
      installedAt: 'then'
    });
    expect(initWorkspace({ root, version: '1.0.0', sourceDir: null }).name).toBe('Old');
  });

  it('refuses a root whose name could rewrite the skill text', () => {
    for (const name of ['a`b', 'a\nb', 'a\u0007b']) {
      const root = path.join(tmpDir('pa-ws-'), name, '.polygon-agent');
      expect(() => initWorkspace({ root, version: '1.0.0', sourceDir: null })).toThrow(
        /control characters or backticks/
      );
    }
  });

  it('refuses a root that is a file', () => {
    const file = path.join(tmpDir('pa-ws-'), 'file');
    fs.writeFileSync(file, '');
    expect(() => initWorkspace({ root: file, version: '1.0.0', sourceDir: null })).toThrow(
      /not a directory/
    );
  });
});

describe('the wrapper', () => {
  it('runs the installed CLI with the workspace state folder and passes arguments through', () => {
    const root = path.join(tmpDir('pa ws '), '.polygon-agent');
    const { wrapper } = initWorkspace({ root, version: '1.0.0', sourceDir: null });
    const entry = path.join(root, 'cli', 'node_modules', '@polygonlabs', 'agent-cli', 'dist');
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(
      path.join(entry, 'index.js'),
      'console.log(JSON.stringify({ home: process.env.POLYGON_AGENT_HOME, root: process.env.POLYGON_AGENT_ROOT, proxy: process.env.NODE_USE_ENV_PROXY, args: process.argv.slice(2) }));'
    );

    const out = execFileSync(wrapper, ['wallet', 'status', 'two words'], {
      encoding: 'utf8',
      env: { ...process.env, POLYGON_AGENT_HOME: '/elsewhere', NODE_USE_ENV_PROXY: undefined }
    });
    expect(JSON.parse(out)).toEqual({
      home: path.join(root, 'state'),
      root,
      proxy: '1',
      args: ['wallet', 'status', 'two words']
    });

    // Run by a relative path, an exported CDPATH holding a look-alike folder
    // must not redirect the wrapper's own cd.
    const cdpath = tmpDir('pa-cdpath-');
    fs.mkdirSync(path.join(cdpath, '.polygon-agent', 'bin'), { recursive: true });
    const viaRelative = execFileSync(path.join('.polygon-agent', 'bin', 'polygon-agent'), [], {
      encoding: 'utf8',
      cwd: path.dirname(root),
      env: { ...process.env, CDPATH: cdpath }
    });
    expect(JSON.parse(viaRelative).root).toBe(root);

    // An explicit NODE_USE_ENV_PROXY is kept.
    const optedOut = execFileSync(wrapper, [], {
      encoding: 'utf8',
      env: { ...process.env, NODE_USE_ENV_PROXY: '0' }
    });
    expect(JSON.parse(optedOut).proxy).toBe('0');
  });
});

describe('skills', () => {
  it('renders the CLI note after the frontmatter', () => {
    const rendered = renderSkill({ markdown: SKILL, wrapper: '/w/bin/polygon-agent' });
    const [, frontmatter, body] = rendered.split('---\n');
    expect(frontmatter).toBe('name: polygon-oms-wallet\ndescription: test\n');
    expect(body.startsWith("\n> **This install's CLI:** `/w/bin/polygon-agent`.")).toBe(true);
    expect(body).toContain('# Wallet');
  });

  it('sets a POLYGON_AGENT placeholder line to the wrapper path', () => {
    const markdown =
      '---\nname: x\n---\n\n```sh\nPOLYGON_AGENT=<workspace>/.polygon-agent/bin/polygon-agent\n' +
      '"$POLYGON_AGENT" wallet status\n```\n';
    const rendered = renderSkill({ markdown, wrapper: '/my ws/.polygon-agent/bin/polygon-agent' });
    expect(rendered).toContain("POLYGON_AGENT='/my ws/.polygon-agent/bin/polygon-agent'\n");
    expect(rendered).toContain('"$POLYGON_AGENT" wallet status');
    expect(rendered).not.toContain('<workspace>');
  });

  // Paths an install could plausibly (or hostilely) live under.
  it.each([
    '/ws/project-$budget/.polygon-agent/bin/polygon-agent',
    '/ws/$(touch PWNED)/.polygon-agent/bin/polygon-agent',
    '/ws/`touch PWNED`/.polygon-agent/bin/polygon-agent',
    "/ws/it's/.polygon-agent/bin/polygon-agent",
    '/ws/a$&b$1\\n "q"/.polygon-agent/bin/polygon-agent'
  ])('the rendered POLYGON_AGENT line evaluates in sh to the exact path (case %#)', (wrapper) => {
    const markdown = '---\nname: x\n---\n\nPOLYGON_AGENT=<placeholder>\n';
    const line = renderSkill({ markdown, wrapper })
      .split('\n')
      .find((l) => l.startsWith('POLYGON_AGENT='));
    const cwd = tmpDir('pa-quote-');
    const value = execFileSync('sh', ['-c', `${line}\nprintf %s "$POLYGON_AGENT"`], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, budget: 'expanded' }
    });
    expect(value).toBe(wrapper);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("renders the repo's polygon-oms-wallet skill for a wrapper", () => {
    const repoSkills = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'skills');
    const markdown = readSkill({ sourceDir: repoSkills, name: ASSISTANT_SKILL });
    expect(markdown).not.toBeNull();
    const wrapper = "/ws/it's here/.polygon-agent/bin/polygon-agent";
    const rendered = renderSkill({ markdown: markdown ?? '', wrapper });
    const lines = rendered.split('\n').filter((l) => l.startsWith('POLYGON_AGENT='));
    expect(lines).toEqual([`POLYGON_AGENT=${shellQuote(wrapper)}`]);
    expect(rendered).toMatch(/^---\nname: polygon-oms-wallet\n/);
    expect(rendered).toContain(`> **This install's CLI:** \`${wrapper}\``);
  });

  it('quotes with POSIX single quotes', () => {
    expect(shellQuote('/a b')).toBe("'/a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('renders a skill without frontmatter by prepending the note', () => {
    expect(renderSkill({ markdown: '# Hi\n', wrapper: '/w' })).toMatch(/^> \*\*This install/);
  });

  it('installs unrendered outside a workspace', () => {
    const skillsDir = tmpDir('pa-skills-');
    const file = installSkill({ sourceDir: skillSource(), name: ASSISTANT_SKILL, skillsDir });
    expect(fs.readFileSync(file, 'utf8')).toBe(SKILL);
  });

  it('rejects names that escape the skills folder', () => {
    const sourceDir = skillSource();
    expect(readSkill({ sourceDir, name: '../etc' })).toBeNull();
    expect(readSkill({ sourceDir, name: 'missing' })).toBeNull();
    expect(() =>
      installSkill({ sourceDir, name: '../x', skillsDir: tmpDir('pa-skills-') })
    ).toThrow(/Skill not found/);
  });
});
