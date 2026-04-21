import type { Plugin } from 'vite';

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mirror skills/ at the repo root onto an explicit, enumerated URL surface.
// The SKILL protocol defines one file per skill directory (SKILL.md), and
// the published surface is exactly that — nothing else from skills/ is
// served, so stray files (.DS_Store, repo-local READMEs, lint configs)
// cannot leak to the CDN.
//
// Emitted paths, derived from skills/ contents at build and dev-server
// startup:
//
//   /SKILL.md                     <- skills/SKILL.md
//   /skills/SKILL.md              <- skills/SKILL.md
//   /skills/<sub-skill>/SKILL.md  <- skills/<sub-skill>/SKILL.md
//   /<sub-skill>/SKILL.md         <- skills/<sub-skill>/SKILL.md
//                                    (flattened mirror; compat with URLs
//                                     referenced in older CLIs' bundled
//                                     root SKILL.md)
//
// Adding skills/<new-skill>/SKILL.md starts serving both
// /skills/<new-skill>/SKILL.md and /<new-skill>/SKILL.md automatically
// on the next build.
export function mirrorSkills(): Plugin {
  const here = dirname(fileURLToPath(import.meta.url));
  const skillsDir = resolve(here, '../../../skills');

  const withinSkillsDir = (candidate: string) =>
    candidate === skillsDir || candidate.startsWith(`${skillsDir}/`);

  function resolveRequest(url: string): string | null {
    if (url === '/SKILL.md' || url === '/skills/SKILL.md') {
      return resolve(skillsDir, 'SKILL.md');
    }
    const match = url.match(/^\/(?:skills\/)?([^/]+)\/SKILL\.md$/);
    if (!match) return null;
    return resolve(skillsDir, match[1], 'SKILL.md');
  }

  return {
    name: 'mirror-skills',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        const file = resolveRequest(url);
        if (file && withinSkillsDir(file) && existsSync(file) && statSync(file).isFile()) {
          res.setHeader('content-type', 'text/markdown; charset=utf-8');
          res.end(readFileSync(file));
          return;
        }
        next();
      });
    },
    generateBundle() {
      if (!existsSync(skillsDir)) return;

      const rootSkill = resolve(skillsDir, 'SKILL.md');
      if (!existsSync(rootSkill)) return;

      const emit = (fileName: string, source: Buffer) => {
        this.emitFile({ type: 'asset', fileName, source });
      };

      // Root entrypoint — served at both /SKILL.md and /skills/SKILL.md
      const rootSource = readFileSync(rootSkill);
      emit('SKILL.md', rootSource);
      emit('skills/SKILL.md', rootSource);

      // Each sub-skill, served at both /skills/<name>/SKILL.md (structured)
      // and /<name>/SKILL.md (flattened, for older-CLI URL compat)
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = resolve(skillsDir, entry.name, 'SKILL.md');
        if (!existsSync(file)) continue;
        const source = readFileSync(file);
        emit(`skills/${entry.name}/SKILL.md`, source);
        emit(`${entry.name}/SKILL.md`, source);
      }
    }
  };
}
