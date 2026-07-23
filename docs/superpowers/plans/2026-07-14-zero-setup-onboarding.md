# Zero-Setup Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `polygon-agent wallet login` becomes the entire onboarding: the CLI ships a default publishable key, and a successful login auto-provisions a Sequence Builder project + access key into `builder.json`.

**Architecture:** Three small moves. (1) `loadOmsConfig` falls back to a baked-in default publishable key so `getOmsClient` always constructs. (2) The Builder HTTP helpers move from the ink UI file into a lib module. (3) A new `ensureBuilderAccessKey` lib (dependency-injected, unit-tested) runs best-effort after login, reusing the existing ephemeral-EOA ETHAuth flow from `setup`. Spec: `docs/superpowers/specs/2026-07-14-zero-setup-onboarding-design.md`.

**Tech Stack:** TypeScript CLI (yargs, es2023), ethers (existing), vitest (already set up in this package).

## Global Constraints

- Conventional commit messages with package scope; never add a Co-Authored-By trailer. The pre-commit hook runs `pnpm -r run typecheck`.
- No em dashes in any new copy (docs, CLI strings, comments); sentence case.
- Canonical skill docs live in the repo-root `skills/` tree only; never create `packages/polygon-agent-cli/skills/`.
- Provisioning must NEVER fail or slow a successful login beyond its own network calls: every failure is caught, reported on stderr, and reflected as `builderProvisioned: false` in the login JSON.
- The default publishable key is the sandbox key from this machine's `~/.polygon-agent/builder.json` (`publishableKey` field, starts `pk_sdbx_01kqfw9z`); the implementer reads the full value from that file. Swapping it to a production key is a release-checklist item, not code in this plan.
- Existing users' `builder.json` (with accessKey already present) must be untouched by login.

---

### Task 1: Move Builder HTTP helpers into a lib module

**Files:**
- Create: `packages/polygon-agent-cli/src/lib/builder-api.ts`
- Modify: `packages/polygon-agent-cli/src/commands/setup-ui.tsx` (delete the three helpers, import from lib)
- Modify: `packages/polygon-agent-cli/src/commands/setup.ts` (import from lib)

**Interfaces:**
- Consumes: nothing new.
- Produces: `getAuthToken(proofString: string): Promise<string>`, `createProject(name: string, jwtToken: string): Promise<{ id: number; name: string }>`, `getDefaultAccessKey(projectId: number, jwtToken: string): Promise<string>` exported from `lib/builder-api.ts`. Task 3 imports them.

- [ ] **Step 1: Create the lib module**

Create `packages/polygon-agent-cli/src/lib/builder-api.ts` with a header comment and the three functions moved VERBATIM from `packages/polygon-agent-cli/src/commands/setup-ui.tsx` (they are the top-of-file exports `getAuthToken`, `createProject`, `getDefaultAccessKey`; each reads `process.env.SEQUENCE_BUILDER_API_URL || 'https://api.sequence.build'`). Header comment:

```ts
// Sequence Builder API helpers (GetAuthToken / CreateProject / GetDefaultAccessKey).
// Used by `setup` and by the post-login auto-provisioning in lib/builder-provision.ts.
```

- [ ] **Step 2: Update the two import sites**

