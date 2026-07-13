// The browser-login action loop: the branded page (agentconnect-ui /login) is
// the input surface, the relay carries user actions here, and this process
// drives the actual SDK auth so keys and the PKCE verifier never leave the
// machine. Pure orchestration over injected deps so it is unit-testable.

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

export interface BrowserLoginDeps {
  relay: {
    registerSession(session: string): Promise<void>;
    nextAction(session: string): Promise<LoginAction | null>;
    setStatus(session: string, status: LoginStatus): Promise<void>;
    registerOidcHandoff(state: string, returnTo: string): Promise<void>;
    pollOidcCallback(state: string, timeoutMs: number): Promise<{ code: string; state: string }>;
  };
  wallet: {
    startOidcRedirectAuth(p: {
      provider: 'google';
      redirectUri: string;
      relayRedirectUri?: string;
    }): Promise<{ url: string; state: string }>;
    completeOidcRedirectAuth(p: {
      callbackUrl: string;
      walletSelection: 'automatic';
    }): Promise<{ walletAddress: string }>;
    startEmailAuth(p: { email: string }): Promise<void>;
    completeEmailAuth(p: {
      code: string;
      walletSelection: 'automatic';
    }): Promise<{ walletAddress: string }>;
  };
  announce(url: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  randomSessionId(): string;
}

export interface BrowserLoginOpts {
  relayBase: string;
  uiBase: string;
  seqRelay?: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}

const MAX_OTP_ATTEMPTS = 3;

export async function runBrowserLogin(
  deps: BrowserLoginDeps,
  opts: BrowserLoginOpts
): Promise<{ walletAddress: string; loginMethod: 'google' | 'email' }> {
  const { relay, wallet } = deps;
  const interval = opts.pollIntervalMs ?? 2000;
  const session = deps.randomSessionId();
  const pageUrl = `${opts.uiBase}/login#${session}`;
  const deadline = deps.now() + opts.timeoutMs;

  await relay.registerSession(session);
  await deps.announce(pageUrl);

  // Publish a terminal error so the page does not sit on a spinner, then throw.
  const fail = async (message: string): Promise<never> => {
    try {
      await relay.setStatus(session, { status: 'error', message });
    } catch {
      // Best-effort: the CLI error below is the source of truth.
    }
    throw new Error(message);
  };

  let otpFailures = 0;

  while (deps.now() < deadline) {
    const action = await relay.nextAction(session);
    if (!action) {
      await deps.sleep(interval);
      continue;
    }

    if (action.type === 'cancel') {
      return fail('Login cancelled in the browser.');
    }

    if (action.type === 'google') {
      const { url, state } = await wallet.startOidcRedirectAuth({
        provider: 'google',
        redirectUri: `${opts.relayBase}/api/oidc/cb`,
        ...(opts.seqRelay ? { relayRedirectUri: opts.seqRelay } : {})
      });
      await relay.registerOidcHandoff(state, pageUrl);
      await relay.setStatus(session, { status: 'auth-url', url });
      try {
        const cb = await relay.pollOidcCallback(state, Math.max(deadline - deps.now(), 1));
        const callbackUrl = `${opts.relayBase}/api/oidc/cb?code=${encodeURIComponent(cb.code)}&state=${encodeURIComponent(cb.state)}`;
        const result = await wallet.completeOidcRedirectAuth({
          callbackUrl,
          walletSelection: 'automatic'
        });
        await relay.setStatus(session, { status: 'done', walletAddress: result.walletAddress });
        return { walletAddress: result.walletAddress, loginMethod: 'google' };
      } catch (error) {
        return fail((error as Error).message);
      }
    }

    if (action.type === 'email') {
      try {
        await wallet.startEmailAuth({ email: action.email });
        otpFailures = 0;
        await relay.setStatus(session, { status: 'otp-sent' });
      } catch (error) {
        return fail((error as Error).message);
      }
      continue;
    }

    // action.type === 'otp'
    try {
      const result = await wallet.completeEmailAuth({
        code: action.code,
        walletSelection: 'automatic'
      });
      await relay.setStatus(session, { status: 'done', walletAddress: result.walletAddress });
      return { walletAddress: result.walletAddress, loginMethod: 'email' };
    } catch {
      otpFailures += 1;
      if (otpFailures >= MAX_OTP_ATTEMPTS) {
        return fail('Login failed: too many invalid codes.');
      }
      await relay.setStatus(session, {
        status: 'otp-invalid',
        attemptsLeft: MAX_OTP_ATTEMPTS - otpFailures
      });
    }
  }

  return fail('Timed out waiting for browser login. Re-run, or use `wallet login --local`.');
}
