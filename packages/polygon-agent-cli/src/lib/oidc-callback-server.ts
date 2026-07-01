// Short-lived localhost callback server for the browser OIDC login flow.
//
// The OMS OIDC redirect sends the user to Google; after login the relay bounces
// the browser back to a loopback URL we host here. We capture that single
// callback request, hand the full URL back to the caller (who passes it to
// completeOidcRedirectAuth), serve a "you can close this tab" page, and shut
// down. The server binds to 127.0.0.1 on an ephemeral port and `unref()`s so it
// never keeps the CLI process alive on its own.

import type { AddressInfo } from 'node:net';

import http from 'node:http';

export interface OidcCallbackServer {
  /** The loopback redirect URI to pass to startOidcRedirectAuth. */
  redirectUri: string;
  /** Resolves with the full callback URL once the browser hits /callback. */
  waitForCallbackUrl: Promise<string>;
  /** Idempotently stop the server. */
  close(): void;
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Login complete</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0a1f;color:#ece8f7;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
.box{text-align:center;max-width:420px;padding:32px}
h1{font-size:20px;margin:0 0 8px}p{color:#9a92b8;font-size:14px;line-height:1.5}</style></head>
<body><div class="box"><h1>You're signed in</h1>
<p>Login complete. You can close this tab and return to your terminal.</p></div></body></html>`;

const ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Login failed</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0a1f;color:#ece8f7;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
.box{text-align:center;max-width:420px;padding:32px}
h1{font-size:20px;margin:0 0 8px}p{color:#9a92b8;font-size:14px;line-height:1.5}</style></head>
<body><div class="box"><h1>Login failed</h1>
<p>Something went wrong. Return to your terminal for details.</p></div></body></html>`;

/**
 * Start the loopback callback server. Resolves once it's listening, with the
 * derived redirectUri and a promise that fires on the callback.
 *
 * @param opts.port    Explicit port, or 0/undefined for an OS-assigned one.
 * @param opts.timeoutMs  Reject waitForCallbackUrl if no callback arrives in time.
 */
export function startOidcCallbackServer(opts: {
  port?: number;
  timeoutMs: number;
}): Promise<OidcCallbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let settled = false;
    let resolveUrl!: (url: string) => void;
    let rejectUrl!: (err: Error) => void;
    const waitForCallbackUrl = new Promise<string>((res, rej) => {
      resolveUrl = res;
      rejectUrl = rej;
    });

    const server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      // Ignore favicon/prefetch and anything that isn't the callback so a stray
      // browser request doesn't prematurely resolve the flow.
      if (path !== '/callback') {
        res.statusCode = 204;
        res.end();
        return;
      }
      const isError = (req.url ?? '').includes('error=');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(isError ? ERROR_HTML : SUCCESS_HTML, () => {
        // Resolve with the full absolute URL the SDK expects (it parses
        // code/state/error from the query string).
        const port = (server.address() as AddressInfo).port;
        if (!settled) {
          settled = true;
          resolveUrl(`http://localhost:${port}${req.url}`);
        }
        close();
      });
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectUrl(new Error('Browser login timed out. Re-run, or use `wallet login`.'));
        close();
      }
    }, opts.timeoutMs);

    let closed = false;
    function close(): void {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      server.close();
    }

    server.on('error', (err) => {
      // Surface listen errors (e.g. EADDRINUSE on an explicit --port) clearly.
      if (!settled) {
        settled = true;
        rejectUrl(err);
      }
      rejectServer(err);
    });

    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.unref(); // never block process exit on the listener
      resolveServer({
        redirectUri: `http://localhost:${port}/callback`,
        waitForCallbackUrl,
        close
      });
    });
  });
}
