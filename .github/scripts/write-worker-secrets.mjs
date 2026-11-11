// Collects the Worker secrets that are set into a file for `wrangler deploy --secrets-file`.
// Unset ones are left out (their endpoints answer 503); wrangler never deletes secrets.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const keys = ['AGENT_CERT_SECRET', 'CREDENTIALS_KEY', 'INDEXER_ACCESS_KEY', 'TRAILS_API_KEY'];

const runnerTemp = process.env.RUNNER_TEMP;
if (!runnerTemp) {
  console.error('::error::RUNNER_TEMP is not set');
  process.exit(1);
}

const secrets = Object.fromEntries(
  keys.filter((key) => process.env[key]).map((key) => [key, process.env[key]])
);
writeFileSync(join(runnerTemp, 'worker-secrets.json'), JSON.stringify(secrets), { mode: 0o600 });
