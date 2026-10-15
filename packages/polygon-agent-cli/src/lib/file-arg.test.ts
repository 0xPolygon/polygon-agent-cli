// `@file` arguments never read the CLI's own state, where the wallet keys are.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-state-'));
process.env.POLYGON_AGENT_HOME = home;
fs.writeFileSync(path.join(home, '.encryption-key'), 'secret');
const { fileCoerce } = await import('./utils.ts');

describe('fileCoerce', () => {
  it('reads an ordinary file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-body-')), 'body.json');
    fs.writeFileSync(file, '{"q":1}\n');
    expect(fileCoerce(`@${file}`)).toBe('{"q":1}');
  });

  it('refuses files in the state folder, however the path is written', () => {
    expect(() => fileCoerce(`@${path.join(home, '.encryption-key')}`)).toThrow(/state folder/);
    expect(() => fileCoerce(`@${home}/sub/../.encryption-key`)).toThrow(/state folder/);
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-link-')), 'innocent.json');
    fs.symlinkSync(path.join(home, '.encryption-key'), link);
    expect(() => fileCoerce(`@${link}`)).toThrow(/state folder/);
    // A symlink to the folder itself, then a file inside it.
    const folderLink = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-link-')), 'dir');
    fs.symlinkSync(home, folderLink);
    expect(() => fileCoerce(`@${folderLink}/.encryption-key`)).toThrow(/state folder/);
  });
});
