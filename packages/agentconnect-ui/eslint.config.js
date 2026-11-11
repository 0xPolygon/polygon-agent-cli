import { defineConfig } from 'eslint/config';

import { frontend, recommended, typescript } from '@polygonlabs/apps-team-lint';

export default defineConfig([
  ...recommended({ globals: 'browser' }),
  ...typescript({ tsconfigRootDir: import.meta.dirname }),
  ...frontend(),
  // `.wrangler/` holds `pnpm dev:worker`'s temporary bundles.
  { ignores: ['dist/**', 'out-tsc/**', '.wrangler/**'] }
]);
