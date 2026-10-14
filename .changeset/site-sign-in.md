---
'@polygonlabs/agentconnect-ui': minor
---

Sign in on the site itself. Opening agentconnect without a link from your agent now shows sign-in (email code or Google), then your dashboard, and you stay signed in for 30 days. The worker does the sign-in and sets an HttpOnly session cookie, so it works on every domain, and the saved address, cards, and auto-pay limit accept that cookie as well as the agent's link token. Settings has a Sign out button.
