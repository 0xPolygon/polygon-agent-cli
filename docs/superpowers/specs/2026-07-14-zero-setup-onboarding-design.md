# Zero-setup onboarding: default publishable key and automatic Builder provisioning

Date: 2026-07-14
Status: approved (design agreed in conversation)

## Problem

Onboarding today needs two manual steps before the wallet works: obtain an OMS publishable key and run `setup --oms-publishable-key` (or export `SEQUENCE_PUBLISHABLE_KEY`), and separately run `setup` to provision a Sequence Builder project and access key (which carries the indexer and Trails quota). The target is that `polygon-agent wallet login` is the entire onboarding.

## Decision summary

1. The CLI ships a baked-in default publishable key. Publishable keys are client-embeddable by design; the CLI is the app, users are wallets within its OMS project. The default is the current sandbox key (`pk_sdbx_01kqfw9z...`); swapping it to a production project key is added to the existing staging-to-production cutover checklist. Resolution order becomes: `SEQUENCE_PUBLISHABLE_KEY` env, then `builder.json`, then the baked default. `setup --oms-publishable-key` and the env var remain as overrides.
2. After a successful `wallet login` (browser and `--local` paths alike), the CLI auto-provisions Builder credentials when `builder.json` has no access key: generate an ephemeral EOA, sign an ETHAuth proof (existing `lib/ethauth.ts`), exchange it at `api.sequence.build` for a JWT, create a project, fetch the default access key, and save everything to `builder.json`. This is the code path `setup` already uses, relocated to run automatically.
3. Provisioning is best-effort and idempotent: it never fails the login (a warning goes to stderr and the login JSON reports `builderProvisioned: false`), and it is skipped when an access key already exists. It re-runs on the next login after a failure.
4. Rejected for now: signing the ETHAuth proof with the embedded smart wallet (which would bind the Builder project to the user identity and allow cross-machine recovery). A spike on 2026-07-14 showed the OMS SDK's `signTypedData` cannot sign the chainless ETHAuth domain, and Builder-side ERC-1271 verification for a counterfactual wallet is unverified. Revisit when the SDK or Builder surface changes.

## Architecture

- `packages/polygon-agent-cli/src/lib/storage.ts`: `loadOmsConfig()` returns the baked default instead of null when neither env nor `builder.json` provide a key. The "OMS credentials not configured" error path disappears.
- New `packages/polygon-agent-cli/src/lib/builder-provision.ts`: `ensureBuilderAccessKey(deps): Promise<{ provisioned: boolean; reason?: string }>` with injected deps (config load/save, proof generation, HTTP calls) so it is unit-testable with fakes. The Builder HTTP helpers move out of `setup-ui` into a shared module or are imported from it.
- `wallet.ts` `handleLogin`: after `saveOmsWalletPointer`, call `ensureBuilderAccessKey` best-effort; add `builderProvisioned` to the success JSON; print a one-line stderr note when provisioning fails.
- `setup` stays for overrides and re-provisioning (`--force`), documented as advanced.
- Project naming: `polygon-agent-<first 8 hex chars of wallet address>` so a human can correlate a Builder project with an agent wallet.

## Error handling

- Any provisioning failure (network, Builder API error) is caught, reported on stderr with the failing stage, and surfaced as `builderProvisioned: false`. Login output is otherwise unchanged.
- A pre-existing `builder.json` access key short-circuits provisioning (`provisioned: false, reason: 'existing'`), preserving current users' projects.

## Testing

- Unit tests for `ensureBuilderAccessKey` with fake deps: fresh provisioning happy path, existing-key short-circuit, failure at each HTTP stage (login still succeeds), saved-config shape.
- `loadOmsConfig` default fallback covered by a test (env wins, file wins, default last).
- Manual verification: on a machine/profile with no `~/.polygon-agent`, `wallet login` alone yields a working wallet plus `builder.json` with publishableKey (default), accessKey, projectId; `balances` (indexer) and `deposit` dry-run (Trails) work with no env vars.

## Out of scope

- Wallet-signed Builder auth and cross-machine project recovery (follow-up).
- Any change to the OMS project the default key points at; swapping sandbox to production is a checklist item, not code.
- Deduplicating Builder projects across machines (each machine that provisions gets its own project, as `setup` does today).
