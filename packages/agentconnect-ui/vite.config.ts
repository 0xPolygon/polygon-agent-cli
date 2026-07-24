import type { Plugin, ResolvedConfig } from 'vite';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(pkgDir, '../../skills');

// Copy the repo's agent skill tree into the build output so the deployed
// Cloudflare worker serves them as static assets at /SKILL.md,
// /polygon-agent-cli/SKILL.md, /polygon-defi/SKILL.md, etc. — the URLs the
// dashboard and the skills themselves reference. Without this the skills are
// only reachable from the retired connector-ui deployment.
function serveSkills(): Plugin {
  let absOutDir = path.resolve(pkgDir, 'dist');
  return {
    name: 'serve-skills',
    apply: 'build',
    configResolved(cfg: ResolvedConfig) {
      absOutDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    closeBundle() {
      if (!fs.existsSync(skillsDir)) {
        console.warn(`[serve-skills] skills dir not found at ${skillsDir}; nothing copied`);
        return;
      }
      // Mirror skills/* into dist/* (dist already holds the built SPA; the
      // skill tree only adds .md files under new paths, no collisions).
      fs.cpSync(skillsDir, absOutDir, { recursive: true });
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), serveSkills()],
  server: {
    port: 4444
  }
});
