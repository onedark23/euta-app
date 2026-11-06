// E2E helper (not a spec): a real euta cloud server for the app E2E — the sibling repo's docker
// compose PostgreSQL + its built server (`../euta-cloud/packages/server/dist/main.js`) on a fresh
// database, admin-approval sign-up mode (no SMTP). Nothing in euta-cloud is modified.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOUD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../euta-cloud');
const SERVER_DIR = join(CLOUD_DIR, 'packages/server');
const COMPOSE = join(CLOUD_DIR, 'deploy/docker-compose.yml');
export const PASSWORD = 'correct-horse-battery-e2e';

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

function psql(sql: string): void {
  const r = spawnSync('docker', ['compose', '-f', COMPOSE, 'exec', '-T', 'db', 'psql', '-U', 'euta', '-d', 'euta', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr || r.stdout}`);
}

export interface Res {
  status: number;
  body: any;
  cookie?: string;
}

export class CloudTestServer {
  url = '';
  private proc: ChildProcess | undefined;
  private port = 0;
  private internalPort = 0;
  private readonly db = `euta_app_e2e_${randomBytes(4).toString('hex')}`;
  private readonly env: Record<string, string>;

  constructor(
    private readonly tmp: string,
    readonly adminEmail: string,
    /** Extra server environment (C3 E2E: RUNNER_TOKEN, ALLOW_PRIVATE_TARGETS=true — dev/test only). */
    extraEnv: Record<string, string> = {},
  ) {
    this.env = {
      ...extraEnv,
      DATABASE_URL: `postgres://euta:euta-dev-only@127.0.0.1:55432/${this.db}`,
      BETTER_AUTH_SECRET: randomBytes(24).toString('hex'),
      CREDENTIALS_KEY: randomBytes(32).toString('base64'),
      ADMIN_EMAILS: adminEmail,
      ALLOWED_EMAIL_DOMAINS: 'example.com',
      AUTH_RATE_LIMIT: 'false',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      RESULTS_DIR: join(tmp, 'cloud-results'),
    };
  }

  static available(): string | undefined {
    if (!existsSync(join(SERVER_DIR, 'dist/main.js'))) return `euta-cloud server is not built (${SERVER_DIR}/dist) — run pnpm build in euta-cloud`;
    const d = spawnSync('docker', ['info'], { encoding: 'utf8' });
    if (d.status !== 0) return 'docker is not running';
    return undefined;
  }

  /** Internal runner API (`/internal/*`, runner token) — for a local runner process. */
  get internalUrl(): string {
    return `http://127.0.0.1:${this.internalPort}`;
  }

  async start(): Promise<void> {
    mkdirSync(this.tmp, { recursive: true });
    const up = spawnSync('docker', ['compose', '-f', COMPOSE, 'up', '-d', '--wait', 'db'], { encoding: 'utf8' });
    if (up.status !== 0) throw new Error(`docker compose up failed: ${up.stderr}`);
    psql(`CREATE DATABASE ${this.db}`);
    this.port = await freePort();
    this.internalPort = await freePort();
    this.url = `http://127.0.0.1:${this.port}`;
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    const log = createWriteStream(join(this.tmp, 'cloud-server.log'), { flags: 'a' });
    this.proc = spawn(process.execPath, ['dist/main.js'], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...this.env, PORT: String(this.port), INTERNAL_PORT: String(this.internalPort), BASE_URL: this.url, SMTP_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout!.pipe(log);
    this.proc.stderr!.pipe(log);
    const t0 = Date.now();
    for (;;) {
      if (this.proc.exitCode !== null) throw new Error(`cloud server exited (${this.proc.exitCode}) — see ${join(this.tmp, 'cloud-server.log')}`);
      try {
        if ((await fetch(`${this.url}/healthz`)).ok) return;
      } catch {
        /* not yet */
      }
      if (Date.now() - t0 > 30_000) throw new Error('cloud server did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Stop the server process (the database stays) — "offline" for the apps. */
  async stop(): Promise<void> {
    const p = this.proc;
    this.proc = undefined;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((res) => {
      p.once('exit', () => res());
      p.kill('SIGTERM');
      setTimeout(() => p.kill('SIGKILL'), 5000);
    });
  }

  /** Same port, same database: sessions (device tokens) survive. */
  async restart(): Promise<void> {
    await this.stop();
    await this.spawn();
  }

  async dispose(): Promise<void> {
    await this.stop();
    try {
      psql(`DROP DATABASE IF EXISTS ${this.db} WITH (FORCE)`);
    } catch {
      /* best effort */
    }
  }

  async req(method: string, path: string, o: { cookie?: string; body?: unknown } = {}): Promise<Res> {
    const r = await fetch(`${this.url}${path}`, {
      method,
      headers: { origin: this.url, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: o.cookie } : {}) },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await r.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0]).filter(Boolean);
    return { status: r.status, body, ...(cookies.length ? { cookie: cookies.join('; ') } : {}) };
  }

  async signUp(email: string, name: string): Promise<void> {
    const r = await this.req('POST', '/api/auth/sign-up/email', { body: { email, password: PASSWORD, name } });
    if (r.status >= 400) throw new Error(`sign-up ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  }

  /** Web sign-in (cookie session) — what the browser would hold when approving a device. */
  async signIn(email: string): Promise<string> {
    const r = await this.req('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
    if (r.status !== 200 || !r.cookie) throw new Error(`sign-in ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.cookie;
  }

  async approveUser(adminCookie: string, email: string): Promise<void> {
    const users = (await this.req('GET', '/api/admin/users', { cookie: adminCookie })).body.users as { id: string; email: string; status: string }[];
    const u = users.find((x) => x.email === email);
    if (!u) throw new Error(`no user ${email}`);
    if (u.status === 'pending') {
      const r = await this.req('POST', `/api/admin/users/${u.id}/approve`, { cookie: adminCookie });
      if (r.status !== 200) throw new Error(`approve ${email}: ${r.status}`);
    }
  }

  /** The browser side of device authorization: claim the code, then approve it (ADR-023 결과). */
  async approveDevice(cookie: string, userCode: string): Promise<void> {
    const claim = await this.req('GET', `/api/auth/device?user_code=${encodeURIComponent(userCode)}`, { cookie });
    if (claim.status !== 200) throw new Error(`device claim: ${claim.status} ${JSON.stringify(claim.body)}`);
    const ok = await this.req('POST', '/api/auth/device/approve', { cookie, body: { userCode } });
    if (ok.status !== 200) throw new Error(`device approve: ${ok.status} ${JSON.stringify(ok.body)}`);
  }
}
