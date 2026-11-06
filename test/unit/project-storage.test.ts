// Project storage (SPEC 프로젝트-관리 완료 기준 — 단위): project/env/suite store with atomic
// writes + restart restore, app state, vault (values never disclosed, insecure backends
// refused), activity log (append, month rotation, filters, never throws), run-option assembly.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLog, monthOf } from '../../src/main/project/activity-log.js';
import { applyTheme, AppStateStore } from '../../src/main/project/app-state.js';
import { writeJsonAtomic } from '../../src/main/project/fsx.js';
import { InputError, PROJECT_SUBDIRS, ProjectStore } from '../../src/main/project/project-store.js';
import { aiServerConfig, assembleRun, INTERNAL_ENV } from '../../src/main/project/run-options.js';
import { Vault, VaultUnavailableError } from '../../src/main/project/vault.js';
import { mockSafeStorage } from './helpers.js';

const tmp = (p = 'euta-proj-'): string => mkdtempSync(join(tmpdir(), p));

describe('atomic JSON writes', () => {
  it('replaces the file via a temp file and leaves no temp behind', () => {
    const d = tmp();
    const f = join(d, 'a', 'x.json');
    writeJsonAtomic(f, { v: 1 });
    writeJsonAtomic(f, { v: 2 });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ v: 2 });
    expect(readdirSync(join(d, 'a'))).toEqual(['x.json']);
  });
});

