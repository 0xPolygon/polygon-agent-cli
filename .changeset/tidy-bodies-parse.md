---
'@polygonlabs/agentconnect-ui': patch
'@polygonlabs/oidc-relay': patch
---

Reject malformed requests with a clear 400 error

The sign-in, approval and connector endpoints now validate the shape of every request body up front, so a body of the wrong type gets a plain error naming the problem instead of failing partway through. Valid requests behave exactly as before.
