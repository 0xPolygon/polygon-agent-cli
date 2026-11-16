import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOAD_LIMIT_MS, runLoad } from './runLoad.js';

describe('runLoad', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const start = (load: () => Promise<number>) => {
    const onDone = vi.fn();
    const onFail = vi.fn();
    const cancel = runLoad({ load, onDone, onFail });
    return { onDone, onFail, cancel };
  };

  it('fails a load that never answers once the limit passes', async () => {
    const { onDone, onFail } = start(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(LOAD_LIMIT_MS - 1);
    expect(onFail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('delivers a result that arrives inside the limit and leaves no timer behind', async () => {
    const { onDone, onFail } = start(
      () => new Promise((resolve) => setTimeout(() => resolve(7), LOAD_LIMIT_MS - 1000))
    );
    await vi.advanceTimersByTimeAsync(LOAD_LIMIT_MS - 1000);
    expect(onDone).toHaveBeenCalledWith(7);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LOAD_LIMIT_MS);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('ignores a result that arrives after the limit', async () => {
    let resolve: (n: number) => void = () => {};
    const { onDone, onFail } = start(() => new Promise<number>((r) => (resolve = r)));
    await vi.advanceTimersByTimeAsync(LOAD_LIMIT_MS);
    resolve(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reports a rejection as a failure', async () => {
    const boom = new Error('boom');
    const { onFail } = start(() => Promise.reject(boom));
    await vi.advanceTimersByTimeAsync(0);
    expect(onFail).toHaveBeenCalledWith(boom);
  });

  it('writes nothing and holds no timer once cancelled', async () => {
    let resolve: (n: number) => void = () => {};
    const { onDone, onFail, cancel } = start(() => new Promise<number>((r) => (resolve = r)));
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    resolve(7);
    await vi.advanceTimersByTimeAsync(LOAD_LIMIT_MS);
    expect(onDone).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });
});
