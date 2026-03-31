// packages/connector-ui/worker.mjs
import { handleRelayRequest, SessionRelay } from './src/relay.ts';

export { SessionRelay };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Route /api/relay/* to Durable Object relay
    if (url.pathname.startsWith('/api/relay')) {
      return handleRelayRequest(request, env);
    }

    if (!env.ASSETS) {
      return new Response('ASSETS binding is missing', { status: 500 });
    }

    // SPA fallback: serve index.html for non-file paths
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;

    if (/\.[a-z0-9]+$/i.test(url.pathname)) return res;

    const indexUrl = new URL(request.url);
    indexUrl.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
  }
};
