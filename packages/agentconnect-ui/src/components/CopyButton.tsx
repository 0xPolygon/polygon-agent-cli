import { Copy } from 'lucide-react';

import { Button, cn } from '@polygonlabs/design-system';

interface CopyButtonProps {
  copied: boolean;
  onClick: () => void;
  label?: string;
  size?: 'lg' | 'default';
  className?: string;
}

export function CopyButton({
  copied,
  onClick,
  label = 'Copy',
  size = 'lg',
  className
}: CopyButtonProps) {
  return (
    <Button
      type="button"
      variant="secondary"
      size={size}
      onClick={onClick}
      className={cn('justify-center', className)}
    >
      {size === 'lg' && <Copy />}
      {copied ? 'Copied' : label}
    </Button>
  );
}
