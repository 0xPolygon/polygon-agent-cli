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
  | { type: 'back' };

export const initialState: MachineState = { kind: 'method' };

function emailOf(state: MachineState): string {
  return 'email' in state ? state.email : '';
}

export function reduce(state: MachineState, event: MachineEvent): MachineState {
  if (event.type === 'status') {
    const s = event.status;
    // Terminal statuses win from anywhere.
    if (s.status === 'expired') return { kind: 'expired' };
    if (s.status === 'error') return { kind: 'failed', message: s.message };
    if (s.status === 'done') return { kind: 'success', walletAddress: s.walletAddress };
    // otp-sent snaps forward (also reconciles a refreshed page).
    if (s.status === 'otp-sent') {
      if (state.kind === 'otp-entry' || state.kind === 'otp-wait') return state;
      return { kind: 'otp-entry', email: emailOf(state) };
    }
    if (s.status === 'otp-invalid' && state.kind === 'otp-wait') {
      return { kind: 'otp-entry', email: state.email, invalid: true, attemptsLeft: s.attemptsLeft };
    }
    // awaiting-method and auth-url never regress the ui.
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
  }
}
