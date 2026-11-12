import { Card, Skeleton } from '@polygonlabs/design-system';

export function VaultCardSkeleton() {
  return (
    <Card variant="outline" className="flex flex-col gap-4 p-6">
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-10 w-1/2" />
      <Skeleton className="h-10 w-full" />
    </Card>
  );
}
