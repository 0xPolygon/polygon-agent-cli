import { useEffect, useState } from 'react';

import { CodeStep } from './CodeStep.js';
import { EmailStep } from './EmailStep.js';
import { GoogleSignIn } from './GoogleSignIn.js';
import { finishEmail, finishGoogle, startEmail, startGoogle } from './signin.js';
import { SignInHeading } from './SignInHeading.js';

interface SignInFormProps {
  finishing: boolean;
  onSignedIn: (wallet: string) => void;
}

export function SignInForm({ finishing, onSignedIn }: SignInFormProps) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(finishing);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const step = finishing && busy ? 'finishing' : sent ? 'code' : 'email';

  useEffect(() => {
    if (finishing) void run(async () => onSignedIn(await finishGoogle()));
  }, [finishing]);

  return (
    <div className="flex flex-col gap-8 rounded-3xl bg-white px-7 py-8">
      <SignInHeading />

      {step === 'finishing' && (
        <span className="text-center text-base text-muted">Signing you in…</span>
      )}
      {step === 'email' && (
        <EmailStep
          email={email}
          busy={busy}
          onEmailChange={setEmail}
          onSubmit={() =>
            void run(async () => {
              await startEmail(email.trim());
              setSent(true);
            })
          }
        />
      )}
      {step === 'code' && (
        <CodeStep
          email={email}
          code={code}
          busy={busy}
          onCodeChange={setCode}
          onSubmit={() => void run(async () => onSignedIn(await finishEmail(code.trim())))}
          onBack={() => {
            setSent(false);
            setCode('');
          }}
        />
      )}

      {step === 'email' && <GoogleSignIn busy={busy} onClick={() => void run(startGoogle)} />}

      {error && (
        <span role="alert" className="text-center text-sm font-medium text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
