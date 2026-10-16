import type { Plugin, ResolvedConfig } from 'vite';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { writeSkillIndex } from './skills-index.ts';

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(pkgDir, '../../skills');

// Copy the repo's agent skill tree into the build output so the deployed
// Cloudflare worker serves it as static assets: the AgentPay skill at
// /agentpay/SKILL.md with its references at /agentpay/references/<topic>.md.
//
// The AgentPay skill is the one entry point, so it is also served at /skill.md
// (what assistants are given), at /SKILL.md and /setup.md, and at every older
// skill URL (200, not a redirect: some agents don't follow redirects for
// markdown). Its references are also served at /references/<topic>.md, where its
// relative links resolve when it's read from one of the root copies. These are deploy-only
// copies: the repo's skills/ tree keeps one skill, so `npx skills add` offers one.
const ENTRY_SKILL = 'agentpay';
const ENTRY_ALIASES = [
  'skill.md',
  'setup.md',
  'SKILL.md',
  'polygon-agent-wallet/SKILL.md',
  'polygon-oms-wallet/SKILL.md',
  'polygon-agent-cli/SKILL.md',
  'polygon-defi/SKILL.md',
  'polygon-discovery/SKILL.md',
  'polygon-polymarket/SKILL.md'
];

function serveSkills(): Plugin {
  let absOutDir = path.resolve(pkgDir, 'dist');
  return {
    name: 'serve-skills',
    apply: 'build',
    configResolved(cfg: ResolvedConfig) {
      absOutDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    closeBundle() {
      // Mirror skills/* into dist/* (dist already holds the built SPA; the
      // skill tree only adds .md files under new paths, no collisions). A
      // missing or broken skill fails the build: the site serves the install guide.
      fs.cpSync(skillsDir, absOutDir, { recursive: true });
      // /.well-known/agent-skills/index.json, from the skills' frontmatter.
      writeSkillIndex({ skillsDir, outDir: absOutDir });

      const entry = path.join(skillsDir, ENTRY_SKILL, 'SKILL.md');
      for (const alias of ENTRY_ALIASES) {
        fs.mkdirSync(path.dirname(path.join(absOutDir, alias)), { recursive: true });
        fs.copyFileSync(entry, path.join(absOutDir, alias));
      }
      fs.cpSync(
        path.join(skillsDir, ENTRY_SKILL, 'references'),
        path.join(absOutDir, 'references'),
        { recursive: true }
      );
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), serveSkills()],
  // Worker tests run in Node, where the Workers runtime module doesn't exist.
  ...(process.env.VITEST
    ? {
        resolve: {
          alias: {
            'cloudflare:workers': path.resolve(pkgDir, 'worker/test-cloudflare-workers.ts')
          }
        },
        // Bundle the OAuth provider so the alias reaches its import.
        test: { server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } } }
      }
    : {}),
  server: {
    port: 4444
  }
});
