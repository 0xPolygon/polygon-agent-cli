import { Bot } from 'lucide-react';

export function SignInHeading() {
  return (
    <div className="flex flex-col items-center gap-4">
      <Bot aria-hidden="true" className="size-6 stroke-1 text-link" />
      <div className="flex w-full flex-col gap-3">
        <h1 className="m-0 text-center text-[28px] leading-[1.2] font-bold text-black">
          A wallet for your agent
        </h1>
        <p className="m-0 text-sm leading-[1.2] font-medium text-muted">
          Add your details once. Then let any agent you use shop, predict, and earn for you, within
          a limit you set.
        </p>
      </div>
    </div>
  );
}
