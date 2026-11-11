import { defineConfig } from 'vitest/config';

// The repo tsconfig targets es2024 (Node 24+ dev requirement), but the
// esbuild bundled with this Vite/Vitest major doesn't recognize that target
// string yet and warns on every transform. Vite's esbuild plugin loads the
// project tsconfig's `target` into `tsconfigRaw.compilerOptions.target`
// regardless of the top-level `esbuild.target` below, so both need the
// override to actually silence the warning; other tsconfig-derived options
// (jsx, verbatimModuleSyntax, etc.) are untouched. Tests still run on
// Node >=20 either way, so lowering the transform target has no effect on
// behavior.
export default defineConfig({
  // Tests that stub HOME must never reach a developer's real state folder.
  test: {
    env: { POLYGON_AGENT_HOME: '' },
    // Builds the CLI once so *.cli.test.ts can run the real binary.
    globalSetup: ['./src/test-harness/global-setup.ts'],
    // Floors are the measured baseline, not targets: raise them in the PR that adds tests.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.d.ts', 'src/test-harness/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 73.5,
        statements: 73.5,
        functions: 83.9,
        branches: 83.8,
        'src/lib/session/**': { lines: 85.3, statements: 85.3, functions: 93.6, branches: 83.0 },
        'src/lib/trade/**': { lines: 94.0, statements: 94.0, functions: 98.0, branches: 85.9 },
        'src/lib/polymarket/**': { lines: 93.0, statements: 93.0, functions: 97.2, branches: 87.7 },
        'src/lib/owner/**': { lines: 90.8, statements: 90.8, functions: 94.9, branches: 83.1 },
        'src/lib/oms-tx.ts': { lines: 77.1, statements: 77.1, functions: 85.2, branches: 84.9 },
        'src/lib/tx-dispatch.ts': {
          lines: 70.9,
          statements: 70.9,
          functions: 99.5,
          branches: 70.9
        },
        'src/commands/operations.ts': {
          lines: 40.1,
          statements: 40.1,
          functions: 50.5,
          branches: 68.0
        }
      }
    }
  },
  esbuild: {
    target: 'es2023',
    tsconfigRaw: { compilerOptions: { target: 'es2023' } }
  }
});
