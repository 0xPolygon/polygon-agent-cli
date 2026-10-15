// Guards the email sign-in save/restore against the real SDK class: if
// @polygonlabs/oms-wallet changes how it keeps the attempt, this fails.

import { createHash, randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EthereumPrivateKeyCredentialSigner,
  MemoryStorageManager,
  OMSWallet
} from '@polygonlabs/oms-wallet';

import { upstreamErrorName } from '../errors.ts';
import { DEFAULT_OMS_PUBLISHABLE_KEY } from '../storage.ts';
import { exportEmailAttempt, restoreEmailAttempt } from './email-attempt.ts';

const EMAIL = 'owner@example.com';

function owner(): OMSWallet {
  return new OMSWallet({
    publishableKey: DEFAULT_OMS_PUBLISHABLE_KEY,
    storage: new MemoryStorageManager(),
    credentialSigner: new EthereumPrivateKeyCredentialSigner(randomBytes(32))
  });
}

let completeAuthBodies: unknown[];

beforeEach(() => {
  completeAuthBodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/CommitVerifier')) {
        return Response.json({ verifier: 'verifier-1', challenge: 'challenge-1' });
      }
      if (url.endsWith('/CompleteAuth')) {
        completeAuthBodies.push(JSON.parse(String(init?.body)));
        return Response.json(
          {
            error: 'AnswerIncorrect',
            code: 7003,
            msg: 'The provided answer is incorrect',
            status: 400
          },
          { status: 400 }
        );
      }
      return Response.json({ error: 'unexpected', url }, { status: 500 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('email attempt save/restore (real SDK)', () => {
  it('exports exactly the attempt startEmailAuth stored', async () => {
    const first = owner();
    await first.wallet.startEmailAuth({ email: EMAIL, sessionLifetimeSeconds: 600 });
    expect(exportEmailAttempt(first.wallet)).toEqual({
      email: EMAIL,
      verifier: 'verifier-1',
      challenge: 'challenge-1',
      sessionLifetimeSeconds: 600
    });
  });

  it('lets a fresh client complete the sign-in with the restored attempt', async () => {
    const first = owner();
    await first.wallet.startEmailAuth({ email: EMAIL, sessionLifetimeSeconds: 600 });
    const attempt = JSON.parse(JSON.stringify(exportEmailAttempt(first.wallet)));

    const second = owner();
    restoreEmailAttempt({ wallet: second.wallet, attempt });
    const error = await second.wallet
      .completeEmailAuth({ code: '123456', walletSelection: 'automatic' })
      .catch((e: unknown) => e);

    // The request reached WaaS with the original verifier and the code hashed
    // with the original challenge; WaaS's answer maps to a known error name.
    expect(upstreamErrorName(error)).toBe('AnswerIncorrect');
    const answer = createHash('sha256').update('challenge-1123456').digest('base64url');
    expect(completeAuthBodies).toEqual([
      expect.objectContaining({ verifier: 'verifier-1', answer, lifetime: 600 })
    ]);
  });

  it('without a restored attempt, the SDK refuses to complete', async () => {
    const error = await owner()
      .wallet.completeEmailAuth({ code: '123456', walletSelection: 'automatic' })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/No pending email auth attempt/);
    expect(completeAuthBodies).toEqual([]);
  });

  it('refuses to export when there is no attempt', () => {
    expect(() => exportEmailAttempt(owner().wallet)).toThrow(/changed how it stores it/);
  });
});
