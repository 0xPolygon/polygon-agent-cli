// Checkouts at any store, run in a hosted browser for agents that have none
// (Grok, ChatGPT): the agent clicks through the store with our browsing tools,
// and when it reaches payment we type Kernel's placeholder card and press pay
// ourselves. Kernel's vault holds the store's card request, and AgentCard asks
// the owner to approve it; approved, the real card pays and the store sees the
// processor's answer. The agent never sees a card number, and every checkout
// waits for the owner, whatever the auto-pay limit.
//
// The owner's approval link goes through our /approve page (signed in), never
// to the agent: Kernel asks that AgentCard's link stays out of model context.
//
// The scripts below are fixed: what the agent sends (refs, text, keys, URLs)
// reaches them as JSON data, never as code.

import type { Env } from './index.ts';
import type { AgentCardAuthorization } from './kernel.ts';
import type { Approval, BrowserCheckout, CredentialStore } from './store.ts';
import type { PaymentLock } from './wallet-lock.ts';

import { Kernel, KernelError } from './kernel.ts';
import { createApproval, randomId, setApproval } from './services.ts';
import { ValidationError } from './shipping.ts';

// One wallet item per AgentCard user: Kernel fixes a wallet's user for good,
// and won't delete one whose card it can't settle (`recovery_required`).
const walletKey = (userId: string) => `wallet-${userId}`;
// One card item per checkout. Kernel never lets a card whose outcome it can't
// tell (`recovery_required`) be reused or deleted, so a stuck one must not
// block the next checkout.
const cardKey = (checkoutId: string) => `card-${checkoutId}`;
// Idle seconds before Kernel closes the browser.
const BROWSER_TIMEOUT_SEC = 900;
// After pressing pay, how long the store has to send its card request.
const NO_REQUEST_MS = 3 * 60_000;
const MAX_KEPT = 20;
const OPEN: BrowserCheckout['status'][] = ['browsing', 'awaiting_approval'];

/**
 * Whether the owner can still approve: Kernel keeps reporting an authorization
 * as awaiting approval after it has expired, and AgentCard's page can't pay it.
 */
const approvable = (auth: AgentCardAuthorization) =>
  auth.status === 'awaiting_approval' &&
  (!auth.expires_at || Date.parse(auth.expires_at) > Date.now());
const KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'PageDown',
  'PageUp',
  'Space'
]);
// Currencies without minor units in AgentCard's (ISO 4217) sense.
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp', 'isk', 'ugx', 'xaf', 'xof', 'pyg']);

const vaultName = (wallet: string) => `oma-${wallet.toLowerCase()}`;

// The page as the agent sees it: where it is, its text, and what it can act
// on, each with a ref (e12) for the next action. Main frame only: card fields
// live in the processor's frames, which only the pay script touches.
export const SNAPSHOT = `
const P = context.pages().at(-1) ?? page;
await P.bringToFront().catch(() => {});
await P.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
await P.waitForTimeout(ARGS.settleMs ?? 1200);
const seen = await P.evaluate((maxText) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  document.querySelectorAll('[data-oma-ref]').forEach((e) => e.removeAttribute('data-oma-ref'));
  const items = [];
  let n = 0;
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=radio],[role=checkbox],[role=option],[role=combobox],[role=tab],[role=menuitem]';
  for (const el of document.querySelectorAll(sel)) {
    if (n >= 200) break;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden' || !visible(el) || el.closest('[aria-hidden="true"]')) continue;
    const ref = 'e' + ++n;
    el.setAttribute('data-oma-ref', ref);
    const tag = el.tagName.toLowerCase();
    const label = clean(
      el.getAttribute('aria-label') ||
        (el.labels && el.labels[0] && el.labels[0].innerText) ||
        el.getAttribute('placeholder') ||
        el.innerText ||
        (type === 'submit' || type === 'button' ? el.value : '') ||
        el.getAttribute('title') ||
        el.getAttribute('name')
    ).slice(0, 80);
    let line = ref + ' ' + (el.getAttribute('role') || tag) + (type ? '[' + type + ']' : '') + ' "' + label + '"';
    if ((tag === 'input' && type !== 'checkbox' && type !== 'radio' && type !== 'password') || tag === 'textarea')
      line += ' value="' + clean(el.value).slice(0, 60) + '"';
    if (type === 'checkbox' || type === 'radio' || el.getAttribute('aria-checked') === 'true')
      line += el.checked || el.getAttribute('aria-checked') === 'true' ? ' (checked)' : ' (unchecked)';
    if (tag === 'select')
      line += ' selected="' + clean(el.selectedOptions[0] && el.selectedOptions[0].text) + '" options=' +
        JSON.stringify([...el.options].slice(0, 40).map((o) => clean(o.text)));
    if (el.disabled) line += ' (disabled)';
    if (tag === 'a') line += ' -> ' + (el.getAttribute('href') || '').slice(0, 100);
    items.push(line);
  }
  return { text: clean(document.body ? document.body.innerText : '').slice(0, maxText), elements: items };
}, ARGS.maxText ?? 5000);
return { url: P.url(), title: await P.title(), text: seen.text, elements: seen.elements };
`;

