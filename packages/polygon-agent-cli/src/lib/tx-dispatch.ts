// Transaction dispatch. Every write from an OMS wallet goes through runTx:
// owner-mode wallets send with the owner's session (oms-tx.ts); session-mode
// wallets transfer through the install's smart sessions (session/run-tx.ts).

import type { OmsTxParams, OmsTxResult } from './oms-tx.ts';
import type { SpendPurpose } from './session/ledger.ts';

import { CliError } from './errors.ts';
import { runOmsTx } from './oms-tx.ts';
import { runSessionTx } from './session/run-tx.ts';
import { loadOmsWalletPointer } from './storage.ts';

export interface RunTxParams extends OmsTxParams {
  // What a session-mode spend is for, recorded in the USD ledger.
  purpose?: SpendPurpose;
  ref?: string;
  // Refuse in session mode even if the transaction would be a plain transfer.
  ownerOnly?: boolean;
}
export type RunTxResult = OmsTxResult;

export async function runTx(params: RunTxParams): Promise<RunTxResult> {
  const pointer = await loadOmsWalletPointer(params.walletName);
  if (pointer?.access !== 'session') return runOmsTx(params);
  if (params.ownerOnly) {
    throw new CliError({
      code: 'owner_required',
      message: "This needs the wallet owner; it isn't available with this install's allowance."
    });
  }
  return runSessionTx({ ...params, walletAddress: pointer.walletAddress });
}
