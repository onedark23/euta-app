// C3 app side against a fake euta cloud (fetch level): run location "클라우드" (local blockers + server
// precheck, request → Live "클라우드" view, feed run.* → refresh, cancel, 422 daily cap / precheck text),
// History merge, opening a cloud run (download into cloud-runs/<id>/ + replay, 2 GB LRU shrunk for the test,
// "파일 만료"), "클라우드에 올리기" (tar = run folder contents with run.json at the top, version vs 로컬 수정본),
// schedules (path → script id, cadence labels), app notifications (stream, resume, backlog fold, off), and
// the invite search with its 404 fallback.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar-stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptHash } from '@euta/core';
import { CloudService } from '../../src/main/cloud/cloud-service.js';
import { CloudError } from '../../src/main/cloud/client.js';
import { CloudNotifier, notificationText } from '../../src/main/cloud/notifications.js';
import { packRunDir, problemText, runRequestError, toRunView } from '../../src/main/cloud/runs.js';
import { cadenceLabel } from '../../src/main/cloud/schedules.js';
import type { RunDetailDto, UserEventDto } from '../../src/main/cloud/types.js';
import { compactId, WorkingCopy } from '../../src/main/cloud/workcopy.js';
import { LiveStore } from '../../src/main/live-store.js';
import { ProjectService } from '../../src/main/project/service.js';
import { mergeHistory } from '../../src/shared/history-merge.js';
import type { CloudRunItem, HistoryItem } from '../../src/shared/types.js';
import { mockSafeStorage } from './helpers.js';

const TOKEN = 'device-token-c3-0123456789abcdef';
const PID = 'aaaaaaaa-bbbb-cccc-dddd-000000000c03';
const ENV = 'aaaaaaaa-bbbb-cccc-dddd-0000000000e3';
const SUITE = 'aaaaaaaa-bbbb-cccc-dddd-00000000005e';
const SRC = 'version: 1\nname: Login\ntarget:\n  baseUrl: ${env.BASE_URL}\nsteps:\n  - goto: /login\n';

const until = async (fn: () => boolean, ms = 10_000): Promise<void> => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const runDto = (o: Partial<RunDetailDto> & { id: string }): RunDetailDto => ({
  kind: 'script',
  status: 'queued',
  flaky: false,
  parentRunId: null,
  orderIndex: null,
  script: { id: 's-login', path: 'login.yaml', version: 1, contentHash: scriptHash(SRC) },
  suite: null,
  environment: { id: ENV, name: 'dev' },
  source: 'app',
  requestedBy: { id: 'u-me', label: '나' },
  runnerLocation: null,
  queuedAt: '2026-10-21T01:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  summary: null,
  currentStep: null,
  error: null,
  stopRequested: null,
  resultFiles: 'none',
  scheduleId: null,
  scheduledFor: null,
  attempt: 1,
  retryOfRunId: null,
  skipReason: null,
  localModified: false,
  steps: [],
  metrics: [],
  expects: [],
  ...o,
});

/** In-memory euta cloud with the C3 routes the app uses. */
class Fake {
  runs = new Map<string, RunDetailDto>();
  files = new Map<string, Record<string, Buffer>>();
  precheck: { ok: boolean; problems: unknown[] } = { ok: true, problems: [] };
  capReached = false;
  usersRoute = true;
  uploads: { query: URLSearchParams; entries: string[]; runJson: Record<string, unknown> }[] = [];
  schedules: Record<string, unknown>[] = [];
  scheduleBodies: Record<string, unknown>[] = [];
  feed: ReadableStreamDefaultController<Uint8Array>[] = [];
  seq = 1;
  role: 'owner' | 'editor' | 'viewer' = 'owner';
  putMemberIds: string[] = [];
  private n = 0;

