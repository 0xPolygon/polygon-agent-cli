import { CircleHelp } from 'lucide-react';

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@polygonlabs/design-system';

interface EmptyStateProps {
  title: string;
  children?: React.ReactNode;
}

export function EmptyState({ title, children }: EmptyStateProps) {
  return (
    <Empty className="gap-0 rounded-3xl bg-transparent p-6 md:p-6">
      <EmptyHeader className="gap-1">
        <EmptyMedia variant="icon">
          <CircleHelp className="size-8 stroke-1" />
        </EmptyMedia>
        <EmptyTitle className="text-xl text-muted md:text-xl">{title}</EmptyTitle>
        {children && (
          <EmptyDescription className="text-sm text-slate-400 md:text-sm">
            {children}
          </EmptyDescription>
        )}
      </EmptyHeader>
    </Empty>
  );
}
