import type { FormEvent } from 'react';

import { LoginHeading } from '../../login/LoginHeading.js';
import { ConnectCodeForm } from './ConnectCodeForm.js';
import { ConnectEmailForm } from './ConnectEmailForm.js';
import { ConnectGoogleButton } from './ConnectGoogleButton.js';

interface ConnectSignInProps {
  midName: string;
  asksToSpend: boolean;
  sent: boolean;
  email: string;
  code: string;
  busy: boolean;
  setEmail: (v: string) => void;
  setCode: (v: string) => void;
  onEmailSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCodeSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onGoogle: () => void;
}

export function ConnectSignIn({
  midName,
  asksToSpend,
  sent,
  email,
  code,
  busy,
  setEmail,
  setCode,
  onEmailSubmit,
  onCodeSubmit,
  onGoogle
}: ConnectSignInProps) {
  return (
    <>
      <LoginHeading title={`Connect ${midName} to your wallet`}>
        <p className="m-0 text-sm leading-snug text-muted">
          {asksToSpend
            ? 'Sign in, then choose how much it can spend.'
            : 'Sign in, then choose what it can do.'}
        </p>
      </LoginHeading>
      {!sent ? (
        <ConnectEmailForm email={email} busy={busy} setEmail={setEmail} onSubmit={onEmailSubmit} />
      ) : (
        <ConnectCodeForm
          email={email}
          code={code}
          busy={busy}
          setCode={setCode}
          onSubmit={onCodeSubmit}
        />
      )}
      {!sent && <ConnectGoogleButton busy={busy} onClick={onGoogle} />}
    </>
  );
}
