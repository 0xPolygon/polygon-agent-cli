// Appending one JSON line to a log that many runs append to (alerts, x402
// payments). Everything goes through one descriptor, never a check by path
// and then a write by path, so the file can't change between the two. A torn
// earlier append (no final newline) gets its newline first, so it can't
// swallow this entry.

import fs from 'node:fs';

export function appendJsonLine(params: { file: string; entry: unknown }): void {
  const fd = fs.openSync(params.file, 'a+', 0o600);
  try {
    const { size } = fs.fstatSync(fd);
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last.toString() !== '\n') prefix = '\n';
    }
    fs.writeSync(fd, `${prefix}${JSON.stringify(params.entry)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}
