import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VaultItem } from './kernel.ts';
import type { PaymentLock } from './wallet-lock.ts';

import {
  ACT,
  amountForms,
  BrowserCheckouts,
  decideBrowserApproval,
  pageShowsAmount,
  PAY,
  PROBE,
  SNAPSHOT
} from './browser-checkout.ts';
import { Kernel, KernelError } from './kernel.ts';
import { approvalForPage } from './services.ts';
import { CredentialStore } from './store.ts';

const WALLET = '0x00000000000000000000000000000000000000aa';
const ORIGIN = 'https://agentconnect.test';
const APPROVAL = 'https://app.agentcard.sh/a/cauth_test';
const ALIASES = { number: '4242424242424242', cvc: '123', exp_month: '7', exp_year: '2031' };

function fakeKv() {
  const data = new Map<string, string>();
  return {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => void data.set(k, v)
  } as unknown as KVNamespace;
}

const PAGE = {
  url: 'https://shop.example/checkouts/cn/1',
  title: 'Checkout',
  text: 'Total €30,45',
  elements: ['e1 button[submit] "Pay now"']
};

/** Kernel as the service uses it, recording what it was asked. */
function fakeKernel(opts: { cardFields?: boolean; pageText?: string; unknownUser?: boolean } = {}) {
  const items = new Map<string, VaultItem>();
  const calls: { script: string; args: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  let browsers = 0;
  const name = (code: string) =>
    code === SNAPSHOT
      ? 'snapshot'
      : code === ACT
        ? 'act'
        : code === PROBE
          ? 'probe'
          : code === PAY
            ? 'pay'
            : '?';
  const kernel = {
    providerConfig: 'agentconnect-test',
    registered: 0,
    async ensureProviderConfig() {
      this.registered++;
    },
    vault: async (n: string) => ({ id: 'v1', name: n }),
    getItem: async (_v: string, key: string) => items.get(key) ?? null,
    putItem: async (
      _v: string,
      key: string,
      item: { type: string; spec: Record<string, unknown> }
    ) => {
      if (item.type === 'wallet' && opts.unknownUser) {
        throw new KernelError(400, 'AgentCard user is not connected or accessible');
      }
      const stored: VaultItem = {
        key,
        type: item.type,
        spec: item.spec,
        state:
          item.type === 'wallet' ? { status: 'connected' } : { status: 'ready', aliases: ALIASES }
      };
      items.set(key, stored);
      return stored;
    },
    updateItem: async (
      _v: string,
      key: string,
      item: { type: string; spec: Record<string, unknown> }
    ) => {
      const stored = { ...items.get(key)!, spec: item.spec };
      items.set(key, stored);
      return stored;
    },
    deleteItem: async (_v: string, key: string) => void items.delete(key),
    createBrowser: async () => ({ session_id: `b${++browsers}` }),
    deleteBrowser: async (id: string) => void deleted.push(id),
    playwright: async (_b: string, code: string, args: Record<string, unknown>) => {
      const script = name(code);
      calls.push({ script, args });
      if (script === 'snapshot') return { success: true, result: PAGE };
      if (script === 'probe') {
        return {
          success: true,
          result: {
            url: PAGE.url,
            text: opts.pageText ?? 'Subtotal €29,00 Shipping €1,45 Total €30,45',
            cardFields: opts.cardFields ?? true
          }
        };
      }
      if (script === 'pay') return { success: true, result: { pressed: true } };
      return { success: true, result: { opened: false } };
    }
  };
  /** AgentCard's authorization, as Kernel reports it on the card item. */
  const authorize = (status: string, extra: Record<string, unknown> = {}) => {
    const card = items.get('checkout-card')!;
    card.state = {
      ...card.state,
      status: status === 'awaiting_approval' ? 'pending_approval' : 'ready',
      authorization: {
        id: 'auth_1',
        status: status as 'awaiting_approval',
        approval_url: APPROVAL,
        amount_cents: 3045,
        currency: 'eur',
        merchant: 'shop.example',
        browser_id: 'b1',
        created_at: new Date(Date.now() + 1000).toISOString(),
        ...extra
      }
    };
  };
  return { kernel: kernel as unknown as Kernel, fake: kernel, calls, items, deleted, authorize };
}

async function setup(kernelOpts = {}, linked = true) {
  const db = new CredentialStore(fakeKv(), 'test-credentials-key');
  if (linked) await db.update(WALLET, (r) => ({ ...r, agentcardUsers: ['usr_owner'] }));
  const k = fakeKernel(kernelOpts);
  return { db, ...k, checkouts: new BrowserCheckouts(db, k.kernel, WALLET) };
}

const pay = (
  checkouts: BrowserCheckouts,
  id: string,
  lock: PaymentLock | null = null,
  total = 3045
) =>
  checkouts.pay(
    id,
    { totalCents: total, currency: 'EUR', payRef: undefined, holderName: 'Alex Rivera' },
    lock
  );

function onceLock(): PaymentLock {
  const seen = new Set<string>();
  return {
    claim: async (key: string) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }
  } as PaymentLock;
}

