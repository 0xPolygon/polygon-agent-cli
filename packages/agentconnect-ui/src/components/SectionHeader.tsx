import type { ReactNode } from 'react';

interface SectionHeaderProps {
  title: string;
  children?: ReactNode;
}

export function SectionHeader({ title, children }: SectionHeaderProps) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <h2 className="text-2xl font-bold">{title}</h2>
      {children}
    </div>
  );
}
