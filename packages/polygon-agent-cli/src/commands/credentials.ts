// `credentials`: details the owner saved for agents to use when buying for
// them (shipping address now; cards next). Stored by agentconnect, read and
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

export const credentialsCommand: CommandModule = {
  command: 'credentials',
  describe: 'Saved details agents use to buy for the owner (shipping address)',
  builder: (y) => y.command(statusCommand).command(addressCommand).demandCommand(1),
  handler: () => {}
};