describe('ProjectStore', () => {
  it('creates the project folder layout and restores everything after a restart', () => {
    const u = tmp();
    const s = new ProjectStore(u);
    const p = s.create({ name: '고객 포털', description: 'portal' });
    for (const d of PROJECT_SUBDIRS) expect(existsSync(join(u, 'projects', p.id, d))).toBe(true);
    const { env: dev } = s.upsertEnv(p.id, undefined, { name: 'dev', baseUrl: 'http://127.0.0.1:4173', vars: { LOCALE: 'ko' } });
    const { env: stg } = s.upsertEnv(p.id, undefined, { name: 'staging', baseUrl: 'https://staging.example.com' });
    s.setSecretNames(p.id, dev.id, ['USER_PASSWORD', 'USER_EMAIL']);
    const suite = s.upsertSuite(p.id, undefined, { name: 'smoke', scripts: ['a.yaml', 'sub/b.yml'], envId: stg.id, stopOnFailure: true });
    s.update(p.id, { pinned: true, browser: { engine: 'webkit', device: 'iPhone 15', headless: false }, defaultEnvId: stg.id });
    expect(readdirSync(join(u, 'projects', p.id)).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const again = new ProjectStore(u).get(p.id)!;
    expect(again.name).toBe('고객 포털');
    expect(again.pinned).toBe(true);
    expect(again.browser).toEqual({ engine: 'webkit', device: 'iPhone 15', headless: false });
    expect(again.defaultEnvId).toBe(stg.id);
    expect(again.environments.map((e) => e.name)).toEqual(['dev', 'staging']);
    expect(again.environments[0]).toMatchObject({ baseUrl: 'http://127.0.0.1:4173', vars: { LOCALE: 'ko' }, secretNames: ['USER_EMAIL', 'USER_PASSWORD'] });
    expect(again.suites).toEqual([{ id: suite.id, name: 'smoke', scripts: ['a.yaml', 'sub/b.yml'], envId: stg.id, stopOnFailure: true }]);
  });

  it('test set "항상 실행": additive field, old files without it still load, follows renames and deletes', () => {
    const u = tmp();
    const s = new ProjectStore(u);
    const p = s.create({ name: 'p' });
    const suite = s.upsertSuite(p.id, undefined, { name: 'smoke', scripts: ['a.yaml', 'cleanup.yaml'], alwaysRun: ['cleanup.yaml', 'not-in-set.yaml', 7] });
    expect(suite.alwaysRun).toEqual(['cleanup.yaml']);
    // Other edits keep the marks; removing the item drops its mark.
    expect(s.upsertSuite(p.id, suite.id, { stopOnFailure: true }).alwaysRun).toEqual(['cleanup.yaml']);
    expect(new ProjectStore(u).get(p.id)!.suites[0]).toEqual({ id: suite.id, name: 'smoke', scripts: ['a.yaml', 'cleanup.yaml'], stopOnFailure: true, alwaysRun: ['cleanup.yaml'] });
    s.renameScriptRefs(p.id, 'cleanup.yaml', 'teardown.yaml');
    expect(s.get(p.id)!.suites[0]).toMatchObject({ scripts: ['a.yaml', 'teardown.yaml'], alwaysRun: ['teardown.yaml'] });
    s.renameScriptRefs(p.id, 'teardown.yaml', undefined);
    expect(s.get(p.id)!.suites[0]!.alwaysRun).toBeUndefined();
    expect(s.upsertSuite(p.id, suite.id, { scripts: ['a.yaml', 'z.yaml'], alwaysRun: ['z.yaml'] }).alwaysRun).toEqual(['z.yaml']);
    expect(s.upsertSuite(p.id, suite.id, { scripts: ['a.yaml'] }).alwaysRun).toBeUndefined();
    // A project.json written before the field existed (no alwaysRun) loads unchanged.
    const file = join(u, 'projects', p.id, 'project.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.suites = [{ id: suite.id, name: 'old', scripts: ['a.yaml'], stopOnFailure: false }];
    writeFileSync(file, JSON.stringify(raw));
    expect(new ProjectStore(u).get(p.id)!.suites).toEqual([{ id: suite.id, name: 'old', scripts: ['a.yaml'], stopOnFailure: false }]);
  });

  it('rejects invalid input', () => {
    const s = new ProjectStore(tmp());
    expect(() => s.create({ name: '  ' })).toThrow(InputError);
    const p = s.create({ name: 'p' });
    expect(() => s.upsertEnv(p.id, undefined, { name: 'x', baseUrl: 'ftp://a' })).toThrow(/http/);
    expect(() => s.upsertEnv(p.id, undefined, { name: 'x', baseUrl: 'https://user:pw@a.example' })).toThrow(/credentials/);
    expect(() => s.upsertEnv(p.id, undefined, { name: 'x', vars: { API_TOKEN: 'abc' } })).toThrow(/secret/);
    expect(() => s.upsertEnv(p.id, undefined, { name: 'x', secretsFile: 'relative.json' })).toThrow(/absolute/);
    s.upsertEnv(p.id, undefined, { name: 'dup' });
    expect(() => s.upsertEnv(p.id, undefined, { name: 'dup' })).toThrow(/already exists/);
    for (const bad of ['../x.yaml', '/abs.yaml', 'a/../../b.yaml', '.hidden.yaml', 'x.txt']) expect(() => s.upsertSuite(p.id, undefined, { name: 's', scripts: [bad] })).toThrow(InputError);
  });

  it('deleting an environment fixes the default env and suites; deleting the project removes its folder', () => {
    const u = tmp();
    const s = new ProjectStore(u);
    const p = s.create({ name: 'p' });
    const a = s.upsertEnv(p.id, undefined, { name: 'a' }).env;
    const b = s.upsertEnv(p.id, undefined, { name: 'b' }).env;
    expect(s.get(p.id)!.defaultEnvId).toBe(a.id); // first env becomes the default
    s.upsertSuite(p.id, undefined, { name: 's', scripts: ['x.yaml'], envId: a.id });
    s.deleteEnv(p.id, a.id);
    expect(s.get(p.id)!.defaultEnvId).toBe(b.id);
    expect(s.get(p.id)!.suites[0]!.envId).toBeUndefined();
    s.renameScriptRefs(p.id, 'x.yaml', 'y.yaml');
    expect(s.get(p.id)!.suites[0]!.scripts).toEqual(['y.yaml']);
    s.delete(p.id);
    expect(existsSync(join(u, 'projects', p.id))).toBe(false);
    expect(new ProjectStore(u).list()).toEqual([]);
  });
});

describe('AppStateStore (app.json)', () => {
  it('keeps recent order, last project and AI model; never reads the old settings.json', () => {
    const u = tmp();
    writeFileSync(join(u, 'settings.json'), JSON.stringify({ aiModel: 'opus', runsDir: '/old/runs' }));
    const a = new AppStateStore(u);
    expect(a.settings()).toEqual({ aiModel: '', cloudNotify: true, theme: 'system' }); // no migration
    a.touchProject('aaaaaa1');
    a.touchProject('bbbbbb2');
    a.touchProject('aaaaaa1');
    expect(a.updateSettings({ aiModel: 'sonnet' }).changed).toEqual(['aiModel']);
    expect(a.updateSettings({ aiModel: 'bad model!' }).changed).toEqual([]);
    const b = new AppStateStore(u).get();
    expect(b).toMatchObject({ recent: ['aaaaaa1', 'bbbbbb2'], lastProjectId: 'aaaaaa1', aiModel: 'sonnet' });
    new AppStateStore(u).forgetProject('aaaaaa1');
    expect(new AppStateStore(u).get()).toMatchObject({ recent: ['bbbbbb2'] });
    expect(new AppStateStore(u).get().lastProjectId).toBeUndefined();
  });
});

describe('screen theme (앱 설정 "화면 테마")', () => {
  it('persists system / light / dark, rejects other values, and survives a restart', () => {
    const u = tmp();
    const a = new AppStateStore(u);
    expect(a.settings().theme).toBe('system');
    expect(a.updateSettings({ theme: 'dark' }).changed).toEqual(['theme']);
    expect(a.updateSettings({ theme: 'dark' }).changed).toEqual([]);
    expect(a.updateSettings({ theme: 'sepia' }).changed).toEqual([]);
    expect(new AppStateStore(u).settings().theme).toBe('dark');
    new AppStateStore(u).updateSettings({ theme: 'light' });
    expect(new AppStateStore(u).settings()).toMatchObject({ theme: 'light', aiModel: '', cloudNotify: true });
    // A hand-edited app.json with a bad value falls back to the OS.
    writeFileSync(join(u, 'app.json'), JSON.stringify({ schema: 1, recent: [], aiModel: '', theme: 'neon' }));
    expect(new AppStateStore(u).settings().theme).toBe('system');
  });

  it('applies the theme as nativeTheme.themeSource', () => {
    const native: { themeSource: 'system' | 'light' | 'dark' } = { themeSource: 'system' };
    applyTheme(native, 'dark');
    expect(native.themeSource).toBe('dark');
    applyTheme(native, 'system');
    expect(native.themeSource).toBe('system');
  });
});

describe('Vault (safeStorage ciphertext only)', () => {
  const SECRET = 'Pa55-vault-%-value!';

  it('stores ciphertext only, resolves in main, survives restarts, lists names only', () => {
    const u = tmp();
    const ss = mockSafeStorage();
    const v = new Vault(u, ss, 'darwin');
    expect(v.status()).toEqual({ available: true });
    v.set('proj001', 'env0001', 'USER_PASSWORD', SECRET);
    v.set('proj001', 'env0001', 'USER_EMAIL', 'qa@example.com');
    v.set('proj001', 'env0002', 'USER_PASSWORD', 'other');
    const raw = readFileSync(join(u, 'vault.json'), 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('qa@example.com');
    expect(raw).not.toContain(Buffer.from(SECRET).toString('base64'));
    expect(Object.keys(JSON.parse(raw).entries)).toEqual(['proj001/env0001/USER_PASSWORD', 'proj001/env0001/USER_EMAIL', 'proj001/env0002/USER_PASSWORD']);

    const again = new Vault(u, ss, 'darwin');
    expect(again.names('proj001', 'env0001')).toEqual(['USER_EMAIL', 'USER_PASSWORD']);
    expect(again.resolve('proj001', 'env0001')).toEqual({ secrets: { USER_EMAIL: 'qa@example.com', USER_PASSWORD: SECRET }, failed: [] });
    // The public surface has no getter that returns a value for a name.
    expect(Object.getOwnPropertyNames(Vault.prototype).sort()).toEqual(['constructor', 'moveEnv', 'names', 'remove', 'removePrefix', 'resolve', 'save', 'set', 'status']);

    expect(again.remove('proj001', 'env0001', 'USER_EMAIL')).toBe(true);
    expect(again.removePrefix('proj001', 'env0002')).toBe(1);
    expect(new Vault(u, ss, 'darwin').names('proj001', 'env0001')).toEqual(['USER_PASSWORD']);
    expect(again.removePrefix('proj001')).toBe(1);
    expect(JSON.parse(readFileSync(join(u, 'vault.json'), 'utf8')).entries).toEqual({});
  });

  it('refuses to store when encryption is unavailable or Linux uses basic_text', () => {
    const u = tmp();
    const off = new Vault(u, mockSafeStorage({ available: false }), 'darwin');
    expect(off.status().available).toBe(false);
    expect(() => off.set('proj001', 'env0001', 'X', 'v')).toThrow(VaultUnavailableError);
    const basic = new Vault(u, mockSafeStorage({ backend: 'basic_text' }), 'linux');
    expect(basic.status()).toMatchObject({ available: false, backend: 'basic_text' });
    expect(() => basic.set('proj001', 'env0001', 'X', 'v')).toThrow(/cannot be stored/);
    expect(existsSync(join(u, 'vault.json'))).toBe(false);
    expect(new Vault(u, mockSafeStorage({ backend: 'gnome_libsecret' }), 'linux').status()).toEqual({ available: true, backend: 'gnome_libsecret' });
  });

  it('validates names and reports undecryptable entries by name only', () => {
    const u = tmp();
    const v = new Vault(u, mockSafeStorage(), 'darwin');
    expect(() => v.set('proj001', 'env0001', 'bad-name', 'x')).toThrow(/secret name/);
    expect(() => v.set('proj001', 'env0001', 'OK', '')).toThrow(/empty/);
    v.set('proj001', 'env0001', 'OK', 'value');
    const file = join(u, 'vault.json');
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.entries['proj001/env0001/BROKEN'] = Buffer.from('garbage').toString('base64');
    writeFileSync(file, JSON.stringify(j));
    expect(new Vault(u, mockSafeStorage(), 'darwin').resolve('proj001', 'env0001')).toEqual({ secrets: { OK: 'value' }, failed: ['BROKEN'] });
  });
});

describe('ActivityLog (append-only JSONL per month)', () => {
  it('appends, rotates by month, lists newest first with filters, skips bad lines', () => {
    const d = tmp();
    let now = new Date(2026, 8, 30, 23, 59); // Sep 2026 (local time)
    const seen: string[] = [];
    const log = new ActivityLog(d, { now: () => now, redact: (s) => s.replaceAll('hunter2', '***'), onAppend: (e) => seen.push(e.kind) });
    log.append('project.created', 'user', '프로젝트 생성');
    log.append('run.started', 'user', 'run a', { runId: 'r1' });
    now = new Date(2026, 9, 1, 0, 1); // Oct 2026
    log.append('run.finished', 'suite', 'run a → passed', { runId: 'r1' });
    log.append('chat.turn', 'ai', 'login with hunter2\nplease');
    expect(readdirSync(join(d, 'activity')).sort()).toEqual(['2026-09.jsonl', '2026-10.jsonl']);
    expect(monthOf(now)).toBe('2026-10');
    appendFileSafe(join(d, 'activity', '2026-10.jsonl'), 'not json\n');

    const all = log.list();
    expect(all.map((e) => e.kind)).toEqual(['chat.turn', 'run.finished', 'run.started', 'project.created']);
    expect(all[0]!.summary).toBe('login with *** please');
    expect(all[2]!.ref).toEqual({ runId: 'r1' });
    expect(log.list({ actors: ['suite'] }).map((e) => e.kind)).toEqual(['run.finished']);
    expect(log.list({ kinds: ['run.started', 'run.finished'] })).toHaveLength(2);
    expect(log.list({ limit: 1 })).toHaveLength(1);
    expect(seen).toEqual(['project.created', 'run.started', 'run.finished', 'chat.turn']);
    // Earlier lines are untouched by later appends (append-only).
    const sep = readFileSync(join(d, 'activity', '2026-09.jsonl'), 'utf8').trim().split('\n');
    expect(sep).toHaveLength(2);
  });

  it('never throws into callers', () => {
    const d = tmp();
    writeFileSync(join(d, 'activity'), 'a file where the folder should be');
    const log = new ActivityLog(d);
    expect(log.append('run.started', 'user', 'x')).toBeUndefined();
    expect(log.list()).toEqual([]);
  });
});

function appendFileSafe(file: string, text: string): void {
  writeFileSync(file, readFileSync(file, 'utf8') + text);
}

describe('run-option assembly (environment → env / secrets / runsDir / baselineDir / browser)', () => {
  const project = {
    id: 'proj001',
    name: 'Portal',
    description: '',
    browser: { engine: 'firefox' as const, device: 'iPhone 15', headless: false },
    pinned: false,
    createdAt: '',
    lastOpenedAt: '',
    environments: [],
    suites: [],
  };
  const env = { id: 'env0001', name: 'staging', baseUrl: 'https://staging.example.com', vars: { LOCALE: 'ko', BASE_PATH: '/app' }, secretNames: ['USER_PASSWORD'] };

  it('composes process env + BASE_URL + vars (+ overrides) and project folders', () => {
    const a = assembleRun(
      { project, projectDir: '/u/projects/proj001', env, secrets: { USER_PASSWORD: 'pw' }, processEnv: { PATH: '/bin', BASE_URL: 'http://wrong', EUTA_APP_TOKEN: 'tok', LOCALE: 'en' } },
      { env: { EXTRA: '1' }, vars: { reportName: 'R' } },
      { suiteRunId: 'srun01' },
    );
    expect(a.env).toEqual({ PATH: '/bin', BASE_URL: 'https://staging.example.com', LOCALE: 'ko', BASE_PATH: '/app', EXTRA: '1' });
    for (const k of INTERNAL_ENV) expect(a.env[k]).toBeUndefined();
    expect(a.secrets).toEqual({ USER_PASSWORD: 'pw' });
    expect(a.vars).toEqual({ reportName: 'R' });
    expect(a.runsDir).toBe(join('/u/projects/proj001', 'runs'));
    expect(a.baselineDir).toBe(join('/u/projects/proj001', 'baselines', 'env0001'));
    expect(a).toMatchObject({ headless: false, browserEngine: 'firefox', browserDevice: 'iPhone 15' });
    expect(a.meta).toEqual({ projectId: 'proj001', projectName: 'Portal', envId: 'env0001', envName: 'staging', suiteRunId: 'srun01' });
    // Per-run overrides win over the project defaults.
    expect(assembleRun({ project, projectDir: '/p', env, secrets: {}, processEnv: {} }, { headless: true, browser: 'chromium' })).toMatchObject({ headless: true, browserEngine: 'chromium' });
  });

  it('without an environment: no BASE_URL, no baselines override', () => {
    const a = assembleRun({ project, projectDir: '/p', secrets: {}, processEnv: { HOME: '/h' } });
    expect(a.env).toEqual({ HOME: '/h' });
    expect(a.baselineDir).toBeUndefined();
    expect(a.meta).toEqual({ projectId: 'proj001', projectName: 'Portal' });
  });

  it('AI tool config uses the same environment settings', () => {
    const c = aiServerConfig({ project, projectDir: '/p', env, secrets: { USER_PASSWORD: 'pw' }, processEnv: {} });
    expect(c).toMatchObject({
      runsDir: join('/p', 'runs'),
      baselineDir: join('/p', 'baselines', 'env0001'),
      secrets: { USER_PASSWORD: 'pw' },
      runHeadless: false,
      sessionHeadless: false,
      runBrowser: { engine: 'firefox', device: 'iPhone 15' },
      runMeta: { projectId: 'proj001', envName: 'staging', source: 'ai' },
    });
    expect(c.env.BASE_URL).toBe('https://staging.example.com');
  });
});

