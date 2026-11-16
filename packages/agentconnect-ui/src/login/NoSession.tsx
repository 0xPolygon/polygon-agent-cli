import { LoginCommand } from './LoginCommand.js';
import { LoginHeading } from './LoginHeading.js';

export function NoSession() {
  return (
    <LoginHeading title="No login session">
      <p className="m-0 text-sm text-muted">
        Open this page from the polygon-agent CLI: run <LoginCommand /> in your terminal.
      </p>
    </LoginHeading>
  );
}
