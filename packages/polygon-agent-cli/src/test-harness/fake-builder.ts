import http from 'node:http';

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export interface FakeBuilder {
  url: string;
  requests: RecordedRequest[];
  /** Makes CreateProject answer 500 from now on. */
  failProjectCreation: () => void;
  close: () => Promise<void>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Answers the three RPC paths `setup` calls, with fixed throwaway values.
export async function startFakeBuilder(): Promise<FakeBuilder> {
  const requests: RecordedRequest[] = [];
  let failCreate = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const path = req.url ?? '';
      requests.push({
        method: req.method ?? '',
        path,
        authorization: req.headers.authorization,
        body: parseJson(raw)
      });
      const reply = (status: number, json: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
      };
      if (path === '/rpc/Builder/GetAuthToken') {
        reply(200, { ok: true, auth: { jwtToken: 'jwt-test' } });
      } else if (path === '/rpc/Builder/CreateProject') {
        if (failCreate) reply(500, { error: 'create failed' });
        else reply(200, { project: { id: 7, name: 'fake-project' } });
      } else if (path === '/rpc/QuotaControl/GetDefaultAccessKey') {
        reply(200, { accessKey: { accessKey: 'ak-test' } });
      } else {
        reply(404, {});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake builder failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    failProjectCreation: () => {
      failCreate = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
