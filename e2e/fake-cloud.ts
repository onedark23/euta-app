// E2E / unit helper (not a spec): an in-memory fake euta cloud speaking the stage-15 API contract
// (~/.cache/euta-wt/API_CONTRACT.md — roles incl. runner, birth record, visibility, receive list,
// access requests, merge check, `access_lost`) plus the routes the app opens on connect (me, feeds,
// runs, schedules, activity). Only what the app reads is modelled. Device login is approved by the
// test (`approveDevice(userCode, email)`), like a browser would. Not a server implementation.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { scriptHash } from '@euta/core';
import { compareVersions } from '../src/shared/app-version.js';

type Role = 'owner' | 'editor' | 'runner' | 'viewer';
const CAN: Record<Role, string[]> = {
  owner: ['project.view', 'run.execute', 'run.upload', 'schedule.manage', 'script.edit', 'suite.edit', 'environment.edit', 'credential.write', 'project.update', 'member.manage', 'project.visibility', 'project.transfer', 'project.merge', 'project.delete', 'project.restore', 'member.leave'],
  editor: ['project.view', 'run.execute', 'run.upload', 'schedule.manage', 'script.edit', 'suite.edit', 'environment.edit', 'credential.write', 'project.update', 'access.request', 'member.leave'],
  runner: ['project.view', 'run.execute', 'run.upload', 'access.request', 'member.leave'],
  viewer: ['project.view', 'access.request'],
};
const RANK: Record<Role, number> = { viewer: 0, runner: 1, editor: 2, owner: 3 };

interface User {
  id: string;
  email: string;
  name: string;
}
interface Script {
  id: string;
  version: number;
  source: string;
  author: string;
}
interface Env {
  id: string;
  name: string;
  baseUrl: string;
  vars: Record<string, string>;
  credentialNames: string[];
}
interface Suite {
  id: string;
  name: string;
  scriptIds: string[];
  alwaysRun: string[];
  defaultEnvironmentId: string | null;
}
interface AccessRequest {
  id: string;
  userId: string;
  role: 'editor' | 'runner';
  memo: string;
  status: 'open' | 'approved' | 'rejected';
  createdAt: string;
  grantedRole: Role | null;
}
export interface FakeProject {
  id: string;
  name: string;
  description: string;
  visibility: 'org' | 'members';
  origin: 'web' | 'app' | 'unknown';
  originLocalId: string | null;
  createdBy: string;
  createdAt: string;
  members: Map<string, Role>;
  envs: Env[];
  scripts: Map<string, Script>;
  suites: Suite[];
  requests: AccessRequest[];
  seq: number;
  defaultEnvironmentId: string | null;
  merged?: Record<string, unknown>;
}
interface Feed {
  projectId: string;
  userId: string;
  res: ServerResponse;
}

export class FakeCloud {
  url = '';
  private server: Server | undefined;
  readonly users = new Map<string, User>();
  private readonly tokens = new Map<string, string>();
  private readonly codes = new Map<string, { deviceCode: string; token?: string }>();
  readonly projects = new Map<string, FakeProject>();
  private feeds: Feed[] = [];
  private userFeeds: { userId: string; res: ServerResponse }[] = [];
  private userEventId = 1;
  /** Requests seen (method path) — tests assert on them. */
  readonly log: string[] = [];
  /** Stage 17: MIN_APP_VERSION — device-token /api requests from an older app (or without the header) get 426. */
  minVersion: string | undefined;
  /** X-Euta-App-Version per device-token request: `METHOD path → version` (header missing = '-'). */
  readonly appVersions: string[] = [];
  /** `GET /api/config` `appUpdates` (ADR-047). */
  appUpdates = true;
    /** Stage 17: the public update files (`/updates/<channel>/<name>` → body) and `/api/app/releases` answer. */
  readonly updateFiles = new Map<string, string>();
  appReleases: { channel: string; releases: unknown[] } = { channel: 'alpha', releases: [] };

  addUser(email: string, name: string): User {
    const u = { id: randomUUID(), email, name };
    this.users.set(u.id, u);
    return u;
  }

  user(email: string): User {
    const u = [...this.users.values()].find((x) => x.email === email);
    if (!u) throw new Error(`no user ${email}`);
    return u;
  }