export const ACT = `
const P = context.pages().at(-1) ?? page;
const el = () => P.locator('[data-oma-ref="' + ARGS.ref + '"]').first();
const pagesBefore = context.pages().length;
if (ARGS.action === 'open') {
  await P.goto(ARGS.url, { waitUntil: 'commit', timeout: 30000 });
  await P.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
}
// Styled radios and checkboxes often sit under their label: click through if covered.
if (ARGS.action === 'click') {
  await el().click({ timeout: 8000 }).catch(() => el().click({ force: true, timeout: 5000 }));
}
if (ARGS.action === 'type') {
  await el().fill(ARGS.text, { timeout: 10000 });
  if (ARGS.submit) await el().press('Enter');
}
if (ARGS.action === 'select') {
  await el().selectOption({ label: ARGS.option }, { timeout: 10000 })
    .catch(() => el().selectOption(ARGS.option, { timeout: 10000 }));
}
if (ARGS.action === 'press') await P.keyboard.press(ARGS.key);
if (ARGS.action === 'scroll') await P.mouse.wheel(0, ARGS.down ? 700 : -700);
return { opened: context.pages().length > pagesBefore };
`;

// The checkout page's text and whether it shows card fields.
export const PROBE = `
const P = context.pages().at(-1) ?? page;
const CARD = ['input[autocomplete="cc-number"]', 'input#number', 'input[name="cardnumber"]', 'input[name="number"]', 'input[name="cardNumber"]'];
let cardFields = false;
for (const f of P.frames()) {
  if (f === P.mainFrame()) continue;
  for (const s of CARD) if (await f.locator(s).count().catch(() => 0)) cardFields = true;
}
if (await P.locator('input[autocomplete="cc-number"]').count()) cardFields = true;
return { url: P.url(), text: await P.evaluate(() => document.body ? document.body.innerText : ''), cardFields };
`;

// Types the placeholder card (Kernel's aliases) into the processor's fields
// and presses pay. Card frames first; the main frame only by autocomplete.
export const PAY = `
const P = context.pages().at(-1) ?? page;
const SETS = {
  number: ['input[autocomplete="cc-number"]', 'input#number', 'input[name="cardnumber"]', 'input[name="number"]', 'input[name="cardNumber"]'],
  expiry: ['input[autocomplete="cc-exp"]', 'input#expiry', 'input[name="exp-date"]', 'input[name="expiry"]', 'input[name="cardExpiry"]'],
  cvc: ['input[autocomplete="cc-csc"]', 'input#verification_value', 'input[name="cvc"]', 'input[name="securityCode"]', 'input[name="cardCvc"]'],
  name: ['input[autocomplete="cc-name"]', 'input#name', 'input[name="ccname"]', 'input[name="cardholderName"]']
};
// The field a person types in. Card frames also hold hidden copies for
// autofill (Shopify's number frame has an aria-hidden expiry), so skip those.
const find = async (kind) => {
  for (const f of P.frames()) {
    const main = f === P.mainFrame();
    for (const s of SETS[kind]) {
      if (main && !s.includes('autocomplete')) continue;
      const all = f.locator(s + ':not([aria-hidden="true"]):not([tabindex="-1"]):not([type="hidden"])');
      const count = await all.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const loc = all.nth(i);
        if (!(await loc.isVisible().catch(() => false))) continue;
        const box = await loc.boundingBox().catch(() => null);
        if (box && box.width > 4 && box.height > 4) return loc;
      }
    }
  }
  return null;
};
const type = async (loc, value) => {
  await loc.click({ timeout: 5000 }).catch(() => loc.focus());
  await loc.press('ControlOrMeta+a').catch(() => {});
  await loc.press('Backspace').catch(() => {});
  await loc.pressSequentially(value, { delay: 60 });
};
const number = await find('number');
const expiry = await find('expiry');
const cvc = await find('cvc');
if (!number || !expiry || !cvc) return { error: 'no_card_fields', number: !!number, expiry: !!expiry, cvc: !!cvc };
await type(number, ARGS.number);
await type(expiry, ARGS.expiry);
await type(cvc, ARGS.cvc);
const name = await find('name');
if (name && !(await name.inputValue().catch(() => '')) && ARGS.name) await type(name, ARGS.name);
await P.waitForTimeout(800);
let button = null;
if (ARGS.payRef) button = P.locator('[data-oma-ref="' + ARGS.payRef + '"]').first();
else {
  for (const s of ['#checkout-pay-button', 'button[type="submit"]', 'button', 'input[type="submit"]']) {
    const all = P.locator(s).filter({ hasText: /pay|place order|complete (order|purchase)|buy now|submit order|confirm order/i });
    const loc = s === '#checkout-pay-button' ? P.locator(s) : all;
    const count = await loc.count();
    for (let i = 0; i < count; i++) {
      if (await loc.nth(i).isVisible().catch(() => false)) { button = loc.nth(i); break; }
    }
    if (button) break;
  }
}
if (!button) return { error: 'no_pay_button' };
await button.click({ timeout: 10000 });
return { pressed: true };
`;

