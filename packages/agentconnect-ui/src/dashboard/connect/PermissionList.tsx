import type { LucideIcon } from 'lucide-react';

import { Card } from '@polygonlabs/design-system';

interface PermissionListProps {
  permissions: { icon: LucideIcon; text: string }[];
}

export function PermissionList({ permissions }: PermissionListProps) {
  return (
    <Card variant="outline" className="rounded-2xl px-4 py-1">
      {permissions.map((p) => (
        <div
          key={p.text}
          className="flex items-center gap-3 border-t border-slate-200 py-3.5 text-base first:border-t-0"
        >
          <p.icon aria-hidden="true" className="size-5 shrink-0 text-muted" />
          <span>{p.text}</span>
        </div>
      ))}
    </Card>
  );
}
