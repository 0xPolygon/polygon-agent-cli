import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  // A Worker has web-platform globals (fetch, Request, crypto), not Node's.
  ...recommended({ globals: 'browser' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
  { ignores: ['out-tsc/**'] }
]);
