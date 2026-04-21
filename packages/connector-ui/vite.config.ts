import type { Plugin } from 'vite';

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Mirror skills/ at the repo root onto the following URL surface, purely in
// memory — no symlinks, no committed duplicates:
//
//   /SKILL.md                     <- skills/SKILL.md         (root entrypoint)
//   /skills/<...>                 <- skills/<...>            (full tree)
//   /<sub-skill>/SKILL.md         <- skills/<sub-skill>/SKILL.md
//                                   (compat with URLs referenced in older
//                                    CLIs' bundled root SKILL.md)
//
// Every pattern is derived dynamically from skills/ contents at build and
// dev-server startup. Adding skills/<new-skill>/SKILL.md starts serving
// /skills/<new-skill>/SKILL.md and /<new-skill>/SKILL.md automatically.
function mirrorSkills(): Plugin {
  const here = dirname(fileURLToPath(import.meta.url));
  const skillsDir = resolve(here, '../../skills');

  const withinSkillsDir = (candidate: string) =>
    candidate === skillsDir || candidate.startsWith(`${skillsDir}/`);

  const contentType = (file: string) =>
    file.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/octet-stream';

  function walk(dir: string, prefix: string, emit: (fileName: string, source: Buffer) => void) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${prefix}${entry.name}/`, emit);
      } else {
        emit(`${prefix}${entry.name}`, readFileSync(full));
      }
    }
  }

  function resolveRequest(url: string): string | null {
    if (url === '/SKILL.md') return resolve(skillsDir, 'SKILL.md');
    if (url.startsWith('/skills/')) return resolve(skillsDir, url.slice('/skills/'.length));
    const match = url.match(/^\/([^/]+)\/SKILL\.md$/);
    if (match) return resolve(skillsDir, match[1], 'SKILL.md');
    return null;
  }

  return {
    name: 'mirror-skills',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        const file = resolveRequest(url);
        if (file && withinSkillsDir(file) && existsSync(file) && statSync(file).isFile()) {
          res.setHeader('content-type', contentType(file));
          res.end(readFileSync(file));
          return;
        }
        next();
      });
    },
    generateBundle() {
      if (!existsSync(skillsDir)) return;

      const emit = (fileName: string, source: Buffer) => {
        this.emitFile({ type: 'asset', fileName, source });
      };

      // /SKILL.md
      emit('SKILL.md', readFileSync(resolve(skillsDir, 'SKILL.md')));

      // /skills/* (whole tree, recursive)
      walk(skillsDir, 'skills/', emit);

      // /<sub-skill>/SKILL.md (compat mirror for older-CLI URLs)
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = resolve(skillsDir, entry.name, 'SKILL.md');
        if (!existsSync(file)) continue;
        emit(`${entry.name}/SKILL.md`, readFileSync(file));
      }
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), mirrorSkills()],
  server: {
    port: 4444
  }
});
