import { Button } from '@polygonlabs/design-system';

import { GoogleIcon } from '../dashboard/GoogleIcon.js';
import { LoginHeading } from './LoginHeading.js';

interface MethodChoiceProps {
  line: string;
  onGoogle: () => void;
  onEmail: () => void;
}

export function MethodChoice({ line, onGoogle, onEmail }: MethodChoiceProps) {
  return (
    <div className="flex flex-col gap-8">
      <LoginHeading title="Sign in to your agent wallet">
        <p className="m-0 text-sm text-muted">{line}</p>
      </LoginHeading>
      <div className="flex flex-col gap-3">
        <Button type="button" size="lg" onClick={onGoogle} className="w-full justify-center">
          <GoogleIcon />
          Continue with Google
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onEmail}
          className="w-full justify-center border-slate-500"
        >
          Continue with email
        </Button>
      </div>
    </div>
  );
}
