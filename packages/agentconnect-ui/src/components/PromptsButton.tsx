import { Bot } from 'lucide-react';

import { Button } from '@polygonlabs/design-system';

interface PromptsButtonProps {
  onClick: () => void;
}

export function PromptsButton({ onClick }: PromptsButtonProps) {
  return (
    <Button
      type="button"
      variant="secondary"
      iconOnly
      aria-label="Agent prompts"
      onClick={onClick}
      className="size-8 shrink-0"
    >
      <Bot />
    </Button>
  );
}
