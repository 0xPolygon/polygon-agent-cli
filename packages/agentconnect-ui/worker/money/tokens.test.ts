import { describe, expect, it } from 'vitest';

// eslint-disable-next-line import-x/no-relative-packages -- checks the two copies match
import * as cli from '../../../polygon-agent-cli/src/lib/session/tokens.ts';
import { BUY_ALIAS, HOME_CHAINS, SUPPORTED } from './tokens.ts';

describe('covered tokens', () => {
  // A connection covers the same reviewed tokens as a CLI install.
  it("match the CLI's table", () => {
    expect(SUPPORTED).toEqual(cli.SUPPORTED);
    expect(BUY_ALIAS).toEqual(cli.BUY_ALIAS);
    expect(HOME_CHAINS).toEqual(cli.HOME_CHAINS);
  });
});
