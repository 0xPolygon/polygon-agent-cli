import { SignInArt } from './SignInArt.js';
import { SignInForm } from './SignInForm.js';

interface OnboardingProps {
  finishing?: boolean;
}

/** Shown when the page is opened without a wallet; `finishing` is set on the Google return to `/login`. */
export function Onboarding({ finishing = false }: OnboardingProps) {
  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-gradient-to-r from-purple-100 to-purple-50 text-primary md:grid md:grid-cols-2 md:overflow-visible md:bg-none md:bg-white">
      <SignInArt />
      <div className="relative flex flex-1 items-center justify-center px-4 pt-[179px] pb-4 md:min-h-[100dvh] md:py-4">
        <div className="w-full max-w-[400px]">
          <SignInForm finishing={finishing} onSignedIn={() => window.location.assign('/')} />
        </div>
      </div>
    </div>
  );
}
