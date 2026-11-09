// `pnpm release:upload` (scripts/release-upload.mjs) against a fake admin API (API_CONTRACT 단계 17):
// draft → streamed PUTs → publish, platforms in separate runs into the same draft, a published version
// refused, the admin token only ever in the Authorization header (never in the log).
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM build script, no types
import { releaseFiles, uploadRelease } from '../../scripts/release-upload.mjs';

const TOKEN = 'euta_ADMIN-TOKEN-must-not-leak-0123456789';

interface Rel {
  status: 'draft' | 'published';
  notes: string;
  files: Map<string, Buffer>;
}

describe('release:upload', () => {
  let server: Server;
  let url = '';
  let dir: string;
  const releases = new Map<string, Rel>();
  const auth: string[] = [];
  const log: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      auth.push(String(req.headers.authorization));
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const send = (status: number, j: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(j));
        };
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(403, { error: { code: 'FORBIDDEN', message: 'admin only' } });
        const p = new URL(req.url!, 'http://x').pathname;
        if (p === '/api/admin/app-releases' && req.method === 'POST') {
          const { version, notes } = JSON.parse(body.toString());
          if (releases.has(version)) return send(409, { error: { code: 'VERSION_EXISTS', message: 'exists' } });
          releases.set(version, { status: 'draft', notes, files: new Map() });
          return send(201, { version, channel: 'alpha', status: 'draft' });
        }
        if (p === '/api/admin/app-releases' && req.method === 'GET') {
          return send(200, { releases: [...releases].map(([version, r]) => ({ version, status: r.status, files: [...r.files.keys()].map((name) => ({ name })) })) });
        }
        const put = /^\/api\/admin\/app-releases\/([^/]+)\/files\/([^/]+)$/.exec(p);
        if (put && req.method === 'PUT') {
          const r = releases.get(decodeURIComponent(put[1]!));
          if (!r) return send(404, { error: { code: 'NOT_FOUND', message: 'no' } });
          if (r.status !== 'draft') return send(409, { error: { code: 'NOT_DRAFT', message: 'published' } });
          if (req.headers['content-type'] !== 'application/octet-stream') return send(415, {});
          r.files.set(decodeURIComponent(put[2]!), body);
          return send(201, { name: put[2], size: body.length, sha512: createHash('sha512').update(body).digest('base64') });
        }
        const pub = /^\/api\/admin\/app-releases\/([^/]+)\/publish$/.exec(p);
        if (pub && req.method === 'POST') {
          const r = releases.get(decodeURIComponent(pub[1]!))!;
          if (![...r.files.keys()].some((n) => /^latest.*\.yml$/.test(n))) return send(400, { error: { code: 'NO_UPDATE_META', message: 'no yml' } });
          r.status = 'published';
          return send(200, { version: pub[1], publishedAt: '2026-10-30T10:00:00Z' });
        }
        send(404, {});
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    dir = mkdtempSync(join(tmpdir(), 'euta-upload-'));
    const put = (os: string, name: string, bytes: number) => {
      mkdirSync(join(dir, os), { recursive: true });
      writeFileSync(join(dir, os, name), Buffer.alloc(bytes, name.length));
    };
    put('mac', 'euta-0.1.0-alpha.1-mac-arm64.dmg', 300_000);
    put('mac', 'euta-0.1.0-alpha.1-mac-arm64.zip', 200_000);
    put('mac', 'euta-0.1.0-alpha.1-mac-arm64.zip.blockmap', 1_000);
    put('mac', 'latest-mac.yml', 300);
    put('mac', 'builder-debug.yml', 10); // not a release file
    put('win', 'euta-0.1.0-alpha.1-win-x64.exe', 250_000);
    put('win', 'euta-0.1.0-alpha.1-win-x64.exe.blockmap', 900);
    put('win', 'latest.yml', 300);
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('picks only release files per OS', () => {
    expect(releaseFiles(dir, ['mac']).map((f: string) => f.slice(dir.length + 1))).toEqual(['mac/euta-0.1.0-alpha.1-mac-arm64.dmg', 'mac/euta-0.1.0-alpha.1-mac-arm64.zip', 'mac/euta-0.1.0-alpha.1-mac-arm64.zip.blockmap', 'mac/latest-mac.yml']);
  });

  it('mac now, windows later into the same draft, then publish', async () => {
    const r1 = await uploadRelease({ server: `${url}/`, token: TOKEN, version: '0.1.0-alpha.1', notes: '- 첫 배포', files: releaseFiles(dir, ['mac']), log: (l: string) => log.push(l) });
    expect(r1).toEqual({ version: '0.1.0-alpha.1', published: false });
    expect(releases.get('0.1.0-alpha.1')).toMatchObject({ status: 'draft', notes: '- 첫 배포' });
    expect([...releases.get('0.1.0-alpha.1')!.files.keys()]).toHaveLength(4);
    expect(releases.get('0.1.0-alpha.1')!.files.get('euta-0.1.0-alpha.1-mac-arm64.dmg')!.length).toBe(300_000);

    const r2 = await uploadRelease({ server: url, token: TOKEN, version: '0.1.0-alpha.1', notes: '- 첫 배포', files: releaseFiles(dir, ['win']), publish: true, log: (l: string) => log.push(l) });
    expect(r2).toMatchObject({ published: true, publishedAt: '2026-10-30T10:00:00Z' });
    expect(releases.get('0.1.0-alpha.1')!.status).toBe('published');
    expect([...releases.get('0.1.0-alpha.1')!.files.keys()]).toHaveLength(7);
    expect(log.some((l) => l.includes('이어서 올립니다'))).toBe(true);
  });

  it('a published version is refused; no token, wrong token', async () => {
    await expect(uploadRelease({ server: url, token: TOKEN, version: '0.1.0-alpha.1', notes: 'x', files: releaseFiles(dir, ['mac']), log: () => undefined })).rejects.toThrow(/이미 게시/);
    await expect(uploadRelease({ server: url, token: '', version: '0.1.0-alpha.2', notes: 'x', files: [], log: () => undefined })).rejects.toThrow(/EUTA_ADMIN_TOKEN/);
    const err = await uploadRelease({ server: url, token: 'euta_wrong', version: '0.1.0-alpha.2', notes: 'x', files: [], log: () => undefined }).catch((e: Error) => e);
    expect(String(err.message)).toMatch(/HTTP 403 FORBIDDEN/);
    expect(String(err.message)).not.toContain('euta_wrong');
  });

  it('the token goes only into the Authorization header, never into the log', () => {
    expect(auth.filter((a) => a === `Bearer ${TOKEN}`).length).toBeGreaterThan(8);
    expect(log.join('\n')).not.toContain(TOKEN);
  });
});
