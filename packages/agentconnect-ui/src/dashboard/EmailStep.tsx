import { Button, Input, Label } from '@polygonlabs/design-system';

interface EmailStepProps {
  email: string;
  busy: boolean;
  onEmailChange: (email: string) => void;
  onSubmit: () => void;
}

export function EmailStep({ email, busy, onEmailChange, onSubmit }: EmailStepProps) {
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
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
        onChange={(e) => onEmailChange(e.target.value)}
        placeholder="you@example.com"
        className="text-base sm:text-sm"
      />
      <Button type="submit" size="lg" disabled={busy} className="w-full justify-center">
        {busy ? 'Sending code…' : 'Continue with email'}
      </Button>
    </form>
  );
}
