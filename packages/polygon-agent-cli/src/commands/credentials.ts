// `credentials`: details the owner saved for agents to use when buying for
// them: a shipping address, and cards in the AgentCard vault. Stored by agentconnect, read and
// written as this wallet's linked agent key.

import type { CommandModule } from 'yargs';

import fs from 'node:fs';
import path from 'node:path';

import { credentialsApi, loadCertificate } from '../lib/credentials/agent.ts';
import { CliError, jsonFail, jsonOut } from '../lib/errors.ts';
import { ensureStorageDir, loadOmsWalletPointer, STORAGE_ROOT } from '../lib/storage.ts';

interface ShippingAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
}

type WalletArgs = { wallet: string };

const walletOpt = { type: 'string', default: 'main', describe: 'agent wallet name' } as const;

const statusCommand: CommandModule<object, WalletArgs> = {
  command: 'status',
  describe: 'Whether this install is linked for saved credentials',
  builder: (y) => y.option('wallet', walletOpt),
  handler: async (argv) => {
    try {
      const cert = loadCertificate(argv.wallet);
      const pointer = await loadOmsWalletPointer(argv.wallet);
      jsonOut({
        ok: true,
        walletName: argv.wallet,
        linked: !!cert,
        ...(cert
          ? { walletAddress: cert.wallet, expiresAt: new Date(cert.expiresAt * 1000).toISOString() }
          : {
              next: `polygon-agent wallet link-credentials${argv.wallet === 'main' ? '' : ` --name ${argv.wallet}`}`,
              hint:
                pointer?.access === 'session'
                  ? 'The owner approves the link with one sign-in.'
                  : 'Links right away while the owner is signed in.'
            })
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

type AddressArgs = WalletArgs & Partial<ShippingAddress> & { clear?: boolean };

const ADDRESS_FLAGS: (keyof ShippingAddress)[] = [
  'name',
  'line1',
  'line2',
  'city',
  'state',
  'zip',
  'country',
  'phone'
];

const addressCommand: CommandModule<object, AddressArgs> = {
  command: 'address',
  describe: 'Show the saved shipping address; with --line1 etc. save one, with --clear remove it',
  builder: (y) =>
    y
      .option('wallet', walletOpt)
      .option('name', { type: 'string', describe: 'Recipient full name' })
      .option('line1', { type: 'string', describe: 'Street address' })
      .option('line2', { type: 'string', describe: 'Apartment, suite (optional)' })
      .option('city', { type: 'string' })
      .option('state', { type: 'string', describe: 'State or region' })
      .option('zip', { type: 'string', describe: 'ZIP or postal code' })
      .option('country', { type: 'string', describe: 'Country (e.g. US)' })
      .option('phone', { type: 'string', describe: 'Phone for delivery (optional)' })
      .option('clear', { type: 'boolean', describe: 'Remove the saved address' })
      .example(
        '$0 credentials address --name "Alex Rivera" --line1 "214 Bergen St" --city Brooklyn --state NY --zip 11217 --country US',
        'Save a shipping address'
      ),
  handler: async (argv) => {
    try {
      const given = ADDRESS_FLAGS.filter((f) => argv[f] !== undefined);
      if (argv.clear && given.length > 0) {
        throw new CliError({ code: 'invalid_input', message: 'Use --clear on its own.' });
      }
      if (argv.clear) {
        await credentialsApi(argv.wallet, 'DELETE', '/api/credentials/address');
        jsonOut({ ok: true, walletName: argv.wallet, address: null });
        return;
      }
      if (given.length === 0) {
        const res = await credentialsApi<{ address: ShippingAddress | null }>(
          argv.wallet,
          'GET',
          '/api/credentials/address'
        );
        jsonOut({
          ok: true,
          walletName: argv.wallet,
          address: res.address,
          ...(res.address
            ? {}
            : { hint: 'No address saved. Ask the user for one, or send them the dashboard link.' })
        });
        return;
      }
      // Partial flags update the saved address; the server checks required fields.
      const current = await credentialsApi<{ address: ShippingAddress | null }>(
        argv.wallet,
        'GET',
        '/api/credentials/address'
      );
      const next = Object.fromEntries(
        ADDRESS_FLAGS.map((f) => [f, argv[f] ?? current.address?.[f] ?? ''])
      );
      const res = await credentialsApi<{ address: ShippingAddress }>(
        argv.wallet,
        'PUT',
        '/api/credentials/address',
        next
      );
      jsonOut({ ok: true, walletName: argv.wallet, address: res.address });
    } catch (error) {
      jsonFail(error);
    }
  }
};

// --- cards (AgentCard vault) ---

interface Card {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

const describeCard = (c: Card) =>
  `${c.brand.charAt(0).toUpperCase()}${c.brand.slice(1)} ending ${c.last4}, expires ${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}`;

async function listCards(wallet: string): Promise<Card[]> {
  const res = await credentialsApi<{ cards: Card[] }>(wallet, 'GET', '/api/credentials/cards');
  return res.cards;
}

const cardsListCommand: CommandModule<object, WalletArgs> = {
  command: '$0',
  describe: 'List saved cards (brand, last 4, expiry; never the number)',
  builder: (y) => y.option('wallet', walletOpt),
  handler: async (argv) => {
    try {
      const cards = await listCards(argv.wallet);
      jsonOut({
        ok: true,
        walletName: argv.wallet,
        cards: cards.map((c) => ({ ...c, label: describeCard(c) })),
        ...(cards.length === 0
          ? { hint: 'No card saved. Run `credentials cards add` and send the user its link.' }
          : {})
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

const cardsAddCommand: CommandModule<object, WalletArgs> = {
  command: 'add',
  describe: 'A one-time link where the user saves a card behind their passkey',
  builder: (y) => y.option('wallet', walletOpt),
  handler: async (argv) => {
    try {
      const res = await credentialsApi<{
        sessionId: string;
        url: string;
        expiresAt: string;
        returning: boolean;
      }>(argv.wallet, 'POST', '/api/credentials/cards/session');
      jsonOut({
        ok: true,
        walletName: argv.wallet,
        url: res.url,
        session: res.sessionId,
        expiresAt: res.expiresAt,
        next: `polygon-agent credentials cards wait --session ${res.sessionId}${argv.wallet === 'main' ? '' : ` --wallet ${argv.wallet}`}`,
        hint:
          'Send `url` to the user exactly as given, alone on its own line (anything appended breaks it). ' +
          (res.returning
            ? 'They get a code by email or text first, since they have saved a card before. '
            : '') +
          'Then run `next` to wait until the card is saved.'
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};

type WaitArgs = WalletArgs & { session: string; timeout: number };

const cardsWaitCommand: CommandModule<object, WaitArgs> = {
  command: 'wait',
  describe: 'Wait until the user finishes saving a card from `cards add`',
  builder: (y) =>
    y
      .option('wallet', walletOpt)
      .option('session', {
        type: 'string',
        demandOption: true,
        describe: 'Session id from `cards add`'
      })
      .option('timeout', { type: 'number', default: 600, describe: 'Seconds to wait' }),
  handler: async (argv) => {
    try {
      const deadline = Date.now() + argv.timeout * 1000;
      for (;;) {
        const res = await credentialsApi<{
          status: string;
          cardSaved: boolean;
          pollInterval: number;
        }>(
          argv.wallet,
          'GET',
          `/api/credentials/cards/session?id=${encodeURIComponent(argv.session)}`
        );
        // `linked` means the passkey user exists; the card is stored after that.
        if (res.cardSaved) {
          const cards = await listCards(argv.wallet);
          jsonOut({
            ok: true,
            walletName: argv.wallet,
            status: 'saved',
            cards: cards.map((c) => ({ ...c, label: describeCard(c) }))
          });
          return;
        }
        if (res.status === 'expired') {
          throw new CliError({
            code: 'request_expired',
            message: 'The add-a-card link expired before a card was saved.',
            command: `polygon-agent credentials cards add${argv.wallet === 'main' ? '' : ` --wallet ${argv.wallet}`}`
          });
        }
        if (Date.now() >= deadline) {
          jsonOut({
            ok: true,
            walletName: argv.wallet,
            status: 'waiting',
            next: `polygon-agent credentials cards wait --session ${argv.session}${argv.wallet === 'main' ? '' : ` --wallet ${argv.wallet}`}`,
            hint: 'The user has not finished yet. Run `next` again when they say they are done.'
          });
          return;
        }
        await new Promise((r) => setTimeout(r, Math.max(3, res.pollInterval) * 1000));
      }
    } catch (error) {
      jsonFail(error);
    }
  }
};

interface BuyTurn {
  nextAction?: { type: string; message: string; url: string | null; sessionId: string };
  conversationId?: string;
  status: string;
  reply?: string | null;
  cart?: { merchant_name?: string; totalCents: number } | null;
  declineCode?: string | null;
  orderId?: string | null;
  autoPay?: boolean;
  approvalId?: string;
  approvalUrl?: string;
}

interface ApprovalStatus {
  approvalId: string;
  kind?: 'cart' | 'checkout';
  status: string;
  merchant: string;
  totalCents: number;
  approvalUrl?: string;
  result?: Record<string, unknown>;
}

const walletFlag = (w: string) => (w === 'main' ? '' : ` --wallet ${w}`);

// What the agent should do after a purchase step.
function buyNext(t: BuyTurn, wallet: string): Record<string, string> {
  if (t.status === 'requires_action' && t.nextAction?.type === 'add_card') {
    return {
      next: 'No card is saved yet. Send the owner nextAction.url alone on its own line, then wait for them.',
      then: `polygon-agent credentials cards wait --session ${t.nextAction.sessionId}${walletFlag(wallet)}`
    };
  }
  if (t.status === 'pending_approval' && t.approvalId) {
    return {
      next: "Over the owner's auto-pay limit. Send them approvalUrl alone on its own line, then wait for their answer.",
      then: `polygon-agent buy --approval ${t.approvalId} --wait${walletFlag(wallet)}`
    };
  }
  if (t.declineCode) {
    return {
      next: `Not placed (${t.declineCode}), and nothing was charged. Tell the owner what reply says.`
    };
  }
  if (t.status === 'order_placed' || t.status === 'partially_placed') {
    return {
      next: 'Tell the owner the order is placed, with the total and the card it was charged to.'
    };
  }
  if (t.status === 'needs_input' && t.conversationId) {
    return {
      next: 'Relay reply to the owner, then send their answer:',
      answer: `polygon-agent buy --conversation ${t.conversationId} "<answer>"${walletFlag(wallet)}`
    };
  }
  return {};
}

const SETTLED = new Set(['approved', 'declined', 'placed', 'failed']);

async function waitForApproval(
  wallet: string,
  id: string,
  timeoutSec: number
): Promise<ApprovalStatus> {
  const until = Date.now() + timeoutSec * 1000;
  for (;;) {
    const left = Math.max(0, Math.min(25, Math.floor((until - Date.now()) / 1000)));
    const s = await credentialsApi<ApprovalStatus>(
      wallet,
      'GET',
      `/api/credentials/approvals/${encodeURIComponent(id)}?wait=${left}`
    );
    if (SETTLED.has(s.status) || Date.now() >= until) return s;
  }
}

function approvalNext(s: ApprovalStatus, wallet: string): Record<string, string> {
  switch (s.status) {
    case 'placed':
      return { next: 'The owner approved and the order is placed. Tell them.' };
    case 'approved':
      return s.kind === 'checkout'
        ? {
            next: 'Approved. Get the one-time card, then pay:',
            then: `polygon-agent checkout --card ${s.approvalId}${walletFlag(wallet)}`
          }
        : { next: 'Approved. The order is being placed; check again shortly.' };
    case 'canceled':
      return { next: 'This checkout was canceled. Nothing was charged.' };
    case 'declined':
      return { next: 'The owner declined. Nothing was charged; do not retry.' };
    case 'failed':
      return { next: "It didn't go through and nothing was charged. Tell the owner." };
    case 'awaiting_passkey':
      return { next: 'Approved; the owner is confirming with their passkey. Check again shortly.' };
    default:
      return { next: 'Still waiting for the owner. Check again, or remind them of approvalUrl.' };
  }
}

type BuyArgs = WalletArgs & {
  ask?: string;
  conversation?: string;
  approval?: string;
  wait?: boolean;
  timeout: number;
};

export const buyCommand: CommandModule<object, BuyArgs> = {
  command: 'buy [ask]',
  describe:
    "Buy with the saved card and address. Under the owner's auto-pay limit it pays right away; over it, the owner approves",
  builder: (y) =>
    y
      .positional('ask', { type: 'string', describe: 'What to buy, or the answer to a question' })
      .option('conversation', { type: 'string', describe: 'Continue this purchase conversation' })
      .option('approval', {
        type: 'string',
        describe: 'Check an approval (with --wait, wait for it)'
      })
      .option('wait', { type: 'boolean', describe: 'Wait until the owner decides' })
      .option('timeout', { type: 'number', default: 900, describe: 'Seconds to wait' })
      .option('wallet', walletOpt),
  handler: async (argv) => {
    try {
      if (argv.approval) {
        const s = argv.wait
          ? await waitForApproval(argv.wallet, argv.approval, argv.timeout)
          : await credentialsApi<ApprovalStatus>(
              argv.wallet,
              'GET',
              `/api/credentials/approvals/${encodeURIComponent(argv.approval)}`
            );
        jsonOut({ ok: true, walletName: argv.wallet, ...s, ...approvalNext(s, argv.wallet) });
        return;
      }
      if (!argv.ask) {
        throw new CliError({
          code: 'invalid_input',
          message: 'Say what to buy, or pass --approval <id>.'
        });
      }
      const turn = await credentialsApi<BuyTurn>(argv.wallet, 'POST', '/api/credentials/buy', {
        ask: argv.ask,
        ...(argv.conversation ? { conversationId: argv.conversation } : {})
      });
      jsonOut({ ok: true, walletName: argv.wallet, ...turn, ...buyNext(turn, argv.wallet) });
    } catch (error) {
      jsonFail(error);
    }
  }
};

type CheckoutArgs = WalletArgs & {
  merchant?: string;
  url?: string;
  total?: number;
  item?: string[];
  card?: string;
  done?: string;
  cancel?: string;
};

interface CheckoutStep {
  status: string;
  checkoutId?: string;
  approvalId?: string;
  approvalUrl?: string;
  passkeyUrl?: string | null;
  merchant?: string;
  totalCents?: number;
  card?: {
    number: string;
    expMonth: number | null;
    expYear: number | null;
    cvc: string;
    last4: string;
  };
  nextAction?: { type: string; url?: string | null; sessionId?: string; message?: string };
}

const cardDir = () => path.join(STORAGE_ROOT, 'checkout');
const cardFile = (id: string) => path.join(cardDir(), `${id.replace(/[^\w-]/g, '')}.json`);

// The one-time card goes to a file only this user can read, never to stdout:
// output lands in logs and chat transcripts.
function keepCard(step: CheckoutStep): string | null {
  if (!step.card || !step.checkoutId) return null;
  ensureStorageDir();
  fs.mkdirSync(cardDir(), { recursive: true, mode: 0o700 });
  const file = cardFile(step.checkoutId);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        merchant: step.merchant,
        totalCents: step.totalCents,
        number: step.card.number,
        expMonth: step.card.expMonth,
        expYear: step.card.expYear,
        cvc: step.card.cvc
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  fs.chmodSync(file, 0o600);
  return file;
}

export function checkoutOut(step: CheckoutStep, wallet: string) {
  const file = keepCard(step);
  const { card, ...rest } = step;
  const id = step.checkoutId ?? step.approvalId;
  const w = walletFlag(wallet);
  const out: Record<string, unknown> = { ok: true, walletName: wallet, ...rest };
  if (card && file) {
    Object.assign(out, {
      card: { last4: card.last4, expMonth: card.expMonth, expYear: card.expYear },
      cardFile: file,
      next: "Pay now: type the card from cardFile into the store's payment form and submit. Read cardFile only to fill the form, and never show the number in chat. It pays once, for exactly totalCents, and lasts about an hour.",
      then: `polygon-agent checkout --done ${id}${w}   # once the store confirms the order (or --cancel ${id} if you give up)`
    });
  } else if (step.status === 'pending_approval') {
    Object.assign(out, {
      next: "Over the owner's auto-pay limit. Send them approvalUrl alone on its own line, then wait.",
      then: `polygon-agent buy --approval ${id} --wait${w}`
    });
  } else if (step.status === 'awaiting_passkey') {
    Object.assign(out, {
      next: 'The owner confirms this card with their passkey. Send them passkeyUrl alone on its own line, then:',
      then: `polygon-agent checkout --card ${id}${w}`
    });
  } else if (step.status === 'requires_action' && step.nextAction?.type === 'add_card') {
    Object.assign(out, {
      next: 'No card is saved yet. Send the owner nextAction.url alone on its own line, then wait for them.',
      then: `polygon-agent credentials cards wait --session ${step.nextAction.sessionId}${w}`
    });
  } else if (step.status === 'requires_action' && step.nextAction?.type === 'attach_card') {
    Object.assign(out, {
      next: 'The owner adds their card for paying at any store. Send them nextAction.url alone on its own line; once they say done, run checkout again with the same store and total.'
    });
  } else if (step.status === 'declined' || step.status === 'canceled') {
    Object.assign(out, { next: 'Nothing was charged. Do not retry; tell the owner.' });
  }
  return out;
}

export const checkoutCommand: CommandModule<object, CheckoutArgs> = {
  command: 'checkout',
  describe:
    "Pay at any store's checkout in your browser: a one-time card for the exact total (the owner approves over their auto-pay limit)",
  builder: (y) =>
    y
      .option('merchant', { type: 'string', describe: 'The store' })
      .option('url', { type: 'string', describe: 'The checkout or product page' })
      .option('total', { type: 'number', describe: 'Checkout total in USD, with tax and shipping' })
      .option('item', {
        type: 'string',
        array: true,
        describe: 'An item, "name" or "2x name" (repeatable)'
      })
      .option('card', {
        type: 'string',
        describe: 'Get the one-time card for an approved checkout'
      })
      .option('done', { type: 'string', describe: 'The store confirmed the order: close the card' })
      .option('cancel', { type: 'string', describe: 'Give up on a checkout: close the card' })
      .option('wallet', walletOpt),
  handler: async (argv) => {
    try {
      const finish = argv.done ?? argv.cancel;
      if (finish) {
        const s = await credentialsApi<CheckoutStep>(
          argv.wallet,
          'POST',
          `/api/credentials/checkout/${encodeURIComponent(finish)}/close`,
          { outcome: argv.done ? 'paid' : 'canceled' }
        );
        fs.rmSync(cardFile(finish), { force: true });
        jsonOut({ ok: true, walletName: argv.wallet, ...s });
        return;
      }
      if (argv.card) {
        const s = await credentialsApi<CheckoutStep>(
          argv.wallet,
          'POST',
          `/api/credentials/checkout/${encodeURIComponent(argv.card)}/card`
        );
        jsonOut(checkoutOut(s, argv.wallet));
        return;
      }
      if (!argv.merchant || argv.total === undefined) {
        throw new CliError({
          code: 'invalid_input',
          message: 'Pass --merchant and --total, or --card / --done / --cancel <checkoutId>.'
        });
      }
      if (!Number.isFinite(argv.total) || argv.total <= 0) {
        throw new CliError({
          code: 'invalid_input',
          message: '--total must be the checkout total in USD.'
        });
      }
      const items = (argv.item ?? []).map((raw) => {
        const m = /^(\d+)\s*x\s+(.+)$/i.exec(raw.trim());
        return m ? { name: m[2], qty: Number(m[1]) } : { name: raw.trim(), qty: 1 };
      });
      const s = await credentialsApi<CheckoutStep>(
        argv.wallet,
        'POST',
        '/api/credentials/checkout',
        {
          merchant: argv.merchant,
          ...(argv.url ? { merchantUrl: argv.url } : {}),
          totalCents: Math.round(argv.total * 100),
          items
        }
      );
      jsonOut(checkoutOut(s, argv.wallet));
    } catch (error) {
      jsonFail(error);
    }
  }
};

const cardsCommand: CommandModule = {
  command: 'cards',
  describe: 'Saved cards: list them, or `add` one through a secure link',
  builder: (y) => y.command(cardsListCommand).command(cardsAddCommand).command(cardsWaitCommand),
  handler: () => {}
};

export const credentialsCommand: CommandModule = {
  command: 'credentials',
  describe: 'Saved details agents use to buy for the owner (shipping address, cards)',
  builder: (y) =>
    y.command(statusCommand).command(addressCommand).command(cardsCommand).demandCommand(1),
  handler: () => {}
};
