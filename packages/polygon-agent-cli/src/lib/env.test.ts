import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEnv, resetEnv } from './env.ts';
import { CliError } from './errors.ts';

describe('getEnv', () => {
  beforeEach(() => {
    resetEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnv();
  });

  it('applies the defaults when nothing is set', () => {
    for (const key of [
      'POLYGON_AGENT_OIDC_RELAY',
      'POLYGON_AGENT_LOGIN_UI',
      'SEQUENCE_INDEXER_URL',
      'SEQUENCE_BUILDER_API_URL',
      'POLYMARKET_GAMMA_URL',
      'POLYMARKET_CLOB_URL',
      'POLYMARKET_DATA_URL',
      'POLYMARKET_BRIDGE_URL',
      'POLYMARKET_GEOBLOCK_URL',
      'SEQ_ECO_NATIVE_DIRECT'
    ]) {
      vi.stubEnv(key, '');
    }
    const env = getEnv();
    expect(env.POLYGON_AGENT_OIDC_RELAY).toBe('https://oidc-relay.polygon.technology');
    expect(env.POLYGON_AGENT_LOGIN_UI).toBe('https://agentconnect.polygon.technology');
    expect(env.SEQUENCE_INDEXER_URL).toBe(
      'https://indexer.sequence.app/rpc/IndexerGateway/GetTokenBalancesSummary'
    );
    expect(env.SEQUENCE_BUILDER_API_URL).toBe('https://api.sequence.build');
    expect(env.POLYMARKET_GAMMA_URL).toBe('https://gamma-api.polymarket.com');
    expect(env.POLYMARKET_CLOB_URL).toBe('https://clob.polymarket.com');
    expect(env.POLYMARKET_DATA_URL).toBe('https://data-api.polymarket.com');
    expect(env.POLYMARKET_BRIDGE_URL).toBe('https://bridge.polymarket.com');
    expect(env.POLYMARKET_GEOBLOCK_URL).toBe('https://polymarket.com/api/geoblock');
    expect(env.SEQ_ECO_NATIVE_DIRECT).toBe(false);
  });

  it('treats empty strings as unset', () => {
    vi.stubEnv('TRAILS_API_KEY', '');
    vi.stubEnv('SEQUENCE_PROJECT_ACCESS_KEY', '');
    expect(getEnv().TRAILS_API_KEY).toBeUndefined();
    expect(getEnv().SEQUENCE_PROJECT_ACCESS_KEY).toBeUndefined();
  });

  it('reads the values it is given', () => {
    vi.stubEnv('POLYMARKET_GAMMA_URL', 'http://127.0.0.1:9999');
    vi.stubEnv('SEQUENCE_NODES_URL', 'https://nodes.example/{network}/key');
    expect(getEnv().POLYMARKET_GAMMA_URL).toBe('http://127.0.0.1:9999');
    expect(getEnv().SEQUENCE_NODES_URL).toBe('https://nodes.example/{network}/key');
  });

  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['TRUE', true],
    ['0', false],
    ['false', false],
    ['no', false]
  ])('reads SEQ_ECO_NATIVE_DIRECT=%s as %s', (value, expected) => {
    vi.stubEnv('SEQ_ECO_NATIVE_DIRECT', value);
    expect(getEnv().SEQ_ECO_NATIVE_DIRECT).toBe(expected);
  });

  it('fails with a clear message on an invalid value', () => {
    vi.stubEnv('POLYMARKET_GAMMA_URL', 'not a url');
    // Throws the CLI's own error, and prints nothing itself.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = (() => {
      try {
        getEnv();
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: 'invalid_env' });
    expect((error as CliError).message).toContain('POLYMARKET_GAMMA_URL: ');
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('memoises until resetEnv is called', () => {
    vi.stubEnv('TRAILS_API_HOSTNAME', 'first.example');
    expect(getEnv().TRAILS_API_HOSTNAME).toBe('first.example');
    vi.stubEnv('TRAILS_API_HOSTNAME', 'second.example');
    expect(getEnv().TRAILS_API_HOSTNAME).toBe('first.example');
    resetEnv();
    expect(getEnv().TRAILS_API_HOSTNAME).toBe('second.example');
  });
});
