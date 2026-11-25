# @polygonlabs/agent-shared

Private workspace package holding what the CLI and the agentconnect Worker and site must agree on:
the reviewed token table (`SUPPORTED`, `BUY_ALIAS`, `HOME_CHAINS`), `USDC_POLYGON` and
`TRAILS_API_URL`. One copy means the CLI's session mode and the Worker's allowance planning cannot
drift apart.

It is never published or built to `dist/`. Consumers' bundlers (esbuild for the CLI, Vite and
wrangler for agentconnect-ui) read `src/` through the package's `exports`, so the CLI's bundle
inlines it and it is a `devDependency` there.

It must not import anything at runtime (`viem` is a type-only import and a devDependency): as a
workspace link it would otherwise resolve its own copy of the dependency and put a second one in the
Worker bundle.
