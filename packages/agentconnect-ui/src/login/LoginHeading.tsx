import type { ReactNode } from 'react';

interface LoginHeadingProps {
  title: string;
  children?: ReactNode;
}

export function LoginHeading({ title, children }: LoginHeadingProps) {
  return (
    <div className="flex flex-col gap-3 text-center">
      <h1 className="m-0 text-2xl leading-tight font-bold text-black">{title}</h1>
      {children}
    </div>
  );
}