  pushFeed(kind: string, data: Record<string, unknown>): void {
    this.seq++;
    const line = `id: ${this.seq}\nevent: change\ndata: ${JSON.stringify({ seq: this.seq, kind, actorId: null, data })}\n\n`;
    for (const c of this.feed) c.enqueue(new TextEncoder().encode(line));
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const m = init.method ?? 'GET';
    const p = u.pathname;
    const ok = (b: unknown, status = 200) => new Response(b === undefined ? null : JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const err = (status: number, code: string, message: string, details?: unknown) => ok({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status);
    if (p === '/api/auth/device/code') return ok({ device_code: 'dc', user_code: 'AAAA-BBBB', verification_uri: 'http://c3.test/device', expires_in: 900, interval: 1 });
    if (p === '/api/auth/device/token') return ok({ access_token: TOKEN });
    if ((init.headers as Record<string, string>).authorization !== `Bearer ${TOKEN}`) return err(401, 'UNAUTHENTICATED', 'sign in');
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    if (p === '/api/me') return ok({ id: 'u-me', email: 'me@example.com', name: '나', isAdmin: false });
    if (p === '/api/users') return this.usersRoute ? ok({ users: [{ id: 'u-kim', name: '김', email: 'kim@example.com' }].filter((x) => x.email.startsWith(u.searchParams.get('q') ?? '')) }) : err(404, 'NOT_FOUND', 'Route GET:/api/users not found');
    const base = `/api/projects/${PID}`;
    if (p === base) return ok({ id: PID, name: 'C3', description: '', browser: { engine: 'chromium' }, testRules: '', defaultEnvironmentId: ENV, myRole: this.role, can: this.role === 'viewer' ? ['project.view'] : ['project.view', 'script.edit', 'run.execute', 'run.upload', 'schedule.manage', 'member.manage'], updatedAt: '' });
    if (p === `${base}/environments`) return ok({ environments: [{ id: ENV, name: 'dev', baseUrl: 'https://dev.example.com', vars: {}, allowedDomains: ['dev.example.com'], cloudRunnable: true, addressCheck: { public: true }, isDefault: true, credentialNames: [] }] });
    if (p === `${base}/suites`) return ok({ suites: [{ id: SUITE, name: 'smoke', scripts: [{ id: 's-login', path: 'login.yaml' }], defaultEnvironmentId: null }] });
    if (p === `${base}/scripts`) return ok({ scripts: u.searchParams.get('deleted') ? [] : [{ id: 's-login', path: 'login.yaml', version: 1, contentHash: scriptHash(SRC), validationOk: true, updatedAt: '', updatedBy: null }] });
    if (p === `${base}/scripts/login.yaml`) return ok({ id: 's-login', path: 'login.yaml', version: 1, contentHash: scriptHash(SRC), validationOk: true, updatedAt: '', updatedBy: null, source: SRC });
    if (p === `${base}/events`) {
      const signal = init.signal!;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          this.feed.push(c);
          c.enqueue(new TextEncoder().encode(`id: ${this.seq}\nevent: ready\ndata: {}\n\n`));
          signal.addEventListener('abort', () => {
            this.feed = this.feed.filter((x) => x !== c);
            c.error(new Error('aborted'));
          });
        },
      });
      return new Response(stream, { status: 200 });
    }
    if (p === '/api/me/events') return new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
    if (p === `${base}/members`) return ok({ members: [{ userId: 'u-me', email: 'me@example.com', name: '나', role: 'owner', active: true }] });
    const mem = new RegExp(`^${base}/members/(.+)$`).exec(p);
    if (mem && m === 'PUT') {
      this.putMemberIds.push(mem[1]!);
      return ok({});
    }
    if (p === `${base}/runs/precheck`) return ok({ ...this.precheck, environment: { id: ENV, name: 'dev' }, credentialNames: ['USER_PASSWORD'], scripts: [] });
    if (p === `${base}/runs/upload` && m === 'POST') {
      const entries: string[] = [];
      let runJson: Record<string, unknown> = {};
      const ex = tar.extract();
      const done = (async () => {
        for await (const e of ex) {
          entries.push(e.header.name);
          const chunks: Buffer[] = [];
          for await (const c of e) chunks.push(c as Buffer);
          if (e.header.name === 'run.json') runJson = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
      })();
      Readable.from([Buffer.from(init.body as Uint8Array)]).pipe(ex);
      await done;
      if (!entries.includes('run.json')) return err(422, 'RUN_JSON_MISSING', 'no run.json at the top level');
      this.uploads.push({ query: u.searchParams, entries, runJson });
      const id = `00000000-0000-0000-0000-00000000u${String(++this.n).padStart(3, '0')}`;
      const linked = runJson.scriptHash === scriptHash(SRC);
      const dto = runDto({ id, status: runJson.status as 'passed', source: 'local_upload', runnerLocation: 'PC — 나', resultFiles: 'present', localModified: !linked, script: { id: 's-login', path: u.searchParams.get('scriptPath')!, version: linked ? 1 : null, contentHash: null }, startedAt: '2026-10-21T00:30:00.000Z' });
      this.runs.set(id, dto);
      return ok(dto, 201);
    }
    if (p === `${base}/runs` && m === 'POST') {
      if (this.capReached) return err(422, 'DAILY_RUN_CAP_REACHED', 'daily run cap reached', { cap: 50, used: 50, day: '2026-10-21' });
      if (!this.precheck.ok) return err(422, 'OS_INPUT_NOT_ALLOWED', 'precheck failed', this.precheck.problems);
      const id = `00000000-0000-0000-0000-0000000000${String(++this.n).padStart(2, '0')}`;
      const dto = body.suiteId
        ? runDto({ id, kind: 'suite', script: null, suite: { id: SUITE, name: 'smoke' }, children: [runDto({ id: `${id}-c1`, parentRunId: id })] })
        : runDto({ id });
      this.runs.set(id, dto);
      return ok(dto, 201);
    }
    if (p === `${base}/runs` && m === 'GET') {
      const st = u.searchParams.get('status');
      return ok({ runs: [...this.runs.values()].filter((r) => !r.parentRunId && (!st || r.status === st)) });
    }
    const run = new RegExp(`^${base}/runs/([^/]+)(/cancel|/files(?:/(.*))?)?$`).exec(p);
    if (run) {
      const r = this.runs.get(run[1]!);
      if (!r) return err(404, 'NOT_FOUND', 'run');
      if (run[2] === '/cancel') {
        r.status = 'cancelled';
        return ok(r);
      }
      if (run[2] === '/files') return ok({ resultFiles: r.resultFiles, files: Object.entries(this.files.get(r.id) ?? {}).map(([path, b]) => ({ path, size: b.length })) });
      if (run[3] !== undefined) {
        const b = this.files.get(r.id)?.[decodeURIComponent(run[3])];
        return b ? new Response(b, { status: 200 }) : err(404, 'NOT_FOUND', 'file');
      }
      return ok(r);
    }
    if (p === `${base}/schedules` && m === 'GET') return ok({ schedules: this.schedules });
    if (p === `${base}/schedules` && m === 'POST') {
      this.scheduleBodies.push(body);
      const dto = { id: 'sch-1', name: body.name, target: { kind: 'script', script: { id: body.scriptId, path: 'login.yaml' } }, environment: { id: ENV, name: 'dev' }, cadence: body.cadence, cron: '5 * * * *', timezone: 'Asia/Seoul', timeLimitSec: null, retryOnFailure: !!body.retryOnFailure, enabled: body.enabled !== false, disabledReason: null, nextRunAt: '2026-10-21T02:05:00.000Z', intervalMin: 60, createdBy: { id: 'u-me', label: '나' }, createdAt: '', updatedAt: '', lastRun: null, durationWarning: { avgDurationMs: 90 * 60_000, intervalMs: 60 * 60_000 } };
      this.schedules = [dto];
      return ok(dto, 201);
    }
    return err(404, 'NOT_FOUND', `no route ${m} ${p}`);
  };
}