describe('amounts on the page', () => {
  it('reads a total in the forms stores print it', () => {
    expect(amountForms(123450, 'eur')).toEqual(
      expect.arrayContaining(['1234.50', '1,234.50', '1.234,50', '1 234,50'])
    );
    expect(pageShowsAmount('Total €30,45 EUR', 3045, 'eur')).toBe(true);
    expect(pageShowsAmount('Total $1,234.50', 123450, 'usd')).toBe(true);
    expect(pageShowsAmount('Total ¥3,045', 3045, 'jpy')).toBe(true);
  });

  it("doesn't match an amount inside a longer one", () => {
    expect(pageShowsAmount('Total €130.45', 3045, 'eur')).toBe(false);
    expect(pageShowsAmount('Total €30.450', 3045, 'eur')).toBe(false);
  });
});

describe('browser checkouts', () => {
  it('needs a saved card first', async () => {
    const { checkouts } = await setup({}, false);
    await expect(
      checkouts.start({ productUrl: 'https://shop.example/p/1', description: 'Coffee beans' })
    ).rejects.toThrow(/add_card/);
  });

  it("imports the owner's AgentCard user and opens the product page", async () => {
    const { checkouts, items, calls, fake } = await setup();
    const { c, page } = await checkouts.start({
      productUrl: 'https://shop.example/p/1',
      description: 'Coffee beans'
    });
    expect(c).toMatchObject({ status: 'browsing', browserId: 'b1' });
    expect(page).toEqual(PAGE);
    expect(items.get('agentcard-wallet')?.spec).toEqual({
      provider: 'agentcard',
      provider_config: { name: 'agentconnect-test' },
      user_id: 'usr_owner'
    });
    expect(fake.registered).toBe(1);
    expect(calls[0]).toEqual({
      script: 'act',
      args: { action: 'open', url: 'https://shop.example/p/1' }
    });
  });

  it("says so when AgentCard doesn't know the owner's user", async () => {
    const { checkouts } = await setup({ unknownUser: true });
    await expect(
      checkouts.start({ productUrl: 'https://shop.example/p/1', description: 'Coffee beans' })
    ).rejects.toThrow(/add the card again/);
  });

  it('passes what the agent sends as data, and checks refs and keys', async () => {
    const { checkouts, calls } = await setup();
    const { c } = await checkouts.start({
      productUrl: 'https://shop.example/p/1',
      description: 'x'
    });
    await checkouts.act(c.id, { action: 'type', ref: 'e5', text: '"); evil(); ("' });
    expect(calls.at(-2)).toEqual({
      script: 'act',
      args: { action: 'type', ref: 'e5', text: '"); evil(); ("', submit: false }
    });
    await expect(checkouts.act(c.id, { action: 'click', ref: 'button' })).rejects.toThrow(/ref/);
    await expect(checkouts.act(c.id, { action: 'press', key: 'Control+w' })).rejects.toThrow(/key/);
    await expect(
      checkouts.act(c.id, { action: 'open', url: 'javascript:alert(1)' })
    ).rejects.toThrow(/http/);
  });

  it('refuses to pay before the payment step, or for a total the page does not show', async () => {
    const noFields = await setup({ cardFields: false });
    const a = await noFields.checkouts.start({
      productUrl: 'https://shop.example/p',
      description: 'x'
    });
    await expect(pay(noFields.checkouts, a.c.id)).rejects.toThrow(/no card fields/);

    const other = await setup();
    const b = await other.checkouts.start({
      productUrl: 'https://shop.example/p',
      description: 'x'
    });
    await expect(pay(other.checkouts, b.c.id, null, 2500)).rejects.toThrow(
      /isn't on the checkout page/
    );
    expect(other.calls.some((x) => x.script === 'pay')).toBe(false);
  });

  it('types the placeholder card, presses pay, and sends the owner our approval page', async () => {
    const { checkouts, calls, items, authorize, db } = await setup();
    const { c } = await checkouts.start({
      productUrl: 'https://shop.example/p',
      description: 'Coffee beans'
    });
    expect(await pay(checkouts, c.id)).toBeNull();
    expect(items.get('checkout-card')?.spec).toEqual({
      provider: 'agentcard',
      wallet: 'agentcard-wallet',
      merchant: 'shop.example',
      amount: 3045,
      currency: 'eur',
      checkout_origin: 'https://shop.example'
    });
    expect(calls.find((x) => x.script === 'pay')?.args).toEqual({
      number: ALIASES.number,
      expiry: '0731',
      cvc: '123',
      name: 'Alex Rivera',
      payRef: null
    });
    authorize('awaiting_approval');
    const status = await checkouts.status(c.id, ORIGIN, 0);
    expect(status).toMatchObject({
      status: 'pending_approval',
      merchant: 'shop.example',
      total: '€30.45'
    });
    const approvalId = (status as { approval_url: string }).approval_url.split('r=')[1];
    expect((status as { approval_url: string }).approval_url).toBe(
      `${ORIGIN}/approve?r=${approvalId}`
    );
    // AgentCard's own link stays out of what the agent sees.
    expect(JSON.stringify(status)).not.toContain('agentcard.sh');
    expect((await approvalForPage(db, approvalId))?.approval).toMatchObject({
      kind: 'browser',
      totalCents: 3045,
      currency: 'eur',
      items: [{ name: 'Coffee beans', qty: 1 }]
    });
  });

  it('pays at most once', async () => {
    const { checkouts, calls } = await setup();
    const lock = onceLock();
    const { c } = await checkouts.start({ productUrl: 'https://shop.example/p', description: 'x' });
    await pay(checkouts, c.id, lock);
    await expect(pay(checkouts, c.id, lock)).rejects.toThrow(/waiting for the owner|before paying/);
    expect(calls.filter((x) => x.script === 'pay')).toHaveLength(1);
  });

  it('sends the owner on to AgentCard when they approve, and closes the browser when they decline', async () => {
    const { checkouts, authorize, db, deleted } = await setup();
    const { c } = await checkouts.start({ productUrl: 'https://shop.example/p', description: 'x' });
    await pay(checkouts, c.id);
    authorize('awaiting_approval');
    const approvalId = (await checkouts.find(c.id)).approvalId!;
    const approval = (await approvalForPage(db, approvalId))!.approval;
    expect(await decideBrowserApproval(checkouts, approval, true)).toEqual({
      status: 'awaiting_passkey',
      passkeyUrl: APPROVAL
    });
    expect(await decideBrowserApproval(checkouts, approval, false)).toEqual({ status: 'declined' });
    expect(deleted).toContain('b1');
    expect(await checkouts.status(c.id, ORIGIN, 0)).toMatchObject({ status: 'declined' });
  });

  it('reports a paid checkout with the page, and marks its approval placed', async () => {
    const { checkouts, authorize, db } = await setup();
    const { c } = await checkouts.start({ productUrl: 'https://shop.example/p', description: 'x' });
    await pay(checkouts, c.id);
    authorize('approved', { charged_kind: 'captured', replay_delivered: true });
    const status = await checkouts.status(c.id, ORIGIN, 0);
    expect(status).toMatchObject({ status: 'paid', page: PAGE });
    const approvalId = (await checkouts.find(c.id)).approvalId!;
    expect((await approvalForPage(db, approvalId))?.approval.status).toBe('placed');
  });

  it('reports a card AgentCard declined, and closes the browser', async () => {
    const { checkouts, authorize, deleted } = await setup();
    const { c } = await checkouts.start({ productUrl: 'https://shop.example/p', description: 'x' });
    await pay(checkouts, c.id);
    authorize('declined', { reason: 'cardholder_declined' });
    expect(await checkouts.status(c.id, ORIGIN, 0)).toMatchObject({ status: 'declined' });
    expect(deleted).toContain('b1');
  });

  it('keeps one checkout open at a time', async () => {
    const { checkouts, deleted } = await setup();
    const first = await checkouts.start({ productUrl: 'https://shop.example/p', description: 'x' });
    await checkouts.start({ productUrl: 'https://shop.example/q', description: 'y' });
    expect(deleted).toEqual(['b1']);
    expect(await checkouts.status(first.c.id, ORIGIN, 0)).toMatchObject({ status: 'canceled' });
  });
});

describe('Kernel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("registers the deployment's AgentCard client once, named after it", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('{"message":"exists"}', { status: bodies.length === 1 ? 201 : 409 });
    });
    const k = new Kernel('key', 'agentconnect-test', {
      clientId: 'cb09e0dd-2eaa',
      clientSecret: 'secret'
    });
    expect(k.providerConfig).toBe('agentconnect-test-cb09e0dd');
    await k.ensureProviderConfig();
    await k.ensureProviderConfig();
    expect(bodies).toEqual([
      {
        name: 'agentconnect-test-cb09e0dd',
        provider: 'agentcard',
        credentials: { client_id: 'cb09e0dd-2eaa', client_secret: 'secret' }
      }
    ]);
    // Another isolate finds it registered already.
    await new Kernel('key', 'agentconnect-other', {
      clientId: 'cb09e0dd-2eaa',
      clientSecret: 'secret'
    }).ensureProviderConfig();
    expect(bodies).toHaveLength(2);
  });
});
