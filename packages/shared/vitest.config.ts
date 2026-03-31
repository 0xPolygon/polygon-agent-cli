import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node' },
  esbuild: { target: 'es2022' }
});
