// `credentials`: details the owner saved for agents to use when buying for
// them: a shipping address, and cards in the AgentCard vault. Stored by agentconnect, read and
// written as this wallet's linked agent key.

import type { CommandModule } from 'yargs';

import { credentialsApi, loadCertificate } from '../lib/credentials/agent.ts';
import { CliError, jsonFail, jsonOut } from '../lib/errors.ts';
import { loadOmsWalletPointer } from '../lib/storage.ts';

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
  describe:
    "A one-time link where the user saves a card behind their passkey (AgentCard's secure page)",
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
  conversationId: string;
  status: string;
  reply: string | null;
  cart: { merchant_name?: string; totalCents: number; hash: string } | null;
  approvalUrl: string | null;
  declineCode: string | null;
  orderId: string | null;
}

type BuyArgs = WalletArgs & { ask?: string; conversation?: string; confirm?: string };

const walletFlag = (w: string) => (w === 'main' ? '' : ` --wallet ${w}`);

// What the agent should do after this turn.
function buyNext(t: BuyTurn, wallet: string): Record<string, string> {
  const again = `polygon-agent credentials buy --conversation ${t.conversationId}`;
  if (t.status === 'declined' && t.declineCode === 'vault_approval_required' && t.approvalUrl) {
    return {
      next: 'Send the owner approvalUrl on its own line. They approve with their passkey; nothing is charged until then.',
      then: `${again} --confirm ${t.cart?.hash ?? '<hash>'}${walletFlag(wallet)}`
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
  if (t.cart && t.status === 'needs_input') {
    return {
      next: 'Show the owner the cart and total, and ask whether to place it.',
      confirm: `${again} --confirm ${t.cart.hash}${walletFlag(wallet)}`,
      change: `${again} "<what to change>"${walletFlag(wallet)}`
    };
  }
  if (t.status === 'needs_input') {
    return {
      next: 'Relay reply to the owner, then send their answer:',
      answer: `${again} "<answer>"${walletFlag(wallet)}`
    };
  }
  return {};
}

const buyCommand: CommandModule<object, BuyArgs> = {
  command: 'buy [ask]',
  describe:
    'Shop at real stores with the saved card and address: describe it, show the cart, confirm its hash',
  builder: (y) =>
    y
      .positional('ask', { type: 'string', describe: 'What to buy, or the answer to a question' })
      .option('conversation', { type: 'string', describe: 'Continue this purchase conversation' })
      .option('confirm', { type: 'string', describe: 'Place the cart with this hash' })
      .option('wallet', walletOpt),
  handler: async (argv) => {
    try {
      if (!argv.ask && !argv.confirm) {
        throw new CliError({
          code: 'invalid_input',
          message: 'Say what to buy, or pass --conversation and --confirm <hash>.'
        });
      }
      const turn = await credentialsApi<BuyTurn>(argv.wallet, 'POST', '/api/credentials/buy', {
        ...(argv.ask ? { ask: argv.ask } : {}),
        ...(argv.conversation ? { conversationId: argv.conversation } : {}),
        ...(argv.confirm ? { confirm: argv.confirm } : {})
      });
      jsonOut({ ok: true, walletName: argv.wallet, ...turn, ...buyNext(turn, argv.wallet) });
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
  describe: 'Saved details agents use to buy for the owner (shipping address, cards), and buying',
  builder: (y) =>
    y
      .command(statusCommand)
      .command(addressCommand)
      .command(cardsCommand)
      .command(buyCommand)
      .demandCommand(1),
  handler: () => {}
};
