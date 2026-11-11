import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupHarness,
  makeHome,
  resetTripwire,
  runCli,
  tripwireHits
} from '../test-harness/cli.ts';

afterAll(cleanupHarness);

// Throwaway values; the shape follows OmsWalletPointer in lib/storage.ts.
function seedWallet(params: { home: string; name: string; access?: 'owner' | 'session' }): {
  address: string;
  pointerPath: string;
  omsDir: string;
} {
  const address = `0x${randomBytes(20).toString('hex')}`;
  const pointerPath = path.join(params.home, 'wallets', `${params.name}.json`);
  const omsDir = path.join(params.home, 'oms', params.name);
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  fs.mkdirSync(omsDir, { recursive: true });
  fs.writeFileSync(path.join(omsDir, 'session.json'), '{}');
  fs.writeFileSync(
    pointerPath,
    JSON.stringify({
      walletAddress: address,
      loginMethod: 'email',
      createdAt: new Date().toISOString(),
      ...(params.access ? { access: params.access } : {})
    })
  );
  return { address, pointerPath, omsDir };
}

describe('agent wallet', { timeout: 30_000 }, () => {
  it('lists seeded wallets and prints one address', async () => {
    resetTripwire();
    const home = makeHome();
    const main = seedWallet({ home, name: 'main' });
    const other = seedWallet({ home, name: 'other' });

    const list = await runCli({ args: ['wallet', 'list'], home });
    expect(list.exitCode).equal(0);
    expect(list.stdoutJson)
      .property('wallets')
      .deep.members([
        {
          name: 'main',
          address: main.address,
          chain: 'polygon',
          chainId: 137,
          loginMethod: 'email'
        },
        {
          name: 'other',
          address: other.address,
          chain: 'polygon',
          chainId: 137,
          loginMethod: 'email'
        }
      ]);

    const address = await runCli({ args: ['wallet', 'address', '--name', 'other'], home });
    expect(address.exitCode).equal(0);
    expect(address.stdoutJson).property('walletAddress').equal(other.address);
    expect(tripwireHits()).deep.equal([]);
  });

  it('fails for a missing wallet with the failure JSON on stdout (current behaviour)', async () => {
    resetTripwire();
    const result = await runCli({ args: ['wallet', 'address', '--name', 'ghost'] });
    expect(result.exitCode).equal(1);
    expect(result.stdoutJson).property('ok').equal(false);
    expect(result.stdoutJson).property('error').contain('Wallet not found: ghost');
    expect(result.stderr).equal('');
    expect(tripwireHits()).deep.equal([]);
  });

  it('remove deletes an owner wallet pointer and its SDK state dir', async () => {
    resetTripwire();
    const home = makeHome();
    const owner = seedWallet({ home, name: 'owner-wallet', access: 'owner' });
    const keep = seedWallet({ home, name: 'keep' });

    await runCli({ args: ['wallet', 'remove', '--name', 'owner-wallet'], home });
    // The on-disk result is the contract here; the exit code is not asserted.
    expect(fs.existsSync(owner.pointerPath)).equal(false);
    expect(fs.existsSync(owner.omsDir)).equal(false);
    expect(fs.existsSync(keep.pointerPath)).equal(true);
    expect(tripwireHits()).deep.equal([]);
  });

  it('remove refuses a session wallet and keeps its files', async () => {
    resetTripwire();
    const home = makeHome();
    const session = seedWallet({ home, name: 'main', access: 'session' });

    const result = await runCli({ args: ['wallet', 'remove'], home });
    expect(result.exitCode).equal(1);
    expect(result.stdout).equal('');
    expect(result.stderrJson).property('code').equal('invalid_input');
    expect(fs.existsSync(session.pointerPath)).equal(true);
    expect(fs.existsSync(session.omsDir)).equal(true);
    expect(tripwireHits()).deep.equal([]);
  });
});
