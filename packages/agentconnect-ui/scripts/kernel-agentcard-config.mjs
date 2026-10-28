// Once per deployment: register its AgentCard client with Kernel, so Kernel's
// vault can hold a store's card request and ask AgentCard for the owner's
// approval (worker/browser-checkout.ts). Configurations are shared across the
// Kernel organization, so this needs an organization-wide Kernel API key.
//
// Usage: node scripts/kernel-agentcard-config.mjs <vars file> <name>
//   e.g. node scripts/kernel-agentcard-config.mjs .dev.vars.staging agentconnect-staging
// The vars file holds KERNEL_API_KEY, AGENTCARD_CLIENT_ID and
// AGENTCARD_CLIENT_SECRET; <name> is the deployment's KERNEL_AGENTCARD_CONFIG
// in wrangler.toml. Prints the name and whether AgentCard is in test mode,
// never the credentials.

import { readFileSync } from 'node:fs';

const [file, name] = process.argv.slice(2);
if (!file || !name) throw new Error('Usage: kernel-agentcard-config.mjs <vars file> <name>');

const vars = Object.fromEntries(
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
    })
);
for (const k of ['KERNEL_API_KEY', 'AGENTCARD_CLIENT_ID', 'AGENTCARD_CLIENT_SECRET']) {
  if (!vars[k]) throw new Error(`${k} is missing from ${file}`);
}

const res = await fetch('https://api.onkernel.com/vault-provider-configs', {
  method: 'POST',
  headers: { authorization: `Bearer ${vars.KERNEL_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    name,
    provider: 'agentcard',
    credentials: {
      client_id: vars.AGENTCARD_CLIENT_ID,
      client_secret: vars.AGENTCARD_CLIENT_SECRET
    }
  })
});
const body = await res.json().catch(() => ({}));
if (res.status === 409) {
  console.log(`${name} is already registered with Kernel.`);
} else if (!res.ok) {
  console.error(`Kernel refused it (${res.status}): ${body.message ?? JSON.stringify(body)}`);
  process.exit(1);
} else {
  console.log(`Registered ${body.name} (AgentCard ${body.test_mode ? 'sandbox' : 'live'}).`);
}
