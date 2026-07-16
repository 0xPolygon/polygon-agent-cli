// The browser-login action loop: the branded page (agentconnect-ui /login) is
// the input surface, the relay carries user actions here, and this process
// drives the actual SDK auth so keys and the PKCE verifier never leave the
// machine. Pure orchestration over injected deps so it is unit-testable.

export type LoginAction =
  | { type: 'google' }
  | { type: 'oidc-callback'; callbackUrl: string }
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
  };
  wallet: {
    startOidcRedirectAuth(p: {
      provider: unknown;
      omsRelayReturnUri: string;
    }): Promise<{ authorizationUrl: string }>;
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
  // The SDK's opaque Google provider value (OmsRelayOidcProviders.google), injected
  // so this file stays SDK-agnostic and unit tests can fake it with a sentinel.
  oidcProviderGoogle: unknown;
  announce(url: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  randomSessionId(): string;
}

export interface BrowserLoginOpts {
  relayBase: string;
  uiBase: string;
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

  const runActionLoop = async (): Promise<{
    walletAddress: string;
    loginMethod: 'google' | 'email';
  }> => {
    let otpFailures = 0;

    while (deps.now() < deadline) {
      const action = await relay.nextAction(session);
      if (!action) {
        await deps.sleep(interval);
        continue;
      }

      if (action.type === 'cancel') {
        throw new Error('Login cancelled in the browser.');
      }

      if (action.type === 'google') {
        // The OMS relay validates this return URI against the project's
        // allowlist with an exact string match, so it must stay the bare,
        // static `/login` (no query): a per-login `?s=` would never match a
        // static registration. The pairing session instead survives the
        // OAuth round trip via sessionStorage on the page itself, which the
        // relay bounces back to with its own callback params appended; the
        // page then posts the full return URL back to us as an
        // `oidc-callback` action below.
        const { authorizationUrl } = await wallet.startOidcRedirectAuth({
          provider: deps.oidcProviderGoogle,
          omsRelayReturnUri: `${opts.uiBase}/login`
        });
        await relay.setStatus(session, { status: 'auth-url', url: authorizationUrl });
        continue;
      }

      if (action.type === 'oidc-callback') {
        const result = await wallet.completeOidcRedirectAuth({
          callbackUrl: action.callbackUrl,
          walletSelection: 'automatic'
        });
        await relay.setStatus(session, { status: 'done', walletAddress: result.walletAddress });
        return { walletAddress: result.walletAddress, loginMethod: 'google' };
      }

      if (action.type === 'email') {
        await wallet.startEmailAuth({ email: action.email });
        otpFailures = 0;
        await relay.setStatus(session, { status: 'otp-sent' });
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
          throw new Error('Login failed: too many invalid codes.');
        }
        await relay.setStatus(session, {
          status: 'otp-invalid',
          attemptsLeft: MAX_OTP_ATTEMPTS - otpFailures
        });
      }
    }

    throw new Error('Timed out waiting for browser login. Re-run, or use `wallet login --local`.');
  };

  try {
    return await runActionLoop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await relay.setStatus(session, { status: 'error', message });
    } catch {
      // Best-effort: the thrown error below is the source of truth.
    }
    throw error instanceof Error ? error : new Error(message);
  }
}
