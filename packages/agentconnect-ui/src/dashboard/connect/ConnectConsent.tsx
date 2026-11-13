import type { LucideIcon } from 'lucide-react';

import { Button } from '@polygonlabs/design-system';

import { LoginHeading } from '../../login/LoginHeading.js';
import { PermissionList } from './PermissionList.js';
import { SpendingLimit } from './SpendingLimit.js';

interface ConnectConsentProps {
  name: string;
  midName: string;
  email: string | null;
  permissions: { icon: LucideIcon; text: string }[];
  spending?: { minUsd: number; maxUsd: number; maxDays: number };
  allowanceUsd: number;
  days: number;
  busy: boolean;
  amountValid: boolean;
  setAllowanceUsd: (n: number) => void;
  setDays: (n: number) => void;
  onDecide: (allow: boolean) => void;
}

export function ConnectConsent({
  name,
  midName,
  email,
  permissions,
  spending,
  allowanceUsd,
  days,
  busy,
  amountValid,
  setAllowanceUsd,
  setDays,
  onDecide
}: ConnectConsentProps) {
  return (
    <>
      <LoginHeading title={`Allow ${midName} to use your wallet?`}>
        {email && <p className="m-0 text-sm text-muted">Signed in as {email}</p>}
      </LoginHeading>
      <PermissionList permissions={permissions} />
      {spending && (
        <SpendingLimit
          spending={spending}
          allowanceUsd={allowanceUsd}
          days={days}
          busy={busy}
          amountValid={amountValid}
          setAllowanceUsd={setAllowanceUsd}
          setDays={setDays}
        />
      )}
      <span className="text-sm leading-snug text-muted">
        {spending
          ? `${name} spends from your agent wallet, never past this limit. Disconnect it anytime in Settings to stop it.`
          : `Disconnect ${midName} anytime in Settings.`}
      </span>
      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          disabled={busy}
          onClick={() => onDecide(false)}
          className="justify-center"
        >
          Don&apos;t allow
        </Button>
        <Button
          type="button"
          size="lg"
          disabled={busy || !amountValid}
          onClick={() => onDecide(true)}
          className="justify-center"
        >
          {busy ? (spending ? 'Approving…' : 'Connecting…') : 'Allow'}
        </Button>
      </div>
    </>
  );
}
