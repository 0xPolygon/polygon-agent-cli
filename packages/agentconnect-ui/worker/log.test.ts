import { afterEach, describe, expect, it, vi } from 'vitest';

import { logError, logWarn } from './log.ts';
import { MoneyError } from './money/errors.ts';

function captured(spy: { mock: { calls: unknown[][] } }) {
  expect(spy.mock.calls).toHaveLength(1);
  return JSON.parse(String(spy.mock.calls[0]?.[0]));
}

afterEach(() => vi.restoreAllMocks());

describe('worker log helper', () => {
  it('logs an Error as one JSON line with type, message and stack', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError('connect failed', { err: new TypeError('boom'), grantId: 'g1' });
    const out = captured(spy);
    expect(out).toMatchObject({ level: 'error', msg: 'connect failed', grantId: 'g1' });
    expect(out.err).toMatchObject({ type: 'TypeError', message: 'boom' });
    expect(typeof out.err.stack).toBe('string');
    expect(out.err.code).toBeUndefined();
  });

  it('keeps a MoneyError code and its native cause', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cause = new Error('upstream 503');
    logError('money failed', {
      err: new MoneyError({ code: 'upstream_unavailable', message: 'down', cause })
    });
    const { err } = captured(spy);
    expect(err).toMatchObject({ type: 'MoneyError', code: 'upstream_unavailable' });
    expect(err.cause).toMatchObject({ type: 'Error', message: 'upstream 503' });
  });

  it('caps a nested cause chain at depth 5', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let err = new Error('e9');
    for (let i = 8; i >= 0; i--) err = new Error(`e${i}`, { cause: err });
    logError('deep', { err });
    let node = captured(spy).err;
    let depth = 0;
    while (node.cause) {
      node = node.cause;
      depth++;
    }
    expect(depth).toBe(5);
    expect(node.message).toBe('e5');
  });

  it('serialises thrown non-Error values', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logError('string', { err: 'plain' });
    logError('object', { err: { a: 1 } });
    expect(JSON.parse(String(spy.mock.calls[0]?.[0])).err).toEqual({
      type: 'string',
      message: 'plain'
    });
    expect(JSON.parse(String(spy.mock.calls[1]?.[0])).err.type).toBe('object');
  });

  it('logWarn writes level warn through console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logWarn('retrying', { attempt: 2 });
    expect(captured(spy)).toEqual({ level: 'warn', msg: 'retrying', attempt: 2 });
  });
});
