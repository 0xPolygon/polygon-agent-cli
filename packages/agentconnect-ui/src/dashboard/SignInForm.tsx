import { useEffect, useState } from 'react';

import { Button, Input, Label, Separator } from '@polygonlabs/design-system';

import { GoogleIcon } from './GoogleIcon.js';
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

  useEffect(() => {
    if (finishing) void run(async () => onSignedIn(await finishGoogle()));
  }, [finishing]);

  return (
    <div className="flex flex-col gap-8 rounded-3xl bg-white px-7 py-8">
      <SignInHeading />

      {finishing && busy ? (
        <span className="text-center text-base text-muted">Signing you in…</span>
      ) : !sent ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await startEmail(email.trim());
              setSent(true);
            });
          }}
        >
          <Label htmlFor="email" className="sr-only">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="text-base sm:text-sm"
          />
          <Button type="submit" size="lg" disabled={busy} className="w-full justify-center">
            {busy ? 'Sending code…' : 'Continue with email'}
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => onSignedIn(await finishEmail(code.trim())));
          }}
        >
          <Label htmlFor="code" className="block text-sm font-medium break-words text-muted">
            Enter the code we sent to {email}
          </Label>
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            className="text-base tracking-[0.2em] sm:text-sm"
          />
          <Button type="submit" size="lg" disabled={busy} className="w-full justify-center">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            onClick={() => {
              setSent(false);
              setCode('');
            }}
            className="w-full justify-center text-muted"
          >
            Use a different email
          </Button>
        </form>
      )}

      {!sent && !(finishing && busy) && (
        <>
          <div className="-my-3 flex items-center gap-4 text-xs font-medium text-slate-400">
            <Separator className="flex-1 bg-slate-400" />
            or
            <Separator className="flex-1 bg-slate-400" />
          </div>
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={busy}
            onClick={() => void run(startGoogle)}
            className="w-full justify-center border-slate-500"
          >
            <GoogleIcon />
            Sign in with Google
          </Button>
        </>
      )}

      {error && (
        <span role="alert" className="text-center text-sm font-medium text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
