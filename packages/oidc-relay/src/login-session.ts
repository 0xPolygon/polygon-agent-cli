// Pairing-session logic for the browser login flow. Pure logic over a minimal
// storage interface so it is unit-testable without the Workers runtime; the
// Durable Object wrapper lives in relay.ts wiring (Task 2).
//
// One pending action slot, latest wins: the page waits for a status change
// before offering the next input, so at most one action is meaningfully in
// flight; a second submit (double click, cancel during OTP) should replace,
// not queue. Actions are one-time reads so an OTP can never be replayed.

export type LoginAction =
  | { type: 'google' }
  | { type: 'email'; email: string }
  | { type: 'otp'; code: string }
  | { type: 'cancel' }
  | { type: 'oidc-callback'; callbackUrl: string };

export type LoginStatus =
  | { status: 'awaiting-method' }
  | { status: 'auth-url'; url: string }
  | { status: 'otp-sent' }
  | { status: 'otp-invalid'; attemptsLeft?: number }
  | { status: 'done'; walletAddress: string; funding?: { url: string } }
  | { status: 'error'; message: string };

// What the sign-in approves, published by the CLI at register so the page can
// say so. Entirely optional: an invalid context is dropped, never an error.
export interface LoginContext {
  purpose: 'connect' | 'allowance' | 'renew' | 'withdraw' | 'access' | 'owner';
  allowanceUsd?: number;
  days?: number;
  polymarket?: boolean;
}

const PURPOSES = new Set(['connect', 'allowance', 'renew', 'withdraw', 'access', 'owner']);

// Returns a reconstructed context with only known, valid fields, or undefined
// when the input is not a usable context.
export function parseLoginContext(c: unknown): LoginContext | undefined {
  if (typeof c !== 'object' || c === null) return undefined;
  const { purpose, allowanceUsd, days, polymarket } = c as Record<string, unknown>;
  if (typeof purpose !== 'string' || !PURPOSES.has(purpose)) return undefined;
  const out: LoginContext = { purpose: purpose as LoginContext['purpose'] };
  if (typeof allowanceUsd === 'number' && Number.isFinite(allowanceUsd) && allowanceUsd >= 0) {
    out.allowanceUsd = allowanceUsd;
  }
  if (typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= 3650) {
    out.days = days;
  }
  if (typeof polymarket === 'boolean') out.polymarket = polymarket;
  return out;
}

const VALID_STATUS_VALUES = new Set([
  'awaiting-method',
  'auth-url',
  'otp-sent',
  'otp-invalid',
  'done',
  'error'
]);

// Validate and normalize a browser/CLI-submitted status before it reaches the DO.
// Performs per-field validation (status enum, string length bounds, required fields
// per status kind) and returns a reconstructed object containing only the known fields
// for that status type, preventing junk properties from reaching durable storage.
// Returns null if the input is invalid.
export function parseLoginStatus(s: unknown): LoginStatus | null {
  if (typeof s !== 'object' || s === null) return null;
  const status = (s as { status?: unknown }).status;
  if (typeof status !== 'string' || !VALID_STATUS_VALUES.has(status)) return null;

  // Extract and validate optional fields
  const url = (s as { url?: unknown }).url;
  if (url !== undefined && (typeof url !== 'string' || url.length > 2048)) return null;

  const walletAddress = (s as { walletAddress?: unknown }).walletAddress;
  if (
    walletAddress !== undefined &&
    (typeof walletAddress !== 'string' || walletAddress.length > 128)
  )
    return null;

  const message = (s as { message?: unknown }).message;
  if (message !== undefined && (typeof message !== 'string' || message.length > 512)) return null;

  const attemptsLeft = (s as { attemptsLeft?: unknown }).attemptsLeft;
  if (attemptsLeft !== undefined && typeof attemptsLeft !== 'number') return null;

  // Funding is a courtesy link: anything but a short https URL is dropped,
  // leaving the done status itself intact.
  const rawFunding = (s as { funding?: { url?: unknown } | null }).funding;
  let funding: { url: string } | undefined;
  if (typeof rawFunding === 'object' && rawFunding !== null) {
    const furl = rawFunding.url;
    if (typeof furl === 'string' && furl.length <= 2048) {
      try {
        if (new URL(furl).protocol === 'https:') funding = { url: furl };
      } catch {
        // not a URL; dropped
      }
    }
  }

  // Reconstruct with only valid fields for this status
  switch (status) {
    case 'awaiting-method':
      return { status: 'awaiting-method' };
    case 'auth-url':
      if (typeof url !== 'string') return null;
      return { status: 'auth-url', url };
    case 'otp-sent':
      return { status: 'otp-sent' };
    case 'otp-invalid':
      return typeof attemptsLeft === 'number'
        ? { status: 'otp-invalid', attemptsLeft }
        : { status: 'otp-invalid' };
    case 'done':
      if (typeof walletAddress !== 'string') return null;
      return funding
        ? { status: 'done', walletAddress, funding }
        : { status: 'done', walletAddress };
    case 'error':
      if (typeof message !== 'string') return null;
      return { status: 'error', message };
    default:
      return null;
  }
}

