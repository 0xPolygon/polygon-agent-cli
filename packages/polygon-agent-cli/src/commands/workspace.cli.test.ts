import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupHarness,
  makeHome,
  resetTripwire,
  runCli,
  tripwireHits
} from '../test-harness/cli.ts';

afterAll(cleanupHarness);

const bundledSkill = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'skills',
  'open-money-agent',
  'SKILL.md'
);

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe('workspace init', { timeout: 30_000 }, () => {
  it('lays out wrapper, private state folder, .gitignore and skill, and is idempotent', async () => {
    resetTripwire();
    const home = makeHome();
    const root = path.join(home, 'ws', '.polygon-agent');
    const skillsDir = path.join(home, 'skills');
    const args = ['workspace', 'init', '--root', root, '--skills-dir', skillsDir, '--name', 't'];

    const first = await runCli({ args, home });
    expect(first.exitCode).equal(0);
    expect(first.stdoutJson).property('ok').equal(true);
    const skillFile = path.join(skillsDir, 'open-money-agent', 'SKILL.md');
    expect(first.stdoutJson).property('skill').property('installed').equal(true);
    expect(first.stdoutJson).property('skill').property('path').equal(skillFile);

    const wrapper = path.join(root, 'bin', 'polygon-agent');
    expect(mode(wrapper)).equal(0o755);
    expect(mode(path.join(root, 'state'))).equal(0o700);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).equal('*\n');
    expect(fs.existsSync(skillFile)).equal(true);

    const record = fs.readFileSync(path.join(root, 'state', 'install.json'), 'utf8');
    const second = await runCli({ args, home });
    expect(second.exitCode).equal(0);
    expect(second.stdoutJson).property('skill').property('installed').equal(true);
    expect(mode(wrapper)).equal(0o755);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).equal('*\n');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'state', 'install.json'), 'utf8')))
      .property('installedAt')
      .equal(JSON.parse(record).installedAt);
    expect(tripwireHits()).deep.equal([]);
  });

  it('refuses a root that already holds unrelated files and writes nothing there', async () => {
    resetTripwire();
    const home = makeHome();
    const root = path.join(home, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'notes.txt'), 'mine');

    const result = await runCli({ args: ['workspace', 'init', '--root', root], home });
    expect(result.exitCode).equal(1);
    expect(result.stdout).equal('');
    expect(result.stderrJson).property('ok').equal(false);
    expect(fs.readdirSync(root)).deep.equal(['notes.txt']);
    expect(tripwireHits()).deep.equal([]);
  });
});

describe('skills show', { timeout: 30_000 }, () => {
  it('prints the bundled skill unchanged', async () => {
    resetTripwire();
    const result = await runCli({ args: ['skills', 'show', 'open-money-agent'] });
    expect(result.exitCode).equal(0);
    expect(result.stdout).equal(fs.readFileSync(bundledSkill, 'utf8'));
    expect(tripwireHits()).deep.equal([]);
  });
});
