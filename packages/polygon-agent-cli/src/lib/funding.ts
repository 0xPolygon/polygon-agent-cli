// The wallet funding page (Trails on-ramp + swap): the agentconnect dashboard
// (POLYGON_AGENT_CREDENTIALS_URL, else the login page's host), which reads
// ?wallet&chain&view&amount. POLYGON_AGENT_FUNDING_UI overrides.

import { credentialsBaseUrl } from './oms-client.ts';

// The Polymarket bridge's minimum, and so the smallest amount worth asking for.
export const MIN_FUNDING_USD = 2;

export function fundingUiBase(): string {
  const v = process.env.POLYGON_AGENT_FUNDING_UI;
  return v ? v.replace(/\/+$/, '') : credentialsBaseUrl();
}

export type FundingView = 'fund' | 'dashboard';

export function fundingUrl(params: {
  walletAddress: string;
  chainId: number;
  amountUsd?: number | string;
  view?: FundingView;
}): string {
  const view = params.view ?? 'fund';
  const url = `${fundingUiBase()}/?wallet=${params.walletAddress}&chain=${params.chainId}&view=${view}`;
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

// The wallet's page on agentconnect, sent after every connect and by `wallet
// status`: the fund view while the wallet is empty, the dashboard after.
// `polymarketAddress` is the Polymarket deposit (trading) account, where
// positions live; the dashboard reads it as `pm`.
export function dashboardInfo(params: {
  walletAddress: string;
  funded: boolean;
  polymarketAddress?: string | null;
}): {
  url: string;
} {
  let url = fundingUrl({
    walletAddress: params.walletAddress,
    chainId: 137,
    view: params.funded ? 'dashboard' : 'fund'
  });
  if (params.polymarketAddress) url += `&pm=${params.polymarketAddress}`;
  return { url };
}