describe('cloud runs in the app (fake cloud)', () => {
  let root: string;
  let userData: string;
  let live: LiveStore;
  let svc: ProjectService;
  let cloud: CloudService;
  const fake = new Fake();
  const changed: string[] = [];
  let id = '';

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'euta-cloud-runs-'));
    userData = join(root, 'userData');
    live = new LiveStore({ throttleMs: 0 });
    svc = new ProjectService({ userData, safeStorage: mockSafeStorage(), live, watch: false, platform: 'darwin' });
    cloud = new CloudService({ userData, safeStorage: mockSafeStorage(), projects: svc, live, fetch: fake.fetch, retry: { min: 50, max: 100 }, events: { runsChanged: (x) => changed.push(x) }, runs: { cacheMaxBytes: 3000, refreshDelayMs: 10 }, notifyEnabled: () => false });
    cloud.setServer('http://c3.test');
    await cloud.login();
    await until(() => cloud.status().state === 'online');
    id = await cloud.openRemote(PID);
    svc.open(id);
    await until(() => svc.scripts(id).some((s) => s.path === 'login.yaml'));
  });
  afterAll(async () => {
    cloud.dispose();
    await svc.dispose();
    live.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('precheck: unsent saves → "먼저 보내기" (no server call); otherwise the server problems in Korean', async () => {
    const wc = new WorkingCopy(svc.store.dir(id));
    wc.enqueue({ path: 'login.yaml', baseVersion: 1, origin: 'app', source: `${SRC}# edit\n`, status: 'conflict' });
    const blocked = await cloud.runs.precheck(id, { script: 'login.yaml' });
    expect(blocked).toMatchObject({ ok: false, needsSend: true });
    expect(blocked.reasons[0]).toMatch(/보내기 대기 중인 저장이 있습니다 — 먼저 보내기/);
    await expect(cloud.runs.start(id, { script: 'login.yaml' })).rejects.toThrow(/먼저 보내기/);
    wc.removePending(wc.pending()[0]!.ticket);
    expect((await cloud.runs.precheck(id, { script: 'new.yaml' })).reasons[0]).toMatch(/아직 클라우드에 없는 스크립트/);
    expect(await cloud.runs.precheck(id, { script: 'login.yaml', envId: compactId(ENV) })).toEqual({ ok: true, reasons: [], credentialNames: ['USER_PASSWORD'] });
    fake.precheck = { ok: false, problems: [{ code: 'OS_INPUT_NOT_ALLOWED', message: 'x', issues: [{ path: 'steps[1].input', message: 'm' }] }, { code: 'CREDENTIALS_MISSING', message: 'x', names: ['USER_PASSWORD'] }] };
    const bad = await cloud.runs.precheck(id, { script: 'login.yaml' });
    expect(bad.ok).toBe(false);
    expect(bad.reasons).toEqual([expect.stringMatching(/클라우드에서는 OS 입력\(input: os\)을 쓸 수 없습니다 — steps\[1\]\.input/), expect.stringMatching(/클라우드에 등록되지 않은 테스트 계정: USER_PASSWORD/)]);
    await expect(cloud.runs.start(id, { script: 'login.yaml' })).rejects.toThrow(/클라우드에서 실행할 수 없습니다 — 클라우드에서는 OS 입력/);
    fake.precheck = { ok: true, problems: [] };
    fake.capReached = true;
    await expect(cloud.runs.start(id, { script: 'login.yaml' })).rejects.toThrow('오늘 클라우드 실행 상한에 도달했습니다 — 50/50회 (2026-10-21, Asia/Seoul)');
    fake.capReached = false;
  });

  it('request → Live "클라우드" view at once; feed run.* refreshes it (steps, current step); cancel', async () => {
    const { runId } = await cloud.runs.start(id, { script: 'login.yaml', envId: compactId(ENV), vars: 'A=1' });
    let v = live.get(runId)!;
    expect(v).toMatchObject({ source: 'cloud', projectId: id, status: 'running', name: 'login.yaml' });
    expect(v.cloud).toMatchObject({ status: 'queued', sourceLabel: '앱', canCancel: true });
    const r = fake.runs.get(runId)!;
    Object.assign(r, { status: 'running', runnerLocation: '사내 dev', startedAt: '2026-10-21T01:00:05.000Z', steps: [{ stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 120 }], currentStep: { stepId: '2', action: 'fill' } });
    fake.pushFeed('run.progress', { runId, currentStep: { stepId: '2', action: 'fill' }, stepsDone: 1 });
    await until(() => live.get(runId)?.steps.length === 2);
    v = live.get(runId)!;
    expect(v.steps.map((s) => [s.stepId, s.status])).toEqual([['1', 'passed'], ['2', 'running']]);
    expect(v.cloud?.runnerLocation).toBe('사내 dev');
    expect(changed).toContain(id);
    await cloud.runs.cancel(id, runId);
    expect(live.get(runId)?.cloud).toMatchObject({ status: 'cancelled', canCancel: false });
    expect(live.get(runId)?.status).toBe('error');
    // a running cloud run does not block removing the working copy (the server keeps it)
    r.status = 'running';
    await cloud.runs.refresh(id, runId);
    expect(svc.deleteBlocker(id)).toBeUndefined();
    r.status = 'cancelled';
    await cloud.runs.refresh(id, runId);
  });

  it('suite request: Live shows the suite scripts as rows', async () => {
    const { runId } = await cloud.runs.start(id, { suiteId: compactId(SUITE) });
    expect(live.get(runId)).toMatchObject({ name: '테스트 세트: smoke' });
    expect(live.get(runId)?.steps).toEqual([expect.objectContaining({ name: 'login.yaml', status: 'skipped' })]);
    // Live set grouping (ADR-032): the parent lists its scripts; the running child gets its own view.
    expect(live.get(runId)?.suiteItems).toEqual([{ runId: `${runId}-c1`, script: 'login.yaml', status: 'pending' }]);
    expect(live.get(runId)?.cloud?.envName).toBe('dev');
    const parent = fake.runs.get(runId)!;
    const child = { ...parent.children![0]!, status: 'running' as const, alwaysRun: true, steps: [{ stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 50 }] };
    parent.children = [child];
    parent.status = 'running';
    fake.runs.set(child.id, child as never);
    await cloud.runs.refresh(id, runId);
    expect(live.get(runId)?.suiteItems?.[0]).toMatchObject({ status: 'running', alwaysRun: true });
    expect(live.get(child.id)).toMatchObject({ source: 'cloud', name: 'login.yaml', status: 'running' });
    expect(live.get(child.id)?.cloud?.parentRunId).toBe(runId);
    // Its report is the web run detail of the parent.
    expect(cloud.runs.webRunUrl(id, runId)).toBe(`http://c3.test/projects/${PID}/runs/${runId}`);
    expect(() => cloud.runs.webRunUrl(id, '../x')).toThrow(/invalid/);
    parent.status = 'passed';
    parent.children = [{ ...child, status: 'passed' }];
    fake.runs.set(child.id, { ...child, status: 'passed' } as never);
    await cloud.runs.refresh(id, runId);
    expect(live.get(child.id)?.status).toBe('passed');
  });

  it('open: files are downloaded once into cloud-runs/<id>/ and replayed; expired → summary + flag; LRU keeps the budget', async () => {
    const engineId = '20261021-010000-login-abc123';
    const mk = (cloudId: string, eng: string, pad: number) => {
      fake.runs.set(cloudId, runDto({ id: cloudId, status: 'passed', resultFiles: 'present', startedAt: '2026-10-21T01:00:00.000Z', finishedAt: '2026-10-21T01:01:00.000Z' }));
      const ev = (seq: number, type: string, extra: Record<string, unknown>) => JSON.stringify({ v: 1, seq, ts: '2026-10-21T01:00:00.000Z', runId: eng, type, ...extra });
      fake.files.set(cloudId, {
        'run.json': Buffer.from(JSON.stringify({ id: eng, status: 'passed' })),
        'steps.jsonl': Buffer.from([ev(1, 'run.started', { kind: 'script', script: { name: 'Login' }, env: {}, runDir: `/tmp/runner-work/${eng}` }), ev(2, 'step.started', { stepId: '1', index: 0, action: 'goto' }), ev(3, 'step.finished', { stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 5 }), ev(4, 'run.finished', { status: 'passed', summary: { total: 1, passed: 1, failed: 0, error: 0, skipped: 0 } })].join('\n')),
        'report.html': Buffer.from(`<html>${'x'.repeat(pad)}</html>`),
      });
    };
    const A = '00000000-0000-0000-0000-0000000000a1';
    mk(A, engineId, 1000);
    const o = await cloud.runs.open(id, A);
    expect(o).toEqual({ liveId: engineId, files: true });
    const dir = join(svc.store.dir(id), 'cloud-runs', A);
    expect(readFileSync(join(dir, 'report.html'), 'utf8')).toMatch(/^<html>/);
    expect(live.get(engineId)).toMatchObject({ status: 'passed', projectId: id, runDir: dir });
    expect(live.get(engineId)?.cloud).toMatchObject({ runId: A, downloaded: true });
    expect(svc.projectOfRunDir(dir)).toBe(id);
    expect(cloud.runs.dirOfEngineRun(id, engineId)).toBe(dir);
    fake.files.delete(A); // second open uses the cache
    expect((await cloud.runs.open(id, A)).liveId).toBe(engineId);

    const B = '00000000-0000-0000-0000-0000000000b2';
    mk(B, '20261021-020000-login-def456', 1500);
    await new Promise((r) => setTimeout(r, 5));
    await cloud.runs.open(id, B); // A (older use) is evicted to stay under 3000 bytes
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(svc.store.dir(id), 'cloud-runs', B))).toBe(true);

    const E = '00000000-0000-0000-0000-0000000000e9';
    fake.runs.set(E, runDto({ id: E, status: 'failed', resultFiles: 'expired', summary: { total: 2, passed: 1, failed: 1, error: 0, skipped: 0 } }));
    const ex = await cloud.runs.open(id, E);
    expect(ex).toEqual({ liveId: E, files: false, expired: true });
    expect(live.get(E)?.cloud?.resultFiles).toBe('expired');
  });

  it('upload: tar of the run folder CONTENTS (run.json on top) → linked version or 로컬 수정본; no double upload', async () => {
    const runsDir = join(svc.store.dir(id), 'runs');
    const mkRun = (rid: string, hash: string) => {
      const d = join(runsDir, rid);
      mkdirSync(join(d, 'screenshots'), { recursive: true });
      writeFileSync(join(d, 'run.json'), JSON.stringify({ id: rid, status: 'passed', scriptHash: hash, scriptPath: join(svc.view(id).dirs.scripts, 'login.yaml'), meta: { envId: compactId(ENV), envName: 'dev' } }));
      writeFileSync(join(d, 'steps.jsonl'), '');
      writeFileSync(join(d, 'screenshots', 'step-1.png'), Buffer.from([1, 2, 3]));
      return d;
    };
    const d1 = mkRun('20261021-003000-login-aaa111', scriptHash(SRC));
    // packaging alone: entry names are relative to the run folder, run.json first
    const t = await packRunDir(d1);
    const names: string[] = [];
    const ex = tar.extract();
    const done = (async () => {
      for await (const e of ex) {
        names.push(e.header.name);
        e.resume();
      }
    })();
    Readable.from([t]).pipe(ex);
    await done;
    expect(names).toEqual(['run.json', 'screenshots/step-1.png', 'steps.jsonl']);

    const svcAny = svc as unknown as { findRun: (p: string, r: string) => { id: string; dir: string } | undefined };
    const orig = svcAny.findRun.bind(svc);
    svcAny.findRun = (p, r) => (r.startsWith('20261021-0030') ? { id: r, dir: d1 } : r.startsWith('20261021-0031') ? { id: r, dir: d2 } : orig(p, r));
    const d2 = mkRun('20261021-003100-login-bbb222', 'f'.repeat(64));
    try {
      const u1 = await cloud.runs.upload(id, '20261021-003000-login-aaa111');
      expect(u1).toMatchObject({ version: 1, localModified: false });
      expect(fake.uploads[0]!.query.get('scriptPath')).toBe('login.yaml');
      expect(fake.uploads[0]!.query.get('environmentId')).toBe(ENV);
      expect(fake.uploads[0]!.entries[0]).toBe('run.json');
      await expect(cloud.runs.upload(id, '20261021-003000-login-aaa111')).rejects.toThrow(/이미 클라우드에 올린 실행/);
      const u2 = await cloud.runs.upload(id, '20261021-003100-login-bbb222');
      expect(u2).toMatchObject({ localModified: true });
      expect(u2.version).toBeUndefined();
      expect(cloud.runs.uploads(id)).toEqual({ '20261021-003000-login-aaa111': u1.cloudRunId, '20261021-003100-login-bbb222': u2.cloudRunId });
      const h = await cloud.runs.history(id);
      expect(h.canUpload).toBe(true);
      expect(h.runs.find((r) => r.id === u1.cloudRunId)).toMatchObject({ source: 'local_upload', sourceLabel: '로컬 올림', runnerLocation: 'PC — 나' });
    } finally {
      svcAny.findRun = orig;
    }
  });

  it('schedules: script path → server script id, labels and the duration warning', async () => {
    const list = await cloud.schedules.save(id, undefined, { name: '매시간', script: 'login.yaml', envId: compactId(ENV), cadence: { kind: 'hourly', minute: 5 }, retryOnFailure: true });
    expect(fake.scheduleBodies[0]).toMatchObject({ name: '매시간', scriptId: 's-login', environmentId: ENV, cadence: { kind: 'hourly', minute: 5 }, retryOnFailure: true });
    expect(list[0]).toMatchObject({ cadenceLabel: '매시간 05분', envId: compactId(ENV), target: { kind: 'script', path: 'login.yaml' } });
    expect(list[0]!.warning).toMatch(/최근 3회 평균 실행 시간\(1\.5시간\)이 예약 간격\(60분\)보다 깁니다/);
    await expect(cloud.schedules.save(id, undefined, { name: 'x', script: 'nope.yaml', cadence: { kind: 'daily', time: '09:00' } })).rejects.toThrow(/아직 클라우드에 없는 스크립트/);
    expect(cadenceLabel({ kind: 'weekly', dayOfWeek: 1, time: '09:30' })).toBe('매주 월 09:30');
    expect(cadenceLabel({ kind: 'weekdays', time: '08:00' })).toBe('평일 08:00');
  });

  it('invite: GET /api/users?q= finds people; a server without it (404) falls back to the admin-only rule', async () => {
    expect(await cloud.searchUsers('kim')).toEqual([{ id: 'u-kim', name: '김', email: 'kim@example.com' }]);
    await cloud.setMember(id, 'kim@example.com', 'editor');
    expect(fake.putMemberIds).toEqual(['u-kim']);
    fake.usersRoute = false;
    expect(await cloud.searchUsers('kim')).toBeUndefined();
    await expect(cloud.setMember(id, 'kim@example.com', 'editor')).rejects.toThrow(/관리자만 이메일로 초대/);
    fake.usersRoute = true;
  });
});

