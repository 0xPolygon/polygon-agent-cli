import type { ReactNode } from 'react';

interface ErrorNoteProps {
  children: ReactNode;
}

export function ErrorNote({ children }: ErrorNoteProps) {
  return (
    <span role="alert" className="text-center text-sm font-medium text-destructive">
      {children}
    </span>
  );
}
