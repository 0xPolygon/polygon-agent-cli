import { Button, Separator } from '@polygonlabs/design-system';

import { GoogleIcon } from '../GoogleIcon.js';

interface ConnectGoogleButtonProps {
  busy: boolean;
  onClick: () => void;
}

export function ConnectGoogleButton({ busy, onClick }: ConnectGoogleButtonProps) {
  return (
    <>
      <div className="-my-2 flex items-center gap-4 text-xs font-medium text-slate-400">
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
        className="-mt-2 w-full justify-center border-slate-500"
      >
        <GoogleIcon />
        Continue with Google
      </Button>
    </>
  );
}
