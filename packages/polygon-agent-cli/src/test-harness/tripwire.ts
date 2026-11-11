import http from 'node:http';

export interface Tripwire {
  url: string;
  /** Every outbound attempt the child made, as `CONNECT host:port` or `METHOD url`. */
  hits: string[];
  close: () => Promise<void>;
}

// A proxy that records and refuses what reaches it, so "made no call" becomes an
// assertion on `hits`. It sees fetch, Node's default http(s) agent and the global
// WebSocket; a library with its own agent or a raw socket goes around it unseen.
export async function startTripwire(): Promise<Tripwire> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method ?? 'GET'} ${req.url ?? ''}`);
    res.writeHead(403).end();
  });
  server.on('connect', (req, socket) => {
    hits.push(`CONNECT ${req.url ?? ''}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('tripwire failed to bind');
  const { port } = address;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
