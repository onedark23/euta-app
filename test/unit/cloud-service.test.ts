// CloudService + ProjectService against a fake euta cloud (fetch-level): device login and token
// at rest, opening a cloud project (snapshot + feed resync), credential dual status (cloud / this
// PC), the pending queue across offline → reconnect, viewer read-only, the editor conflict view.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptHash } from '@euta/core';
import { CloudService } from '../../src/main/cloud/cloud-service.js';
import { compactId, WorkingCopy } from '../../src/main/cloud/workcopy.js';
import { LiveStore } from '../../src/main/live-store.js';
import { ProjectService } from '../../src/main/project/service.js';
import { toModel, toPayload } from '../../src/shared/script-model.js';
import { allFiles, mockSafeStorage } from './helpers.js';

const TOKEN = 'device-session-token-SECRET-0123456789';
const CRED_VALUE = 'cloud-credential-value-should-never-be-stored';
const PC_VALUE = 'this-pc-value-encrypted-only';
const PID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const ENV = 'aaaaaaaa-bbbb-cccc-dddd-0000000000e1';
const SCRIPT = (name: string, path = '/') => `version: 1\nname: ${name}\ntarget:\n  baseUrl: \${env.BASE_URL}\nsteps:\n  - goto: ${path}\n`;

const until = async (fn: () => boolean, ms = 10_000): Promise<void> => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Minimal in-memory euta cloud speaking the real routes. */
class FakeCloud {
  down = false;
  role: 'owner' | 'editor' | 'viewer' = 'editor';
  seq = 3;
  approved = false;
  credentialValues = new Map<string, string>();
  env = { id: ENV, name: 'dev', baseUrl: 'https://dev.example.com', vars: { LANG: 'ko' }, allowedDomains: ['dev.example.com'], cloudRunnable: true, addressCheck: { public: true }, isDefault: true, credentialNames: ['USER_PASSWORD'] };
  scripts = new Map<string, { id: string; version: number; source: string; author: string }>([['login.yaml', { id: 's-login', version: 1, source: SCRIPT('Login', '/login'), author: 'Other' }]]);
  puts: string[] = [];
  /** Server suites; `alwaysRun` absent = a server from before ADR-031. */
  suites: { id: string; name: string; scriptIds: string[]; alwaysRun?: string[] }[] = [];
  suiteBodies: Record<string, unknown>[] = [];

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError('fetch failed');
    const u = new URL(url);
    const m = init.method ?? 'GET';
    const auth = (init.headers as Record<string, string>).authorization;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const p = u.pathname;
    if (p === '/api/auth/device/code') return ok({ device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_uri: 'http://cloud.test/device', verification_uri_complete: 'http://cloud.test/device?user_code=ABCD-EFGH', expires_in: 900, interval: 1 });
    if (p === '/api/auth/device/token') return this.approved ? ok({ access_token: TOKEN }) : ok({ error: 'authorization_pending' }, 400);
    if (auth !== `Bearer ${TOKEN}`) return ok({ error: { code: 'UNAUTHENTICATED', message: 'sign in' } }, 401);
    if (p === '/api/me') return ok({ id: 'u-me', email: 'me@example.com', name: '나', isAdmin: false });
    const base = `/api/projects/${PID}`;
    if (p === base) return ok({ id: PID, name: 'Shared Portal', description: 'cloud', browser: { engine: 'chromium' }, testRules: '게시 금지', defaultEnvironmentId: ENV, myRole: this.role, can: this.role === 'viewer' ? ['project.view'] : ['project.view', 'script.edit', 'credential.write'], updatedAt: '' });
    if (p === `${base}/environments`) return ok({ environments: [this.env] });
    const suiteDto = (x: { id: string; name: string; scriptIds: string[]; alwaysRun?: string[] }) => ({
      id: x.id,
      name: x.name,
      scripts: x.scriptIds.map((sid) => ({ id: sid, path: [...this.scripts].find(([, v]) => v.id === sid)?.[0] ?? null })),
      ...(x.alwaysRun ? { alwaysRun: x.alwaysRun } : {}),
      defaultEnvironmentId: null,
    });
    if (p === `${base}/suites` && m === 'GET') return ok({ suites: this.suites.map(suiteDto) });
    if (p === `${base}/suites` && m === 'POST') {
      const x = { id: `aaaaaaaa-bbbb-cccc-dddd-00000000005${this.suites.length}`, name: body.name, scriptIds: body.scriptIds ?? [], alwaysRun: body.alwaysRun ?? [] };
      this.suites.push(x);
      this.suiteBodies.push(body);
      return ok(suiteDto(x), 201);
    }
    const su = this.suites.find((x) => p === `${base}/suites/${x.id}`);
    if (su && m === 'PATCH') {
      this.suiteBodies.push(body);
      Object.assign(su, body.name !== undefined ? { name: body.name } : {}, body.scriptIds ? { scriptIds: body.scriptIds } : {}, body.alwaysRun ? { alwaysRun: body.alwaysRun } : {});
      return ok(suiteDto(su));
    }
    if (p === `${base}/events`) {
      const enc = new TextEncoder();
      const signal = init.signal!;
      const stream = new ReadableStream<Uint8Array>({
        start: (ctl) => {
          ctl.enqueue(enc.encode(`id: ${this.seq}\nevent: ready\ndata: {"seq":${this.seq}}\n\n`));
          signal.addEventListener('abort', () => ctl.error(new Error('aborted')));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const cred = new RegExp(`^${base}/environments/${ENV}/credentials/(\\w+)$`).exec(p);
    if (cred && m === 'PUT') {
      this.credentialValues.set(cred[1]!, body.value);
      if (!this.env.credentialNames.includes(cred[1]!)) this.env.credentialNames = [...this.env.credentialNames, cred[1]!].sort();
      return ok({ name: cred[1] });
    }
    const dto = (path: string) => {
      const s = this.scripts.get(path)!;
      return { id: s.id, path, version: s.version, contentHash: scriptHash(s.source), validationOk: true, updatedAt: '', updatedBy: { id: 'x', name: s.author } };
    };
    if (p === `${base}/scripts` && m === 'GET') return ok({ scripts: u.searchParams.get('deleted') ? [] : [...this.scripts.keys()].map(dto) });
    const sp = p.startsWith(`${base}/scripts/`) ? decodeURIComponent(p.slice(`${base}/scripts/`.length)) : undefined;
    if (sp && m === 'GET') return this.scripts.has(sp) ? ok({ ...dto(sp), source: this.scripts.get(sp)!.source }) : ok({ error: { code: 'NOT_FOUND', message: 'nf' } }, 404);
    if (sp && m === 'PUT') {
      this.puts.push(`${sp}@${body.baseVersion}`);
      const cur = this.scripts.get(sp);
      if ((cur?.version ?? null) !== (body.baseVersion ?? null)) {
        return ok({ error: { code: 'SCRIPT_CONFLICT', message: 'changed', details: { current: cur ? { version: cur.version, source: cur.source, author: { id: 'x', name: cur.author }, createdAt: '' } : null } } }, 409);
      }
      this.scripts.set(sp, { id: cur?.id ?? `s-${sp}`, version: (cur?.version ?? 0) + 1, source: body.source, author: '나' });
      this.seq++;
      return ok({ script: dto(sp), version: {}, unchanged: false }, cur ? 200 : 201);
    }
    return ok({ error: { code: 'NOT_FOUND', message: `no route ${m} ${p}` } }, 404);
  };
}

describe('CloudService (fake cloud)', () => {
  let root: string;
  let userData: string;
  let live: LiveStore;
  let svc: ProjectService;
  let cloud: CloudService;
  const fake = new FakeCloud();
  const ss = mockSafeStorage();
  const opened: string[] = [];
  let id = '';

  const make = () => {
    svc = new ProjectService({ userData, safeStorage: ss, live, watch: false, platform: 'darwin' });
    cloud = new CloudService({ userData, safeStorage: ss, projects: svc, fetch: fake.fetch, openExternal: (u) => opened.push(u), retry: { min: 50, max: 100 } });
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'euta-cloud-svc-'));
    userData = join(root, 'userData');
    live = new LiveStore({ throttleMs: 0 });
    make();
  });
  afterAll(async () => {
    cloud?.dispose();
    await svc?.dispose();
    live?.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('device login: code shown, browser opened, token stored as ciphertext only', async () => {
    expect(cloud.status().state).toBe('none');
    expect(cloud.setServer('http://cloud.test/').state).toBe('signed_out');
    const st = await cloud.login();
    expect(st.login?.userCode).toBe('ABCD-EFGH');
    expect(opened).toEqual(['http://cloud.test/device?user_code=ABCD-EFGH']);
    fake.approved = true;
    await until(() => cloud.status().state === 'online', 5000);
    expect(cloud.status().user).toMatchObject({ email: 'me@example.com', name: '나' });
    expect(readFileSync(join(userData, 'cloud', 'account.json'), 'utf8')).not.toContain(TOKEN);
  });

  it('opens a cloud project: snapshot → project, feed `ready` → full resync of scripts', async () => {
    const items = await cloud.receiveList().catch(() => ({ mine: [], org: [] }));
    expect(items).toEqual({ mine: [], org: [] }); // the fake has no list route; opening works by id
    id = await cloud.openRemote(PID);
    expect(id).toBe(compactId(PID));
    const v = svc.open(id);
    expect(v.cloud?.projectId).toBe(PID);
    expect(v.dirs.root).toBe(join(userData, 'cloud', cloud.account.serverId, 'projects', PID));
    expect(v.cloudView).toMatchObject({ role: 'editor', readOnly: false, online: true, pending: 0, testRules: '게시 금지' });
    await until(() => svc.scripts(id).some((s) => s.path === 'login.yaml'));
    expect(svc.scripts(id).find((s) => s.path === 'login.yaml')?.cloud).toMatchObject({ version: 1, pending: false });
    expect(new WorkingCopy(v.dirs.root).state().lastSeq).toBe(3);
  });

  it('test credentials: "클라우드: 등록됨 / 이 PC: 없음" and both sides set separately', async () => {
    const envId = compactId(ENV);
    let env = svc.view(id).environments[0]!;
    expect(env.id).toBe(envId);
    expect(env.cloud?.credentialNames).toEqual(['USER_PASSWORD']);
    expect(env.secretNames).toEqual([]);
    // This PC's value: local vault, keyed by the cloud project/env ids; the server is not touched.
    svc.setSecret(id, envId, 'USER_PASSWORD', PC_VALUE);
    env = svc.view(id).environments[0]!;
    expect(env.secretNames).toEqual(['USER_PASSWORD']);
    expect(svc.runContext(id, envId).secrets).toEqual({ USER_PASSWORD: PC_VALUE });
    expect(fake.credentialValues.size).toBe(0);
    // Cloud value: passed to the server only.
    await cloud.setCredential(id, envId, 'API_SECRET', CRED_VALUE);
    env = svc.view(id).environments[0]!;
    expect(env.cloud?.credentialNames).toEqual(['API_SECRET', 'USER_PASSWORD']);
    expect(env.secretNames).toEqual(['USER_PASSWORD']);
    expect(fake.credentialValues.get('API_SECRET')).toBe(CRED_VALUE);
  });

  it('test set "항상 실행" round-trips: local paths ↔ server script ids; an old server without the field still loads', async () => {
    let v = await cloud.upsertSuite(id, undefined, { name: '정리 포함', scripts: ['login.yaml', 'login.yaml'] });
    const sid = v.suites[0]!.id;
    expect(v.suites[0]).toMatchObject({ name: '정리 포함', scripts: ['login.yaml', 'login.yaml'], stopOnFailure: false });
    expect(v.suites[0]!.alwaysRun).toBeUndefined();
    v = await cloud.upsertSuite(id, sid, { alwaysRun: ['login.yaml'] });
    expect(fake.suiteBodies.at(-1)).toEqual({ alwaysRun: ['s-login'] });
    expect(v.suites[0]!.alwaysRun).toEqual(['login.yaml']);
    // "실패 시 중단" stays on this PC and survives the next snapshot; the mark comes from the server.
    await cloud.upsertSuite(id, sid, { stopOnFailure: true });
    v = await cloud.upsertSuite(id, sid, { name: '정리 포함 2' });
    expect(v.suites[0]).toMatchObject({ name: '정리 포함 2', stopOnFailure: true, alwaysRun: ['login.yaml'] });
    delete fake.suites[0]!.alwaysRun;
    v = await cloud.upsertSuite(id, sid, { name: '정리 포함' });
    expect(v.suites[0]).toMatchObject({ scripts: ['login.yaml', 'login.yaml'], stopOnFailure: true });
    expect(v.suites[0]!.alwaysRun).toBeUndefined();
  });

  it('offline saves wait in pending/ and are sent in order after reconnect', async () => {
    fake.down = true;
    await cloud.probe();
    expect(cloud.status().state).toBe('offline');
    expect(svc.view(id).cloudView?.online).toBe(false);
    const r1 = svc.writeScript(id, 'login.yaml', SCRIPT('Login', '/login?a=1'), 'user');
    const r2 = svc.writeScript(id, 'new.yaml', SCRIPT('New'), 'user', { exclusive: true, kind: 'create' });
    expect(!r1.conflict && (await r1.cloud!.outcome)).toEqual({ kind: 'queued', reason: 'offline' });
    expect(!r2.conflict && r2.cloud).toBeTruthy();
    expect(svc.scripts(id).filter((s) => s.cloud?.pending).map((s) => s.path)).toEqual(['login.yaml', 'new.yaml']);
    expect(cloud.status().pending).toBe(2);
    fake.down = false;
    await until(() => cloud.status().state === 'online', 5000);
    await until(() => cloud.status().pending === 0, 5000);
    expect(fake.puts.slice(-2)).toEqual(['login.yaml@1', 'new.yaml@null']);
    expect(fake.scripts.get('login.yaml')?.version).toBe(2);
  });

  it('editor save over a newer server version → the 3-choice conflict view', async () => {
    const d = svc.scriptDetail(id, 'login.yaml');
    fake.scripts.set('login.yaml', { id: 's-login', version: 3, source: SCRIPT('Login (other)', '/login'), author: 'Other' });
    const edit = toModel(d.script!);
    edit.header.name = 'Login (mine)';
    const r = await cloud.saveScript(id, 'login.yaml', d.text, toPayload(edit));
    expect(r.ok).toBe(false);
    const c = !r.ok && 'cloudConflict' in r ? r.cloudConflict : undefined;
    expect(c).toMatchObject({ path: 'login.yaml', status: 'conflict', server: { version: 3, author: 'Other' }, copyPath: 'login-나.yaml', laterSaves: 0 });
    expect(c?.header).toContain('이름');
    expect(svc.view(id).cloudView?.blocked?.ticket).toBe(c?.ticket);
    // ③ my text as a copy; the original takes the server version.
    await cloud.resolveConflict(id, c!.ticket, 'copy');
    expect(fake.scripts.get('login-나.yaml')?.source).toContain('Login (mine)');
    expect(svc.readLocalScript(id, 'login.yaml')).toBe(SCRIPT('Login (other)', '/login'));
    expect(svc.view(id).cloudView?.blocked).toBeUndefined();
  });

  it('viewer: read-only, saves refused', async () => {
    fake.role = 'viewer';
    await cloud.resync(id);
    expect(svc.view(id).cloudView).toMatchObject({ role: 'viewer', readOnly: true });
    expect(() => svc.writeScript(id, 'login.yaml', SCRIPT('x'), 'user')).toThrow(/보기 전용/);
    fake.role = 'editor';
    await cloud.resync(id);
  });

  it('restart keeps the working copy; no token or credential value in plaintext under userData', async () => {
    cloud.dispose();
    await svc.dispose();
    make();
    expect(svc.list().find((p) => p.id === id)?.cloud).toMatchObject({ role: 'editor', pending: 0 });
    expect(cloud.status().state).toBe('offline'); // until the startup probe
    cloud.start();
    await until(() => cloud.status().state === 'online', 5000);
    for (const f of allFiles(userData)) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toContain(TOKEN);
      expect(text, f).not.toContain(CRED_VALUE);
      expect(text, f).not.toContain(PC_VALUE);
    }
    await cloud.logout();
    expect(svc.view(id).cloudView?.needsLogin).toBe(true);
    expect(readFileSync(join(userData, 'cloud', 'account.json'), 'utf8')).not.toContain('token');
  });
});