export interface SessionStore {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export class LoginSessionCore {
  constructor(private readonly store: SessionStore) {}

  async register(context?: unknown): Promise<void> {
    const parsed = parseLoginContext(context);
    await this.store.put({ armed: true, status: { status: 'awaiting-method' } });
    if (parsed) await this.store.put({ context: parsed });
    else await this.store.delete('context');
  }

  async submitAction(
    action: LoginAction
  ): Promise<{ ok: boolean; error?: 'expired' | 'finished' }> {
    if (!(await this.store.get<boolean>('armed'))) return { ok: false, error: 'expired' };
    const status = await this.store.get<LoginStatus>('status');
    if (status && (status.status === 'done' || status.status === 'error')) {
      return { ok: false, error: 'finished' };
    }
    await this.store.put({ pendingAction: action });
    return { ok: true };
  }

  async nextAction(): Promise<
    { state: 'expired' } | { state: 'pending' } | { state: 'action'; action: LoginAction }
  > {
    if (!(await this.store.get<boolean>('armed'))) return { state: 'expired' };
    const action = await this.store.get<LoginAction>('pendingAction');
    if (!action) return { state: 'pending' };
    await this.store.delete('pendingAction');
    return { state: 'action', action };
  }

  async setStatus(status: LoginStatus): Promise<{ ok: boolean }> {
    if (!(await this.store.get<boolean>('armed'))) return { ok: false };
    await this.store.put({ status });
    return { ok: true };
  }

  async getStatus(): Promise<(LoginStatus & { context?: LoginContext }) | { status: 'expired' }> {
    if (!(await this.store.get<boolean>('armed'))) return { status: 'expired' };
    const status = await this.store.get<LoginStatus>('status');
    if (!status) return { status: 'expired' };
    const context = await this.store.get<LoginContext>('context');
    return context ? { ...status, context } : status;
  }
}

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the login

function doStore(storage: DurableObjectStorage): SessionStore {
  return {
    get: (key) => storage.get(key),
    put: (entries) => storage.put(entries),
    delete: (key) => storage.delete(key),
    deleteAll: () => storage.deleteAll()
  };
}

// --- Durable Object: one instance per login session id ---
export class LoginSession {
  private readonly core: LoginSessionCore;
  constructor(private readonly state: DurableObjectState) {
    this.core = new LoginSessionCore(doStore(state.storage));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.pathname; // internal path set by the router in relay.ts

    if (op === '/register') {
      const context = await request.json().catch(() => undefined);
      await this.core.register(context);
      await this.state.storage.setAlarm(Date.now() + SESSION_TTL_MS);
      return new Response(null, { status: 204 });
    }
    if (op === '/action') {
      const action = (await request.json()) as LoginAction;
      const result = await this.core.submitAction(action);
      if (!result.ok) return Response.json({ error: result.error }, { status: 410 });
      return new Response(null, { status: 204 });
    }
    if (op === '/next-action') {
      return Response.json(await this.core.nextAction());
    }
    if (op === '/set-status') {
      const result = await this.core.setStatus(await request.json());
      if (!result.ok) return Response.json({ error: 'expired' }, { status: 410 });
      return new Response(null, { status: 204 });
    }
    if (op === '/get-status') {
      return Response.json(await this.core.getStatus());
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
