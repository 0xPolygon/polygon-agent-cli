import { handle as walletService } from './oms-rac.ts';

export interface Recorded {
  host: string;
  method: string;
  path: string;
  headerNames: string[];
  body: string | null;
  faked: boolean;
}

export const CONTROL_HOST = 'fake-control.test';

// A suffix, so whichever wallet-service host the SDK picks for the test key lands here.
const isWalletService = (host: string) => host.endsWith('.polygon.technology');

let log: Recorded[] = [];
const scenarios = new Map<string, unknown>();

// Fails closed: a host with no route is recorded and answered 599, never forwarded.
export async function outbound(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.hostname === CONTROL_HOST) return control(req, url);
  const faked = isWalletService(url.hostname);
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.clone().text();
  log.push({
    host: url.hostname,
    method: req.method,
    path: url.pathname + url.search,
    headerNames: [...req.headers.keys()].sort(),
    body,
    faked
  });
  if (!faked) return Response.json({ error: 'host not faked' }, { status: 599 });
  return walletService(req, scenarios.get(url.hostname) as Parameters<typeof walletService>[1]);
}

async function control(req: Request, url: URL): Promise<Response> {
  if (req.method === 'GET' && url.pathname === '/log') return Response.json(log);
  if (req.method === 'POST' && url.pathname === '/scenario') {
    const { host, scenario } = (await req.json()) as { host: string; scenario: unknown };
    scenarios.set(host, scenario);
    return Response.json({ ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/reset') {
    log = [];
    scenarios.clear();
    return Response.json({ ok: true });
  }
  return Response.json({ error: 'unknown control route' }, { status: 404 });
}