describe('pure helpers', () => {
  it('mergeHistory: local + cloud in time order, uploaded twins shown once, filter "클라우드"', () => {
    const local = (id: string, at: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({ id, kind: 'script', name: 'login', status: 'passed', startedAt: at, durationMs: 1, total: 1, passed: 1, failed: 0, errors: 0, skipped: 0, dir: '/x', hasReport: true, ...extra });
    const cloudItem = (id: string, at: string, extra: Partial<CloudRunItem> = {}): CloudRunItem => ({ id, kind: 'script', status: 'passed', flaky: false, name: 'login.yaml', envName: 'dev', source: 'schedule', sourceLabel: '예약', requestedBy: '예약 — 나', at, durationMs: 1, resultFiles: 'present', localModified: false, attempt: 1, ...extra });
    const rows = mergeHistory(
      { runs: [local('L1', '2026-10-21T01:00:00.000Z'), local('L2', '2026-10-21T03:00:00.000Z')], suiteRuns: [] },
      [cloudItem('C1', '2026-10-21T02:00:00.000Z'), cloudItem('C2', '2026-10-21T00:30:00.000Z', { source: 'local_upload', sourceLabel: '로컬 올림' }), cloudItem('C3', '2026-10-21T04:00:00.000Z', { status: 'skipped' })],
      { L1: 'C2' },
    );
    expect(rows.map((r) => (r.kind === 'cloud' ? r.cloud.id : r.kind === 'run' ? r.run.id : '?'))).toEqual(['C3', 'L2', 'C1', 'L1']);
    expect(rows.find((r) => r.kind === 'run' && r.run.id === 'L1')).toMatchObject({ uploadedAs: 'C2' });
    expect(mergeHistory({ runs: [local('L1', 'a')], suiteRuns: [] }, [cloudItem('C1', 'b')], {}, '클라우드').map((r) => r.kind)).toEqual(['cloud']);
  });

  it('toRunView / problemText / runRequestError', () => {
    const v = toRunView('p1', runDto({ id: 'r1', status: 'timeout', error: 'secret input blocked: page host "evil.test" is not an allowed domain (dev.example.com)', skipReason: null }), true);
    expect(v).toMatchObject({ status: 'error', source: 'cloud' });
    expect(v.error).toMatch(/^테스트 계정 입력 차단/);
    expect(v.cloud?.canCancel).toBe(false);
    expect(problemText({ code: 'TARGET_NOT_PUBLIC', message: 'x' })).toMatch(/사설·사내 주소/);
    expect(runRequestError(new CloudError(403, 'FORBIDDEN', 'no'))).toBeUndefined();
  });

  it('notificationText: titles per kind, never values', () => {
    const e = (kind: UserEventDto['kind'], status: UserEventDto['data']['status'], extra: Partial<UserEventDto['data']> = {}): UserEventDto => ({ id: 1, kind, at: '2026-10-21T00:00:00.000Z', projectId: PID, runId: 'r-1', data: { projectName: 'C3', target: 'login.yaml', environment: 'dev', status, flaky: false, source: 'schedule', durationMs: 61_000, url: 'http://c3.test/x', ...extra } });
    expect(notificationText(e('failure', 'failed', { scheduleName: '아침', failedStep: '로그인 버튼 누르기' }))).toEqual({ projectId: compactId(PID), runId: 'r-1', kind: 'failure', title: '[euta] 실패 — login.yaml', body: 'C3 · dev · 예약 아침 · 실패 단계: 로그인 버튼 누르기 · 61초' });
    expect(notificationText(e('run.finished', 'passed', { source: 'app' })).title).toBe('클라우드 실행 끝: 통과 — login.yaml');
    expect(notificationText(e('recovery', 'passed')).title).toBe('[euta] 회복 — login.yaml');
  });

  it('CloudNotifier: notifies live events, folds an old backlog, resumes from the saved position, resync moves on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'euta-notify-'));
    const got: string[] = [];
    const asked: (number | null)[] = [];
    let script: { event: string; id: number; data?: UserEventDto }[] = [];
    const ev = (id: number, at: string): { event: string; id: number; data: UserEventDto } => ({ event: 'notification', id, data: { id, kind: 'failure', at, projectId: PID, runId: `r${id}`, data: { projectName: 'C3', target: `t${id}`, environment: 'dev', status: 'failed', flaky: false, source: 'schedule', durationMs: null, url: '' } } });
    const client = {
      async *userEvents(last: number | null, signal: AbortSignal) {
        asked.push(last);
        for (const x of script) yield x;
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      },
    };
    let enabled = true;
    const n = new CloudNotifier({ userData: dir, client: () => client as never, serverUrl: () => 'http://c3.test', enabled: () => enabled, notify: (v) => got.push(v.title), offline: () => undefined, authLost: () => undefined, now: () => Date.parse('2026-10-21T10:00:00.000Z') });
    script = [{ event: 'ready', id: 10 }, ev(11, '2026-10-21T10:00:01.000Z')];
    n.start();
    await until(() => got.length === 1);
    n.stop();
    expect(got).toEqual(['[euta] 실패 — t11']);
    expect(JSON.parse(readFileSync(join(dir, 'cloud', 'notify.json'), 'utf8'))).toEqual({ serverUrl: 'http://c3.test', lastEventId: 11 });
    // next start resumes after 11; four outcomes from while the app was closed fold into one summary
    script = [{ event: 'ready', id: 11 }, ...[12, 13, 14, 15].map((i) => ev(i, '2026-10-21T08:00:00.000Z'))];
    n.start();
    await until(() => got.length === 2);
    n.stop();
    expect(asked).toEqual([null, 11]);
    expect(got[1]).toBe('[euta] 앱이 꺼져 있는 동안 클라우드 알림 4건');
    // turned off: nothing shown, position forgotten (on again = from now, no flood)
    enabled = false;
    n.reset();
    script = [{ event: 'resync', id: 99 }];
    expect(n.running).toBe(false);
    n.start();
    expect(n.running).toBe(false);
    enabled = true;
    n.start();
    await until(() => asked.length === 3);
    expect(asked[2]).toBeNull();
    await until(() => JSON.parse(readFileSync(join(dir, 'cloud', 'notify.json'), 'utf8')).lastEventId === 99);
    n.stop();
    expect(got).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
