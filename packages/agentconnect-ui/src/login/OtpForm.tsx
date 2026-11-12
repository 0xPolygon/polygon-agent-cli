import { useState } from 'react';

import { Button, Input, Label } from '@polygonlabs/design-system';

import { LoginHeading } from './LoginHeading.js';

interface OtpFormProps {
  invalid?: boolean;
  attemptsLeft?: number;
  onSubmit: (code: string) => void;
}

export function OtpForm({ invalid, attemptsLeft, onSubmit }: OtpFormProps) {
  const [code, setCode] = useState('');
  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim().length >= 4) onSubmit(code.trim());
      }}
    >
      <LoginHeading title="Enter your code">
        <p className="m-0 text-sm text-muted">We sent a one-time code to your email.</p>
        {invalid && (
          <p role="alert" className="m-0 text-sm font-medium text-destructive">
            That code didn't work
            {typeof attemptsLeft === 'number' ? ` (${attemptsLeft} attempts left)` : ''}. Try again.
          </p>
        )}
      </LoginHeading>
      <div className="flex flex-col gap-3">
        <Label htmlFor="login-code" className="sr-only">
          One-time code
        </Label>
        <Input
          id="login-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456"
          className="text-center text-lg tracking-widest"
        />
        <Button type="submit" size="lg" className="w-full justify-center">
          Verify
        </Button>
      </div>
    </form>
  );
}