  /** The browser side of device authorization: the person `email` approves `userCode`. */
  approveDevice(userCode: string, email: string): void {
    const c = this.codes.get(userCode);
    if (!c) throw new Error(`no device code ${userCode}`);
    const token = `fake-session-${randomBytes(12).toString('hex')}`;
    this.tokens.set(token, this.user(email).id);
    c.token = token;
  }

  byName(name: string): FakeProject {
    const p = [...this.projects.values()].find((x) => x.name === name);
    if (!p) throw new Error(`no project ${name}`);
    return p;
  }

  /** A project made outside the app (web / an old copy-upload = unknown). */
  createProject(o: { name: string; ownerEmail: string; origin?: 'web' | 'unknown' | 'app'; originLocalId?: string; scripts?: Record<string, string>; envs?: { name: string; baseUrl: string }[]; suites?: { name: string; scripts: string[] }[] }): FakeProject {
    const owner = this.user(o.ownerEmail);
    const p: FakeProject = {
      id: randomUUID(),
      name: o.name,
      description: '',
      visibility: 'org',
      origin: o.origin ?? 'web',
      originLocalId: o.originLocalId ?? null,
      createdBy: owner.id,
      createdAt: new Date().toISOString(),
      members: new Map([[owner.id, 'owner']]),
      envs: (o.envs ?? []).map((e) => ({ id: randomUUID(), name: e.name, baseUrl: e.baseUrl, vars: {}, credentialNames: [] })),
      scripts: new Map(Object.entries(o.scripts ?? {}).map(([path, source]) => [path, { id: randomUUID(), version: 1, source, author: owner.name }])),
      suites: [],
      requests: [],
      seq: 1,
      defaultEnvironmentId: null,
    };
    p.defaultEnvironmentId = p.envs[0]?.id ?? null;
    for (const s of o.suites ?? []) p.suites.push({ id: randomUUID(), name: s.name, scriptIds: s.scripts.map((x) => p.scripts.get(x)!.id), alwaysRun: [], defaultEnvironmentId: null });
    this.projects.set(p.id, p);
    return p;
  }

  roleOf(p: FakeProject, userId: string): Role | null {
    return p.members.get(userId) ?? (p.visibility === 'org' ? 'viewer' : null);
  }

  // ---- owner-side changes the tests make "on the web" -----------------------------------------

  setMember(p: FakeProject, email: string, role: Role | null): void {
    const u = this.user(email);
    if (role) p.members.set(u.id, role);
    else p.members.delete(u.id);
    this.change(p, role ? 'member.role_changed' : 'member.removed', { targetId: u.id, ...(role ? { role } : {}) });
  }

  setVisibility(p: FakeProject, v: 'org' | 'members'): void {
    p.visibility = v;
    this.change(p, 'project.visibility_changed', { visibility: v });
  }

  /** A feed row to everyone following the project; followers who can no longer see it get `access_lost`. */
  private change(p: FakeProject, kind: string, data: Record<string, unknown>, actorId: string | null = null): void {
    p.seq++;
    for (const f of this.feeds.filter((x) => x.projectId === p.id)) {
      if (!this.roleOf(p, f.userId)) {
        f.res.write(`event: access_lost\ndata: {"reason":"not_visible"}\n\n`);
        f.res.end();
        this.feeds = this.feeds.filter((x) => x !== f);
        continue;
      }
      f.res.write(`id: ${p.seq}\nevent: change\ndata: ${JSON.stringify({ kind, actorId, data })}\n\n`);
    }
  }

  private notify(userId: string, kind: string, projectId: string, data: Record<string, unknown>): void {
    const id = this.userEventId++;
    const ev = { id, kind, at: new Date().toISOString(), projectId, runId: null, data };
    for (const f of this.userFeeds.filter((x) => x.userId === userId)) f.res.write(`id: ${id}\nevent: notification\ndata: ${JSON.stringify(ev)}\n\n`);
  }

  // ---- DTOs ---------------------------------------------------------------------------------