- In `setup-ui.tsx`: delete the three function bodies and their now-unused imports if any; add `export { getAuthToken, createProject, getDefaultAccessKey } from '../lib/builder-api.ts';` so any other consumer keeps working.
- In `setup.ts`: change the import line `import { SetupUI, getAuthToken, createProject, getDefaultAccessKey } from './setup-ui.js';` to import the three helpers from `../lib/builder-api.ts` and keep `SetupUI` from `./setup-ui.js`.

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @polygonlabs/agent-cli typecheck && pnpm --filter @polygonlabs/agent-cli test`
Expected: typecheck clean, 9/9 tests pass (pure move, no behavior change).

```bash
git add packages/polygon-agent-cli/src/lib/builder-api.ts packages/polygon-agent-cli/src/commands/setup-ui.tsx packages/polygon-agent-cli/src/commands/setup.ts
git commit -m "refactor(cli): move Builder API helpers into lib/builder-api"
```

---

### Task 2: Default publishable key in loadOmsConfig, with tests

**Files:**
- Modify: `packages/polygon-agent-cli/src/lib/storage.ts` (`loadOmsConfig`)
- Modify: `packages/polygon-agent-cli/src/lib/oms-client.ts` (drop the unreachable not-configured error)
- Test: `packages/polygon-agent-cli/src/lib/oms-config.test.ts`

**Interfaces:**
- Consumes: existing `OmsConfig` type, `loadOmsConfig(): OmsConfig | null`.
- Produces: `loadOmsConfig(): OmsConfig` (never null) and exported `DEFAULT_SEQUENCE_PUBLISHABLE_KEY` from storage.ts. `getOmsClient` no longer throws for missing config.

- [ ] **Step 1: Write the failing tests**

Create `packages/polygon-agent-cli/src/lib/oms-config.test.ts`. Storage computes its dir from `os.homedir()` at import time, so each case stubs `HOME` and imports a FRESH module copy:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function freshStorage(home: string) {
  vi.resetModules();
  vi.stubEnv('HOME', home);
  return await import('./storage.ts');
}

describe('loadOmsConfig resolution order', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('falls back to the baked-in default when neither env nor file exist', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    vi.stubEnv('SEQUENCE_PUBLISHABLE_KEY', '');
    const storage = await freshStorage(home);
    const cfg = storage.loadOmsConfig();
    expect(cfg.publishableKey).toBe(storage.DEFAULT_SEQUENCE_PUBLISHABLE_KEY);
    expect(cfg.publishableKey.startsWith('pk_')).toBe(true);
  });

  it('prefers builder.json over the default', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    fs.mkdirSync(path.join(home, '.polygon-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.polygon-agent', 'builder.json'),
      JSON.stringify({ publishableKey: 'pk_test_fromfile' })
    );
    vi.stubEnv('SEQUENCE_PUBLISHABLE_KEY', '');
    const storage = await freshStorage(home);
    expect(storage.loadOmsConfig().publishableKey).toBe('pk_test_fromfile');
  });

  it('prefers the env var over everything', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-home-'));
    vi.stubEnv('SEQUENCE_PUBLISHABLE_KEY', 'pk_test_fromenv');
    const storage = await freshStorage(home);
    expect(storage.loadOmsConfig().publishableKey).toBe('pk_test_fromenv');
  });
});
```

Note: the empty-string stub for `SEQUENCE_PUBLISHABLE_KEY` matters because the developer shell may have it set; `loadOmsConfig` treats empty as unset (it already does: `if (envPk)`).

Run: `pnpm --filter @polygonlabs/agent-cli test`
Expected: FAIL (`DEFAULT_SEQUENCE_PUBLISHABLE_KEY` not exported; null return).

- [ ] **Step 2: Implement**

In `storage.ts`, above `loadOmsConfig`:

```ts
// Default OMS publishable key so `wallet login` works with zero setup.
// Publishable keys are client-embeddable by design; users are wallets inside
// the CLI's shared OMS project. Currently the sandbox project key; swap to the
// production project key at the staging-to-production cutover. Override with
// SEQUENCE_PUBLISHABLE_KEY or `setup --oms-publishable-key`.
export const DEFAULT_SEQUENCE_PUBLISHABLE_KEY = '<full pk_sdbx_... value read from ~/.polygon-agent/builder.json>';
```

(The implementer substitutes the real value: `python3 -c "import json;print(json.load(open('$HOME/.polygon-agent/builder.json'))['publishableKey'])"`.)

Change `loadOmsConfig` to return type `OmsConfig` and replace its final `return null` with:

```ts
  return { publishableKey: DEFAULT_SEQUENCE_PUBLISHABLE_KEY, omsProjectId: envProj };
```

(keep the env and file branches exactly as they are). In `oms-client.ts`, `getOmsClient`: remove the `if (!cfg) throw new Error('OMS credentials not configured...')` block (the compiler will flag it as unreachable once the return type narrows; delete the block and the stale comment).

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @polygonlabs/agent-cli test && pnpm -r run typecheck`
Expected: 12/12 tests pass, typecheck clean.

```bash
git add packages/polygon-agent-cli/src/lib/storage.ts packages/polygon-agent-cli/src/lib/oms-client.ts packages/polygon-agent-cli/src/lib/oms-config.test.ts
git commit -m "feat(cli): default publishable key so wallet login needs no setup"
```

---

### Task 3: ensureBuilderAccessKey provisioning lib with tests

**Files:**
- Create: `packages/polygon-agent-cli/src/lib/builder-provision.ts`
- Test: `packages/polygon-agent-cli/src/lib/builder-provision.test.ts`

**Interfaces:**
- Consumes: `getAuthToken`/`createProject`/`getDefaultAccessKey` from Task 1's `lib/builder-api.ts`; `generateEthAuthProof` from `lib/ethauth.ts`; `loadBuilderConfig`/`saveBuilderConfig` from `lib/storage.ts` (existing: `saveBuilderConfig({ privateKey, eoaAddress, accessKey, projectId })` encrypts the key and merges into builder.json).
- Produces: `ensureBuilderAccessKey(walletAddress: string, deps: ProvisionDeps): Promise<ProvisionResult>`, `makeDefaultProvisionDeps(): ProvisionDeps`. Task 4 calls both.

- [ ] **Step 1: Write the failing tests**

Create `packages/polygon-agent-cli/src/lib/builder-provision.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { ensureBuilderAccessKey, type ProvisionDeps } from './builder-provision.ts';

