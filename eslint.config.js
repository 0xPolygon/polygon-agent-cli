import globals from 'globals';

import { frontend, recommended, javascript, typescript } from '@polygonlabs/apps-team-lint';

export default [
  ...recommended(),
  ...javascript({ globals: 'node' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
  ...frontend(),
  {
    files: ['packages/polygon-agent-cli/**/*.ts'],
    languageOptions: { globals: { ...globals.node } }
  },
  { ignores: ['.claude/**', '**/dist/**', 'test-smart-wallet-polymarket.mjs', 'x402-test-server/**'] }
];
