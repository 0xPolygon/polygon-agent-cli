// Before a deploy: give each KV binding of one environment that has no id the
// id of the namespace wrangler created for it earlier (titled
// "<worker>-<binding>"), so wrangler reuses it instead of trying to create it
// again. That happens when a worker loses a binding and gets it back: the
// namespace and its data are still there, but wrangler only matches an id-less
// binding to the worker's current bindings, and creating a namespace with a
// title that exists fails.
//
// Usage: node scripts/pin-kv-ids.mjs <env> (CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID set). Edits wrangler.toml in place, in CI only.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const env = process.argv[2];
if (!env) throw new Error('Usage: pin-kv-ids.mjs <env>');

const file = new URL('../wrangler.toml', import.meta.url);
const lines = readFileSync(file, 'utf8').split('\n');

// The worker's name for this environment: the first `name =` in [env.<env>].
const start = lines.indexOf(`[env.${env}]`);
if (start < 0) throw new Error(`No [env.${env}] in wrangler.toml`);
const worker = lines
  .slice(start + 1)
  .find((l) => /^name\s*=/.test(l))
  ?.match(/"([^"]+)"/)?.[1];
if (!worker) throw new Error(`No worker name in [env.${env}]`);

// The JSON list, without any banner wrangler prints around it.
const listed = execFileSync('npx', ['-y', 'wrangler@4', 'kv', 'namespace', 'list'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit']
});
const namespaces = JSON.parse(listed.slice(listed.indexOf('['), listed.lastIndexOf(']') + 1));
const idFor = (title) => namespaces.find((n) => n.title === title)?.id;

const header = `[[env.${env}.kv_namespaces]]`;
const out = [];
for (let i = 0; i < lines.length; i++) {
  out.push(lines[i]);
  if (lines[i] !== header) continue;
  // The table's own lines, up to the next blank line or table.
  let j = i + 1;
  while (j < lines.length && lines[j].trim() && !lines[j].startsWith('[')) j++;
  const table = lines.slice(i + 1, j);
  const binding = table.join('\n').match(/^binding\s*=\s*"([^"]+)"/m)?.[1];
  if (binding && !table.some((l) => /^id\s*=/.test(l))) {
    const id = idFor(`${worker}-${binding.toLowerCase()}`);
    if (id) {
      out.push(`id = "${id}"`);
      console.log(`${binding}: reusing ${worker}-${binding.toLowerCase()}`);
    }
  }
}
writeFileSync(file, out.join('\n'));
