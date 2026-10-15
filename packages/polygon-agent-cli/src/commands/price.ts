// `price <token> [--chain]` (FS §8.1): the USD price from Trails with its
// timestamp, and for a canonical symbol, the covered tokens' prices per chain.

import type { CommandModule } from 'yargs';

import { CliError, jsonFail, jsonOut } from '../lib/errors.ts';
import { relatedPriceTokens, resolvePriceTarget } from '../lib/price-target.ts';
import { getPriceReadings, priceKey } from '../lib/prices.ts';
import { chainLabel } from '../lib/session/tokens.ts';

interface PriceArgs {
  token?: string;
  chain?: string;
}

export const priceCommand: CommandModule<object, PriceArgs> = {
  command: 'price <token>',
  describe: 'USD price of a token (ETH, BTC, POL, USDC… or any token with --chain)',
  builder: (y) =>
    y
      .positional('token', { type: 'string', describe: 'Symbol or contract address' })
      .option('chain', {
        type: 'string',
        describe: 'Chain (needed for anything but ETH, BTC, POL and stablecoins)'
      }),
  handler: async (argv) => {
    try {
      if (!argv.token) throw new CliError({ code: 'invalid_input', message: 'Give a token.' });
      const target = await resolvePriceTarget({ token: argv.token, chain: argv.chain });
      const related = relatedPriceTokens(target);
      const readings = await getPriceReadings({ tokens: [target, ...related], now: new Date() });
      const reading = readings.get(priceKey(target));
      jsonOut({
        ok: true,
        token: target.symbol,
        chain: chainLabel(target.chainId),
        chainId: target.chainId,
        address: target.address,
        priceUsd: reading?.usd ?? null,
        updatedAt: reading?.updatedAt ?? null,
        stale: reading?.stale ?? true,
        ...(reading?.stale !== false
          ? { note: 'No current price (missing or older than 5 minutes); watches ignore it.' }
          : {}),
        ...(related.length
          ? {
              chains: related.map((token) => {
                const r = readings.get(priceKey(token));
                return {
                  chain: token.chainName,
                  symbol: token.symbol,
                  address: token.address,
                  priceUsd: r?.usd ?? null,
                  stale: r?.stale ?? true
                };
              })
            }
          : {})
      });
    } catch (error) {
      jsonFail(error);
    }
  }
};
