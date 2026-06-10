// Transaction dispatch — submits via the OMS (Sequence V3) primitive.
//
// Command call sites import `runTx` from here. (Kept as a thin indirection so
// call sites don't import oms-tx directly, leaving room for future routing.)

import type { OmsTxParams, OmsTxResult } from './oms-tx.ts';

import { runOmsTx } from './oms-tx.ts';

export type RunTxParams = OmsTxParams;
export type RunTxResult = OmsTxResult;

export async function runTx(params: RunTxParams): Promise<RunTxResult> {
  return runOmsTx(params);
}
