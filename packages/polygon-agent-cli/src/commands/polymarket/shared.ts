// Helpers shared by the polymarket subcommands.

import type { Argv } from 'yargs';

import { bigintReplacer, CliError, errorJson, failureJson } from '../../lib/errors.ts';
import { loadOmsWalletPointer } from '../../lib/storage.ts';

export function walletOption<T>(y: Argv<T>) {
  return y.option('wallet', { type: 'string', default: 'main', describe: 'OMS wallet name' });
}

export function ok(data: Record<string, unknown>): void {
  console.log(JSON.stringify({ ok: true, ...data }, bigintReplacer, 2));
}

export function fail(err: unknown, { stack = false } = {}): never {
  console.error(JSON.stringify(stack ? failureJson(err) : errorJson(err), bigintReplacer));
  process.exit(1);
}

export async function omsAddress(wallet: string): Promise<string> {
  const pointer = await loadOmsWalletPointer(wallet);
  if (!pointer) {
    throw new CliError({
      code: 'not_connected',
      message: `Wallet '${wallet}' isn't connected.`,
      command: 'agent wallet login'
    });
  }
  return pointer.walletAddress;
}

export const REDEEMABLE_ROW_CAP = 2000;

type PageLike = { items: unknown[]; hasMore?: boolean; nextCursor?: string };

// Every REDEEMABLE position, across pages, up to a row cap. `truncated` says more remained.
export async function collectRedeemable(client: {
  listPositions(req: object): AsyncIterable<PageLike>;
}): Promise<{ items: unknown[]; truncated: boolean }> {
  const items: unknown[] = [];
  for await (const page of client.listPositions({ status: 'REDEEMABLE', pageSize: 500 })) {
    items.push(...page.items);
    const more = page.hasMore ?? page.nextCursor !== undefined;
    if (items.length >= REDEEMABLE_ROW_CAP) {
      const truncated = items.length > REDEEMABLE_ROW_CAP || more;
      return { items: items.slice(0, REDEEMABLE_ROW_CAP), truncated };
    }
  }
  return { items, truncated: false };
}
