// In-process fake zeus Decision API v1 for contract tests (node:http, no dep).
// Each test assigns `route(req)` to decide the scripted response; the server
// records every request (method, path, auth header, decoded body) so tests can
// assert the wire shape the client sends.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  json?: unknown;
}

export interface FakeZeus {
  baseUrl: string;
  requests: FakeRequest[];
  route: (req: FakeRequest) => FakeResponse;
  close: () => Promise<void>;
}

export async function startFakeZeus(): Promise<FakeZeus> {
  const requests: FakeRequest[] = [];
  // Replaced by each test; default 201 decisions response.
  let route: (req: FakeRequest) => FakeResponse = () => ({
    status: 201,
    json: {
      decisionId: 'dec_1',
      grade: 'D2',
      mode: 'approve-sync',
      status: 'awaiting_approval',
      ruleId: 'd2-org',
      auditSeq: 0,
    },
  });

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = {};
      if (raw !== '') {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          body = raw;
        }
      }
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      const fakeReq: FakeRequest = { method: req.method ?? 'GET', pathname, headers, body };
      requests.push(fakeReq);
      const out = route(fakeReq);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(out.json === undefined ? '' : JSON.stringify(out.json));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    set route(fn: (req: FakeRequest) => FakeResponse) {
      route = fn;
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** Build an online client pointed at the fake server with injected sleep. */
export function makeDeps(baseUrl: string, token = 'test-token') {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { baseUrl, token, sleep, sleeps };
}
