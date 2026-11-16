interface ApproveLoadingProps {
  error: string | null;
}

export function ApproveLoading({ error }: ApproveLoadingProps) {
  return <span className="text-center text-base text-muted">{error ? '' : 'Loading…'}</span>;
}
