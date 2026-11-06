import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { connect } from 'node:net';
import { isLoopbackAddress, isLoopbackHost, startLocalServer, type EventsEnvelope, type LocalServer } from '../../src/main/local-server.js';

interface Res {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function call(srv: LocalServer, path: string, opts: { method?: string; token?: string | null; body?: string; ctype?: string; host?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? srv.token}`;
    if (opts.ctype !== '') headers['Content-Type'] = opts.ctype ?? 'application/json';
    if (opts.host) headers.Host = opts.host;
    const req = request({ host: '127.0.0.1', port: srv.port, path, method: opts.method ?? 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const envelope = (events: unknown[]): string =>
  JSON.stringify({ source: 'euta-mcp', protocol: 1, pid: 42, sentAt: new Date().toISOString(), events } satisfies EventsEnvelope);

describe('local server', () => {
  let srv: LocalServer | undefined;
  const got: { events: EventsEnvelope[]; hooks: unknown[] } = { events: [], hooks: [] };
  const start = async (): Promise<LocalServer> => {
    got.events = [];
    got.hooks = [];
    srv = await startLocalServer({ onEvents: (e) => got.events.push(e), onHook: (h) => got.hooks.push(h) });
    return srv;
  };
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it('binds to 127.0.0.1 on a random port with a random 64-hex token', async () => {
    const s = await start();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(s.port).toBeGreaterThan(0);
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
    const addr = s.server.address();
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1');
    const other = await startLocalServer({ onEvents() {}, onHook() {} });
    expect(other.token).not.toBe(s.token);
    await other.close();
  });

  it('rejects requests without / with a wrong bearer token (401)', async () => {
    const s = await start();
    expect((await call(s, '/events', { token: null, body: envelope([]) })).status).toBe(401);
    expect((await call(s, '/events', { token: 'nope', body: envelope([]) })).status).toBe(401);
    expect((await call(s, '/hooks/claude', { token: null, body: '{}' })).status).toBe(401);
    expect(got.events).toHaveLength(0);
    expect(got.hooks).toHaveLength(0);
  });

  it('accepts a valid token (204, empty body) and never sends CORS headers', async () => {
    const s = await start();
    const r = await call(s, '/events', { body: envelope([{ type: 'log', runId: 'r1', seq: 1 }]) });
    expect(r.status).toBe(204);
    expect(r.body).toBe('');
    expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
    expect(got.events).toHaveLength(1);
    expect(got.events[0]?.pid).toBe(42);
    const opt = await call(s, '/events', { method: 'OPTIONS' });
    expect(opt.status).toBe(405);
    expect(Object.keys(opt.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
  });

  it('rejects non-loopback remote addresses (403) before checking the token', async () => {
    const s = await start();
    s.server.prependListener('connection', (sock) => Object.defineProperty(sock, 'remoteAddress', { value: '192.168.1.20' }));
    const r = await call(s, '/events', { body: envelope([]) });
    expect(r.status).toBe(403);
    expect(got.events).toHaveLength(0);
  });

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const s = await start();
    expect((await call(s, '/events', { host: `evil.example:${s.port}`, body: envelope([]) })).status).toBe(403);
    expect((await call(s, '/events', { host: `localhost:${s.port}`, body: envelope([]) })).status).toBe(204);
  });

  it('validates method, content type, JSON and envelope; 404 for other paths', async () => {
    const s = await start();
    expect((await call(s, '/events', { method: 'GET' })).status).toBe(405);
    expect((await call(s, '/events', { ctype: 'text/plain', body: envelope([]) })).status).toBe(415);
    expect((await call(s, '/events', { body: '{not json' })).status).toBe(400);
    expect((await call(s, '/events', { body: JSON.stringify({ source: 'x', protocol: 2, events: [] }) })).status).toBe(400);
    expect((await call(s, '/events', { body: JSON.stringify({ source: 'x', protocol: 1, events: {} }) })).status).toBe(400);
    expect((await call(s, '/hooks/claude', { body: '[1,2]' })).status).toBe(400);
    expect((await call(s, '/nope', { body: '{}' })).status).toBe(404);
    expect(got.events).toHaveLength(0);
  });

  it('enforces the body size limit (413)', async () => {
    const s = await start();
    const big = JSON.stringify({ source: 'euta-mcp', protocol: 1, events: [], pad: 'x'.repeat(5 * 1024 * 1024) });
    // Raw socket: the server answers 413 while the client is still writing, so the
    // client side may see EPIPE — swallow it and just read the status line.
    const rawStatus = (chunked: boolean): Promise<string> =>
      new Promise((resolve) => {
        const sock = connect(s.port, '127.0.0.1');
        let buf = '';
        sock.on('error', () => undefined);
        sock.on('data', (c) => {
          buf += c.toString();
          if (buf.includes('\r\n')) {
            resolve(buf.split('\r\n')[0]!);
            sock.destroy();
          }
        });
        const len = chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${Buffer.byteLength(big)}`;
        sock.write(`POST /events HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAuthorization: Bearer ${s.token}\r\nContent-Type: application/json\r\n${len}\r\n\r\n`);
        const payload = chunked ? `${Buffer.byteLength(big).toString(16)}\r\n${big}\r\n0\r\n\r\n` : big;
        sock.write(payload, () => undefined);
      });
    expect(await rawStatus(false)).toContain('413');
    expect(await rawStatus(true)).toContain('413');
    expect(got.events).toHaveLength(0);
  });

  it('accepts Claude Code hook payloads with an empty 2xx', async () => {
    const s = await start();
    const hook = { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'hello', cwd: '/tmp' };
    const r = await call(s, '/hooks/claude', { body: JSON.stringify(hook) });
    expect(r.status).toBe(204);
    expect(r.body).toBe('');
    expect(got.hooks).toEqual([hook]);
  });

  it('loopback helpers', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackHost('127.0.0.1:1234')).toBe(true);
    expect(isLoopbackHost('[::1]:1234')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});
