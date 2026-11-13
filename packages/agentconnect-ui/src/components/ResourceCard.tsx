import { ExternalLink } from 'lucide-react';

import { Card } from '@polygonlabs/design-system';

interface ResourceCardProps {
  title: string;
  description: string;
  href: string;
}

export function ResourceCard({ title, description, href }: ResourceCardProps) {
  return (
    <Card
      variant="outline"
      clickable
      render={<a href={href} target="_blank" rel="noopener noreferrer" />}
      className="flex items-start justify-between gap-2 pr-4 text-primary"
    >
      <span className="flex min-w-0 flex-col gap-3">
        <span className="text-2xl font-bold">{title}</span>
        <span className="text-base font-medium text-muted">{description}</span>
      </span>
      <ExternalLink className="size-6 shrink-0 stroke-[1.5]" aria-hidden />
    </Card>
  );
}
