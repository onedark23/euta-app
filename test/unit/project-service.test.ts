// ProjectService against the engine fixture site (real runs, no model): script library
// (scan / import / rename / delete / outside changes), runs per environment (BASE_URL +
// vault secrets), suites (order, stop-on-failure, cancel, aggregation, SuiteRun JSON),
// activity timeline, AI chat in a project environment (fake agent), restart restore,
// project deletion, and no plaintext secret anywhere under userData.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { startFixtureServer, FIXTURE_USER, type FixtureServer } from '../../../euta-engine/packages/core/test/fixture-site/server.js';
import { fakeQuery } from '../../src/main/ai/fake-agent.js';
import type { SdkModule } from '../../src/main/ai/chat-engine.js';
import { LiveStore } from '../../src/main/live-store.js';
import { ProjectService } from '../../src/main/project/service.js';
import type { ActivityEvent, SuiteRun } from '../../src/shared/types.js';
import { allFiles, mockSafeStorage } from './helpers.js';

const EXAMPLES = resolve(import.meta.dirname, '../../../euta-engine/examples');
const sdk: SdkModule = {
  tool,
  createSdkMcpServer,
  query: () => {
    throw new Error('real query() must not be called in tests');
  },
};

const OK_YAML = `version: 1
name: Login page opens
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: /login
  - expect: { url: /login }
`;

