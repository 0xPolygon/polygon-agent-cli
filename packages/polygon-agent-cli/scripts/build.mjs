import fs from 'node:fs';
import path from 'node:path';

import * as esbuild from 'esbuild';

// Bundle the CLI with agent-shared inlined. All other node_modules packages
// remain as external runtime dependencies — they are listed in package.json
// dependencies and installed by npm/pnpm when the CLI is installed globally.
//
// agent-shared is private and not on npm, so it must be inlined. esbuild
// follows the workspace symlink, reads the TypeScript source directly, and
// includes the compiled output in dist/index.js.
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'es2023',
  format: 'esm',
  outfile: 'dist/index.js',
  plugins: [
    {
      name: 'external-node-modules',
      setup(build) {
        // Mark every bare import (node_modules package) as external,
        // EXCEPT @polygonlabs/agent-shared which we inline.
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith('@polygonlabs/agent-shared')) return null;
          return { external: true };
        });
      }
    }
  ]
});

// Bundle the repo's skills (skills/<name>/SKILL.md) into dist/skills/, for
// `skills show|install` and `workspace init`.
const skillsSrc = path.resolve('..', '..', 'skills');
const skillsOut = path.join('dist', 'skills');
fs.rmSync(skillsOut, { recursive: true, force: true });
for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
  const skill = path.join(skillsSrc, entry.name, 'SKILL.md');
  if (!entry.isDirectory() || !fs.existsSync(skill)) continue;
  fs.mkdirSync(path.join(skillsOut, entry.name), { recursive: true });
  fs.copyFileSync(skill, path.join(skillsOut, entry.name, 'SKILL.md'));
}

console.log('Build complete: dist/index.js, dist/skills/');
