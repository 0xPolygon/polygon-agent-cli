import { useState } from 'react';

import { Button, Input, Label } from '@polygonlabs/design-system';

import { LoginHeading } from './LoginHeading.js';

interface EmailFormProps {
  onSubmit: (email: string) => void;
  onBack: () => void;
}

export function EmailForm({ onSubmit, onBack }: EmailFormProps) {
  const [email, setEmail] = useState('');
  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (email.includes('@')) onSubmit(email.trim());
      }}
    >
      <LoginHeading title="Sign in with email" />
      <div className="flex flex-col gap-3">
        <Label htmlFor="login-email" className="sr-only">
          Email
        </Label>
        <Input
          id="login-email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="text-base sm:text-sm"
        />
        <Button type="submit" size="lg" className="w-full justify-center">
          Send code
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="lg"
          onClick={onBack}
          className="w-full justify-center text-muted"
        >
          Back
        </Button>
      </div>
    </form>
  );
}
