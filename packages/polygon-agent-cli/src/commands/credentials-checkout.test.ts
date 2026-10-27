import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { checkoutOut as CheckoutOut } from './credentials.ts';

let home: string;
let checkoutOut: typeof CheckoutOut;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-checkout-'));
  vi.stubEnv('POLYGON_AGENT_HOME', home);
  ({ checkoutOut } = await import('./credentials.ts'));
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('checkout output', () => {
  const ready = {
    status: 'card_ready',
    checkoutId: 'apr_0123456789abcdef01234567',
    merchant: 'Zalando',
    totalCents: 8990,
    card: { number: '4111111111117318', expMonth: 12, expYear: 2030, cvc: '123', last4: '7318' }
  };

  it('keeps the card in a private file and out of the output', () => {
    const out = checkoutOut(ready, 'main');
    expect(JSON.stringify(out)).not.toContain('4111111111117318');
    expect(JSON.stringify(out)).not.toContain('"123"');
    expect(out).toMatchObject({ card: { last4: '7318' } });
    const file = out.cardFile as string;
    expect(file.startsWith(home)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      number: '4111111111117318',
      cvc: '123',
      totalCents: 8990
    });
    expect(out.then).toContain(`checkout --done ${ready.checkoutId}`);
  });

  it('sends the owner the approval link over the limit', () => {
    const out = checkoutOut(
      {
        status: 'pending_approval',
        checkoutId: 'apr_1',
        approvalUrl: 'https://x.test/approve?r=apr_1'
      },
      'work'
    );
    expect(out).toMatchObject({ then: 'polygon-agent buy --approval apr_1 --wait --wallet work' });
    expect(out.cardFile).toBeUndefined();
  });
});
