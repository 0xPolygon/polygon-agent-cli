import { Progress } from '@polygonlabs/design-system';

const SPENT_SHARE = 20;

// Static illustration of the dashboard, not the visitor's data.
export function SignInArt() {
  return (
    <div
      aria-hidden="true"
      className="contents md:relative md:order-2 md:my-[67px] md:mr-14 md:block md:overflow-hidden md:rounded-3xl md:bg-gradient-to-r md:from-purple-100 md:to-purple-50"
    >
      <img
        src="/signin-art.webp"
        alt=""
        width={1024}
        height={1024}
        className="pointer-events-none absolute top-[71px] left-[-129px] h-[756px] w-[704px] max-w-none object-cover md:top-[-10px] md:left-[167px] md:h-[763px] md:w-[711px]"
      />
      <div className="order-1 mx-4 mb-[26px] flex flex-col gap-4 md:absolute md:inset-x-auto md:bottom-16 md:left-[76px] md:m-0 md:w-[313px] md:max-w-[calc(100%-96px)]">
        <div className="flex flex-col gap-3">
          <span className="text-lg leading-[1.2] font-medium text-purple-400 [text-box:trim-both_cap_alphabetic]">
            Balance
          </span>
          <span className="text-6xl leading-[1.1] font-bold text-link">$245.72</span>
        </div>
        <Progress
          value={SPENT_SHARE}
          className="gap-3"
          trackClassName="bg-purple-200"
          indicatorClassName="bg-link"
        >
          <div className="flex w-full items-center justify-between text-sm leading-[1.2] font-medium">
            <span className="text-purple-400 [text-box:trim-both_cap_alphabetic]">
              Spending limit
            </span>
            <span className="text-link [text-box:trim-both_cap_alphabetic]">
              $5.28 of $200 today
            </span>
          </div>
        </Progress>
      </div>
    </div>
  );
}
