// Cloud HTTP client + SSE parser (ADR-025): bearer header, JSON-only device token request,
// error mapping, change-feed stream parsing.
import { describe, expect, it } from 'vitest';
import { CloudClient, CloudError, CloudNetworkError, normalizeServerUrl, type FetchLike } from '../../src/main/cloud/client.js';
import { SseParser } from '../../src/main/cloud/sse.js';

describe('SseParser', () => {
  it('parses id/event/data across chunk boundaries, ignores comments, keeps lastEventId', () => {
    const p = new SseParser();
    expect(p.push('retry: 3000\n\n: keep-alive\n\nid: 4\nevent: rea')).toEqual([]);
    expect(p.push('dy\ndata: {"seq":4}\n\nid: 5\r\nevent: change\r\ndata: {"a":1,\r\ndata: "b":2}\r\n\r')).toEqual([{ id: '4', event: 'ready', data: '{"seq":4}' }]);
    expect(p.push('\n')).toEqual([{ id: '5', event: 'change', data: '{"a":1,\n"b":2}' }]);
    expect(p.lastEventId).toBe('5');
    expect(p.retry).toBe(3000);
    expect(p.push('data: plain\n\n')).toEqual([{ event: 'message', data: 'plain' }]);
  });
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchLike & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('CloudClient', () => {
  it('normalizes server addresses', () => {
    expect(normalizeServerUrl(' https://euta.example.com/ ')).toBe('https://euta.example.com');
    expect(normalizeServerUrl('http://127.0.0.1:8080/base/')).toBe('http://127.0.0.1:8080/base');
    expect(() => normalizeServerUrl('ftp://x')).toThrow();
    expect(() => normalizeServerUrl('https://u:p@x')).toThrow();
  });

  it('sends the bearer token and maps error envelopes', async () => {
    const f = fakeFetch((url) => (url.endsWith('/api/me') ? json(200, { id: 'u1', email: 'a@example.com', name: 'A', isAdmin: false }) : json(409, { error: { code: 'SCRIPT_CONFLICT', message: 'changed', details: { current: { version: 3 } } } })));
    const c = new CloudClient('http://cloud.test', () => 'tok-123', f);
    expect((await c.me()).name).toBe('A');
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
    const err = await c.putScript('p', 'dir/a b.yaml', { source: 'x', baseVersion: 1, origin: 'app' }).catch((e) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err).toMatchObject({ status: 409, code: 'SCRIPT_CONFLICT', details: { current: { version: 3 } } });
    expect(f.calls[1]!.url).toBe('http://cloud.test/api/projects/p/scripts/dir/a%20b.yaml');
    expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({ source: 'x', baseVersion: 1, origin: 'app' });
  });

  it('unreachable servers become CloudNetworkError', async () => {
    const c = new CloudClient('http://cloud.test', () => undefined, async () => {
      throw new TypeError('fetch failed');
    });
    await expect(c.me()).rejects.toBeInstanceOf(CloudNetworkError);
    const g = new CloudClient('http://cloud.test', () => undefined, async () => new Response('bad gateway', { status: 502 }));
    await expect(g.me()).rejects.toBeInstanceOf(CloudNetworkError);
  });

  it('device token polling posts JSON (never form encoding) and returns RFC 8628 errors as values', async () => {
    let n = 0;
    const f = fakeFetch((_url, init) => {
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
      return ++n === 1 ? json(400, { error: 'authorization_pending', error_description: 'wait' }) : json(200, { access_token: 'sess-token', token_type: 'Bearer' });
    });
    const c = new CloudClient('http://cloud.test', () => undefined, f);
    expect(await c.deviceToken('dc')).toEqual({ error: 'authorization_pending', error_description: 'wait' });
    expect(await c.deviceToken('dc')).toEqual({ access_token: 'sess-token' });
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dc', client_id: 'euta-app' });
  });

  it('streams the change feed (ready, change, resync) with ?lastEventId=', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(enc.encode('retry: 3000\n\nid: 7\nevent: ready\ndata: {"seq":7}\n\n'));
        ctl.enqueue(enc.encode('id: 8\nevent: change\ndata: {"seq":8,"kind":"script.saved","at":"x","actorId":"u2","data":{"path":"a.yaml","version":2}}\n\n'));
        ctl.enqueue(enc.encode(': keep-alive\n\nid: 9\nevent: resync\ndata: {"seq":9}\n\n'));
        ctl.close();
      },
    });
    const f = fakeFetch(() => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const c = new CloudClient('http://cloud.test', () => 't', f);
    const got = [];
    for await (const ev of c.events('p1', 6, new AbortController().signal)) got.push(ev);
    expect(f.calls[0]!.url).toBe('http://cloud.test/api/projects/p1/events?lastEventId=6');
    expect(got).toEqual([
      { event: 'ready', seq: 7 },
      { event: 'change', seq: 8, kind: 'script.saved', actorId: 'u2', data: { path: 'a.yaml', version: 2 } },
      { event: 'resync', seq: 9 },
    ]);
    const denied = new CloudClient('http://cloud.test', () => 't', async () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } }));
    await expect(denied.events('p1', null, new AbortController().signal).next()).rejects.toMatchObject({ status: 401 });
  });
});
