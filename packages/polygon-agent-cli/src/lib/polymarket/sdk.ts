// Lazy access to @polymarket/client. The SDK declares Node >= 24 while the CLI
// supports 22, so it is only loaded when a Polymarket command runs.

import type * as SdkRoot from '@polymarket/client';
import type * as SdkActions from '@polymarket/client/actions';
import type * as SdkNode from '@polymarket/client/node';
import type * as SdkViem from '@polymarket/client/viem';

import { CliError } from '../errors.ts';

export type Sdk = {
  root: typeof SdkRoot;
  viem: typeof SdkViem;
  node: typeof SdkNode;
  actions: typeof SdkActions;
};

let cached: Sdk | undefined;
let rootRef: Sdk['root'] | undefined;

export async function loadSdk(): Promise<Sdk> {
  if (cached) return cached;
  const [root, viem, node, actions] = await Promise.all([
    import('@polymarket/client'),
    import('@polymarket/client/viem'),
    import('@polymarket/client/node'),
    import('@polymarket/client/actions')
  ]);
  rootRef = root;
  cached = { root, viem, node, actions };
  return cached;
}

// Class checks use `instanceof`: the SDK's static `isError` matches any
// Polymarket error, not just the named class.
export function mapSdkError(err: unknown): unknown {
  const r = rootRef;
  if (!r || err instanceof CliError) return err;
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof r.RateLimitError) {
    return new CliError({ code: 'rate_limited', message, cause: err });
  }
  if (err instanceof r.TransportError || err instanceof r.TimeoutError) {
    return new CliError({ code: 'upstream_unavailable', message, cause: err });
  }
  if (err instanceof r.UserInputError) {
    return new CliError({ code: 'invalid_input', message, cause: err });
  }
  if (err instanceof r.RequestRejectedError) {
    const status = (err as { status?: number }).status;
    return new CliError({
      code: status !== undefined && status >= 500 ? 'upstream_unavailable' : 'upstream_error',
      message,
      cause: err
    });
  }
  return err;
}