function makeFakes(overrides: Partial<ProvisionDeps> = {}) {
  const saved: unknown[] = [];
  const deps: ProvisionDeps = {
    loadBuilderConfig: async () => null,
    saveBuilderConfig: async (cfg) => {
      saved.push(cfg);
    },
    createEoa: () => ({ privateKey: '0xkey', address: '0xE0A0000000000000000000000000000000000001' }),
    generateProof: async () => 'eth.proof',
    getAuthToken: async () => 'jwt-1',
    createProject: async (name) => ({ id: 4242, name }),
    getDefaultAccessKey: async () => 'AQAAAA-access-key',
    ...overrides
  };
  return { deps, saved };
}

const WALLET = '0xc2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17';

describe('ensureBuilderAccessKey', () => {
  it('provisions a project and saves the credentials', async () => {
    const { deps, saved } = makeFakes();
    const result = await ensureBuilderAccessKey(WALLET, deps);
    expect(result).toEqual({ provisioned: true });
    expect(saved).toEqual([
      {
        privateKey: '0xkey',
        eoaAddress: '0xE0A0000000000000000000000000000000000001',
        accessKey: 'AQAAAA-access-key',
        projectId: 4242
      }
    ]);
  });

  it('derives the project name from the wallet address', async () => {
    let projectName = '';
    const { deps } = makeFakes({
      createProject: async (name) => {
        projectName = name;
        return { id: 1, name };
      }
    });
    await ensureBuilderAccessKey(WALLET, deps);
    expect(projectName).toBe('polygon-agent-c2f4cafe');
  });

  it('short-circuits when an access key already exists', async () => {
    const { deps, saved } = makeFakes({
      loadBuilderConfig: async () =>
        ({ accessKey: 'existing', projectId: 1, privateKey: 'x', eoaAddress: '0x1' }) as never
    });
    const result = await ensureBuilderAccessKey(WALLET, deps);
    expect(result).toEqual({ provisioned: false, reason: 'existing' });
    expect(saved).toEqual([]);
  });

  it('reports the failing stage without throwing', async () => {
    const { deps: authFail } = makeFakes({
      getAuthToken: async () => {
        throw new Error('GetAuthToken failed: 500');
      }
    });
    await expect(ensureBuilderAccessKey(WALLET, authFail)).resolves.toEqual({
      provisioned: false,
      reason: 'auth: GetAuthToken failed: 500'
    });

    const { deps: projectFail, saved } = makeFakes({
      createProject: async () => {
        throw new Error('CreateProject failed: 403');
      }
    });
    await expect(ensureBuilderAccessKey(WALLET, projectFail)).resolves.toEqual({
      provisioned: false,
      reason: 'project: CreateProject failed: 403'
    });
    expect(saved).toEqual([]);
  });
});
```

Run: `pnpm --filter @polygonlabs/agent-cli test`
Expected: FAIL, cannot resolve `./builder-provision.ts`.

- [ ] **Step 2: Implement**

Create `packages/polygon-agent-cli/src/lib/builder-provision.ts`:

```ts
// Post-login Builder provisioning: gives every agent its own Sequence Builder
// project + access key (indexer and Trails quota) with zero manual steps.
// Signs an ETHAuth proof with an ephemeral EOA, exactly like `setup` always
// did, but runs automatically after `wallet login`. Best-effort by contract:
// this function never throws; a failure must never fail a completed login.

import { ethers } from 'ethers';

import { getAuthToken, createProject, getDefaultAccessKey } from './builder-api.ts';
import { generateEthAuthProof } from './ethauth.ts';
import { loadBuilderConfig, saveBuilderConfig } from './storage.ts';

