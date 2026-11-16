import { Copy } from 'lucide-react';

import { Button, cn } from '@polygonlabs/design-system';

interface CopyButtonProps {
  copied: boolean;
  onClick: () => void;
  label?: string;
  size?: 'lg' | 'default';
  variant?: 'default' | 'secondary';
  className?: string;
}

export function CopyButton({
  copied,
  onClick,
  label = 'Copy',
  size = 'lg',
  variant = 'secondary',
  className
}: CopyButtonProps) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={onClick}
      className={cn('justify-center', className)}
    >
      {size === 'lg' && <Copy />}
      {copied ? 'Copied' : label}
    </Button>
  );
}
