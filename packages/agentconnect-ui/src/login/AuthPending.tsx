import { Spinner, buttonVariants, cn } from '@polygonlabs/design-system';

interface AuthPendingProps {
  url?: string;
}

export function AuthPending({ url }: AuthPendingProps) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <Spinner size="xl" />
      <p className="m-0 text-sm text-muted">Finishing sign in</p>
      {url && (
        <a href={url} className={cn(buttonVariants({ variant: 'link' }), 'underline')}>
          Not redirected? Continue with Google
        </a>
      )}
    </div>
  );
}
