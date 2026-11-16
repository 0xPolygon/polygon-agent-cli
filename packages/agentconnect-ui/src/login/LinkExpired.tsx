import { LoginCommand } from './LoginCommand.js';
import { LoginHeading } from './LoginHeading.js';

export function LinkExpired() {
  return (
    <LoginHeading title="This link has expired">
      <p className="m-0 text-sm text-muted">
        Run <LoginCommand /> again to get a fresh link.
      </p>
    </LoginHeading>
  );
}
