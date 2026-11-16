import { Button, Input, Label } from '@polygonlabs/design-system';

interface CodeStepProps {
  email: string;
  code: string;
  busy: boolean;
  onCodeChange: (code: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}

export function CodeStep({ email, code, busy, onCodeChange, onSubmit, onBack }: CodeStepProps) {
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
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
        onChange={(e) => onCodeChange(e.target.value)}
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
        onClick={onBack}
        className="w-full justify-center text-muted"
      >
        Use a different email
      </Button>
    </form>
  );
}