export interface ProvisionDeps {
  loadBuilderConfig(): Promise<{ accessKey?: string } | null>;
  saveBuilderConfig(cfg: {
    privateKey: string;
    eoaAddress: string;
    accessKey: string;
    projectId: number;
  }): Promise<void>;
  createEoa(): { privateKey: string; address: string };
  generateProof(privateKey: string): Promise<string>;
  getAuthToken(proof: string): Promise<string>;
  createProject(name: string, jwt: string): Promise<{ id: number; name: string }>;
  getDefaultAccessKey(projectId: number, jwt: string): Promise<string>;
}

export interface ProvisionResult {
  provisioned: boolean;
  reason?: string;
}

export function makeDefaultProvisionDeps(): ProvisionDeps {
  return {
    loadBuilderConfig,
    saveBuilderConfig,
    createEoa: () => {
      const wallet = ethers.Wallet.createRandom();
      return { privateKey: wallet.privateKey, address: wallet.address };
    },
    generateProof: (privateKey) => generateEthAuthProof(privateKey),
    getAuthToken,
    createProject,
    getDefaultAccessKey
  };
}

/** Provision a Builder project + access key unless one already exists. Never throws. */
export async function ensureBuilderAccessKey(
  walletAddress: string,
  deps: ProvisionDeps
): Promise<ProvisionResult> {
  try {
    const existing = await deps.loadBuilderConfig();
    if (existing?.accessKey) return { provisioned: false, reason: 'existing' };
  } catch {
    // An unreadable config is treated as absent; provisioning may repair it.
  }

  const eoa = deps.createEoa();

  let jwt: string;
  try {
    const proof = await deps.generateProof(eoa.privateKey);
    jwt = await deps.getAuthToken(proof);
  } catch (error) {
    return { provisioned: false, reason: `auth: ${(error as Error).message}` };
  }

  const projectName = `polygon-agent-${walletAddress.slice(2, 10).toLowerCase()}`;

  let projectId: number;
  try {
    const project = await deps.createProject(projectName, jwt);
    projectId = project.id;
  } catch (error) {
    return { provisioned: false, reason: `project: ${(error as Error).message}` };
  }

  try {
    const accessKey = await deps.getDefaultAccessKey(projectId, jwt);
    await deps.saveBuilderConfig({
      privateKey: eoa.privateKey,
      eoaAddress: eoa.address,
      accessKey,
      projectId
    });
    return { provisioned: true };
  } catch (error) {
    return { provisioned: false, reason: `access-key: ${(error as Error).message}` };
  }
}
```

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @polygonlabs/agent-cli test && pnpm --filter @polygonlabs/agent-cli typecheck`
Expected: 16/16 tests pass.

```bash
git add packages/polygon-agent-cli/src/lib/builder-provision.ts packages/polygon-agent-cli/src/lib/builder-provision.test.ts
git commit -m "feat(cli): auto-provision Builder access key after login"
```

---

### Task 4: Wire provisioning into wallet login and update docs

**Files:**
- Modify: `packages/polygon-agent-cli/src/commands/wallet.ts` (handleLogin)
- Modify: `packages/polygon-agent-cli/README.md`, `skills/SKILL.md`, `skills/polygon-agent-cli/SKILL.md`, `CLAUDE.md` (onboarding sections)

**Interfaces:**
- Consumes: `ensureBuilderAccessKey`, `makeDefaultProvisionDeps` (Task 3).
- Produces: `wallet login` success JSON gains `builderProvisioned: boolean`; onboarding docs collapse to `wallet login`.

- [ ] **Step 1: Wire into handleLogin**

In `wallet.ts`, add the import:

```ts
import { ensureBuilderAccessKey, makeDefaultProvisionDeps } from '../lib/builder-provision.ts';
```

In `handleLogin`, between `await saveOmsWalletPointer(...)` and the `jsonOut(...)` success line, insert:

```ts
    // Zero-setup onboarding: give this agent its own Builder project + access
    // key (indexer and Trails quota). Best-effort: a failure never fails the
    // login and provisioning retries on the next login.
    const provision = await ensureBuilderAccessKey(walletAddress, makeDefaultProvisionDeps());
    const builderProvisioned = provision.provisioned || provision.reason === 'existing';
    if (!builderProvisioned) {
      process.stderr.write(
        `Note: Builder provisioning failed (${provision.reason}). ` +
          'Indexer and Trails calls fall back to shared defaults; it will retry on the next login.\n'
      );
    }
```

and change the success output to:

