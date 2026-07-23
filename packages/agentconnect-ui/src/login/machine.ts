// Pure state machine for the /login page. The component polls the relay and
// feeds statuses in as events alongside user input; side effects (posting
// actions, redirecting to the auth url) live in the component, not here.

export type LoginStatus =
  | { status: 'awaiting-method' }
  | { status: 'auth-url'; url: string }
  | { status: 'otp-sent' }
  | { status: 'otp-invalid'; attemptsLeft?: number }
  | { status: 'done'; walletAddress: string }
  | { status: 'error'; message: string };

export type RelayStatus = LoginStatus | { status: 'expired' };

export type MachineState =
  | { kind: 'method' }
  | { kind: 'google-wait' }
  // `url` is present when this came from a live `auth-url` status (offers a
  // manual fallback link); absent when the page detected a relay return on
  // load, since there is nothing left to link to at that point.
  | { kind: 'auth-pending'; url?: string }
  | { kind: 'email-entry' }
  | { kind: 'email-wait'; email: string }
  | { kind: 'otp-entry'; email: string; invalid?: boolean; attemptsLeft?: number }
  | { kind: 'otp-wait'; email: string }
  | { kind: 'success'; walletAddress: string }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };

export type MachineEvent =
  | { type: 'status'; status: RelayStatus }
  | { type: 'choose-google' }
  | { type: 'choose-email' }
  | { type: 'submit-email'; email: string }
  | { type: 'submit-otp'; code: string }
  | { type: 'back' }
  // Fired once on initial mount when the page detects it was just returned to
  // from the OMS relay (as opposed to a fresh open). Skips the method chooser
  // and goes straight to the finishing spinner.
  | { type: 'relay-return' };

export type LoginAction =
  | { type: 'google' }
  | { type: 'email'; email: string }
  | { type: 'otp'; code: string }
  | { type: 'cancel' }
  | { type: 'oidc-callback'; callbackUrl: string };

export const initialState: MachineState = { kind: 'method' };

function emailOf(state: MachineState): string {
  return 'email' in state ? state.email : '';
}

export function reduce(state: MachineState, event: MachineEvent): MachineState {
  // Terminal states absorb everything: a stale or duplicate poll response must
  // never regress the ui once the flow has resolved.
  if (state.kind === 'success' || state.kind === 'expired' || state.kind === 'failed') {
    return state;
  }

  if (event.type === 'status') {
    const s = event.status;
    // Terminal statuses win from anywhere.
    if (s.status === 'expired') return { kind: 'expired' };
    if (s.status === 'error') return { kind: 'failed', message: s.message };
    if (s.status === 'done') return { kind: 'success', walletAddress: s.walletAddress };

    // auth-pending only exits via a terminal status (handled above): once the
    // page is waiting out the Google redirect there is nothing else worth
    // reacting to until sign-in finishes or fails.
    if (state.kind === 'auth-pending') return state;

    // otp-sent snaps forward (also reconciles a refreshed page).
    if (s.status === 'otp-sent') {
      if (state.kind === 'otp-entry' || state.kind === 'otp-wait') return state;
      return { kind: 'otp-entry', email: emailOf(state) };
    }
    // otp-invalid snaps forward from anywhere that isn't already on the otp
    // form, reconciling a refreshed or lagging page onto the invalid-code
    // message instead of leaving it stuck on an earlier step.
    if (s.status === 'otp-invalid') {
      if (state.kind === 'otp-entry') return state;
      return {
        kind: 'otp-entry',
        email: emailOf(state),
        invalid: true,
        attemptsLeft: s.attemptsLeft
      };
    }
    // auth-url on a fresh or refreshed page (still at `method`) must not show
    // the live method buttons while a Google redirect is in flight, so it
    // moves to a distinct waiting state with a manual fallback link. From
    // google-wait the component itself auto-redirects, so state is unchanged.
    if (s.status === 'auth-url' && state.kind === 'method') {
      return { kind: 'auth-pending', url: s.url };
    }
    // awaiting-method and auth-url (from any other state) never regress the ui.
    return state;
  }

  switch (event.type) {
    case 'choose-google':
      return state.kind === 'method' ? { kind: 'google-wait' } : state;
    case 'choose-email':
      return state.kind === 'method' ? { kind: 'email-entry' } : state;
    case 'submit-email':
      return state.kind === 'email-entry' ? { kind: 'email-wait', email: event.email } : state;
    case 'submit-otp':
      return state.kind === 'otp-entry' ? { kind: 'otp-wait', email: state.email } : state;
    case 'back':
      return state.kind === 'email-entry' ? { kind: 'method' } : state;
    case 'relay-return':
      return state.kind === 'method' ? { kind: 'auth-pending' } : state;
  }
}
