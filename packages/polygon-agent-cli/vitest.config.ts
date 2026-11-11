import { defineConfig, mergeConfig } from 'vitest/config';

// The repo tsconfig targets es2024 (Node 24+ dev requirement), but the
// esbuild bundled with this Vite/Vitest major doesn't recognize that target
// string yet and warns on every transform. Vite's esbuild plugin loads the
// project tsconfig's `target` into `tsconfigRaw.compilerOptions.target`
// regardless of the top-level `esbuild.target` below, so both need the
// override to actually silence the warning; other tsconfig-derived options
// (jsx, verbatimModuleSyntax, etc.) are untouched. Tests still run on
// Node >=20 either way, so lowering the transform target has no effect on
// behavior.
const base = defineConfig({
  // Tests that stub HOME must never reach a developer's real state folder.
  test: { env: { POLYGON_AGENT_HOME: '' } },
  esbuild: {
    target: 'es2023',
    tsconfigRaw: { compilerOptions: { target: 'es2023' } }
  }
});

// Builds the CLI once per run so *.cli.test.ts can start the real binary.
export default mergeConfig(base, {
  test: { globalSetup: ['./src/test-harness/global-setup.ts'] }
});
