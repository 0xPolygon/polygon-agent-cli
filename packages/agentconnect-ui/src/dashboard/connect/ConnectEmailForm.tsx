import type { FormEvent } from 'react';

import { Button, Input, Label } from '@polygonlabs/design-system';

interface ConnectEmailFormProps {
  email: string;
  busy: boolean;
  setEmail: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

export function ConnectEmailForm({ email, busy, setEmail, onSubmit }: ConnectEmailFormProps) {
  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      <Label htmlFor="email" className="text-muted">
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
  );
}
