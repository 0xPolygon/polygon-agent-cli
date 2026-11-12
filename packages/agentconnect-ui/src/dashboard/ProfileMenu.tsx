import { CircleUserRound, LogOut, Settings, X } from 'lucide-react';

import {
  Button,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Separator
} from '@polygonlabs/design-system';

interface ProfileMenuProps {
  label: string;
  balance: string;
  onSettings: () => void;
  // Absent when nobody is signed in here, so there is nothing to sign out of.
  onSignOut?: () => void;
}

export function ProfileMenu({ label, balance, onSettings, onSignOut }: ProfileMenuProps) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Account"
        className="flex cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent p-0 text-left"
      >
        <CircleUserRound className="size-6 shrink-0 stroke-[1.5] md:size-7 md:stroke-[0.86]" />
        <span className="hidden max-w-[180px] flex-col gap-2 md:flex">
          <span className="truncate text-sm font-bold text-primary">{label}</span>
          <span className="text-xs font-medium text-muted">{balance}</span>
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={18}
        className="w-[370px] max-w-[calc(100vw-2rem)] p-6"
      >
        <PopoverClose
          aria-label="Close"
          className="absolute right-5 top-5 cursor-pointer border-0 bg-transparent p-0 text-primary"
        >
          <X className="size-4" />
        </PopoverClose>
        <div className="flex items-center gap-3 pr-6">
          <CircleUserRound className="size-11 shrink-0 stroke-1" />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-lg font-bold text-primary">{label}</span>
            <span className="text-sm font-medium text-muted">{balance}</span>
          </div>
        </div>
        <Separator className="my-4" />
        <div className="flex flex-col gap-4">
          <PopoverClose
            render={
              <Button variant="ghost" className="justify-start font-medium" onClick={onSettings}>
                <Settings />
                Settings
              </Button>
            }
          />
          {onSignOut && (
            <PopoverClose
              render={
                <Button variant="ghost" className="justify-start font-medium" onClick={onSignOut}>
                  <LogOut />
                  Sign out
                </Button>
              }
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
