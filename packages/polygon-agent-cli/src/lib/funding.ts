// The wallet funding page (Trails on-ramp + swap): the agentconnect dashboard
// (same host as the login page), which reads ?wallet&chain&view&amount.
// POLYGON_AGENT_FUNDING_UI overrides per environment.

import { loginUiBaseUrl } from './oms-client.ts';

// The Polymarket bridge's minimum, and so the smallest amount worth asking for.
export const MIN_FUNDING_USD = 2;

export function fundingUiBase(): string {
  const v = process.env.POLYGON_AGENT_FUNDING_UI;
  return v ? v.replace(/\/+$/, '') : loginUiBaseUrl();
}

export function fundingUrl(params: {
  walletAddress: string;
  chainId: number;
  amountUsd?: number | string;
}): string {
  const url = `${fundingUiBase()}/?wallet=${params.walletAddress}&chain=${params.chainId}&view=fund`;
  return params.amountUsd === undefined ? url : `${url}&amount=${params.amountUsd}`;
}

// What an error or connect result carries so the assistant can send the link.
export function fundingInfo(params: {
  walletAddress: string;
  chainId: number;
  amountUsd?: number | string;
}): { url: string; amountUsd?: number | string } {
  return {
    url: fundingUrl(params),
    ...(params.amountUsd === undefined ? {} : { amountUsd: params.amountUsd })
  };
}
