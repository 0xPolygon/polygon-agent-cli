import { defineConfig } from 'vitest/config';

// Same es2023 override as the CLI's config: the repo tsconfig targets es2024,
// which the esbuild bundled with Vitest warns about on every transform.
export default defineConfig({
  esbuild: {
    target: 'es2023',
    tsconfigRaw: { compilerOptions: { target: 'es2023' } }
  }
});
