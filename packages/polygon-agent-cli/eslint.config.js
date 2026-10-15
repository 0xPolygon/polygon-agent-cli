import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
  { ignores: ['dist/**'] },
  {
    // Session transactions are prepared and executed in one place only, which
    // records them before sending and never resends.
    files: ['src/**/*.ts'],
    ignores: ['src/lib/session/transfer.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.property.name=/^(prepareTransaction|executeTransaction)$/]',
          message: 'Session transactions go through src/lib/session/transfer.ts only.'
        }
      ]
    }
  }
]);