```ts
    jsonOut({ ok: true, walletName: argv.name, walletAddress, loginMethod, builderProvisioned });
```

(The already-logged-in short-circuit near the top of `handleLogin` stays untouched: it does not provision, because no new login happened.)

- [ ] **Step 2: Update docs**

All four docs say the same thing in their own voice, no em dashes:
- Onboarding is one command: `polygon-agent wallet login`. No key setup is needed: the CLI ships a default publishable key, and after login it automatically creates a Sequence Builder project and saves the access key to `~/.polygon-agent/builder.json`.
- `setup --oms-publishable-key` and `SEQUENCE_PUBLISHABLE_KEY` remain as overrides for developers pointing at their own OMS project; plain `setup` remains for manual or `--force` re-provisioning. Mark both as advanced.
- In `skills/polygon-agent-cli/SKILL.md` and `skills/SKILL.md`, update the quickstart (remove the setup step), the env-var table (`SEQUENCE_PUBLISHABLE_KEY` becomes optional override), the onboarding note, and the troubleshooting row for `OMS credentials not configured` (that error no longer exists; remove the row).
- In `CLAUDE.md`, update the "Requires SEQUENCE_PUBLISHABLE_KEY" bullet to describe the default + override.
- In `README.md`, update the getting-started and env-var sections accordingly.

- [ ] **Step 3: Smoke-check with a clean HOME**

```bash
CLEAN=$(mktemp -d)
HOME="$CLEAN" SEQUENCE_PUBLISHABLE_KEY= timeout 20 pnpm exec tsx packages/polygon-agent-cli/src/index.ts wallet login --timeout 8 --no-fund; echo "exit=$?"
ls "$CLEAN/.polygon-agent" 2>/dev/null || echo "no storage dir"
```

Expected: with NO builder.json and NO env key, the command prints `Open this URL to sign in:` with an agentconnect login URL (proving the baked default key constructed the OMS client), then times out after ~8s with the timed-out JSON error. No `OMS credentials not configured` error anywhere.

- [ ] **Step 4: Full verification and commit**

Run: `pnpm --filter @polygonlabs/agent-cli test && pnpm -r run typecheck && pnpm --filter @polygonlabs/agent-cli lint`
Expected: 16/16, clean, clean.

```bash
git add packages/polygon-agent-cli/src/commands/wallet.ts packages/polygon-agent-cli/README.md skills/SKILL.md skills/polygon-agent-cli/SKILL.md CLAUDE.md
git commit -m "feat(cli): wallet login auto-provisions Builder credentials (zero-setup onboarding)"
```

---

### Task 5: Live end-to-end on a clean profile

**Files:** none (verification only; fixes found here get their own commits).

- [ ] **Step 1: Real login with a fresh HOME (human in the loop)**

```bash
CLEAN=$(mktemp -d)
HOME="$CLEAN" pnpm exec tsx packages/polygon-agent-cli/src/index.ts wallet login --no-fund
```

The human completes the browser login (Google or email). Expected JSON: `{"ok":true,...,"builderProvisioned":true}`.

- [ ] **Step 2: Verify the provisioned state**

```bash
python3 - <<EOF
import json, os
d = json.load(open(os.environ['CLEAN'] + '/.polygon-agent/builder.json'))
print({k: (v[:12] + '...' if isinstance(v, str) and len(v) > 12 else v) for k, v in d.items()})
EOF
```

Expected keys: `privateKey` (encrypted blob), `eoaAddress`, `accessKey`, `projectId`. No `publishableKey` needed (default in code).

- [ ] **Step 3: Prove the quota chain works with zero env vars**

```bash
HOME="$CLEAN" pnpm exec tsx packages/polygon-agent-cli/src/index.ts balances
HOME="$CLEAN" pnpm exec tsx packages/polygon-agent-cli/src/index.ts deposit --asset USDC --amount 0.1
```

Expected: `balances` returns (zero balances are fine; it proves the indexer accepts the provisioned access key); `deposit` dry-run resolves an earn pool via Trails using the same key. Clean up: remove the wallet via the page/`wallet remove` and delete `$CLEAN`.

- [ ] **Step 4: Regression on the developer profile**

On the normal HOME (existing builder.json with accessKey): `pnpm exec tsx packages/polygon-agent-cli/src/index.ts wallet login --name regress --force --no-fund`, complete login, expect `builderProvisioned: true` (reason existing, no new project created; confirm `projectId` in `~/.polygon-agent/builder.json` is unchanged). Remove the `regress` wallet after.
