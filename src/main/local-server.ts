// Local HTTP endpoint for the MCP server's event forwarding (ADR-008 §5) and
// Claude Code HTTP hooks. Contract (ADR-012):
//  - bound to 127.0.0.1 on a random free port; random per-launch bearer token
//  - every request: loopback remote address (403), loopback Host header (403),
//    `Authorization: Bearer <token>` (401), POST only (405), JSON body (415/400),
//    size limit (413). No CORS headers are ever sent.
//  - POST /events         body {source:"euta-mcp", protocol:1, pid, sentAt, events:[...]} -> 204
//  - POST /hooks/claude   body = raw Claude Code hook input JSON -> 204, empty body
//    (an empty 2xx never carries a decision, so the app cannot influence Claude).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export const EVENTS_BODY_LIMIT = 4 * 1024 * 1024;
export const HOOKS_BODY_LIMIT = 4 * 1024 * 1024;
export const EVENTS_PROTOCOL = 1;

export interface EventsEnvelope {
  source: string;
  protocol: number;
  pid?: number;
  sentAt?: string;
  events: unknown[];
}

export interface LocalServerHandlers {
  onEvents(envelope: EventsEnvelope): void;
  onHook(payload: unknown): void;
}

export interface LocalServer {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
  /** @internal for tests */
  readonly server: Server;
}

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(addr: string | undefined): boolean {
  return !!addr && LOOPBACK_ADDRS.has(addr);
}

/** Host header must name a loopback host (defends against DNS rebinding). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m?.[1]) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, message?: string): void {
  if (res.headersSent) return;
  if (message) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(message);
  } else {
    res.writeHead(status, { 'Cache-Control': 'no-store' });
    res.end();
  }
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return reject(new BodyTooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function isEventsEnvelope(v: unknown): v is EventsEnvelope {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.source === 'string' && o.protocol === EVENTS_PROTOCOL && Array.isArray(o.events);
}

export function createRequestHandler(token: string, handlers: LocalServerHandlers) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) return send(res, 403, 'forbidden');
      if (!isLoopbackHost(req.headers.host)) return send(res, 403, 'forbidden');
      if (!tokenMatches(req.headers.authorization, token)) return send(res, 401, 'unauthorized');

      const path = (req.url ?? '/').split('?')[0];
      const route = path === '/events' ? 'events' : path === '/hooks/claude' ? 'hooks' : undefined;
      if (!route) return send(res, 404, 'not found');
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, 'method not allowed');
      }
      const ctype = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!ctype.startsWith('application/json')) return send(res, 415, 'expected application/json');

      let body: Buffer;
      try {
        body = await readBody(req, route === 'events' ? EVENTS_BODY_LIMIT : HOOKS_BODY_LIMIT);
      } catch (e) {
        if (e instanceof BodyTooLarge) return send(res, 413, 'payload too large');
        throw e;
      }
      let json: unknown;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        return send(res, 400, 'invalid json');
      }

      if (route === 'events') {
        if (!isEventsEnvelope(json)) return send(res, 400, 'invalid envelope');
        send(res, 204);
        handlers.onEvents(json);
      } else {
        if (!json || typeof json !== 'object' || Array.isArray(json)) return send(res, 400, 'invalid hook payload');
        // Answer first (empty 2xx = no decision), then record.
        send(res, 204);
        handlers.onHook(json);
      }
    } catch {
      send(res, 500);
    }
  };
}

export async function startLocalServer(handlers: LocalServerHandlers, opts: { token?: string; port?: number } = {}): Promise<LocalServer> {
  const token = opts.token ?? newToken();
  const handle = createRequestHandler(token, handlers);
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (req, res) => void handle(req, res));
  server.maxHeadersCount = 50;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