const until = async (fn: () => boolean, ms = 10_000): Promise<void> => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('ProjectService (fixture site)', () => {
  let site: FixtureServer;
  let root: string;
  let userData: string;
  let ext: string;
  let live: LiveStore;
  let svc: ProjectService;
  const ss = mockSafeStorage();
  const scriptEvents: string[] = [];
  const suiteUpdates: SuiteRun[] = [];

  const make = (): ProjectService =>
    new ProjectService({
      userData,
      safeStorage: ss,
      live,
      platform: 'darwin',
      processEnv: { ...process.env, BASE_URL: 'http://127.0.0.1:9/wrong-if-used' },
      chat: { loadSdk: async () => sdk, queryFn: fakeQuery, throttleMs: 0 },
      watchDebounceMs: 50,
      events: { scriptsChanged: (id) => scriptEvents.push(id), suiteUpdate: (r) => suiteUpdates.push(r) },
    });

  beforeAll(async () => {
    site = await startFixtureServer();
    root = mkdtempSync(join(tmpdir(), 'euta-svc-'));
    userData = join(root, 'userData');
    ext = join(root, 'external');
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, 'login-ok.yaml'), OK_YAML);
    live = new LiveStore({ throttleMs: 0, projectOf: (d) => svc?.projectOfRunDir(d) });
    svc = make();
  });

  afterAll(async () => {
    await svc?.dispose();
    live?.dispose();
    await site?.close();
    rmSync(root, { recursive: true, force: true });
  });

  let pid = '';
  let devId = '';
  let stgId = '';

  it('creates a project with two environments and vault secrets (names only in views)', () => {
    const v = svc.create({ name: 'Fixture portal', baseUrl: site.url });
    pid = v.id;
    expect(v.environments.map((e) => e.name)).toEqual(['default']);
    devId = v.environments[0]!.id;
    svc.upsertEnv(pid, devId, { name: 'dev' });
    // A second environment pointing at the same fixture site (another base URL form).
    stgId = svc.upsertEnv(pid, undefined, { name: 'staging', baseUrl: site.url.replace('127.0.0.1', 'localhost'), vars: { LOCALE: 'ko' } }).environments[1]!.id;
    for (const env of [devId, stgId]) {
      svc.setSecret(pid, env, 'USER_EMAIL', FIXTURE_USER.email);
      expect(svc.setSecret(pid, env, 'USER_PASSWORD', FIXTURE_USER.password)).toEqual(['USER_EMAIL', 'USER_PASSWORD']);
    }
    const view = svc.view(pid);
    expect(view.environments.map((e) => [e.name, e.secretSource, e.secretNames])).toEqual([
      ['dev', 'vault', ['USER_EMAIL', 'USER_PASSWORD']],
      ['staging', 'vault', ['USER_EMAIL', 'USER_PASSWORD']],
    ]);
    expect(JSON.stringify(view)).not.toContain(FIXTURE_USER.password);
    expect(svc.list().map((p) => p.name)).toEqual(['Fixture portal']);
    expect(svc.currentRunsDir()).toBe(join(userData, 'projects', pid, 'runs'));
  });

  it('script library: import, create, rename, delete, export; outside changes refresh the list', async () => {
    expect(svc.importScript(pid, join(ext, 'login-ok.yaml'))).toBe('login-ok.yaml');
    expect(svc.importScript(pid, join(EXAMPLES, 'failing.yaml'))).toBe('failing.yaml');
    expect(svc.importScript(pid, join(EXAMPLES, 'login-download.yaml'))).toBe('login-download.yaml');
    expect(svc.importScript(pid, join(ext, 'login-ok.yaml'))).toBe('login-ok-2.yaml'); // never overwrites
    expect(svc.createScript(pid, 'flows/new.yaml', 'New flow')).toBe('flows/new.yaml');
    expect(svc.renameScript(pid, 'login-ok-2.yaml', 'flows/copy.yaml')).toBe('flows/copy.yaml');
    svc.deleteScript(pid, 'flows/copy.yaml');
    expect(() => svc.renameScript(pid, 'failing.yaml', '../escape.yaml')).toThrow();
    svc.exportScript(pid, 'login-ok.yaml', join(ext, 'exported.yaml'));
    expect(readFileSync(join(ext, 'exported.yaml'), 'utf8')).toBe(OK_YAML);
    const list = svc.scripts(pid);
    expect(list.map((s) => [s.path, s.name])).toEqual([
      ['failing.yaml', 'Deliberately failing'],
      ['flows/new.yaml', 'New flow'],
      ['login-download.yaml', 'Login and export reports'],
      ['login-ok.yaml', 'Login page opens'],
    ]);
    expect(svc.checkScript(pid, 'flows/new.yaml', devId, '', '').issues).toEqual([]);

    // A file written from outside (editor / AI save_script) shows up and is logged.
    const before = scriptEvents.length;
    writeFileSync(join(userData, 'projects', pid, 'scripts', 'outside.yaml'), OK_YAML.replace('Login page opens', 'Outside'));
    await until(() => scriptEvents.length > before && svc.activity(pid, { kinds: ['script.created'] }).some((e) => e.summary.includes('outside.yaml')));
    expect(svc.scripts(pid).some((s) => s.path === 'outside.yaml' && s.name === 'Outside')).toBe(true);
    const kinds = svc.activity(pid).map((e) => e.kind);
    for (const k of ['script.imported', 'script.created', 'script.renamed', 'script.deleted']) expect(kinds).toContain(k);
  });

  it('runs the same script per environment: BASE_URL + vault secrets, project folders, run.json meta', async () => {
    const results: { envName: string; status: string; runDir: string }[] = [];
    for (const envId of [devId, stgId]) {
      const h = svc.startRun({ projectId: pid, script: 'login-download.yaml', envId, vars: '', env: '', headless: true });
      const r = await h.result;
      results.push({ envName: envId === devId ? 'dev' : 'staging', status: r.status, runDir: h.runDir });
      expect(h.runDir.startsWith(join(userData, 'projects', pid, 'runs'))).toBe(true);
      expect(live.get(h.runId)?.projectId).toBe(pid);
      const runJson = JSON.parse(readFileSync(join(h.runDir, 'run.json'), 'utf8')) as { meta: Record<string, string>; env: { baseUrl?: string } };
      expect(runJson.meta).toMatchObject({ projectId: pid, envId, envName: envId === devId ? 'dev' : 'staging' });
    }
    expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
    const hist = svc.history(pid).runs;
    expect(hist.map((h) => h.envName).sort()).toEqual(['dev', 'staging']);
    // The library shows the latest run status.
    expect(svc.scripts(pid).find((s) => s.path === 'login-download.yaml')?.lastRun?.status).toBe('passed');
    const acts = svc.activity(pid, { kinds: ['run.started', 'run.finished'] });
    expect(acts).toHaveLength(4);
    expect(acts[0]!.summary).toMatch(/→ passed/);
    expect(acts.every((a) => a.actor === 'user' && a.ref?.runId)).toBe(true);
  }, 180_000);

  it('suites: serial order, stop-on-failure, aggregation (worst status), SuiteRun JSON, History grouping', async () => {
    const v = svc.upsertSuite(pid, undefined, { name: 'smoke', scripts: ['login-ok.yaml', 'failing.yaml', 'login-ok.yaml'], envId: stgId, stopOnFailure: true });
    const suiteId = v.suites[0]!.id;
    const exec = svc.runSuite(pid, suiteId);
    expect(() => svc.runSuite(pid, suiteId)).toThrow(/already running/);
    const r = await exec.done;
    expect(r.items.map((i) => i.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(r.status).toBe('failed');
    expect(r.envName).toBe('staging');
    expect(r.items[2]!.runId).toBeUndefined();
    const saved = JSON.parse(readFileSync(join(userData, 'projects', pid, 'suite-runs', `${r.id}.json`), 'utf8')) as SuiteRun;
    expect(saved).toMatchObject({ id: r.id, status: 'failed', items: r.items });
    // Serial: the second run started after the first finished.
    const [a, b] = [r.items[0]!.runId!, r.items[1]!.runId!].map((id) => svc.history(pid).runs.find((h) => h.id === id)!);
    expect(new Date(b!.startedAt).getTime()).toBeGreaterThanOrEqual(new Date(a!.startedAt).getTime() + (a!.durationMs ?? 0));
    expect(a!.suiteRunId).toBe(r.id);
    expect(svc.history(pid).suiteRuns[0]!.id).toBe(r.id);
    expect(suiteUpdates.filter((u) => u.id === r.id).at(-1)?.status).toBe('failed');

    // Without stop-on-failure every script runs; the result is still the worst status.
    svc.upsertSuite(pid, suiteId, { stopOnFailure: false });
    const r2 = await svc.runSuite(pid, suiteId).done;
    expect(r2.items.map((i) => i.status)).toEqual(['passed', 'failed', 'passed']);
    expect(r2.status).toBe('failed');

    // Set report (ADR-032): suite-runs/<id>/report.html beside the JSON, announced with hasReport.
    const reportOf = (id: string) => join(userData, 'projects', pid, 'suite-runs', id, 'report.html');
    const html1 = readFileSync(reportOf(r.id), 'utf8');
    expect(html1).toContain('data-testid="sr-compare-none"');
    expect(html1).toContain('Deliberately failing');
    expect(html1).toMatch(/data-testid="sr-step-sentence">[^<]*존재하지 않는 제목/);
    expect(html1).toContain('src="data:image/png;base64,');
    expect(html1).not.toMatch(/(src|href)="https?:/);
    const html2 = readFileSync(reportOf(r2.id), 'utf8');
    expect(html2).toContain('data-testid="sr-still-failing" data-count="1"');
    expect(html2).toContain('data-testid="sr-still-passing" data-count="1"');
    expect(svc.history(pid).suiteRuns.find((x) => x.id === r2.id)?.hasReport).toBe(true);
    expect(suiteUpdates.filter((u) => u.id === r2.id).at(-1)?.hasReport).toBe(true);
    expect(await svc.suiteReport(pid, r2.id)).toBe(reportOf(r2.id));
    // An older run without a report gets one on demand.
    rmSync(join(userData, 'projects', pid, 'suite-runs', r.id), { recursive: true });
    expect(svc.history(pid).suiteRuns.find((x) => x.id === r.id)?.hasReport).toBeUndefined();
    expect(await svc.suiteReport(pid, r.id)).toBe(reportOf(r.id));
    expect(await svc.suiteReport(pid, 'nosuchrun1')).toBeUndefined();
    // Live knows which set a run belongs to.
    expect(live.get(r2.items[0]!.runId!)?.suiteRunId).toBe(r2.id);

    // Cancel: the running script finishes, the rest is skipped.
    svc.upsertSuite(pid, suiteId, { scripts: ['login-ok.yaml', 'login-ok.yaml', 'login-ok.yaml'] });
    const e3 = svc.runSuite(pid, suiteId, devId);
    await until(() => e3.run.items[0]!.status === 'running');
    expect(svc.cancelSuite(e3.run.id)).toBe(true);
    const r3 = await e3.done;
    expect(r3.items.map((i) => i.status)).toEqual(['passed', 'skipped', 'skipped']);
    expect(r3).toMatchObject({ cancelled: true, status: 'passed', envName: 'dev' });

    // "항상 실행": runs after a stop-on-failure and after a cancel; counted in the status.
    svc.upsertSuite(pid, suiteId, { scripts: ['failing.yaml', 'login-ok.yaml', 'outside.yaml'], alwaysRun: ['outside.yaml'], stopOnFailure: true });
    const r4 = await svc.runSuite(pid, suiteId).done;
    expect(r4.items.map((i) => [i.status, i.alwaysRun ?? false])).toEqual([
      ['failed', false],
      ['skipped', false],
      ['passed', true],
    ]);
    expect(r4.status).toBe('failed');
    svc.upsertSuite(pid, suiteId, { scripts: ['login-ok.yaml', 'login-ok.yaml', 'failing.yaml', 'outside.yaml'], alwaysRun: ['failing.yaml', 'outside.yaml'], stopOnFailure: false });
    const e5 = svc.runSuite(pid, suiteId, devId);
    await until(() => e5.run.items[0]!.status === 'running');
    svc.cancelSuite(e5.run.id);
    const r5 = await e5.done;
    expect(r5.items.map((i) => i.status)).toEqual(['passed', 'skipped', 'failed', 'passed']);
    expect(r5).toMatchObject({ cancelled: true, status: 'failed' });

    const acts = svc.activity(pid, { actors: ['suite'] });
    expect(acts.filter((x) => x.kind === 'suite.finished')).toHaveLength(5);
    expect(acts.some((x) => x.kind === 'run.finished' && x.ref?.suiteRunId === r.id)).toBe(true);
  }, 240_000);

  it('AI chat runs in the selected project environment and is logged (fake agent, no model)', async () => {
    const chats = svc.chatEngine(pid);
    const chat = chats.create(stgId);
    expect(chat.cwd).toBe(join(userData, 'projects', pid, 'scripts'));
    const ctx = svc.chatContext(pid, chat);
    expect(ctx.config.env.BASE_URL).toBe(svc.view(pid).environments[1]!.baseUrl);
    expect(ctx.project).toMatchObject({ name: 'Fixture portal', envName: 'staging' });
    await chats.send(chat.id, 'login-download.yaml 실행해줘');
    const c = chats.get(chat.id)!;
    const card = c.items.find((i) => i.kind === 'tool') as { status: string; runId?: string; runStatus?: string };
    expect(card).toMatchObject({ status: 'done', runStatus: 'passed' });
    expect(live.get(card.runId!)).toMatchObject({ source: 'ai', projectId: pid, status: 'passed' });
    const runJson = JSON.parse(readFileSync(join(live.get(card.runId!)!.runDir!, 'run.json'), 'utf8')) as { meta: Record<string, string> };
    expect(runJson.meta).toMatchObject({ projectId: pid, envName: 'staging', source: 'ai' });
    expect(existsSync(join(userData, 'projects', pid, 'chats', `${chat.id}.json`))).toBe(true);
    const acts = svc.activity(pid, { actors: ['ai'] });
    expect(acts.map((a) => a.kind)).toEqual(expect.arrayContaining(['chat.started', 'chat.turn', 'run.started', 'run.finished']));
    const turn = acts.find((a) => a.kind === 'chat.turn')!;
    expect(turn.summary).toBe('login-download.yaml 실행해줘 · 도구: run_script');
    expect(acts.find((a) => a.kind === 'run.finished')!.summary).toContain('@ staging');
    // The system prompt names environments and secret NAMES only.
    expect(JSON.stringify(ctx.project)).not.toContain(FIXTURE_USER.password);
  }, 180_000);

  it('a restart restores projects, environments, secrets (names), scripts, history, suites, chats and activity', async () => {
    await svc.dispose();
    const before = { acts: svc.activity(pid).length, runs: svc.history(pid).runs.length };
    svc = make();
    const v = svc.view(pid);
    expect(v.environments.map((e) => [e.name, e.secretNames.join(',')])).toEqual([
      ['dev', 'USER_EMAIL,USER_PASSWORD'],
      ['staging', 'USER_EMAIL,USER_PASSWORD'],
    ]);
    expect(svc.runContext(pid, devId).secrets).toEqual({ USER_EMAIL: FIXTURE_USER.email, USER_PASSWORD: FIXTURE_USER.password });
    expect(svc.scripts(pid).length).toBeGreaterThanOrEqual(5);
    expect(svc.history(pid).runs.length).toBe(before.runs);
    expect(svc.history(pid).suiteRuns).toHaveLength(5);
    expect(v.suites[0]!.name).toBe('smoke');
    expect(svc.chatEngine(pid).list()).toHaveLength(1);
    expect(svc.activity(pid).length).toBe(before.acts);
  });

  it('no secret value appears in plain text anywhere under userData', () => {
    const needles = [FIXTURE_USER.password, FIXTURE_USER.email, encodeURIComponent(FIXTURE_USER.password), Buffer.from(FIXTURE_USER.password).toString('base64')];
    const hits: string[] = [];
    const files = allFiles(userData);
    expect(files.some((f) => f.endsWith('vault.json'))).toBe(true);
    for (const f of files) {
      const buf = readFileSync(f);
      for (const n of needles) if (buf.includes(Buffer.from(n))) hits.push(`${f}: ${n.slice(0, 3)}…`);
    }
    expect(hits).toEqual([]);
  });

  it('deleting a project removes its folder and vault entries', async () => {
    const acts: ActivityEvent[] = svc.activity(pid);
    expect(acts.length).toBeGreaterThan(10);
    expect(svc.deleteBlocker(pid)).toBeUndefined();
    await svc.delete(pid);
    expect(existsSync(join(userData, 'projects', pid))).toBe(false);
    expect(JSON.parse(readFileSync(join(userData, 'vault.json'), 'utf8')).entries).toEqual({});
    expect(svc.list()).toEqual([]);
    expect(svc.appState.get().recent).toEqual([]);
  });
});
