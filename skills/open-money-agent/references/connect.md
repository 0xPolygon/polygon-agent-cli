# Connect and owner requests

**When to use:** status shows `connected: false`, a `pendingRequest`, `mode: "owner"`, or an allowance that can't cover the task; or the user wants to sign in, raise or renew the limit, withdraw to their own wallet, or see or remove access. Not for adding funds ([wallet](wallet.md)).

**Before you start:** run `"$POLYGON_AGENT" wallet status`. Never start a sign-in when the current connection already covers the task, and never log out just to get more access: raise or renew instead.

## Status rows

| Status shows | Do |
|---|---|
| `pendingRequest` | A sign-in is already waiting for what `pendingRequest.approves` says. With `method: "browser"`, a page is open at `pendingRequest.url`: ask the user to finish it there, then run `pendingRequest.next`. With `method: "email"`, a code went to `pendingRequest.email`: ask the user for it and run `pendingRequest.next` with it. Don't start another unless it expired or they can't find it. |
| `connected: false` | Sign in (below). |
| `mode: "owner"` | This install is signed in as the wallet owner (`wallet login --owner`), with no allowance limits. If it uses the user's Polymarket account (`polymarket status` shows `signer: "oms"`), that is why: leave it. Otherwise tell the user briefly, and offer to switch to an allowance: `wallet logout`, then sign in. |
| The allowance expired or is expiring, or `remainingUsd` can't cover the request | Explain, and offer to renew it or raise the limit (below). |

## Sign in

Don't just report that the wallet isn't connected: explain signing in a sentence or two and ask. For example: "Next, sign in so I can use your agent wallet: signing in approves a spending limit for me, nothing more, and your sign-in itself is never kept here. Would you like to sign in now?" Right after an install, open with "Your agent wallet is installed." If they'd rather wait, tell them to just say "sign in to my agent wallet" when they're ready.

1. Once they say yes, ask how much you may spend, suggesting **$1,000 over 30 days**: "How much should I be able to spend on my own? I suggest up to $1,000 over the next 30 days." A plain yes means $1,000 for 30 days. If they ask how it works: the sign-in lets the CLI act as them just long enough to approve a limited key for this install, then signs out; only that key is kept, never their sign-in.
2. Start the connection. Don't ask for an email yet, and don't say how they'll sign in (a page or an emailed code) until the CLI's output tells you: it picks the method and says what it needs. If the user already gave you their email, pass `--email <email>`, so the code goes there.

   ```sh
   "$POLYGON_AGENT" wallet login --allowance <usd> --days <days>
   ```

   Add `--chains polygon,base,…` only if the user asked for different chains; chains where the wallet already holds supported tokens are added on their own.
3. Follow the outcome (the same for every owner request, below):

   | Output | Do |
   |---|---|
   | `status: "waiting"` | Tell the user, for example, "Sign in on the page that just opened to approve $1,000 over 30 days." Take the amount and period from the `plan`, never from memory. If no browser opened or they can't see it, send them `url`. Run `next` (it ends in `--wait`) straight away. It blocks up to about 90 seconds; if it returns `waiting` again, run `next` again until it finishes. |
   | error `email_required` | Ask for the user's email. Never guess it. Run its `command` with the email in place of `<email>`. |
   | `status: "code_sent"` | Tell the user, for example, "I've sent a code to <email>. Paste it here to approve $1,000 over 30 days." (from the `plan`). When the code arrives, run `next` at once: `"$POLYGON_AGENT" wallet confirm --request <id> --code <code>`. Use the code only here, once. |
   | error `invalid_code` | Ask for the code again. |
   | error `request_expired` | Start again at step 2. |
   | error `browser_signin_failed` | The page sign-in stopped. Run its `command` to use an emailed code instead. |
   | error `request_cancelled` | The user cancelled on the page. Ask whether to try again; don't start one on your own. |
   | error `request_in_progress` | A sign-in for this wallet is already finishing. Run the `--wait` command in its `command`. |

   On any other error, follow its `hint` and `command`.
4. Tell the user the result in one short line, for example: "You're connected. I can spend up to $1,000 over the next 30 days." Take the amount and period from `allowance` in the output. If anything is in `failed` or there are `warnings`, say briefly that part of the setup needs a retry, without naming chains, and run the hinted command. Talk about the allowance as a dollar amount and period only. Don't mention chains or tokens.
5. Give the address: end your message with "Your agent wallet address is:" and send the full address as the next message, with nothing else in it. Never shorten it. (If your platform sends only one message per reply, put it alone on its own line.)
6. Then send: "You can see your wallet and add funds here: <dashboard.url>", with `dashboard.url` from the output, sent in full.
7. Don't stop there. In the same reply, go on to what's next: the user's request if they made one (funding first if it costs money and the wallet is empty, see [wallet](wallet.md)), or, if they haven't asked for anything, two or three things to try, as in the index's first run, ending with a question. This holds when the sign-in finishes on a later turn too, after they paste a code or a `next` returns.

## Raising the limit

When the user asks for a higher limit (or more time):

1. Say yes and ask for the details you don't have, for example: "Sure, we can do that. How much would you like me to be able to spend?" `--amount` is the new total: for "raise it by $500", add $500 to the current allowance (`"$POLYGON_AGENT" wallet allowance`).
2. Run `"$POLYGON_AGENT" wallet allowance set --amount <usd>` (for more time, `wallet allowance renew --days <n>`). Handle the outcome as in step 3 above.
3. Once it's approved, confirm in one line: "Done. I can now spend up to $2,000 until Nov 7."

## Owner requests (a new sign-in each time)

```sh
"$POLYGON_AGENT" wallet allowance set [--amount <usd>] [--add <token>@<chain>] [--chains <csv>]
"$POLYGON_AGENT" wallet allowance renew [--days <n>]
"$POLYGON_AGENT" wallet withdraw --to <address> --token <symbol> --amount <n> --chain <chain>   # from the wallet, as the owner
"$POLYGON_AGENT" wallet access [--revoke <id>]          # every install and sign-in with access
"$POLYGON_AGENT" wallet link-credentials                # link this install to the saved address
```

Each uses the same method picker as `wallet login`, and takes `--email <email>` to force an emailed code. Handle the output like step 3 of Sign in:

- `waiting` (browser): tell the user in a line what it approves (the new amount and period, or the withdrawal's amount, token and recipient) and to sign in on the page that opened (or send `url`), then run `next` until it finishes.
- `email_required`: ask for the email, run `command`.
- `code_sent`: show what will be approved, ask for the code from their email, then run `next` (`wallet confirm --request <id> --code <code>`) as soon as they give it.

For a browser request that finished the sign-in, `wallet confirm --request <id> --wait` waits for the result too.

To cover a token or chain the wallet holds but you can't spend, use `wallet allowance set --add <token>@<chain>` (or `--chains <chain>`). Native coins (ETH, POL, BNB, AVAX) can't be covered.

`"$POLYGON_AGENT" wallet logout` removes this install's access without a sign-in. Connecting again needs a new one.

Some features need the owner's full sign-in, which this install never keeps, so no sign-in unlocks them here (`owner_required`): yield deposits and withdrawals, ERC-8004 identity writes and `call`. Sending a native coin isn't possible either (`native_not_supported`). Tell the user, and don't look for a way around it.

## Errors

Session-mode errors carry `code`, `hint` and `command`: `not_connected` (sign in), `not_covered` (add the token or chain), `allowance_exhausted` and `session_expired` (raise or renew), `owner_required` (above), plus the sign-in errors in step 3.
