---
'@polygonlabs/agentconnect-ui': patch
---

Refresh the dashboard and sign-in pages with a new design. Navigation is grouped into Overview, Markets, Yield and Settings; agent prompts open from one panel on every page; and phones get a header with a slide-out menu.

Alongside the new design:

- The yearly estimate on the Yield page uses each vault's own rate instead of applying one vault's rate to everything.
- The balance at the top of Overview always equals the sum of the three figures under it, and waits for all of them before showing a total.
- Activity no longer lists incoming transfers of tokens that have no known decimals and no dollar value, such as airdropped spam tokens that read "+0". Anything leaving the wallet is always listed.
- Add money opens as a bottom sheet on phones, like withdraw and receive.
