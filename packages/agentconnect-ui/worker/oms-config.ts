// The OMS project the worker signs in to and spends through: the CLI's default
// sandbox project unless OMS_PUBLISHABLE_KEY names another.
export const DEFAULT_PUBLISHABLE_KEY = 'pk_sdbx_01kqfw9zaykks_01kwvkkzs5e2wb6rfas2y2njm8';

export const publishableKey = (env: { OMS_PUBLISHABLE_KEY?: string }) =>
  env.OMS_PUBLISHABLE_KEY || DEFAULT_PUBLISHABLE_KEY;
