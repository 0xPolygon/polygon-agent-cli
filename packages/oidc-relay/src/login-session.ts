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

  async setStatus(status: LoginStatus): Promise<void> {
    await this.store.put({ status });
  }

  async getStatus(): Promise<LoginStatus | { status: 'expired' }> {
    if (!(await this.store.get<boolean>('armed'))) return { status: 'expired' };
    return (await this.store.get<LoginStatus>('status')) ?? { status: 'expired' };
  }
}
