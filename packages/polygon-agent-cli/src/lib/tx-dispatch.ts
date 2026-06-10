// Transaction dispatch shim — routes to the OMS (Sequence V3) primitive when
// POLYGON_AGENT_OMS is set, otherwise the legacy dapp-client primitive.
//
// Command call sites import `runTx` from here instead of runDappClientTx, so the
// migration is a one-line import change per site and both paths coexist during
// the transition.

import type { OmsTxParams, OmsTxResult } from './oms-tx.ts';

import { runDappClientTx } from './dapp-client.ts';
import { runOmsTx } from './oms-tx.ts';

export type RunTxParams = OmsTxParams;
export type RunTxResult = OmsTxResult;

/** True when the OMS (V3) path is enabled via env flag. */
export function isOmsEnabled(): boolean {
  return ['1', 'true', 'yes'].includes(String(process.env.POLYGON_AGENT_OMS || '').toLowerCase());
}

export async function runTx(params: RunTxParams): Promise<RunTxResult> {
  if (isOmsEnabled()) return runOmsTx(params);
  return runDappClientTx(params);
}
