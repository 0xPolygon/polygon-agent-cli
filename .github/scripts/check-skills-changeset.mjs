// Fails when `skills/**` changed but the pending changesets don't release both packages that
// ship skills (the CLI bundles them; the agentconnect-ui site serves them).
//
// `changeset status` exits non-zero without writing its output file when package files changed
// but no changesets exist, and exits 0 with an empty `releases` list when only `skills/` changed.
// Both mean "no changesets", so a non-zero exit or a missing file is treated the same as an empty
// list rather than as a tool failure.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REQUIRED = ['@polygonlabs/agent-cli', '@polygonlabs/agentconnect-ui'];
const base = process.env.BASE_REF || 'main';
const baseRef = `origin/${base}`;

const changedFiles = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
  encoding: 'utf8'
})
  .split('\n')
  .filter(Boolean);

if (!changedFiles.some((file) => file.startsWith('skills/'))) {
  console.log('no skills changes; nothing to check');
  process.exit(0);
}

const outputPath = join(process.env.RUNNER_TEMP ?? tmpdir(), 'changeset-status.json');
rmSync(outputPath, { force: true });

const status = spawnSync(
  'pnpm',
  ['exec', 'changeset', 'status', `--since=${baseRef}`, `--output=${outputPath}`],
  { stdio: ['ignore', 'inherit', 'inherit'] }
);

let released = new Set();
if (status.status === 0 && existsSync(outputPath)) {
  const { releases } = JSON.parse(readFileSync(outputPath, 'utf8'));
  released = new Set(releases.filter((r) => r.type !== 'none').map((r) => r.name));
}

const missing = REQUIRED.filter((name) => !released.has(name));
if (missing.length === 0) {
  console.log(`skills changed; changesets release ${REQUIRED.join(' and ')}`);
  process.exit(0);
}

for (const name of missing) {
  console.error(
    `::error::skills/ changed but no changeset releases ${name}. Run \`pnpm changeset\`, select ${name}, and commit the file.`
  );
}
process.exit(1);
