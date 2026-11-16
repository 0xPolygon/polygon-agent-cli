import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@polygonlabs/design-system';

interface EmptyNoticeProps {
  title: string;
  children?: React.ReactNode;
}

export function EmptyNotice({ title, children }: EmptyNoticeProps) {
  return (
    <Empty className="border-0 bg-transparent p-0 py-8 md:p-0 md:py-8 gap-1.5">
      <EmptyHeader className="gap-1.5">
        <EmptyTitle className="text-[15px] md:text-[15px]">{title}</EmptyTitle>
        {children && (
          <EmptyDescription className="text-[13px] md:text-[13px]">{children}</EmptyDescription>
        )}
      </EmptyHeader>
    </Empty>
  );
}
