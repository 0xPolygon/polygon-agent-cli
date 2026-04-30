# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.10.3](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.10.2...@polygonlabs/agent-cli@0.10.3) (2026-04-30)


### Bug Fixes

* **wallet:** prevent 'Raw mode is not supported' error in non-TTY environments ([4e6a269](https://github.com/0xPolygon/polygon-agent-cli/commit/4e6a269d9d0d1e0db6567235b5068474d6393fec))





## [0.10.2](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.10.1...@polygonlabs/agent-cli@0.10.2) (2026-04-29)


### Bug Fixes

* auto-whitelist Aave V3 Pool, enforce 0.1 gas reserve on deposit ([d7db76b](https://github.com/0xPolygon/polygon-agent-cli/commit/d7db76b1cd202fbe14d45e18c3fc2b23883907a6))
* **deposit:** restore native balance check, reserve USDC only when POL < 0.1 ([f4be1a9](https://github.com/0xPolygon/polygon-agent-cli/commit/f4be1a9e562e55eeda67481fe8a0cd665cab1e9a))





## [0.10.1](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.10.0...@polygonlabs/agent-cli@0.10.1) (2026-04-29)

**Note:** Version bump only for package @polygonlabs/agent-cli





# [0.10.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.5...@polygonlabs/agent-cli@0.10.0) (2026-04-28)


### Features

* **polymarket:** migrate to CLOB V2 SDK, pUSD collateral, and V2 exchange contracts ([95ad532](https://github.com/0xPolygon/polygon-agent-cli/commit/95ad53231556da3e61741598f503cf6057af8e8c))





## [0.9.5](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.4...@polygonlabs/agent-cli@0.9.5) (2026-04-27)


### Bug Fixes

* **wallet:** add POL native ERC-20 to default session whitelist ([93280af](https://github.com/0xPolygon/polygon-agent-cli/commit/93280af01ead364ebe00b1ccae619b295310a5db))
* **wallet:** remove Katana vault contracts from --defi whitelist ([04728b7](https://github.com/0xPolygon/polygon-agent-cli/commit/04728b796b566323d65275211398ad11b59f4f88))
* **wallet:** remove POL 0x1010 from default whitelist — not needed ([5b5f039](https://github.com/0xPolygon/polygon-agent-cli/commit/5b5f0392cc2cdb657700d2f90bbdd667e39809cc))
* **wallet:** scope default session whitelist to USDC/USDC.e; add --defi flag ([f8c9256](https://github.com/0xPolygon/polygon-agent-cli/commit/f8c92566a26257554c585555a5ff6dd6fd9ee591))





## [0.9.4](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.3...@polygonlabs/agent-cli@0.9.4) (2026-04-27)


### Bug Fixes

* **deposit:** pre-flight balance checks, gas reserve, session guard, and actionable errors ([8011838](https://github.com/0xPolygon/polygon-agent-cli/commit/8011838f1ded843fc9666d0f3cb215e8cf871701))
* **deposit:** remove Polygon-only chain restriction, support all Trails chains ([9d26bfc](https://github.com/0xPolygon/polygon-agent-cli/commit/9d26bfcb42f8fd516c4d5298891acca07b71c80b))
* **fund:** point to wallet.polygon.technology instead of demo.trails.build ([9e2735d](https://github.com/0xPolygon/polygon-agent-cli/commit/9e2735d531277d178d7f6c308a5ac625d0e47526))


### Reverts

* **wallet:** remove session replacement guard ([8ab8150](https://github.com/0xPolygon/polygon-agent-cli/commit/8ab81501925b0bf9a75ea765b2e81d89399a0621))





## [0.9.3](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.2...@polygonlabs/agent-cli@0.9.3) (2026-04-22)


### Bug Fixes

* **polymarket:** remove hardcoded feeRateBps to let CLOB client resolve market fee rate ([c6b8232](https://github.com/0xPolygon/polygon-agent-cli/commit/c6b823279b5f32076104983c3fdd8e73934dade6))





## [0.9.2](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.1...@polygonlabs/agent-cli@0.9.2) (2026-04-22)


### Bug Fixes

* **deposit:** correct APY display inflated by 100x ([4d3f1d0](https://github.com/0xPolygon/polygon-agent-cli/commit/4d3f1d0ab2132e50a1ff304409e69c55d4fafaa2))





## [0.9.1](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.0...@polygonlabs/agent-cli@0.9.1) (2026-04-21)


### Bug Fixes

* **cli:** always use builder.json access key for Trails API ([be49e24](https://github.com/0xPolygon/polygon-agent-cli/commit/be49e24cb94d54b5a2b041ca6d89d8d3b502c15a))





# [0.9.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.8.0...@polygonlabs/agent-cli@0.9.0) (2026-04-21)


### Bug Fixes

* **deposit:** whitelist ERC-20 token contracts and fix session error messages ([1beb54b](https://github.com/0xPolygon/polygon-agent-cli/commit/1beb54b61012c4661b3aa9602bb172b3e2c3c7d6))
* smart wallet usdc transfer limits and permissions order ([83e7f2c](https://github.com/0xPolygon/polygon-agent-cli/commit/83e7f2cf281390fbb019d78008a55245ca03fd1d))


### Features

* auto-resolve aToken and Vault positions by asset and protocol in withdraw command ([599cb69](https://github.com/0xPolygon/polygon-agent-cli/commit/599cb69bef4fb638b17e4cf924edd356b8db07de))
* **cli:** add --chains comma list for balances ([0a4f50c](https://github.com/0xPolygon/polygon-agent-cli/commit/0a4f50c1f8c71b9cc4cf9fb15cd46b4c4181a4c1))
* **cli:** add withdraw for Aave aTokens and ERC-4626 vaults ([494ccbc](https://github.com/0xPolygon/polygon-agent-cli/commit/494ccbc3e65c0a2cf87ed22794431cfcc47e183d))
* **cli:** drop bundled skills and sync hook ([d9872eb](https://github.com/0xPolygon/polygon-agent-cli/commit/d9872ebc8c7d0422af4e871e8e84d04080962f5a))





# [0.8.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.7.2...@polygonlabs/agent-cli@0.8.0) (2026-04-16)


### Bug Fixes

* **skills:** fix Twitter/X x402 endpoint in polygon-discovery ([8f667f9](https://github.com/0xPolygon/polygon-agent-cli/commit/8f667f97f8b51c26d95e77de37c6b8877b5a759b))
* **skills:** rename to "Polygon Agent" and fix Twitter/X x402 endpoint ([7909791](https://github.com/0xPolygon/polygon-agent-cli/commit/7909791aa715a3ed5a6aecdf5a0d35d5cf17b9c0))
* **skills:** update install command to npm install -g @polygonlabs/agent-cli ([e0ac8cb](https://github.com/0xPolygon/polygon-agent-cli/commit/e0ac8cb34212f9b4b24b22ea1fa6c3416744cc1a))
* **skills:** update Twitter/X description to follower/following counts and tweet metrics ([7dcfb29](https://github.com/0xPolygon/polygon-agent-cli/commit/7dcfb29d4e5b8c8b5c7227835ce84118adca7b47))
* **skills:** use absolute URLs for sub-skill discovery ([12a8d14](https://github.com/0xPolygon/polygon-agent-cli/commit/12a8d145363bd4749b628e2b94d497e7fa12cba7))
* **wallet:** allow pasting 6-digit code in wallet create flow ([81c9e90](https://github.com/0xPolygon/polygon-agent-cli/commit/81c9e907a7804bc3c885cf52a47eebaf14506e45))


### Features

* **skill:** add prerequisites check to polygon-discovery skill ([d16d6fa](https://github.com/0xPolygon/polygon-agent-cli/commit/d16d6fa8f1eff21f2338550d4f0acc40fc7248a3))
* **skills:** add getEarnPools API reference to polygon-defi skill ([a175c26](https://github.com/0xPolygon/polygon-agent-cli/commit/a175c2670914ad618541ab3dc8d56fac374e03a3))
* **skills:** add getEarnPools API reference to polygon-defi skill ([411d831](https://github.com/0xPolygon/polygon-agent-cli/commit/411d831fe5c43881f1aaa3e07b20359a79e3c673))





## [0.7.2](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.7.1...@polygonlabs/agent-cli@0.7.2) (2026-04-14)


### Bug Fixes

* **ci:** add --access public to lerna publish for scoped packages ([c157790](https://github.com/0xPolygon/polygon-agent-cli/commit/c1577907f1363e5a173e6f49321c545395260fb9))
* **cli:** bundle agent-shared into CLI instead of publishing to npm ([1cc2d7b](https://github.com/0xPolygon/polygon-agent-cli/commit/1cc2d7b28b971f7b4b85d9473393c9fce92edd57))
* **publish:** declare access in publishConfig, remove --access flag from workflow ([e5d23b1](https://github.com/0xPolygon/polygon-agent-cli/commit/e5d23b1ed8c296808f37251cd25843774efd55ac))





## [0.7.1](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.7.0...@polygonlabs/agent-cli@0.7.1) (2026-04-14)

**Note:** Version bump only for package @polygonlabs/agent-cli





# [0.7.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.3.0...@polygonlabs/agent-cli@0.7.0) (2026-04-14)


### Bug Fixes

* add VITE_TRAILS_API_KEY to build env and fix session payload mapping ([560ff65](https://github.com/0xPolygon/polygon-agent-cli/commit/560ff65bde87435254c3591aa09ab2c82f99aaaf))
* address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
* **ci:** use GitHub environments for per-env secrets, add CF Access token support to relay client ([9a89472](https://github.com/0xPolygon/polygon-agent-cli/commit/9a89472bcd740f4e3711046aefe8825e42777676))
* **cli:** wire --timeout to waitForReady, document ephemeral key storage ([3c08268](https://github.com/0xPolygon/polygon-agent-cli/commit/3c082688c73404338512eb68335c53cbe3790bc9))
* **dapp-client:** parse guard string back to GuardConfig with jsonRevivers ([6a2addb](https://github.com/0xPolygon/polygon-agent-cli/commit/6a2addb83db085c5385cdb56f706529ba73bbba5))
* **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
* **skills:** update x402 service endpoints to native onrender.com paths ([a29c3da](https://github.com/0xPolygon/polygon-agent-cli/commit/a29c3da0d851e625670d7e820b24082f42d1c9de))
* **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
* **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))
* **x402-pay:** scope Bazaar payment_details handling to x402-api.onrender.com only ([06563b0](https://github.com/0xPolygon/polygon-agent-cli/commit/06563b03cf483f9c7787231689a3257dc64844b9))
* **x402-pay:** use per-network recipient from payment_details.networks ([abd8da0](https://github.com/0xPolygon/polygon-agent-cli/commit/abd8da0929ca930fa5bd15212b3e01ea72466388))


### Features

* **cli:** auto-whitelist Polygon & Katana DeFi vault contracts in sessions ([d78a093](https://github.com/0xPolygon/polygon-agent-cli/commit/d78a09385448f25e5411673794c68dd474583039))
* **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
* **cli:** polygon purple brand color, bordered code input, dry-run banner, tx result, fund TTY UI ([4490e86](https://github.com/0xPolygon/polygon-agent-cli/commit/4490e86dbd56c089790ffa176f825b782bc325ee))
* **cli:** replace cloudflared tunnel with relay + 6-digit code handoff ([8dba6fb](https://github.com/0xPolygon/polygon-agent-cli/commit/8dba6fb7540adcad4e74dfef574557682ac096c5))
* refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
* **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
* **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
* **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
* **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))
* **x402-pay:** handle custom payment_details 402 format from x402-api.onrender.com ([310a1db](https://github.com/0xPolygon/polygon-agent-cli/commit/310a1db56801299530189781048abea55fbd02bb))





# [0.6.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.3.0...@polygonlabs/agent-cli@0.6.0) (2026-04-14)


### Bug Fixes

* add VITE_TRAILS_API_KEY to build env and fix session payload mapping ([560ff65](https://github.com/0xPolygon/polygon-agent-cli/commit/560ff65bde87435254c3591aa09ab2c82f99aaaf))
* address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
* **ci:** use GitHub environments for per-env secrets, add CF Access token support to relay client ([9a89472](https://github.com/0xPolygon/polygon-agent-cli/commit/9a89472bcd740f4e3711046aefe8825e42777676))
* **cli:** wire --timeout to waitForReady, document ephemeral key storage ([3c08268](https://github.com/0xPolygon/polygon-agent-cli/commit/3c082688c73404338512eb68335c53cbe3790bc9))
* **dapp-client:** parse guard string back to GuardConfig with jsonRevivers ([6a2addb](https://github.com/0xPolygon/polygon-agent-cli/commit/6a2addb83db085c5385cdb56f706529ba73bbba5))
* **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
* **skills:** update x402 service endpoints to native onrender.com paths ([a29c3da](https://github.com/0xPolygon/polygon-agent-cli/commit/a29c3da0d851e625670d7e820b24082f42d1c9de))
* **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
* **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))
* **x402-pay:** scope Bazaar payment_details handling to x402-api.onrender.com only ([06563b0](https://github.com/0xPolygon/polygon-agent-cli/commit/06563b03cf483f9c7787231689a3257dc64844b9))
* **x402-pay:** use per-network recipient from payment_details.networks ([abd8da0](https://github.com/0xPolygon/polygon-agent-cli/commit/abd8da0929ca930fa5bd15212b3e01ea72466388))


### Features

* **cli:** auto-whitelist Polygon & Katana DeFi vault contracts in sessions ([d78a093](https://github.com/0xPolygon/polygon-agent-cli/commit/d78a09385448f25e5411673794c68dd474583039))
* **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
* **cli:** polygon purple brand color, bordered code input, dry-run banner, tx result, fund TTY UI ([4490e86](https://github.com/0xPolygon/polygon-agent-cli/commit/4490e86dbd56c089790ffa176f825b782bc325ee))
* **cli:** replace cloudflared tunnel with relay + 6-digit code handoff ([8dba6fb](https://github.com/0xPolygon/polygon-agent-cli/commit/8dba6fb7540adcad4e74dfef574557682ac096c5))
* refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
* **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
* **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
* **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
* **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))
* **x402-pay:** handle custom payment_details 402 format from x402-api.onrender.com ([310a1db](https://github.com/0xPolygon/polygon-agent-cli/commit/310a1db56801299530189781048abea55fbd02bb))





# [0.5.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.3.0...@polygonlabs/agent-cli@0.5.0) (2026-04-14)


### Bug Fixes

* add VITE_TRAILS_API_KEY to build env and fix session payload mapping ([560ff65](https://github.com/0xPolygon/polygon-agent-cli/commit/560ff65bde87435254c3591aa09ab2c82f99aaaf))
* address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
* **ci:** use GitHub environments for per-env secrets, add CF Access token support to relay client ([9a89472](https://github.com/0xPolygon/polygon-agent-cli/commit/9a89472bcd740f4e3711046aefe8825e42777676))
* **cli:** wire --timeout to waitForReady, document ephemeral key storage ([3c08268](https://github.com/0xPolygon/polygon-agent-cli/commit/3c082688c73404338512eb68335c53cbe3790bc9))
* **dapp-client:** parse guard string back to GuardConfig with jsonRevivers ([6a2addb](https://github.com/0xPolygon/polygon-agent-cli/commit/6a2addb83db085c5385cdb56f706529ba73bbba5))
* **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
* **skills:** update x402 service endpoints to native onrender.com paths ([a29c3da](https://github.com/0xPolygon/polygon-agent-cli/commit/a29c3da0d851e625670d7e820b24082f42d1c9de))
* **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
* **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))
* **x402-pay:** scope Bazaar payment_details handling to x402-api.onrender.com only ([06563b0](https://github.com/0xPolygon/polygon-agent-cli/commit/06563b03cf483f9c7787231689a3257dc64844b9))
* **x402-pay:** use per-network recipient from payment_details.networks ([abd8da0](https://github.com/0xPolygon/polygon-agent-cli/commit/abd8da0929ca930fa5bd15212b3e01ea72466388))


### Features

* **cli:** auto-whitelist Polygon & Katana DeFi vault contracts in sessions ([d78a093](https://github.com/0xPolygon/polygon-agent-cli/commit/d78a09385448f25e5411673794c68dd474583039))
* **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
* **cli:** polygon purple brand color, bordered code input, dry-run banner, tx result, fund TTY UI ([4490e86](https://github.com/0xPolygon/polygon-agent-cli/commit/4490e86dbd56c089790ffa176f825b782bc325ee))
* **cli:** replace cloudflared tunnel with relay + 6-digit code handoff ([8dba6fb](https://github.com/0xPolygon/polygon-agent-cli/commit/8dba6fb7540adcad4e74dfef574557682ac096c5))
* refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
* **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
* **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
* **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
* **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))
* **x402-pay:** handle custom payment_details 402 format from x402-api.onrender.com ([310a1db](https://github.com/0xPolygon/polygon-agent-cli/commit/310a1db56801299530189781048abea55fbd02bb))





# [0.4.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.3.0...@polygonlabs/agent-cli@0.4.0) (2026-04-14)


### Bug Fixes

* add VITE_TRAILS_API_KEY to build env and fix session payload mapping ([560ff65](https://github.com/0xPolygon/polygon-agent-cli/commit/560ff65bde87435254c3591aa09ab2c82f99aaaf))
* address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
* **ci:** use GitHub environments for per-env secrets, add CF Access token support to relay client ([9a89472](https://github.com/0xPolygon/polygon-agent-cli/commit/9a89472bcd740f4e3711046aefe8825e42777676))
* **cli:** wire --timeout to waitForReady, document ephemeral key storage ([3c08268](https://github.com/0xPolygon/polygon-agent-cli/commit/3c082688c73404338512eb68335c53cbe3790bc9))
* **dapp-client:** parse guard string back to GuardConfig with jsonRevivers ([6a2addb](https://github.com/0xPolygon/polygon-agent-cli/commit/6a2addb83db085c5385cdb56f706529ba73bbba5))
* **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
* **skills:** update x402 service endpoints to native onrender.com paths ([a29c3da](https://github.com/0xPolygon/polygon-agent-cli/commit/a29c3da0d851e625670d7e820b24082f42d1c9de))
* **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
* **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))
* **x402-pay:** scope Bazaar payment_details handling to x402-api.onrender.com only ([06563b0](https://github.com/0xPolygon/polygon-agent-cli/commit/06563b03cf483f9c7787231689a3257dc64844b9))
* **x402-pay:** use per-network recipient from payment_details.networks ([abd8da0](https://github.com/0xPolygon/polygon-agent-cli/commit/abd8da0929ca930fa5bd15212b3e01ea72466388))


### Features

* **cli:** auto-whitelist Polygon & Katana DeFi vault contracts in sessions ([d78a093](https://github.com/0xPolygon/polygon-agent-cli/commit/d78a09385448f25e5411673794c68dd474583039))
* **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
* **cli:** polygon purple brand color, bordered code input, dry-run banner, tx result, fund TTY UI ([4490e86](https://github.com/0xPolygon/polygon-agent-cli/commit/4490e86dbd56c089790ffa176f825b782bc325ee))
* **cli:** replace cloudflared tunnel with relay + 6-digit code handoff ([8dba6fb](https://github.com/0xPolygon/polygon-agent-cli/commit/8dba6fb7540adcad4e74dfef574557682ac096c5))
* refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
* **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
* **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
* **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
* **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))
* **x402-pay:** handle custom payment_details 402 format from x402-api.onrender.com ([310a1db](https://github.com/0xPolygon/polygon-agent-cli/commit/310a1db56801299530189781048abea55fbd02bb))





# [0.3.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.2.2...@polygonlabs/agent-cli@0.3.0) (2026-03-17)


### Bug Fixes

* add missing @polymarket/order-utils dependency ([54fe8a2](https://github.com/0xPolygon/polygon-agent-cli/commit/54fe8a2a80c0f40cbad6ad20073e0d51e1309885))
* bump sequence SDK to beta.17 for counterfactual wallet support ([879e06f](https://github.com/0xPolygon/polygon-agent-cli/commit/879e06fabe1813187a5932ac6adde1c6c78441db))
* resolve file system race condition in polymarket key storage ([bf12021](https://github.com/0xPolygon/polygon-agent-cli/commit/bf1202160d50987540268539e3b66150cb645ffd))


### Features

* **polymarket:** port polymarket feature to TypeScript ([1a67055](https://github.com/0xPolygon/polygon-agent-cli/commit/1a67055e4f02b04f4fbf16e076d500901dcc47f2))
* **polymarket:** port to TypeScript, fix factory routing, update docs ([48f8636](https://github.com/0xPolygon/polygon-agent-cli/commit/48f8636600a278d512be0c377969e24178325078))





## [0.2.2](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.2.1...@polygonlabs/agent-cli@0.2.2) (2026-03-05)


### Bug Fixes

* **agent:** handle empty clients list in reputation command ([4a95561](https://github.com/0xPolygon/polygon-agent-cli/commit/4a955616089b604e10d442461f944403e62a207e))





## [0.2.1](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.2.0...@polygonlabs/agent-cli@0.2.1) (2026-03-05)


### Bug Fixes

* **publish:** add repository field to package.json files ([b037364](https://github.com/0xPolygon/polygon-agent-cli/commit/b037364323343900a041e16e4b8f7ff92345d95e))





# [0.2.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.1.2...@polygonlabs/agent-cli@0.2.0) (2026-03-04)


### Bug Fixes

* **dapp-client:** use getAndClear methods instead of save(null) ([6331f98](https://github.com/0xPolygon/polygon-agent-cli/commit/6331f98f919b077ced2dbc87b66f51aeec8c73a7))
* **release:** reset version to 0.1.2 and drop --conventional-graduate ([73ad183](https://github.com/0xPolygon/polygon-agent-cli/commit/73ad18302ea6aa71d2a0860d3f82abd3f663c2cd))
* **swap:** poll waitIntentReceipt until done instead of single call ([e815bc6](https://github.com/0xPolygon/polygon-agent-cli/commit/e815bc69478e78223918b95dd256ae01e90373ff))
* **swap:** use correct property path for intent status in timeout error ([ab88ba8](https://github.com/0xPolygon/polygon-agent-cli/commit/ab88ba8dad8f07ce2236a538a9fd9ce1eb9a09d4))
* **wallet:** auto-whitelist ValueForwarder and Trails contracts at session creation ([adc302a](https://github.com/0xPolygon/polygon-agent-cli/commit/adc302a708a1713410c8d0a62f4f5e67836d401a))
* **wallet:** remove Trails deposit contracts from auto-whitelist ([aeb78ca](https://github.com/0xPolygon/polygon-agent-cli/commit/aeb78ca0aea84a64d11cb5e9db4d24220e734f05))


### Features

* add version to cli commands ([5aa2d75](https://github.com/0xPolygon/polygon-agent-cli/commit/5aa2d75fa0c306686aa390f27d70a0eec0231dc4))
* **cli:** convert polygon-agent-cli from JavaScript to TypeScript + yargs ([186044d](https://github.com/0xPolygon/polygon-agent-cli/commit/186044d1262a4cc059b2ce1f93b982ab58dbc0e7))
* **cli:** show help when command is called without required subcommand ([8b87c5e](https://github.com/0xPolygon/polygon-agent-cli/commit/8b87c5e51ce900475e24676fa48dd06eea58ca7a))
* **cli:** show subcommands in root --help descriptions ([9a7c390](https://github.com/0xPolygon/polygon-agent-cli/commit/9a7c390010f5bc9117cc57b73b8c6d8eb12eaeda))
