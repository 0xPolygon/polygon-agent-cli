import type { FormEvent } from 'react';

import { Button, Input, Label } from '@polygonlabs/design-system';

interface ConnectCodeFormProps {
  email: string;
  code: string;
  busy: boolean;
  setCode: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

export function ConnectCodeForm({ email, code, busy, setCode, onSubmit }: ConnectCodeFormProps) {
  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      <Label htmlFor="code" className="text-muted">
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
        {busy ? 'Signing in…' : 'Continue'}
      </Button>
    </form>
  );
}
