import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendJsonLine } from './jsonl.ts';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-jsonl-')), 'log.jsonl');

describe('appendJsonLine', () => {
  it('creates the file owner-only and appends one line per entry', () => {
    const file = tmpFile();
    appendJsonLine({ file, entry: { a: 1 } });
    appendJsonLine({ file, entry: { b: 2 } });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('starts a new line after a torn earlier append, so neither swallows the other', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{"a":1}\n{"to', { mode: 0o600 });
    appendJsonLine({ file, entry: { b: 2 } });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n{"to\n{"b":2}\n');
  });
});
