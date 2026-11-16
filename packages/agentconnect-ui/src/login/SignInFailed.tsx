import { LoginHeading } from './LoginHeading.js';

interface SignInFailedProps {
  message: string;
}

export function SignInFailed({ message }: SignInFailedProps) {
  return (
    <LoginHeading title="Sign in failed">
      <p className="m-0 text-sm text-muted">{message}</p>
      <p className="m-0 text-sm text-muted">
        Check your terminal for details and re-run the login.
      </p>
    </LoginHeading>
  );
}
