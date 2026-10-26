import { describe, expect, it } from 'vitest';

import type { KeyStorage } from './agent-key.ts';

import {
  ACTION_TTL_MS,
  beginOwnerAction,
  decideAction,
  endOwnerAction,
  loadAction,
  proposeAction
} from './actions.ts';
import { MoneyError } from './errors.ts';
import { START } from './test-fakes.ts';

function memory(): KeyStorage {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => data.get(k) as T | undefined,
    put: async (k, v) => void data.set(k, structuredClone(v)),
    list: async <T>() => new Map() as Map<string, T>,
    deleteAll: async () => data.clear()
  };
}

const propose = (storage: KeyStorage) =>
  proposeAction({
    storage,
    request: { op: 'send' },
    title: 'Send 5 USDC',
    details: [],
    appName: 'ChatGPT',
    now: START
  });

describe('actions the owner approves', () => {
  it('runs an approved request exactly once', async () => {
    const storage = memory();
    const action = await propose(storage);
    let runs = 0;
    const decide = () =>
      decideAction({
        storage,
        id: action.id,
        approve: true,
        run: async () => {
          runs++;
          return { txHash: '0xabc' };
        },
        now: () => START
      });
    expect(await decide()).toMatchObject({ status: 'done', result: { txHash: '0xabc' } });
    await expect(decide()).rejects.toThrow(MoneyError);
    expect(runs).toBe(1);
  });

  it('never runs a declined request', async () => {
    const storage = memory();
    const action = await propose(storage);
    const declined = await decideAction({
      storage,
      id: action.id,
      approve: false,
      run: async () => {
        throw new Error('ran');
      },
      now: () => START
    });
    expect(declined.status).toBe('declined');
  });

  it('records a failure the agent can read, and keeps it failed', async () => {
    const storage = memory();
    const action = await propose(storage);
    const failed = await decideAction({
      storage,
      id: action.id,
      approve: true,
      run: async () => {
        throw new MoneyError({ code: 'insufficient_balance', message: 'Not enough USDC.' });
      },
      now: () => START
    });
    expect(failed).toMatchObject({
      status: 'failed',
      error: { code: 'insufficient_balance', error: 'Not enough USDC.' }
    });
  });

  it('expires after fifteen minutes', async () => {
    const storage = memory();
    const action = await propose(storage);
    const later = new Date(START.getTime() + ACTION_TTL_MS + 1);
    expect((await loadAction(storage, action.id, later)).status).toBe('expired');
    await expect(
      decideAction({ storage, id: action.id, approve: true, run: async () => 1, now: () => later })
    ).rejects.toThrow(/expired/);
  });
});

describe('actions that run from the owner wallet', () => {
  const owner = { chainId: 747474, transactions: [{ to: '0x01', data: '0x' }] };

  it("can't be approved without signing in, only declined", async () => {
    const storage = memory();
    const action = await proposeAction({
      storage,
      request: { op: 'earn_deposit' },
      title: 'Deposit',
      details: [],
      appName: 'Claude',
      owner,
      now: START
    });
    await expect(
      decideAction({ storage, id: action.id, approve: true, run: async () => 1, now: () => START })
    ).rejects.toThrow(/sign in/);
    expect(
      (
        await decideAction({
          storage,
          id: action.id,
          approve: false,
          run: async () => 1,
          now: () => START
        })
      ).status
    ).toBe('declined');
  });

  it('hands its transactions over once, then records the outcome', async () => {
    const storage = memory();
    const action = await proposeAction({
      storage,
      request: { op: 'earn_deposit' },
      title: 'Deposit',
      details: [],
      appName: 'Claude',
      owner,
      now: START
    });
    expect(await beginOwnerAction(storage, action.id, START)).toEqual(owner);
    await expect(beginOwnerAction(storage, action.id, START)).rejects.toThrow(/already/);
    const ended = await endOwnerAction(
      storage,
      action.id,
      { result: { txHashes: ['0x1'] } },
      START
    );
    expect(ended).toMatchObject({ status: 'done', result: { txHashes: ['0x1'] } });
  });
});