/** The forms an amount can take on a page: 1234.5 → 1,234.50, 1.234,50, 1 234,50, 1234.50… */
export function amountForms(cents: number, currency: string): string[] {
  const zero = ZERO_DECIMAL.has(currency.toLowerCase());
  const units = zero ? cents : Math.floor(cents / 100);
  const frac = zero ? '' : String(cents % 100).padStart(2, '0');
  const digits = String(units);
  const group = (sep: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const forms = new Set<string>();
  for (const sep of ['', ',', '.', ' ', "'"]) {
    for (const dec of zero ? [''] : ['.', ',']) {
      if (sep && sep === dec) continue;
      forms.add(zero ? group(sep) : `${group(sep)}${dec}${frac}`);
    }
  }
  return [...forms];
}

/** Whether the page text shows this amount, as a whole number (not inside a longer one). */
export function pageShowsAmount(text: string, cents: number, currency: string): boolean {
  const t = text.replace(/[  ]/g, ' ');
  return amountForms(cents, currency).some((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\d.,])${escaped}(?![\\d]|[.,]\\d)`).test(t);
  });
}

type Page = { url: string; title: string; text: string; elements: string[] };

export class BrowserCheckouts {
  constructor(
    private readonly db: CredentialStore,
    private readonly kernel: Kernel,
    private readonly wallet: string
  ) {}

  private async list(): Promise<BrowserCheckout[]> {
    return (await this.db.get(this.wallet)).browserCheckouts ?? [];
  }

  async find(id: string): Promise<BrowserCheckout> {
    const c = (await this.list()).find((x) => x.id === id);
    if (!c) throw new ValidationError('No such browser checkout for this wallet.');
    return c;
  }

  private async set(id: string, change: Partial<BrowserCheckout>): Promise<BrowserCheckout> {
    let out: BrowserCheckout | null = null;
    await this.db.update(this.wallet, (r) => ({
      ...r,
      browserCheckouts: (r.browserCheckouts ?? []).map((x) => {
        if (x.id !== id) return x;
        out = { ...x, ...change, updatedAt: new Date().toISOString() };
        return out;
      })
    }));
    if (!out) throw new ValidationError('No such browser checkout for this wallet.');
    return out;
  }

  /** The vault holding the owner's AgentCard wallet, imported from their linked card. */
  private async vault(): Promise<{ name: string; walletKey: string }> {
    const r = await this.db.get(this.wallet);
    const userId = r.agentcardConnection?.userId ?? r.agentcardUsers?.at(-1);
    if (!userId) {
      throw new ValidationError(
        'No card saved yet. Call add_card and send the owner the link, then try again.'
      );
    }
    const name = vaultName(this.wallet);
    await this.kernel.vault(name);
    const key = walletKey(userId);
    let item = await this.kernel.getItem(name, key);
    if (!item) {
      await this.kernel.ensureProviderConfig();
      try {
        item = await this.kernel.putItem(name, key, {
          type: 'wallet',
          spec: {
            provider: 'agentcard',
            provider_config: { name: this.kernel.providerConfig },
            user_id: userId
          }
        });
      } catch (err) {
        // AgentCard doesn't know the user under this client: not worth retrying.
        if (err instanceof KernelError && err.status === 400) {
          console.error('[kernel wallet]', err.message);
          throw new ValidationError(
            "The saved card can't be used for browser checkouts. Ask the owner to add the card again with add_card, then try again."
          );
        }
        throw err;
      }
    }
    if (item.state.status !== 'connected') {
      throw new ValidationError(
        `The saved card isn't ready for browser checkouts yet (${item.state.status}).`
      );
    }
    return { name, walletKey: key };
  }

  private async run<T>(c: BrowserCheckout, code: string, args: unknown, timeoutSec = 60) {
    let res;
    try {
      res = await this.kernel.playwright(c.browserId, code, args, timeoutSec);
    } catch (err) {
      if (err instanceof KernelError && (err.status === 404 || err.status === 410)) {
        await this.set(c.id, { status: 'failed', reason: 'browser_closed' });
        throw new ValidationError(
          'The browser for this checkout has closed (it times out after 15 idle minutes). Start a new checkout.'
        );
      }
      throw err;
    }
    if (!res.success) {
      throw new ValidationError(`The browser couldn't do that: ${(res.error ?? '').slice(0, 300)}`);
    }
    return res.result as T;
  }

  private snapshot(c: BrowserCheckout, settleMs?: number): Promise<Page> {
    return this.run<Page>(c, SNAPSHOT, settleMs !== undefined ? { settleMs } : {});
  }

  /** Opens the product page in a new browser. One checkout open at a time. */
  async start(input: { productUrl: unknown; description: unknown }) {
    const productUrl = parseUrl(input.productUrl);
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description || description.length > 300) {
      throw new ValidationError('description is required: what the owner wants, in a sentence.');
    }
    for (const open of (await this.list()).filter((x) => OPEN.includes(x.status))) {
      if (open.status === 'awaiting_approval') {
        throw new ValidationError(
          `Checkout ${open.id} is waiting for the owner's approval. Call browser_checkout_status, or cancel_browser_checkout first.`
        );
      }
      await this.cancel(open.id);
    }
    const { name: vault } = await this.vault();
    const browser = await this.kernel.createBrowser({
      vault,
      timeoutSeconds: BROWSER_TIMEOUT_SEC
    });
    const now = new Date().toISOString();
    const c: BrowserCheckout = {
      id: randomId('bco'),
      browserId: browser.session_id,
      productUrl,
      description,
      status: 'browsing',
      createdAt: now,
      updatedAt: now
    };
    await this.db.update(this.wallet, (r) => ({
      ...r,
      browserCheckouts: [...(r.browserCheckouts ?? []), c].slice(-MAX_KEPT)
    }));
    await this.run(c, ACT, { action: 'open', url: productUrl });
    return { c, page: await this.snapshot(c) };
  }

  async look(id: string) {
    const c = await this.browsing(id);
    return this.snapshot(c, 300);
  }

  /** One browsing action, then the page as it stands. */
  async act(id: string, args: Record<string, unknown>) {
    const c = await this.browsing(id);
    const action = args.action;
    const ref = typeof args.ref === 'string' ? args.ref : '';
    const needsRef = action === 'click' || action === 'type' || action === 'select';
    if (needsRef && !/^e\d{1,4}$/.test(ref)) {
      throw new ValidationError('ref is required: an element ref from the last page, like e12.');
    }
    const data: Record<string, unknown> = { action, ref };
    if (action === 'open') data.url = parseUrl(args.url);
    else if (action === 'type') {
      if (typeof args.text !== 'string' || args.text.length > 500) {
        throw new ValidationError('text is required (at most 500 characters).');
      }
      data.text = args.text;
      data.submit = args.submit === true;
    } else if (action === 'select') {
      if (typeof args.option !== 'string' || !args.option) {
        throw new ValidationError('option is required: the visible text of the option.');
      }
      data.option = args.option;
    } else if (action === 'press') {
      if (typeof args.key !== 'string' || !KEYS.has(args.key)) {
        throw new ValidationError(`key must be one of ${[...KEYS].join(', ')}.`);
      }
      data.key = args.key;
    } else if (action === 'scroll') data.down = args.direction !== 'up';
    else if (action !== 'click') throw new ValidationError('Unknown browser action.');
    await this.run(c, ACT, data);
    await this.set(c.id, {});
    return this.snapshot(c);
  }

  private async browsing(id: string) {
    const c = await this.find(id);
    if (c.status !== 'browsing') {
      throw new ValidationError(
        `This checkout is ${c.status.replace('_', ' ')}; the browser only takes actions before paying.`
      );
    }
    return c;
  }

  /**
   * At the payment step: checks the total on the page, types the placeholder
   * card, presses pay, and records an approval for the owner. Pays at most once.
   */
  async pay(
    id: string,
    input: { totalCents: unknown; currency: unknown; payRef: unknown; holderName: string },
    lock: PaymentLock | null
  ) {
    const c = await this.browsing(id);
    const totalCents = input.totalCents;
    if (
      !Number.isInteger(totalCents) ||
      (totalCents as number) < 1 ||
      (totalCents as number) > 2_000_000
    ) {
      throw new ValidationError(
        "total_cents is required: the checkout total in the currency's smallest unit (3045 for 30.45)."
      );
    }
    const currency = typeof input.currency === 'string' ? input.currency.trim().toLowerCase() : '';
    if (!/^[a-z]{3}$/.test(currency)) {
      throw new ValidationError(
        'currency is required: the three-letter code the checkout shows, like EUR.'
      );
    }
    const payRef =
      typeof input.payRef === 'string' && /^e\d{1,4}$/.test(input.payRef) ? input.payRef : null;
    const probe = await this.run<{ url: string; text: string; cardFields: boolean }>(c, PROBE, {});
    if (!probe.cardFields) {
      throw new ValidationError(
        "This page shows no card fields. Fill in contact and shipping and continue to the payment step (choose card if there's a choice), then call pay_browser_checkout again."
      );
    }
    if (!pageShowsAmount(probe.text, totalCents as number, currency)) {
      throw new ValidationError(
        "That total isn't on the checkout page. Read the total from browser_look (including shipping and tax) and send it exactly."
      );
    }
    const origin = new URL(probe.url).origin;
    const merchant = new URL(probe.url).hostname.replace(/^www\./, '');
    if (lock && !(await lock.claim(`browser:${id}`))) {
      return this.status(id, '', 0);
    }
    const { name: vault, walletKey: wallet } = await this.vault();
    const spec = {
      provider: 'agentcard',
      wallet,
      merchant: merchant.slice(0, 120),
      amount: totalCents,
      currency,
      checkout_origin: origin
    };
    const key = cardKey(id);
    let card = await this.kernel.getItem(vault, key);
    if (card && !['ready', 'requested'].includes(card.state.status)) {
      throw new ValidationError(
        `This checkout's payment can't be used again (${card.state.status}). Cancel it and start a new checkout.`
      );
    }
    card = card
      ? await this.kernel.updateItem(vault, key, { type: 'card', spec })
      : await this.kernel.putItem(vault, key, { type: 'card', spec });
    if (card.state.status === 'requested')
      card = (await this.kernel.getItem(vault, key, 20)) ?? card;
    const aliases = card.state.aliases;
    if (card.state.status !== 'ready' || !aliases) {
      throw new ValidationError(
        `The card isn't ready to pay (${card.state.status}). Try again shortly.`
      );
    }
    const approval = await createApproval(this.db, this.wallet, {
      kind: 'browser',
      merchant,
      merchantUrl: probe.url,
      totalCents: totalCents as number,
      currency,
      items: [{ name: c.description, qty: 1 }],
      conversationId: null,
      hash: null,
      checkoutId: c.id
    });
    await this.set(id, {
      status: 'awaiting_approval',
      merchant,
      totalCents: totalCents as number,
      currency,
      approvalId: approval.id,
      paidAt: new Date().toISOString()
    });
    const pressed = await this.run<{ pressed?: boolean; error?: string }>(
      c,
      PAY,
      {
        number: aliases.number,
        expiry: `${aliases.exp_month.padStart(2, '0')}${aliases.exp_year.slice(-2)}`,
        cvc: aliases.cvc,
        name: input.holderName,
        payRef
      },
      90
    );
    if (!pressed.pressed) {
      await this.set(id, { status: 'failed', reason: pressed.error ?? 'not_pressed' });
      await setApproval(this.db, this.wallet, approval.id, { status: 'failed' });
      throw new ValidationError(
        pressed.error === 'no_pay_button'
          ? "Couldn't find the pay button. Call browser_look and pass the button's ref as pay_ref with a new checkout."
          : "Couldn't type the card into this checkout's payment form."
      );
    }
    return null;
  }

  /**
   * Where a checkout is. Waits up to `waitMs` for the store's card request,
   * the owner's decision, and the payment.
   */
  async status(id: string, origin: string, waitMs = 25_000) {
    const until = Date.now() + waitMs;
    for (;;) {
      let c = await this.find(id);
      if (c.status === 'awaiting_approval') c = await this.refresh(c);
      if (c.status !== 'awaiting_approval' || Date.now() >= until) return this.view(c, origin);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  private async refresh(c: BrowserCheckout): Promise<BrowserCheckout> {
    const approval = c.approvalId
      ? ((await this.db.get(this.wallet)).approvals ?? []).find((a) => a.id === c.approvalId)
      : undefined;
    if (approval?.status === 'declined') {
      await this.close(c);
      return this.set(c.id, { status: 'declined', reason: 'owner_declined' });
    }
    const card = await this.kernel.getItem(vaultName(this.wallet), cardKey(c.id), 10);
    const auth = card?.state.authorization;
    const ours =
      auth &&
      (!auth.browser_id || auth.browser_id === c.browserId) &&
      (!c.paidAt || auth.created_at === undefined || auth.created_at >= c.paidAt.slice(0, 19));
    if (!auth || !ours) {
      if (Date.now() - Date.parse(c.paidAt ?? c.updatedAt) > NO_REQUEST_MS) {
        if (c.approvalId)
          await setApproval(this.db, this.wallet, c.approvalId, { status: 'failed' });
        return this.set(c.id, { status: 'failed', reason: 'store_sent_no_card_request' });
      }
      return c;
    }
    if (approvable(auth)) return c;
    if (auth.status === 'approved') {
      if (c.approvalId) {
        await setApproval(this.db, this.wallet, c.approvalId, {
          status: 'placed',
          result: {
            chargedKind: auth.charged_kind ?? null,
            delivered: auth.replay_delivered ?? null
          }
        });
      }
      return this.set(c.id, { status: 'paid' });
    }
    if (c.approvalId) {
      await setApproval(this.db, this.wallet, c.approvalId, {
        status: auth.status === 'declined' ? 'declined' : 'failed'
      });
    }
    await this.close(c);
    return this.set(c.id, {
      status: auth.status === 'declined' ? 'declined' : 'expired',
      reason: auth.reason ?? auth.status
    });
  }

  private async view(c: BrowserCheckout, origin: string) {
    const base = {
      checkout_id: c.id,
      status: c.status,
      merchant: c.merchant ?? null,
      total: c.totalCents !== undefined && c.currency ? money(c.totalCents, c.currency) : null
    };
    switch (c.status) {
      case 'awaiting_approval':
        return {
          ...base,
          status: 'pending_approval',
          approval_url: `${origin}/approve?r=${c.approvalId}`,
          next: 'Send the owner approval_url on its own line, then call browser_checkout_status again right away: it waits for their decision. Keep calling it while it says pending_approval.'
        };
      case 'paid': {
        const page = await this.snapshot(c, 2500).catch(() => null);
        return {
          ...base,
          page,
          next: "The owner approved and the card was charged. Read the page: tell the owner the store's order number or confirmation if it shows one, or call browser_look in a few seconds if it's still processing. Never pay again."
        };
      }
      case 'declined':
        return {
          ...base,
          next: 'The owner declined, or the card was refused. Nothing was charged. Tell the owner.'
        };
      case 'expired':
        return {
          ...base,
          next: 'The approval expired before the owner decided. Nothing was charged.'
        };
      case 'failed':
        return {
          ...base,
          reason: c.reason ?? null,
          next: 'The payment did not go through. Tell the owner; never retry on your own.'
        };
      default:
        return base;
    }
  }

  async cancel(id: string) {
    const c = await this.find(id);
    if (c.status === 'paid') return this.view(c, '');
    await this.close(c);
    if (c.approvalId && c.status === 'awaiting_approval') {
      await setApproval(this.db, this.wallet, c.approvalId, { status: 'canceled' });
    }
    return this.view(OPEN.includes(c.status) ? await this.set(id, { status: 'canceled' }) : c, '');
  }

  /** The owner declined on the approval page: the held card request goes with the browser. */
  async decline(id: string) {
    const c = await this.find(id);
    if (!OPEN.includes(c.status)) return;
    await this.close(c);
    await this.set(id, { status: 'declined', reason: 'owner_declined' });
  }

  private async close(c: BrowserCheckout) {
    await this.kernel.deleteBrowser(c.browserId).catch((err) => {
      console.error('[browser-checkout] close', err);
    });
    // Its card item too, unless Kernel holds a payment on it or needs it kept.
    const vault = vaultName(this.wallet);
    const card = await this.kernel.getItem(vault, cardKey(c.id)).catch(() => null);
    if (card && (card.state.status === 'ready' || card.state.status === 'requested')) {
      await this.kernel.deleteItem(vault, cardKey(c.id)).catch((err) => {
        console.error('[browser-checkout] card', err);
      });
    }
  }

  /** AgentCard's approval link for the owner, once the store's card request is held. */
  async approvalLink(checkoutId: string, waitSec = 15): Promise<string | null> {
    const c = await this.find(checkoutId);
    if (c.status !== 'awaiting_approval') return null;
    const card = await this.kernel.getItem(vaultName(this.wallet), cardKey(c.id), waitSec);
    const auth = card?.state.authorization;
    return auth && approvable(auth) && (!auth.browser_id || auth.browser_id === c.browserId)
      ? (auth.approval_url ?? null)
      : null;
  }
}

/** A wallet's browser checkouts, or null where Kernel isn't configured. */
export function browserCheckouts(
  env: Env,
  db: CredentialStore,
  wallet: string
): BrowserCheckouts | null {
  const { KERNEL_API_KEY, KERNEL_AGENTCARD_CONFIG, AGENTCARD_CLIENT_ID, AGENTCARD_CLIENT_SECRET } =
    env;
  if (
    !KERNEL_API_KEY ||
    !KERNEL_AGENTCARD_CONFIG ||
    !AGENTCARD_CLIENT_ID ||
    !AGENTCARD_CLIENT_SECRET
  )
    return null;
  return new BrowserCheckouts(
    db,
    new Kernel(KERNEL_API_KEY, KERNEL_AGENTCARD_CONFIG, {
      clientId: AGENTCARD_CLIENT_ID,
      clientSecret: AGENTCARD_CLIENT_SECRET
    }),
    wallet
  );
}

function parseUrl(v: unknown): string {
  let u: URL;
  try {
    u = new URL(typeof v === 'string' ? v.trim() : '');
  } catch {
    throw new ValidationError('A full https:// link to the product page is required.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new ValidationError('Only http(s) links can be opened.');
  }
  return u.toString();
}

export function money(cents: number, currency: string): string {
  const zero = ZERO_DECIMAL.has(currency.toLowerCase());
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase()
    }).format(zero ? cents : cents / 100);
  } catch {
    return `${zero ? cents : (cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

// A finished checkout's status (as the agent sees it), as its approval's.
const SETTLED: Record<string, Approval['status']> = {
  paid: 'placed',
  declined: 'declined',
  expired: 'failed',
  failed: 'failed',
  canceled: 'canceled'
};

/** The owner's decision on the approval page, for a browser checkout. */
export async function decideBrowserApproval(
  checkouts: BrowserCheckouts,
  a: Approval,
  approve: boolean
): Promise<{ status: Approval['status']; passkeyUrl?: string | null }> {
  if (!a.checkoutId) return { status: a.status };
  if (!approve) {
    await checkouts.decline(a.checkoutId);
    return { status: 'declined' };
  }
  // Settles one that expired, or was decided, since the agent last asked.
  const settled = (await checkouts.status(a.checkoutId, '', 0)).status;
  if (settled in SETTLED) return { status: SETTLED[settled] };
  const url = await checkouts.approvalLink(a.checkoutId);
  if (!url) {
    throw new ValidationError(
      "The store hasn't asked for the payment yet. Wait a few seconds and press Approve again."
    );
  }
  return { status: 'awaiting_passkey', passkeyUrl: url };
}
