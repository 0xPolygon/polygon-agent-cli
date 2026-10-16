import { describe, expect, it } from 'vitest';

import { WalletLock } from './wallet-lock.ts';

// Durable Object storage, with every call taking a turn of the event loop.
function storage() {
  const data = new Map<string, number>();
  let alarm: number | null = null;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    data,
    get alarm() {
      return alarm;
    },
    get: async <T>(k: string) => (await tick(), data.get(k) as T | undefined),
    put: async <T>(k: string, v: T) => void (await tick(), data.set(k, v as number)),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...data].filter(([k]) => k.startsWith(prefix))) as Map<string, T>,
    delete: async (keys: string[]) => keys.filter((k) => data.delete(k)).length,
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => void (alarm = t)
  };
}

const claim = (lock: WalletLock, key: string) =>
  lock
    .fetch(
      new Request('https://wallet-lock/claim', { method: 'POST', body: JSON.stringify({ key }) })
    )
    .then((r) => r.json() as Promise<{ claimed: boolean }>);

describe('WalletLock', () => {
  it('gives a key to exactly one of many requests at the same moment', async () => {
    const lock = new WalletLock({ storage: storage() });
    const results = await Promise.all(Array.from({ length: 5 }, () => claim(lock, 'approval:a')));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it('keeps keys apart', async () => {
    const lock = new WalletLock({ storage: storage() });
    expect(await claim(lock, 'approval:a')).toEqual({ claimed: true });
    expect(await claim(lock, 'quote:a')).toEqual({ claimed: true });
  });

  it('answers only POST /claim with a key', async () => {
    const lock = new WalletLock({ storage: storage() });
    expect((await lock.fetch(new Request('https://wallet-lock/claim'))).status).toBe(404);
    const noKey = new Request('https://wallet-lock/claim', { method: 'POST', body: '{}' });
    expect((await lock.fetch(noKey)).status).toBe(400);
  });

  it('forgets claims after a week', async () => {
    const s = storage();
    const lock = new WalletLock({ storage: s });
    await claim(lock, 'approval:old');
    expect(s.alarm).not.toBeNull();
    s.data.set('claim:approval:old', Date.now() - 8 * 24 * 60 * 60 * 1000);
    await claim(lock, 'approval:new');
    await lock.alarm();
    expect([...s.data.keys()]).toEqual(['claim:approval:new']);
  });
});
