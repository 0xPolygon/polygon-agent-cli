interface ConnectLoadingProps {
  finishing: boolean;
}

export function ConnectLoading({ finishing }: ConnectLoadingProps) {
  return (
    <span className="text-center text-base text-muted">
      {finishing ? 'Signing you in…' : 'Loading…'}
    </span>
  );
}