  private projectDto(p: FakeProject, userId: string): Record<string, unknown> {
    const role = this.roleOf(p, userId)!;
    const by = this.users.get(p.createdBy);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      browser: { engine: 'chromium' },
      testRules: '',
      teamsWebhookConfigured: false,
      defaultEnvironmentId: p.defaultEnvironmentId,
      runTimeLimitSec: 600,
      notify: { skipped: false, aborted: false, passed: false, flaky: false },
      dailyRunCap: 50,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
      myRole: role,
      can: CAN[role],
      visibility: p.visibility,
      isMember: p.members.has(userId),
      birth: { origin: p.origin, originLocalId: p.originLocalId, createdBy: by ? { id: by.id, name: by.name } : null, createdAt: p.createdAt },
    };
  }

  private receivable(p: FakeProject, userId: string): Record<string, unknown> {
    const role = this.roleOf(p, userId)!;
    const open = p.requests.find((r) => r.userId === userId && r.status === 'open');
    const by = this.users.get(p.createdBy);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      createdBy: by ? { id: by.id, name: by.name } : null,
      origin: p.origin,
      originLocalId: p.originLocalId,
      visibility: p.visibility,
      myRole: role,
      lastRun: null,
      canRequestAccess: role !== 'owner' && role !== 'editor' && !open,
      openRequest: open ? { id: open.id, role: open.role, createdAt: open.createdAt, expiresAt: open.createdAt } : null,
    };
  }

  private scriptDto(path: string, s: Script): Record<string, unknown> {
    return { id: s.id, path, version: s.version, contentHash: scriptHash(s.source), validationOk: true, updatedAt: '', updatedBy: { id: 'x', name: s.author } };
  }

  private envDto(p: FakeProject, e: Env): Record<string, unknown> {
    return { id: e.id, name: e.name, baseUrl: e.baseUrl, vars: e.vars, allowedDomains: [new URL(e.baseUrl).hostname], cloudRunnable: true, addressCheck: { public: true }, isDefault: p.defaultEnvironmentId === e.id, credentialNames: e.credentialNames };
  }

  private suiteDto(p: FakeProject, s: Suite): Record<string, unknown> {
    const pathOf = (id: string) => [...p.scripts].find(([, v]) => v.id === id)?.[0] ?? null;
    return { id: s.id, name: s.name, scripts: s.scriptIds.map((id) => ({ id, path: pathOf(id) })), alwaysRun: s.alwaysRun, defaultEnvironmentId: s.defaultEnvironmentId };
  }

  private requestDto(p: FakeProject, r: AccessRequest): Record<string, unknown> {
    const u = this.users.get(r.userId)!;
    return { id: r.id, projectId: p.id, projectName: p.name, user: { id: u.id, name: u.name, email: u.email }, role: r.role, memo: r.memo, status: r.status, createdAt: r.createdAt, expiresAt: r.createdAt, decidedAt: null, decidedBy: null, grantedRole: r.grantedRole };
  }

  // ---- HTTP ---------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        try {
          this.route(req, res, body ? JSON.parse(body) : undefined);
        } catch (e) {
          this.json(res, 500, { error: { code: 'INTERNAL', message: String((e as Error).message) } });
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  async stop(): Promise<void> {
    for (const f of [...this.feeds, ...this.userFeeds]) f.res.end();
    this.feeds = [];
    this.userFeeds = [];
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  private err(res: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
    this.json(res, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } });
  }

  private sse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.on('close', () => {
      this.feeds = this.feeds.filter((f) => f.res !== res);
      this.userFeeds = this.userFeeds.filter((f) => f.res !== res);
    });
  }

  private route(req: IncomingMessage, res: ServerResponse, body: any): void {
    const u = new URL(req.url ?? '/', 'http://x');
    const m = req.method ?? 'GET';
    const path = u.pathname;
    this.log.push(`${m} ${path}`);
    if (path === '/api/auth/device/code') {
      const userCode = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
      const deviceCode = randomBytes(8).toString('hex');
      this.codes.set(userCode, { deviceCode });
      return this.json(res, 200, { device_code: deviceCode, user_code: userCode, verification_uri: `${this.url}/device`, verification_uri_complete: `${this.url}/device?user_code=${userCode}`, expires_in: 600, interval: 1 });
    }
    if (path === '/api/auth/device/token') {
      const c = [...this.codes.values()].find((x) => x.deviceCode === body?.device_code);
      return c?.token ? this.json(res, 200, { access_token: c.token }) : this.json(res, 400, { error: 'authorization_pending' });
    }
    if (path === '/api/auth/sign-out') return this.json(res, 200, {});
    // Public update routes (no login, no version check — API_CONTRACT 단계 17).
    if (path.startsWith('/updates/')) {
      const f = this.updateFiles.get(path);
      if (f === undefined) return this.err(res, 404, 'NOT_FOUND', 'no such update file');
      res.writeHead(200, { 'content-type': path.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream', 'cache-control': 'no-store' });
      return void res.end(f);
    }
    if (path === '/api/app/releases') return this.json(res, 200, this.appReleases);
    // Public config (ADR-047): this fake distributes app updates → the app's update source is this server.
    if (path === '/api/config') return this.json(res, 200, { signUpMode: 'approval', allowedEmailDomains: [], microsoftLogin: false, appUpdates: this.appUpdates });
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const userId = auth ? this.tokens.get(auth) : undefined;
    if (!userId) return this.err(res, 401, 'UNAUTHENTICATED', 'sign in');
    const appVersion = req.headers['x-euta-app-version'] as string | undefined;
    this.appVersions.push(`${m} ${path} → ${appVersion ?? '-'}`);
    if (this.minVersion && (!appVersion || compareVersions(appVersion, this.minVersion) < 0)) {
      return this.json(res, 426, { code: 'APP_TOO_OLD', minVersion: this.minVersion, error: { code: 'APP_TOO_OLD', message: 'update the app' } });
    }
    const me = this.users.get(userId)!;
    if (path === '/api/me') return this.json(res, 200, { id: me.id, email: me.email, name: me.name, isAdmin: false });
    if (path === '/api/me/events') {
      this.sse(req, res);
      res.write(`id: ${this.userEventId}\nevent: ready\ndata: {}\n\n`);
      this.userFeeds.push({ userId, res });
      return;
    }
    if (path === '/api/users') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      return this.json(res, 200, { users: [...this.users.values()].filter((x) => x.email.startsWith(q) || x.name.toLowerCase().startsWith(q)) });
    }
    if (path === '/api/projects/receivable' && m === 'GET') {
      const visible = [...this.projects.values()].filter((p) => this.roleOf(p, userId)).sort((a, b) => a.name.localeCompare(b.name));
      return this.json(res, 200, { mine: visible.filter((p) => p.members.has(userId)).map((p) => this.receivable(p, userId)), org: visible.filter((p) => !p.members.has(userId)).map((p) => this.receivable(p, userId)) });
    }
    if (path === '/api/projects' && m === 'GET') return this.json(res, 200, { projects: [...this.projects.values()].filter((p) => this.roleOf(p, userId) && (u.searchParams.get('scope') !== 'mine' || p.members.has(userId))).map((p) => this.projectDto(p, userId)) });
    if (path === '/api/projects' && m === 'POST') {
      if (body.origin === 'app') {
        const prev = [...this.projects.values()].find((p) => p.origin === 'app' && p.originLocalId === body.originLocalId && p.createdBy === userId);
        if (prev) return this.json(res, 200, { ...this.projectDto(prev, userId), resumed: true });
      }
      const p = this.createProject({ name: body.name, ownerEmail: me.email, origin: body.origin === 'app' ? 'app' : 'web', ...(body.originLocalId ? { originLocalId: body.originLocalId } : {}) });
      return this.json(res, 201, this.projectDto(p, userId));
    }
    const pm = /^\/api\/projects\/([0-9a-f-]{36})(\/.*)?$/.exec(path);
    if (!pm) return this.err(res, 404, 'NOT_FOUND', `no route ${m} ${path}`);
    const p = this.projects.get(pm[1]!);
    const role = p ? this.roleOf(p, userId) : null;
    if (!p || !role) return this.err(res, 404, 'NOT_FOUND', 'project not found');
    const rest = pm[2] ?? '';
    const can = (a: string) => CAN[role].includes(a);
    const forbid = () => this.err(res, 403, 'FORBIDDEN', 'not allowed for your role');
    if (rest === '' && m === 'GET') return this.json(res, 200, this.projectDto(p, userId));
    if (rest === '/events') {
      this.sse(req, res);
      const last = u.searchParams.get('lastEventId');
      res.write(last !== null && Number(last) < p.seq ? `id: ${p.seq}\nevent: resync\ndata: {}\n\n` : `id: ${p.seq}\nevent: ready\ndata: {"seq":${p.seq}}\n\n`);
      this.feeds.push({ projectId: p.id, userId, res });
      return;
    }
    if (rest === '/environments' && m === 'GET') return this.json(res, 200, { environments: p.envs.map((e) => this.envDto(p, e)) });
    if (rest === '/environments' && m === 'POST') {
      if (!can('environment.edit')) return forbid();
      if (p.envs.some((e) => e.name === body.name)) return this.err(res, 409, 'CONFLICT', 'environment name taken');
      const e: Env = { id: randomUUID(), name: body.name, baseUrl: body.baseUrl, vars: body.vars ?? {}, credentialNames: [] };
      p.envs.push(e);
      if (body.makeDefault || !p.defaultEnvironmentId) p.defaultEnvironmentId = e.id;
      this.change(p, 'environment.created', { id: e.id }, userId);
      return this.json(res, 201, this.envDto(p, e));
    }
    if (rest === '/suites' && m === 'GET') return this.json(res, 200, { suites: p.suites.map((s) => this.suiteDto(p, s)) });
    if (rest === '/suites' && m === 'POST') {
      if (!can('suite.edit')) return forbid();
      const s: Suite = { id: randomUUID(), name: body.name, scriptIds: body.scriptIds ?? [], alwaysRun: body.alwaysRun ?? [], defaultEnvironmentId: body.defaultEnvironmentId ?? null };
      p.suites.push(s);
      this.change(p, 'suite.created', { id: s.id }, userId);
      return this.json(res, 201, this.suiteDto(p, s));
    }
    const sm = /^\/suites\/([0-9a-f-]{36})$/.exec(rest);
    if (sm && m === 'PATCH') {
      if (!can('suite.edit')) return forbid();
      const s = p.suites.find((x) => x.id === sm[1]);
      if (!s) return this.err(res, 404, 'NOT_FOUND', 'suite');
      if (body.name !== undefined) s.name = body.name;
      if (body.scriptIds) s.scriptIds = body.scriptIds;
      if (body.alwaysRun) s.alwaysRun = body.alwaysRun;
      this.change(p, 'suite.updated', { id: s.id }, userId);
      return this.json(res, 200, this.suiteDto(p, s));
    }
    if (rest === '/scripts' && m === 'GET') return this.json(res, 200, { scripts: u.searchParams.get('deleted') ? [] : [...p.scripts].map(([k, v]) => this.scriptDto(k, v)) });
    if (rest.startsWith('/scripts/')) {
      const sp = decodeURIComponent(rest.slice('/scripts/'.length));
      if (sp.endsWith('/versions')) return this.json(res, 200, { versions: [] });
      if (m === 'GET') {
        const s = p.scripts.get(sp);
        return s ? this.json(res, 200, { ...this.scriptDto(sp, s), source: s.source }) : this.err(res, 404, 'NOT_FOUND', 'script');
      }
      if (m === 'PUT') {
        if (!can('script.edit')) return forbid();
        const cur = p.scripts.get(sp);
        if ((cur?.version ?? null) !== (body.baseVersion ?? null)) return this.err(res, 409, 'SCRIPT_CONFLICT', 'changed', { current: cur ? { version: cur.version, source: cur.source, author: { id: 'x', name: cur.author }, createdAt: '' } : null });
        const s = { id: cur?.id ?? randomUUID(), version: (cur?.version ?? 0) + 1, source: body.source, author: me.name };
        p.scripts.set(sp, s);
        this.change(p, cur ? 'script.saved' : 'script.created', { path: sp, version: s.version }, userId);
        return this.json(res, cur ? 200 : 201, { script: this.scriptDto(sp, s), version: {}, unchanged: false });
      }
    }
    if (rest === '/members' && m === 'GET') return this.json(res, 200, { members: [...p.members].map(([id, r]) => ({ userId: id, email: this.users.get(id)!.email, name: this.users.get(id)!.name, role: r, active: true, addedAt: p.createdAt })) });
    const mm = /^\/members\/([0-9a-f-]{36})$/.exec(rest);
    if (mm) {
      if (!can('member.manage')) return forbid();
      const target = this.users.get(mm[1]!);
      if (!target) return this.err(res, 404, 'NOT_FOUND', 'user');
      this.setMember(p, target.email, m === 'DELETE' ? null : body.role);
      return m === 'DELETE' ? this.json(res, 204, undefined) : this.json(res, 200, { userId: target.id, email: target.email, name: target.name, role: body.role, active: true });
    }
    if (rest === '/visibility' && m === 'PUT') {
      if (!can('project.visibility')) return forbid();
      this.setVisibility(p, body.visibility);
      return this.json(res, 200, this.projectDto(p, userId));
    }
    if (rest === '/access-requests' && m === 'POST') {
      if (!can('access.request')) return forbid();
      if (p.requests.some((r) => r.userId === userId && r.status === 'open')) return this.err(res, 409, 'REQUEST_OPEN', 'open request exists');
      if (RANK[body.role as Role] <= RANK[role]) return this.err(res, 409, 'ALREADY_HAS_ROLE', 'already has role');
      const r: AccessRequest = { id: randomUUID(), userId, role: body.role, memo: body.memo ?? '', status: 'open', createdAt: new Date().toISOString(), grantedRole: null };
      p.requests.push(r);
      for (const [uid, rr] of p.members) if (rr === 'owner') this.notify(uid, 'access.requested', p.id, { projectName: p.name, requestId: r.id, requester: { id: me.id, name: me.name }, role: r.role, memo: r.memo });
      return this.json(res, 201, this.requestDto(p, r));
    }
    if (rest === '/access-requests' && m === 'GET') {
      const st = u.searchParams.get('status');
      const list = p.requests.filter((r) => (can('member.manage') || r.userId === userId) && (!st || r.status === st));
      return this.json(res, 200, { requests: list.map((r) => this.requestDto(p, r)) });
    }
    const am = /^\/access-requests\/([0-9a-f-]{36})\/(approve|reject)$/.exec(rest);
    if (am) {
      if (!can('member.manage')) return forbid();
      const r = p.requests.find((x) => x.id === am[1]);
      if (!r || r.status !== 'open') return this.err(res, 409, 'REQUEST_CLOSED', 'closed');
      const requester = this.users.get(r.userId)!;
      if (am[2] === 'approve') {
        r.status = 'approved';
        r.grantedRole = (body?.role as Role) ?? r.role;
        p.members.set(r.userId, r.grantedRole);
        this.change(p, 'access.approved', { targetId: r.userId, role: r.grantedRole }, userId);
        this.notify(r.userId, 'access.approved', p.id, { projectName: p.name, requestId: r.id, role: r.role, grantedRole: r.grantedRole });
      } else {
        r.status = 'rejected';
        this.notify(r.userId, 'access.rejected', p.id, { projectName: p.name, requestId: r.id, role: r.role });
      }
      return this.json(res, 200, this.requestDto(p, r));
    }
    if (rest === '/merge/check' || rest === '/merge') {
      if (p.origin === 'web') return this.err(res, 403, 'ORIGIN_MISMATCH', 'web origin', { reason: 'web_origin' });
      if (p.origin === 'app' && p.originLocalId !== body.localProjectId) return this.err(res, 403, 'ORIGIN_MISMATCH', 'local id mismatch', { reason: 'local_id_mismatch' });
      if (role !== 'owner') return this.err(res, 403, 'FORBIDDEN', 'not owner', { reason: 'not_owner' });
      if (p.origin === 'unknown' && (body.uploadedTo?.projectId !== p.id || body.uploadedTo?.localId !== p.id.replace(/-/g, ''))) return this.err(res, 403, 'ORIGIN_MISMATCH', 'link mismatch', { reason: 'link_mismatch' });
      if (rest === '/merge') {
        p.origin = 'app';
        p.originLocalId = body.localProjectId;
        p.merged = body.summary ?? {};
        this.change(p, 'project.merged', {}, userId);
        return this.json(res, 200, { ok: true, project: this.projectDto(p, userId) });
      }
      return this.json(res, 200, { ok: true, origin: p.origin, project: this.projectDto(p, userId) });
    }
    if (rest === '/runs' && m === 'GET') return this.json(res, 200, { runs: [] });
    if (rest === '/schedules' && m === 'GET') return this.json(res, 200, { schedules: [] });
    if (rest === '/activity' && m === 'GET') return this.json(res, 200, { entries: [] });
    return this.err(res, 404, 'NOT_FOUND', `no route ${m} ${path}`);
  }
}
