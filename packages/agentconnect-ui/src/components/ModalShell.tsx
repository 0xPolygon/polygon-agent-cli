import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@polygonlabs/design-system';

interface ModalShellProps {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  onClose: () => void;
  children: ReactNode;
  // Pinned below the scrolling content so it stays reachable in short windows.
  action: ReactNode;
}

export function ModalShell({
  icon: Icon,
  title,
  description,
  onClose,
  children,
  action
}: ModalShellProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        responsive
        className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-5 overflow-hidden sm:max-w-[400px]"
      >
        <DialogHeader className="items-center gap-1 pt-1 text-center sm:text-center">
          <Icon aria-hidden="true" className="size-8 stroke-1 text-link" />
          <DialogTitle className="text-[28px] leading-[1.2]">{title}</DialogTitle>
          <DialogDescription className="text-base font-bold text-muted">
            {description}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">{children}</div>
        {action}
      </DialogContent>
    </Dialog>
  );
}
