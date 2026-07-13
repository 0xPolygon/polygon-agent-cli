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
  | { type: 'cancel' };

export type LoginStatus =
  | { status: 'awaiting-method' }
  | { status: 'auth-url'; url: string }
  | { status: 'otp-sent' }
  | { status: 'otp-invalid'; attemptsLeft?: number }
  | { status: 'done'; walletAddress: string }
  | { status: 'error'; message: string };

const VALID_STATUS_VALUES = new Set([
  'awaiting-method',
  'auth-url',
  'otp-sent',
  'otp-invalid',
  'done',
  'error'
]);

// Shape-check a browser/CLI-submitted status before it reaches the DO. Bounds
// every optional string field so a misbehaving caller can't stash an
// unbounded payload in durable storage, and requires the field a given
// status actually needs (url for auth-url, walletAddress for done, message
// for error).
export function validLoginStatus(s: unknown): s is LoginStatus {
  if (typeof s !== 'object' || s === null) return false;
  const status = (s as { status?: unknown }).status;
  if (typeof status !== 'string' || !VALID_STATUS_VALUES.has(status)) return false;

  const url = (s as { url?: unknown }).url;
  if (url !== undefined && (typeof url !== 'string' || url.length > 2048)) return false;
  if (status === 'auth-url' && typeof url !== 'string') return false;

  const walletAddress = (s as { walletAddress?: unknown }).walletAddress;
  if (
    walletAddress !== undefined &&
    (typeof walletAddress !== 'string' || walletAddress.length > 128)
  )
    return false;
  if (status === 'done' && typeof walletAddress !== 'string') return false;

  const message = (s as { message?: unknown }).message;
  if (message !== undefined && (typeof message !== 'string' || message.length > 512)) return false;
  if (status === 'error' && typeof message !== 'string') return false;

  const attemptsLeft = (s as { attemptsLeft?: unknown }).attemptsLeft;
  if (attemptsLeft !== undefined && typeof attemptsLeft !== 'number') return false;

  return true;
}

export interface SessionStore {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export class LoginSessionCore {
  constructor(private readonly store: SessionStore) {}

  async register(): Promise<void> {
    await this.store.put({ armed: true, status: { status: 'awaiting-method' } });
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

  async getStatus(): Promise<LoginStatus | { status: 'expired' }> {
    if (!(await this.store.get<boolean>('armed'))) return { status: 'expired' };
    return (await this.store.get<LoginStatus>('status')) ?? { status: 'expired' };
  }
}

const SESSION_TTL_MS = 10 * 60 * 1000; // matches OidcHandoff

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
      await this.core.register();
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
