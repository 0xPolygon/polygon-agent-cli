import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CI runs tests before any build step, and subprocess tests drive dist/index.js,
// so the bundle is rebuilt once per run rather than assumed.
export function setup(): void {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const built = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: pkgDir,
    encoding: 'utf8'
  });
  if (built.status !== 0) {
    throw new Error(`CLI build failed (exit ${built.status}):\n${built.stdout}\n${built.stderr}`);
  }
}
