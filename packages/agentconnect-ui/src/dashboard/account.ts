// The owner's email, remembered per wallet in this browser. Sign-in on the
// onboarding page and the agent's dashboard link both record it; the sidebar
// shows it in place of the wallet address.

const key = (wallet: string) => `agentconnect_email_${wallet.toLowerCase()}`;

export function rememberEmail(wallet: string, email: string | null | undefined): void {
  if (!email) return;
  try {
    localStorage.setItem(key(wallet), email);
  } catch {
    // Private mode: the sidebar falls back to a generic label.
  }
}

export function rememberedEmail(wallet: string): string | null {
  try {
    return localStorage.getItem(key(wallet));
  } catch {
    return null;
  }
}
