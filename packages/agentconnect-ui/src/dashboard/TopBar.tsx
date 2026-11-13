import type { ReactNode } from 'react';

import { Menu } from 'lucide-react';

import { Button, useSidebar } from '@polygonlabs/design-system';

import { LogoBadge } from '../App.js';

interface TopBarProps {
  profile: ReactNode;
}

export function TopBar({ profile }: TopBarProps) {
  const { setOpenMobile } = useSidebar();
  return (
    <header className="relative flex h-16 shrink-0 items-center justify-between border-b border-border-normal bg-background-primary px-4 md:px-8">
      <Button
        variant="ghost"
        iconOnly
        className="size-9 md:hidden [&_svg]:size-6!"
        aria-label="Open menu"
        onClick={() => setOpenMobile(true)}
      >
        <Menu className="stroke-[1.5]" />
      </Button>
      <div className="absolute left-1/2 -translate-x-1/2 md:static md:translate-x-0">
        <LogoBadge />
      </div>
      {profile}
    </header>
  );
}
