# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.6.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-connector-ui@1.5.0...@polygonlabs/agent-connector-ui@1.6.0) (2026-04-21)


### Bug Fixes

* **deposit:** whitelist ERC-20 token contracts and fix session error messages ([1beb54b](https://github.com/0xPolygon/polygon-agent-cli/commit/1beb54b61012c4661b3aa9602bb172b3e2c3c7d6))
* restore connector skill URL sync (polygon-* public copies + husky) ([d979216](https://github.com/0xPolygon/polygon-agent-cli/commit/d97921674df79dbb616c31de60b4ac1b8028689b))
* smart wallet usdc transfer limits and permissions order ([83e7f2c](https://github.com/0xPolygon/polygon-agent-cli/commit/83e7f2cf281390fbb019d78008a55245ca03fd1d))


### Features

* **cli:** add --chains comma list for balances ([0a4f50c](https://github.com/0xPolygon/polygon-agent-cli/commit/0a4f50c1f8c71b9cc4cf9fb15cd46b4c4181a4c1))
* **cli:** add withdraw for Aave aTokens and ERC-4626 vaults ([494ccbc](https://github.com/0xPolygon/polygon-agent-cli/commit/494ccbc3e65c0a2cf87ed22794431cfcc47e183d))
* **cli:** drop bundled skills and sync hook ([d9872eb](https://github.com/0xPolygon/polygon-agent-cli/commit/d9872ebc8c7d0422af4e871e8e84d04080962f5a))





# [1.5.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-connector-ui@1.4.2...@polygonlabs/agent-connector-ui@1.5.0) (2026-04-16)


### Bug Fixes

* **skills:** fix Twitter/X x402 endpoint in polygon-discovery ([8f667f9](https://github.com/0xPolygon/polygon-agent-cli/commit/8f667f97f8b51c26d95e77de37c6b8877b5a759b))
* **skills:** rename to "Polygon Agent" and fix Twitter/X x402 endpoint ([7909791](https://github.com/0xPolygon/polygon-agent-cli/commit/7909791aa715a3ed5a6aecdf5a0d35d5cf17b9c0))
* **skills:** serve sub-skills at root paths on agentconnect domain ([8d3b042](https://github.com/0xPolygon/polygon-agent-cli/commit/8d3b042e815a485af0582af60d791c15a37249d0))
* **skills:** sync root public/SKILL.md in pre-commit hook ([0e7c291](https://github.com/0xPolygon/polygon-agent-cli/commit/0e7c291c440112c15813ea907aa19dc20d88ae02))
* **skills:** sync root public/SKILL.md to use sub-skill URLs ([0c748fb](https://github.com/0xPolygon/polygon-agent-cli/commit/0c748fb29f3719b2c1d3b8e89a17808465268a41))
* **skills:** update install command to npm install -g @polygonlabs/agent-cli ([e0ac8cb](https://github.com/0xPolygon/polygon-agent-cli/commit/e0ac8cb34212f9b4b24b22ea1fa6c3416744cc1a))
* **skills:** update Twitter/X description to follower/following counts and tweet metrics ([7dcfb29](https://github.com/0xPolygon/polygon-agent-cli/commit/7dcfb29d4e5b8c8b5c7227835ce84118adca7b47))
* **skills:** use absolute URLs for sub-skill discovery ([12a8d14](https://github.com/0xPolygon/polygon-agent-cli/commit/12a8d145363bd4749b628e2b94d497e7fa12cba7))


### Features

* **skill:** add prerequisites check to polygon-discovery skill ([d16d6fa](https://github.com/0xPolygon/polygon-agent-cli/commit/d16d6fa8f1eff21f2338550d4f0acc40fc7248a3))
* **skills:** add getEarnPools API reference to polygon-defi skill ([a175c26](https://github.com/0xPolygon/polygon-agent-cli/commit/a175c2670914ad618541ab3dc8d56fac374e03a3))
* **skills:** add getEarnPools API reference to polygon-defi skill ([411d831](https://github.com/0xPolygon/polygon-agent-cli/commit/411d831fe5c43881f1aaa3e07b20359a79e3c673))





## [1.4.2](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-connector-ui@1.4.1...@polygonlabs/agent-connector-ui@1.4.2) (2026-04-14)


### Bug Fixes

* **ci:** add --access public to lerna publish for scoped packages ([c157790](https://github.com/0xPolygon/polygon-agent-cli/commit/c1577907f1363e5a173e6f49321c545395260fb9))
* **cli:** bundle agent-shared into CLI instead of publishing to npm ([1cc2d7b](https://github.com/0xPolygon/polygon-agent-cli/commit/1cc2d7b28b971f7b4b85d9473393c9fce92edd57))





## [1.4.1](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-connector-ui@1.4.0...@polygonlabs/agent-connector-ui@1.4.1) (2026-04-14)

**Note:** Version bump only for package @polygonlabs/agent-connector-ui





# [1.4.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-connector-ui@1.0.2...@polygonlabs/agent-connector-ui@1.4.0) (2026-04-14)


### Bug Fixes

* address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
* **connector-ui:** add @cloudflare/workers-types for relay DO type resolution ([5e9a070](https://github.com/0xPolygon/polygon-agent-cli/commit/5e9a070b8141687bbc3a95b813b32d7af7b4ad89))
* **connector-ui:** add quotes around claude command argument and lowercase prefix ([0cfc441](https://github.com/0xPolygon/polygon-agent-cli/commit/0cfc44195e4a1b737be7544f7284632b74ed8f32))
* **connector-ui:** add SESSION_RELAY DO bindings to staging and production envs ([16fe31e](https://github.com/0xPolygon/polygon-agent-cli/commit/16fe31ef82972ba7840c2881fc71eb5ee5a0fbe2))
* **connector-ui:** align subtext color to [#6](https://github.com/0xPolygon/polygon-agent-cli/issues/6)b7280 across landing and code screens ([29f7336](https://github.com/0xPolygon/polygon-agent-cli/commit/29f733651f8eb4c5986ad94ffcdcff22d2b38ba0)), closes [#6b7280](https://github.com/0xPolygon/polygon-agent-cli/issues/6b7280)
* **connector-ui:** extend session deadline to 6 months ([cb843b0](https://github.com/0xPolygon/polygon-agent-cli/commit/cb843b05512d326e241cbaab25a93dffb5a94364))
* **connector-ui:** fix logo to top of screen on all flow screens ([4316ae8](https://github.com/0xPolygon/polygon-agent-cli/commit/4316ae875116dd04af9cd52454179185a6bd8efe))
* **connector-ui:** fixed centered logo+badge on screens 1-3, onchain spelling ([e687bce](https://github.com/0xPolygon/polygon-agent-cli/commit/e687bce7fd9df1f3540b571da8ce18acc57da57a))
* **connector-ui:** preserve implicit session metadata, remove tweetnacl, add rid validation ([ca4c4aa](https://github.com/0xPolygon/polygon-agent-cli/commit/ca4c4aa7ce972639e80b3fe4c8cc6abd01db3df1))
* **connector-ui:** relay init error check, rid validation, re-init guard, payload size limit ([509b34f](https://github.com/0xPolygon/polygon-agent-cli/commit/509b34f593478b3b8e4f4c1cdb02ca355e55379c))
* **connector-ui:** remove dollar sign from terminal prefix display ([da70d5f](https://github.com/0xPolygon/polygon-agent-cli/commit/da70d5ffbdbb099d873751e87c046611b39189ce))
* **connector-ui:** remove dollar sign prefix from copied commands ([d8bb2e1](https://github.com/0xPolygon/polygon-agent-cli/commit/d8bb2e1e290f2f57bdc848c894f4dd2be512d5f2))
* **connector-ui:** remove services list card from dashboard ([be3ee92](https://github.com/0xPolygon/polygon-agent-cli/commit/be3ee92ff1ee42d00cc97d0fdb4b7e45a26bd555))
* **connector-ui:** restore >_ agent mono badge on all screens ([d753dd7](https://github.com/0xPolygon/polygon-agent-cli/commit/d753dd72e3c866040f618c8a0262e331681ea9b7))
* **relay:** include code_hash_hex in retrieve response for CLI decryption ([0b713b8](https://github.com/0xPolygon/polygon-agent-cli/commit/0b713b8f380b2f928a0575cc7f2c311177d61d8a))
* **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
* **skills:** update x402 Bazaar endpoints to use POST, update Twitter prompt ([cee084d](https://github.com/0xPolygon/polygon-agent-cli/commit/cee084dc1bdc5dbfffca6209a8734679c8741e82))
* **ui:** shorten lead scoring display text, fix duplicate Target icon ([dd3c976](https://github.com/0xPolygon/polygon-agent-cli/commit/dd3c9761878bbabc377baa7e23a253f484fa000a))
* **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
* **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))


### Features

* **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
* **connector-ui:** add Durable Object relay API + upgrade worker routing ([77a093c](https://github.com/0xPolygon/polygon-agent-cli/commit/77a093cbad4e136fd9ada94da8a667b5ff08a26a))
* **connector-ui:** add Openclaw and Hermes agent options ([e18b076](https://github.com/0xPolygon/polygon-agent-cli/commit/e18b076071ead7223d49732c0202e03f7456a94b))
* **connector-ui:** apply OMSX Figma design system to all screens ([154afbd](https://github.com/0xPolygon/polygon-agent-cli/commit/154afbd28b818add730edc6d3879548b3e5a3743)), closes [#141635](https://github.com/0xPolygon/polygon-agent-cli/issues/141635) [#64708](https://github.com/0xPolygon/polygon-agent-cli/issues/64708) [#c8cfe1](https://github.com/0xPolygon/polygon-agent-cli/issues/c8cfe1) [#929](https://github.com/0xPolygon/polygon-agent-cli/issues/929) [#141635](https://github.com/0xPolygon/polygon-agent-cli/issues/141635) [#7c3](https://github.com/0xPolygon/polygon-agent-cli/issues/7c3) [#f5f6](https://github.com/0xPolygon/polygon-agent-cli/issues/f5f6) [#929](https://github.com/0xPolygon/polygon-agent-cli/issues/929)
* **connector-ui:** enable Mesh onramp in production for TrailsWidget ([93e562b](https://github.com/0xPolygon/polygon-agent-cli/commit/93e562b70c136e5f9bdeb5786df09b63798778c0))
* **connector-ui:** redesign — light theme, code display, funding flow ([63b2fcd](https://github.com/0xPolygon/polygon-agent-cli/commit/63b2fcdf7cb46b44d76e9d441c872098dad21d95))
* **connector-ui:** remove Gemini agent option to prevent chip overflow ([6dacd0f](https://github.com/0xPolygon/polygon-agent-cli/commit/6dacd0f24302924c9feca72b7a284fd4d1c62842))
* **connector-ui:** replace use cases with x402 catalog services ([231fb3a](https://github.com/0xPolygon/polygon-agent-cli/commit/231fb3a2e7f675401f9bca93ccba1fd16c7f2ca7))
* **connector-ui:** v2 session flow — relay encryption + 6-digit code display ([b4ac674](https://github.com/0xPolygon/polygon-agent-cli/commit/b4ac674b13c1965bfe48517b812333ff5b4c5289))
* refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
* **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
* **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
* **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
* **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))





# [1.3.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-connector-ui@1.0.2...@polygonlabs/agent-connector-ui@1.3.0) (2026-04-14)


### Bug Fixes

* address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
* **connector-ui:** add @cloudflare/workers-types for relay DO type resolution ([5e9a070](https://github.com/0xPolygon/polygon-agent-cli/commit/5e9a070b8141687bbc3a95b813b32d7af7b4ad89))
* **connector-ui:** add quotes around claude command argument and lowercase prefix ([0cfc441](https://github.com/0xPolygon/polygon-agent-cli/commit/0cfc44195e4a1b737be7544f7284632b74ed8f32))
* **connector-ui:** add SESSION_RELAY DO bindings to staging and production envs ([16fe31e](https://github.com/0xPolygon/polygon-agent-cli/commit/16fe31ef82972ba7840c2881fc71eb5ee5a0fbe2))
* **connector-ui:** align subtext color to [#6](https://github.com/0xPolygon/polygon-agent-cli/issues/6)b7280 across landing and code screens ([29f7336](https://github.com/0xPolygon/polygon-agent-cli/commit/29f733651f8eb4c5986ad94ffcdcff22d2b38ba0)), closes [#6b7280](https://github.com/0xPolygon/polygon-agent-cli/issues/6b7280)
* **connector-ui:** extend session deadline to 6 months ([cb843b0](https://github.com/0xPolygon/polygon-agent-cli/commit/cb843b05512d326e241cbaab25a93dffb5a94364))
* **connector-ui:** fix logo to top of screen on all flow screens ([4316ae8](https://github.com/0xPolygon/polygon-agent-cli/commit/4316ae875116dd04af9cd52454179185a6bd8efe))
* **connector-ui:** fixed centered logo+badge on screens 1-3, onchain spelling ([e687bce](https://github.com/0xPolygon/polygon-agent-cli/commit/e687bce7fd9df1f3540b571da8ce18acc57da57a))
* **connector-ui:** preserve implicit session metadata, remove tweetnacl, add rid validation ([ca4c4aa](https://github.com/0xPolygon/polygon-agent-cli/commit/ca4c4aa7ce972639e80b3fe4c8cc6abd01db3df1))
* **connector-ui:** relay init error check, rid validation, re-init guard, payload size limit ([509b34f](https://github.com/0xPolygon/polygon-agent-cli/commit/509b34f593478b3b8e4f4c1cdb02ca355e55379c))
* **connector-ui:** remove dollar sign from terminal prefix display ([da70d5f](https://github.com/0xPolygon/polygon-agent-cli/commit/da70d5ffbdbb099d873751e87c046611b39189ce))
* **connector-ui:** remove dollar sign prefix from copied commands ([d8bb2e1](https://github.com/0xPolygon/polygon-agent-cli/commit/d8bb2e1e290f2f57bdc848c894f4dd2be512d5f2))
* **connector-ui:** remove services list card from dashboard ([be3ee92](https://github.com/0xPolygon/polygon-agent-cli/commit/be3ee92ff1ee42d00cc97d0fdb4b7e45a26bd555))
* **connector-ui:** restore >_ agent mono badge on all screens ([d753dd7](https://github.com/0xPolygon/polygon-agent-cli/commit/d753dd72e3c866040f618c8a0262e331681ea9b7))
* **relay:** include code_hash_hex in retrieve response for CLI decryption ([0b713b8](https://github.com/0xPolygon/polygon-agent-cli/commit/0b713b8f380b2f928a0575cc7f2c311177d61d8a))
* **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
* **skills:** update x402 Bazaar endpoints to use POST, update Twitter prompt ([cee084d](https://github.com/0xPolygon/polygon-agent-cli/commit/cee084dc1bdc5dbfffca6209a8734679c8741e82))
* **ui:** shorten lead scoring display text, fix duplicate Target icon ([dd3c976](https://github.com/0xPolygon/polygon-agent-cli/commit/dd3c9761878bbabc377baa7e23a253f484fa000a))
* **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
* **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))


### Features

* **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
* **connector-ui:** add Durable Object relay API + upgrade worker routing ([77a093c](https://github.com/0xPolygon/polygon-agent-cli/commit/77a093cbad4e136fd9ada94da8a667b5ff08a26a))
* **connector-ui:** add Openclaw and Hermes agent options ([e18b076](https://github.com/0xPolygon/polygon-agent-cli/commit/e18b076071ead7223d49732c0202e03f7456a94b))
* **connector-ui:** apply OMSX Figma design system to all screens ([154afbd](https://github.com/0xPolygon/polygon-agent-cli/commit/154afbd28b818add730edc6d3879548b3e5a3743)), closes [#141635](https://github.com/0xPolygon/polygon-agent-cli/issues/141635) [#64708](https://github.com/0xPolygon/polygon-agent-cli/issues/64708) [#c8cfe1](https://github.com/0xPolygon/polygon-agent-cli/issues/c8cfe1) [#929](https://github.com/0xPolygon/polygon-agent-cli/issues/929) [#141635](https://github.com/0xPolygon/polygon-agent-cli/issues/141635) [#7c3](https://github.com/0xPolygon/polygon-agent-cli/issues/7c3) [#f5f6](https://github.com/0xPolygon/polygon-agent-cli/issues/f5f6) [#929](https://github.com/0xPolygon/polygon-agent-cli/issues/929)
* **connector-ui:** enable Mesh onramp in production for TrailsWidget ([93e562b](https://github.com/0xPolygon/polygon-agent-cli/commit/93e562b70c136e5f9bdeb5786df09b63798778c0))
* **connector-ui:** redesign — light theme, code display, funding flow ([63b2fcd](https://github.com/0xPolygon/polygon-agent-cli/commit/63b2fcdf7cb46b44d76e9d441c872098dad21d95))
* **connector-ui:** remove Gemini agent option to prevent chip overflow ([6dacd0f](https://github.com/0xPolygon/polygon-agent-cli/commit/6dacd0f24302924c9feca72b7a284fd4d1c62842))
* **connector-ui:** replace use cases with x402 catalog services ([231fb3a](https://github.com/0xPolygon/polygon-agent-cli/commit/231fb3a2e7f675401f9bca93ccba1fd16c7f2ca7))
* **connector-ui:** v2 session flow — relay encryption + 6-digit code display ([b4ac674](https://github.com/0xPolygon/polygon-agent-cli/commit/b4ac674b13c1965bfe48517b812333ff5b4c5289))
* refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
* **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
* **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
* **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
* **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))





# [1.2.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-connector-ui@1.0.2...@polygonlabs/agent-connector-ui@1.2.0) (2026-04-14)


### Bug Fixes

* address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
* **connector-ui:** add @cloudflare/workers-types for relay DO type resolution ([5e9a070](https://github.com/0xPolygon/polygon-agent-cli/commit/5e9a070b8141687bbc3a95b813b32d7af7b4ad89))
* **connector-ui:** add quotes around claude command argument and lowercase prefix ([0cfc441](https://github.com/0xPolygon/polygon-agent-cli/commit/0cfc44195e4a1b737be7544f7284632b74ed8f32))
* **connector-ui:** add SESSION_RELAY DO bindings to staging and production envs ([16fe31e](https://github.com/0xPolygon/polygon-agent-cli/commit/16fe31ef82972ba7840c2881fc71eb5ee5a0fbe2))
* **connector-ui:** align subtext color to [#6](https://github.com/0xPolygon/polygon-agent-cli/issues/6)b7280 across landing and code screens ([29f7336](https://github.com/0xPolygon/polygon-agent-cli/commit/29f733651f8eb4c5986ad94ffcdcff22d2b38ba0)), closes [#6b7280](https://github.com/0xPolygon/polygon-agent-cli/issues/6b7280)
* **connector-ui:** extend session deadline to 6 months ([cb843b0](https://github.com/0xPolygon/polygon-agent-cli/commit/cb843b05512d326e241cbaab25a93dffb5a94364))
* **connector-ui:** fix logo to top of screen on all flow screens ([4316ae8](https://github.com/0xPolygon/polygon-agent-cli/commit/4316ae875116dd04af9cd52454179185a6bd8efe))
* **connector-ui:** fixed centered logo+badge on screens 1-3, onchain spelling ([e687bce](https://github.com/0xPolygon/polygon-agent-cli/commit/e687bce7fd9df1f3540b571da8ce18acc57da57a))
* **connector-ui:** preserve implicit session metadata, remove tweetnacl, add rid validation ([ca4c4aa](https://github.com/0xPolygon/polygon-agent-cli/commit/ca4c4aa7ce972639e80b3fe4c8cc6abd01db3df1))
* **connector-ui:** relay init error check, rid validation, re-init guard, payload size limit ([509b34f](https://github.com/0xPolygon/polygon-agent-cli/commit/509b34f593478b3b8e4f4c1cdb02ca355e55379c))
* **connector-ui:** remove dollar sign from terminal prefix display ([da70d5f](https://github.com/0xPolygon/polygon-agent-cli/commit/da70d5ffbdbb099d873751e87c046611b39189ce))
* **connector-ui:** remove dollar sign prefix from copied commands ([d8bb2e1](https://github.com/0xPolygon/polygon-agent-cli/commit/d8bb2e1e290f2f57bdc848c894f4dd2be512d5f2))
* **connector-ui:** remove services list card from dashboard ([be3ee92](https://github.com/0xPolygon/polygon-agent-cli/commit/be3ee92ff1ee42d00cc97d0fdb4b7e45a26bd555))
* **connector-ui:** restore >_ agent mono badge on all screens ([d753dd7](https://github.com/0xPolygon/polygon-agent-cli/commit/d753dd72e3c866040f618c8a0262e331681ea9b7))
* **relay:** include code_hash_hex in retrieve response for CLI decryption ([0b713b8](https://github.com/0xPolygon/polygon-agent-cli/commit/0b713b8f380b2f928a0575cc7f2c311177d61d8a))
* **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
* **skills:** update x402 Bazaar endpoints to use POST, update Twitter prompt ([cee084d](https://github.com/0xPolygon/polygon-agent-cli/commit/cee084dc1bdc5dbfffca6209a8734679c8741e82))
* **ui:** shorten lead scoring display text, fix duplicate Target icon ([dd3c976](https://github.com/0xPolygon/polygon-agent-cli/commit/dd3c9761878bbabc377baa7e23a253f484fa000a))
* **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
* **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))


### Features

* **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
* **connector-ui:** add Durable Object relay API + upgrade worker routing ([77a093c](https://github.com/0xPolygon/polygon-agent-cli/commit/77a093cbad4e136fd9ada94da8a667b5ff08a26a))
* **connector-ui:** add Openclaw and Hermes agent options ([e18b076](https://github.com/0xPolygon/polygon-agent-cli/commit/e18b076071ead7223d49732c0202e03f7456a94b))
* **connector-ui:** apply OMSX Figma design system to all screens ([154afbd](https://github.com/0xPolygon/polygon-agent-cli/commit/154afbd28b818add730edc6d3879548b3e5a3743)), closes [#141635](https://github.com/0xPolygon/polygon-agent-cli/issues/141635) [#64708](https://github.com/0xPolygon/polygon-agent-cli/issues/64708) [#c8cfe1](https://github.com/0xPolygon/polygon-agent-cli/issues/c8cfe1) [#929](https://github.com/0xPolygon/polygon-agent-cli/issues/929) [#141635](https://github.com/0xPolygon/polygon-agent-cli/issues/141635) [#7c3](https://github.com/0xPolygon/polygon-agent-cli/issues/7c3) [#f5f6](https://github.com/0xPolygon/polygon-agent-cli/issues/f5f6) [#929](https://github.com/0xPolygon/polygon-agent-cli/issues/929)
* **connector-ui:** enable Mesh onramp in production for TrailsWidget ([93e562b](https://github.com/0xPolygon/polygon-agent-cli/commit/93e562b70c136e5f9bdeb5786df09b63798778c0))
* **connector-ui:** redesign — light theme, code display, funding flow ([63b2fcd](https://github.com/0xPolygon/polygon-agent-cli/commit/63b2fcdf7cb46b44d76e9d441c872098dad21d95))
* **connector-ui:** remove Gemini agent option to prevent chip overflow ([6dacd0f](https://github.com/0xPolygon/polygon-agent-cli/commit/6dacd0f24302924c9feca72b7a284fd4d1c62842))
* **connector-ui:** replace use cases with x402 catalog services ([231fb3a](https://github.com/0xPolygon/polygon-agent-cli/commit/231fb3a2e7f675401f9bca93ccba1fd16c7f2ca7))
* **connector-ui:** v2 session flow — relay encryption + 6-digit code display ([b4ac674](https://github.com/0xPolygon/polygon-agent-cli/commit/b4ac674b13c1965bfe48517b812333ff5b4c5289))
* refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
* **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
* **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
* **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
* **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))





# [1.1.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-connector-ui@1.0.2...@polygonlabs/agent-connector-ui@1.1.0) (2026-04-14)


### Bug Fixes

* address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
* **connector-ui:** add @cloudflare/workers-types for relay DO type resolution ([5e9a070](https://github.com/0xPolygon/polygon-agent-cli/commit/5e9a070b8141687bbc3a95b813b32d7af7b4ad89))
* **connector-ui:** add quotes around claude command argument and lowercase prefix ([0cfc441](https://github.com/0xPolygon/polygon-agent-cli/commit/0cfc44195e4a1b737be7544f7284632b74ed8f32))
* **connector-ui:** add SESSION_RELAY DO bindings to staging and production envs ([16fe31e](https://github.com/0xPolygon/polygon-agent-cli/commit/16fe31ef82972ba7840c2881fc71eb5ee5a0fbe2))
* **connector-ui:** align subtext color to [#6](https://github.com/0xPolygon/polygon-agent-cli/issues/6)b7280 across landing and code screens ([29f7336](https://github.com/0xPolygon/polygon-agent-cli/commit/29f733651f8eb4c5986ad94ffcdcff22d2b38ba0)), closes [#6b7280](https://github.com/0xPolygon/polygon-agent-cli/issues/6b7280)
* **connector-ui:** extend session deadline to 6 months ([cb843b0](https://github.com/0xPolygon/polygon-agent-cli/commit/cb843b05512d326e241cbaab25a93dffb5a94364))
* **connector-ui:** fix logo to top of screen on all flow screens ([4316ae8](https://github.com/0xPolygon/polygon-agent-cli/commit/4316ae875116dd04af9cd52454179185a6bd8efe))
* **connector-ui:** fixed centered logo+badge on screens 1-3, onchain spelling ([e687bce](https://github.com/0xPolygon/polygon-agent-cli/commit/e687bce7fd9df1f3540b571da8ce18acc57da57a))
* **connector-ui:** preserve implicit session metadata, remove tweetnacl, add rid validation ([ca4c4aa](https://github.com/0xPolygon/polygon-agent-cli/commit/ca4c4aa7ce972639e80b3fe4c8cc6abd01db3df1))
* **connector-ui:** relay init error check, rid validation, re-init guard, payload size limit ([509b34f](https://github.com/0xPolygon/polygon-agent-cli/commit/509b34f593478b3b8e4f4c1cdb02ca355e55379c))
* **connector-ui:** remove dollar sign from terminal prefix display ([da70d5f](https://github.com/0xPolygon/polygon-agent-cli/commit/da70d5ffbdbb099d873751e87c046611b39189ce))
* **connector-ui:** remove dollar sign prefix from copied commands ([d8bb2e1](https://github.com/0xPolygon/polygon-agent-cli/commit/d8bb2e1e290f2f57bdc848c894f4dd2be512d5f2))
* **connector-ui:** remove services list card from dashboard ([be3ee92](https://github.com/0xPolygon/polygon-agent-cli/commit/be3ee92ff1ee42d00cc97d0fdb4b7e45a26bd555))
* **connector-ui:** restore >_ agent mono badge on all screens ([d753dd7](https://github.com/0xPolygon/polygon-agent-cli/commit/d753dd72e3c866040f618c8a0262e331681ea9b7))
* **relay:** include code_hash_hex in retrieve response for CLI decryption ([0b713b8](https://github.com/0xPolygon/polygon-agent-cli/commit/0b713b8f380b2f928a0575cc7f2c311177d61d8a))
* **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
* **skills:** update x402 Bazaar endpoints to use POST, update Twitter prompt ([cee084d](https://github.com/0xPolygon/polygon-agent-cli/commit/cee084dc1bdc5dbfffca6209a8734679c8741e82))
* **ui:** shorten lead scoring display text, fix duplicate Target icon ([dd3c976](https://github.com/0xPolygon/polygon-agent-cli/commit/dd3c9761878bbabc377baa7e23a253f484fa000a))
* **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
* **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))


### Features

* **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
* **connector-ui:** add Durable Object relay API + upgrade worker routing ([77a093c](https://github.com/0xPolygon/polygon-agent-cli/commit/77a093cbad4e136fd9ada94da8a667b5ff08a26a))
* **connector-ui:** add Openclaw and Hermes agent options ([e18b076](https://github.com/0xPolygon/polygon-agent-cli/commit/e18b076071ead7223d49732c0202e03f7456a94b))
* **connector-ui:** apply OMSX Figma design system to all screens ([154afbd](https://github.com/0xPolygon/polygon-agent-cli/commit/154afbd28b818add730edc6d3879548b3e5a3743)), closes [#141635](https://github.com/0xPolygon/polygon-agent-cli/issues/141635) [#64708](https://github.com/0xPolygon/polygon-agent-cli/issues/64708) [#c8cfe1](https://github.com/0xPolygon/polygon-agent-cli/issues/c8cfe1) [#929](https://github.com/0xPolygon/polygon-agent-cli/issues/929) [#141635](https://github.com/0xPolygon/polygon-agent-cli/issues/141635) [#7c3](https://github.com/0xPolygon/polygon-agent-cli/issues/7c3) [#f5f6](https://github.com/0xPolygon/polygon-agent-cli/issues/f5f6) [#929](https://github.com/0xPolygon/polygon-agent-cli/issues/929)
* **connector-ui:** enable Mesh onramp in production for TrailsWidget ([93e562b](https://github.com/0xPolygon/polygon-agent-cli/commit/93e562b70c136e5f9bdeb5786df09b63798778c0))
* **connector-ui:** redesign — light theme, code display, funding flow ([63b2fcd](https://github.com/0xPolygon/polygon-agent-cli/commit/63b2fcdf7cb46b44d76e9d441c872098dad21d95))
* **connector-ui:** remove Gemini agent option to prevent chip overflow ([6dacd0f](https://github.com/0xPolygon/polygon-agent-cli/commit/6dacd0f24302924c9feca72b7a284fd4d1c62842))
* **connector-ui:** replace use cases with x402 catalog services ([231fb3a](https://github.com/0xPolygon/polygon-agent-cli/commit/231fb3a2e7f675401f9bca93ccba1fd16c7f2ca7))
* **connector-ui:** v2 session flow — relay encryption + 6-digit code display ([b4ac674](https://github.com/0xPolygon/polygon-agent-cli/commit/b4ac674b13c1965bfe48517b812333ff5b4c5289))
* refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
* **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
* **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
* **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
* **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))





## [1.0.2](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-connector-ui@1.0.1...@polygonlabs/agent-connector-ui@1.0.2) (2026-03-05)


### Bug Fixes

* **publish:** add repository field to package.json files ([b037364](https://github.com/0xPolygon/polygon-agent-cli/commit/b037364323343900a041e16e4b8f7ff92345d95e))





## [1.0.1](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-connector-ui@1.0.0...@polygonlabs/agent-connector-ui@1.0.1) (2026-03-04)

**Note:** Version bump only for package @polygonlabs/agent-connector-ui
