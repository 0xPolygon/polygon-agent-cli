import polygonConfig from './eslint.config.polygon.js';

export default [
  ...polygonConfig,

  // --- Repo-specific overrides below ---
  {
    ignores: ['test-smart-wallet-polymarket.mjs', 'x402-test-server/**']
  }
];
