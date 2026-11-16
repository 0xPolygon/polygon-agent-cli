import { Button, Separator } from '@polygonlabs/design-system';

import { GoogleIcon } from './GoogleIcon.js';

interface GoogleSignInProps {
  busy: boolean;
  onClick: () => void;
}

export function GoogleSignIn({ busy, onClick }: GoogleSignInProps) {
  return (
    <>
      <div className="-my-3 flex items-center gap-4 text-xs font-medium text-slate-400">
        <Separator className="flex-1 bg-slate-400" />
        or
        <Separator className="flex-1 bg-slate-400" />
      </div>
      <Button
        type="button"
        variant="outline"
        size="lg"
        disabled={busy}
        onClick={onClick}
        className="w-full justify-center border-slate-500"
      >
        <GoogleIcon />
        Sign in with Google
      </Button>
    </>
  );
}
