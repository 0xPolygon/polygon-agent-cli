import type { PaymentRequirements } from '@x402/core/types';

import http from 'node:http';

import { encodePaymentRequiredHeader } from '@x402/core/http';

export type X402Answer =
  | { kind: 'payment-required'; accepts: PaymentRequirements[] }
  | { kind: 'ok'; body: unknown }
  | { kind: 'redirect'; location: string };

export interface FakeX402 {
  url: string;
  /** Headers of every request received, lower-cased names. */
  requests: Array<Record<string, string | string[] | undefined>>;
  /** Sets how the next requests are answered. */
  answer: (answer: X402Answer) => void;
  close: () => Promise<void>;
}

// The 402 header comes from the x402 library's own encoder, so the CLI parses
// exactly what a real service would send.
export async function startFakeX402(): Promise<FakeX402> {
  const requests: FakeX402['requests'] = [];
  let current: X402Answer = { kind: 'ok', body: {} };
  const server = http.createServer((req, res) => {
    requests.push({ ...req.headers });
    if (current.kind === 'payment-required') {
      const header = encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url: `http://${req.headers.host ?? ''}${req.url ?? ''}` },
        accepts: current.accepts
      });
      res.writeHead(402, { 'PAYMENT-REQUIRED': header }).end('{}');
    } else if (current.kind === 'redirect') {
      res.writeHead(302, { Location: current.location }).end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(current.body));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake x402 failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    answer: (answer) => {
      current = answer;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
