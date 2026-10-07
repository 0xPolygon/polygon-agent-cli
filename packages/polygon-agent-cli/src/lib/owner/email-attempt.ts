// Saving and restoring the SDK's email sign-in attempt, so the code request
// (step 1) and the code (step 2) can run in separate CLI processes.
//
// startEmailAuth keeps {email, verifier, challenge, sessionLifetimeSeconds} in
// the wallet client's `activeEmailAuthAttempt` field, and completeEmailAuth
// reads it back. TypeScript's `private` is compile-time only, so the field is
// an ordinary property at run time. The SDK is pinned to an exact version, and
// email-attempt.test.ts fails against the real SDK class if the field changes.

import { z } from 'zod';

const FIELD = 'activeEmailAuthAttempt';

export const EmailAttemptSchema = z.object({
  email: z.string(),
  verifier: z.string(),
  challenge: z.string(),
  sessionLifetimeSeconds: z.number()
});
export type EmailAttempt = z.infer<typeof EmailAttemptSchema>;

export function exportEmailAttempt(wallet: object): EmailAttempt {
  const parsed = EmailAttemptSchema.safeParse(Reflect.get(wallet, FIELD));
  if (!parsed.success) {
    throw new Error(
      'Could not save the email sign-in attempt: @polygonlabs/oms-wallet changed how it stores it.'
    );
  }
  return parsed.data;
}

export function restoreEmailAttempt(params: { wallet: object; attempt: EmailAttempt }): void {
  Reflect.set(params.wallet, FIELD, { ...params.attempt });
}
