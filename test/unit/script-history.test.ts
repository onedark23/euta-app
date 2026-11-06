// Script version history and the single write path (SPEC 스크립트-보기-편집 완료 기준, app side):
// save (user) / outside change (external, watcher + detail open) / AI save_script (ai) /
// restore / rename continuity / delete → restore / 100-version cap / conflict handling /
// step-sentence diff summary / latest-run overlay hash match. No browser, no model.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYaml, RunIndex, scriptHash, toScriptEdit } from '@euta/core';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { fakeQuery } from '../../src/main/ai/fake-agent.js';
import type { SdkModule } from '../../src/main/ai/chat-engine.js';
import { buildSystemPrompt } from '../../src/main/ai/agent-options.js';
import { LiveStore } from '../../src/main/live-store.js';
import { ProjectService } from '../../src/main/project/service.js';
import { MAX_VERSIONS } from '../../src/main/project/script-history.js';
import { diffScripts } from '../../src/shared/script-diff.js';
import type { ChatView, ScriptEditPayload } from '../../src/shared/types.js';
import { mockSafeStorage } from './helpers.js';

const BASE = `# login flow
version: 1
name: Login
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: /login # start
  - fill: { target: { label: 이메일 }, value: "\${secrets.USER_EMAIL}" }
  - click: { target: { role: button, name: 로그인 } }
`;

const until = async <T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> => {
  const t = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const sdk: SdkModule = {
  tool,
  createSdkMcpServer,
  query: () => {
    throw new Error('real query() must not be called in tests');
  },
};

const editOf = (text: string): ScriptEditPayload => toScriptEdit(parseYaml(text).value) as ScriptEditPayload;

describe('script history + write path (ProjectService)', () => {
  let root: string;
  let userData: string;
  let svc: ProjectService;
  let pid = '';
  let envId = '';
  let scriptsDir = '';
  const changed: string[] = [];

  const make = (): ProjectService =>
    new ProjectService({
      userData,
      safeStorage: mockSafeStorage(),
      live: new LiveStore({ throttleMs: 0 }),
      platform: 'darwin',
      processEnv: { PATH: process.env.PATH },
      watchDebounceMs: 50,
      chat: { loadSdk: async () => sdk, queryFn: fakeQuery, throttleMs: 0 },
      events: { scriptsChanged: (id) => changed.push(id) },
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'euta-hist-'));
    userData = join(root, 'userData');
    svc = make();
    const v = svc.create({ name: 'History', baseUrl: 'http://127.0.0.1:9' });
    pid = v.id;
    envId = v.environments[0]!.id;
    scriptsDir = v.dirs.scripts;
    svc.setSecret(pid, envId, 'USER_PASSWORD', 'pw-value-1');
  });

  afterAll(async () => {
    await svc?.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('creating a script records version 1 (user · create); the detail view shows it', () => {
    const ext = join(root, 'login.yaml');
    writeFileSync(ext, BASE);
    expect(svc.importScript(pid, ext)).toBe('login.yaml');
    const d = svc.scriptDetail(pid, 'login.yaml', envId);
    expect(d.text).toBe(BASE);
    expect(d.hash).toBe(scriptHash(BASE));
    expect(d.latest).toMatchObject({ version: 1, actor: 'user', kind: 'create', path: 'login.yaml' });
    expect(d.issues).toEqual([]);
    // USER_EMAIL is not registered in the environment: a warning, not a blocking issue.
    expect(d.missingSecrets).toEqual(['USER_EMAIL']);
    expect(d.secretNames).toEqual(['USER_PASSWORD']);
    expect(d.unstable).toBe(0);
    expect(d.lastRun).toBeUndefined();
  });

  it('editor save: validates, keeps comments, records a user version with a diff summary', () => {
    const d = svc.scriptDetail(pid, 'login.yaml', envId);
    const e = editOf(d.text);
    e.steps.push({ step: { expect: { url: '/dashboard' } } });
    (e.steps[2]!.step.click as { target: { name: string } }).target.name = 'Sign in';
    const r = svc.saveScript(pid, 'login.yaml', d.text, e, { envId });
    expect(r).toMatchObject({ ok: true, path: 'login.yaml' });
    const text = readFileSync(join(scriptsDir, 'login.yaml'), 'utf8');
    expect(text).toContain('# login flow');
    expect(text).toContain('- goto: /login # start');
    expect(text).toContain('- expect: { url: /dashboard }');
    const vs = svc.scriptVersions(pid, 'login.yaml').versions;
    expect(vs.map((v) => [v.version, v.actor, v.kind])).toEqual([
      [1, 'user', 'create'],
      [2, 'user', 'save'],
    ]);
    expect(vs[1]!.summary).toBe('단계 1개 추가, 1개 변경');
    const act = svc.activity(pid, { kinds: ['script.changed'] })[0]!;
    expect(act.summary).toContain('단계 1개 추가, 1개 변경');
    expect(act.actor).toBe('user');
  });

  it('save is refused while the result has validation errors', () => {
    const d = svc.scriptDetail(pid, 'login.yaml', envId);
    const e = editOf(d.text);
    e.steps.push({ step: { click: {} } });
    const r = svc.saveScript(pid, 'login.yaml', d.text, e);
    expect(r.ok).toBe(false);
    expect(!r.ok && !r.conflict && r.issues.length).toBeGreaterThan(0);
    expect(svc.checkDraft(pid, d.text, e).issues[0]!.path).toBe('steps[4].click.target');
    expect(svc.scriptVersions(pid, 'login.yaml').versions).toHaveLength(2);
  });

  it('an outside change (watcher) becomes an external version; editing on a stale base is a conflict', async () => {
    svc.open(pid); // starts the watcher
    const d = svc.scriptDetail(pid, 'login.yaml', envId);
    await new Promise((r) => setTimeout(r, 300));
    const outside = d.text.replace('name: Login', 'name: Login (outside)');
    writeFileSync(join(scriptsDir, 'login.yaml'), outside);
    await until(() => svc.scriptVersions(pid, 'login.yaml').versions.length === 3);
    const v3 = svc.scriptVersions(pid, 'login.yaml').versions[2]!;
    expect([v3.actor, v3.kind, v3.summary]).toEqual(['external', 'external', '머리 정보 변경: 이름']);
    // The editor still has the old base → conflict, nothing written.
    const e = editOf(d.text);
    e.steps.pop();
    const r = svc.saveScript(pid, 'login.yaml', d.text, e);
    expect(r).toMatchObject({ ok: false, conflict: true, hash: scriptHash(outside) });
    expect(readFileSync(join(scriptsDir, 'login.yaml'), 'utf8')).toBe(outside);
    // "내 것으로 저장": force — the outside change stays in history (v3), mine is v4.
    const f = svc.saveScript(pid, 'login.yaml', d.text, e, { force: true });
    expect(f.ok).toBe(true);
    const vs = svc.scriptVersions(pid, 'login.yaml').versions;
    expect(vs.map((v) => v.actor)).toEqual(['user', 'user', 'external', 'user']);
    expect(svc.activity(pid, { kinds: ['script.changed'] }).some((a) => a.summary.includes('머리 정보 변경: 이름'))).toBe(true);
  });

  it('a change while the app was not looking is caught when the detail opens', () => {
    const quiet = make(); // no watcher started for this instance
    const p = join(scriptsDir, 'login.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('/login # start', '/signin # start'));
    const d = quiet.scriptDetail(pid, 'login.yaml');
    expect(d.latest).toMatchObject({ version: 5, actor: 'external', summary: '단계 1개 변경' });
    void quiet.dispose();
  });

  it('AI save_script writes through the same path (actor ai)', () => {
    const chat = { id: 'c1', envId } as ChatView;
    const ctx = svc.chatContext(pid, chat);
    const cur = readFileSync(join(scriptsDir, 'login.yaml'), 'utf8');
    ctx.writeScript!(join(ctx.workDir, 'login.yaml'), `${cur}  - measure: timing\n`);
    const last = svc.scriptVersions(pid, 'login.yaml').versions.at(-1)!;
    expect([last.actor, last.kind, last.summary]).toEqual(['ai', 'save', '단계 1개 추가']);
    expect(svc.activity(pid, { kinds: ['script.changed'] })[0]!.actor).toBe('ai');
  });

  it('"AI에게 수정 요청": a new chat gets path, step and request; the test agent reads, saves (actor ai) and validates', async () => {
    const before = svc.scriptVersions(pid, 'login.yaml').versions.length;
    const chat = svc.requestScriptEdit(pid, 'login.yaml', '이 단계 다음에 시간 측정 추가해줘', { id: '2', sentence: "'이메일' 입력란에 🔒USER_EMAIL 입력" }, envId);
    expect(chat.envId).toBe(envId);
    const engine = svc.chatEngine(pid);
    const done = await until(() => {
      const c = engine.get(chat.id);
      return c && !c.busy && c.items.some((i) => i.kind === 'assistant' && i.text.includes('바꾼 점')) ? c : undefined;
    }, 30_000);
    const user = done.items.find((i) => i.kind === 'user') as { text: string };
    expect(user.text).toContain('scriptEdit: login.yaml');
    expect(user.text).toContain("대상 단계: 2번 — '이메일' 입력란에 🔒USER_EMAIL 입력");
    expect(user.text).toContain('요청: 이 단계 다음에 시간 측정 추가해줘');
    expect(user.text).toContain('환경: default');
    const tools = done.items.filter((i) => i.kind === 'tool') as { name: string; status: string }[];
    expect(tools.map((t) => [t.name, t.status])).toEqual([
      ['read_file', 'done'],
      ['save_script', 'done'],
      ['validate_script', 'done'],
    ]);
    const vs = svc.scriptVersions(pid, 'login.yaml').versions;
    expect(vs).toHaveLength(before + 1);
    expect(vs.at(-1)).toMatchObject({ actor: 'ai', kind: 'save', summary: '단계 1개 추가' });
    expect(readFileSync(join(scriptsDir, 'login.yaml'), 'utf8')).toContain('name: AI 가 추가한 시간 측정');
    expect(buildSystemPrompt({ workDir: '/w', runsDir: '/r', secretNames: [] })).toContain('scriptEdit: <path>');
    expect(() => svc.requestScriptEdit(pid, 'login.yaml', '   ')).toThrow(/요청 내용/);
  });

  it('compare shows step sentences; restore puts an old version back and keeps the current one', () => {
    const h = svc.scriptVersions(pid, 'login.yaml');
    const cmp = svc.compareVersions(pid, h.key!, 2);
    expect(cmp.from?.version).toBe(1);
    expect(cmp.rows.filter((r) => r.kind !== 'same')).toEqual([
      { kind: 'changed', depth: 0, before: "'로그인' 버튼 클릭", after: "'Sign in' 버튼 클릭" },
      { kind: 'added', depth: 0, after: '확인: 주소에 /dashboard 포함' },
    ]);
    const before = h.versions.length;
    const r = svc.restoreVersion(pid, h.key!, 1);
    expect(r.conflict).toBeFalsy();
    expect(readFileSync(join(scriptsDir, 'login.yaml'), 'utf8')).toBe(BASE);
    const vs = svc.scriptVersions(pid, 'login.yaml').versions;
    expect(vs).toHaveLength(before + 1);
    expect(vs.at(-1)).toMatchObject({ actor: 'restore', kind: 'restore' });
    expect(svc.activity(pid, { kinds: ['script.restored'] })[0]!.summary).toContain('버전 1');
  });

  it('a rename keeps the history (same key); delete keeps it and the script can be restored', () => {
    const key = svc.scriptVersions(pid, 'login.yaml').key!;
    const n = svc.scriptVersions(pid, 'login.yaml').versions.length;
    expect(svc.renameScript(pid, 'login.yaml', 'flows/login-renamed.yaml')).toBe('flows/login-renamed.yaml');
    const h = svc.scriptVersions(pid, 'flows/login-renamed.yaml');
    expect(h.key).toBe(key);
    expect(h.versions).toHaveLength(n + 1);
    expect(h.versions.at(-1)).toMatchObject({ kind: 'rename', path: 'flows/login-renamed.yaml', summary: '이름 변경: login.yaml → flows/login-renamed.yaml' });
    expect(svc.scriptVersions(pid, 'login.yaml').versions).toEqual([]);

    svc.deleteScript(pid, 'flows/login-renamed.yaml');
    expect(existsSync(join(scriptsDir, 'flows/login-renamed.yaml'))).toBe(false);
    const del = svc.deletedScripts(pid);
    expect(del).toEqual([expect.objectContaining({ key, path: 'flows/login-renamed.yaml', name: 'Login' })]);
    expect(() => svc.restoreVersion(pid, key, 1)).toThrow(/삭제된 스크립트/);
    const rel = svc.undeleteScript(pid, key);
    expect(rel).toBe('flows/login-renamed.yaml');
    expect(readFileSync(join(scriptsDir, rel), 'utf8')).toBe(BASE);
    expect(svc.deletedScripts(pid)).toEqual([]);
    const vs = svc.scriptVersions(pid, rel).versions;
    expect(vs.slice(-2).map((v) => [v.kind, v.actor])).toEqual([
      ['delete', 'user'],
      ['undelete', 'restore'],
    ]);
  });

  it(`keeps the newest ${MAX_VERSIONS} versions per script`, () => {
    const rel = svc.createScript(pid, 'many.yaml', 'Many');
    let text = readFileSync(join(scriptsDir, rel), 'utf8');
    for (let i = 0; i < 105; i++) {
      text = text.replace(/name: .*/, `name: "Many ${i}"`);
      svc.writeScript(pid, rel, text, 'user');
    }
    const h = svc.scriptVersions(pid, rel);
    expect(h.versions).toHaveLength(MAX_VERSIONS);
    expect(h.versions[0]!.version).toBe(7);
    expect(h.versions.at(-1)!.version).toBe(106);
    const files = readdirSync(join(userData, 'projects', pid, 'script-history', h.key!)).filter((f) => f.endsWith('.yaml'));
    expect(files).toHaveLength(MAX_VERSIONS);
  });

  it('history survives a restart', async () => {
    const before = svc.scriptVersions(pid, 'flows/login-renamed.yaml');
    await svc.dispose();
    svc = make();
    expect(svc.scriptVersions(pid, 'flows/login-renamed.yaml')).toEqual(before);
  });

  it('latest-run overlay: per-step results, hash match vs "수정 이후 아직 실행하지 않음"', () => {
    const rel = 'flows/login-renamed.yaml';
    const abs = join(scriptsDir, rel);
    const runsDir = join(userData, 'projects', pid, 'runs');
    const runDir = join(runsDir, 'r-overlay');
    mkdirSync(runDir, { recursive: true });
    const text = readFileSync(abs, 'utf8');
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        id: 'r-overlay',
        scriptHash: scriptHash(text),
        meta: { envName: 'default' },
        status: 'failed',
        steps: [
          { stepId: '1', status: 'passed', durationMs: 400, screenshot: 'screenshots/1.png' },
          { stepId: '2', status: 'failed', durationMs: 20, error: 'boom' },
        ],
      }),
    );
    RunIndex.with(runsDir, (idx) =>
      idx.upsertRun({ id: 'r-overlay', kind: 'script', name: 'Login', scriptPath: abs, status: 'failed', startedAt: new Date().toISOString(), finishedAt: null, durationMs: 1, dir: runDir, browser: 'chromium', total: 2, passed: 1, failed: 1, errors: 0, skipped: 0 }),
    );
    const d = svc.scriptDetail(pid, rel);
    expect(d.lastRun).toMatchObject({ runId: 'r-overlay', status: 'failed', envName: 'default', hashMatch: true });
    expect(d.lastRun!.steps['1']).toEqual({ status: 'passed', durationMs: 400, screenshot: 'screenshots/1.png' });
    expect(d.lastRun!.steps['2']!.error).toBe('boom');
    writeFileSync(abs, `${text}# edited\n`);
    expect(svc.scriptDetail(pid, rel).lastRun!.hashMatch).toBe(false);
  });
});

describe('diffScripts (step-sentence diff)', () => {
  const parse = (t: string) => parseYaml(t).value;
  it('summarizes added / changed / removed steps and header fields', () => {
    const a = parse(BASE);
    const b = parse(BASE.replace('name: Login', 'name: Other').replace('  - goto: /login # start\n', '').concat('  - wait: { ms: 500 }\n  - measure: timing\n'));
    const d = diffScripts(a, b);
    expect(d.summary).toBe('단계 2개 추가, 1개 삭제 · 머리 정보 변경: 이름');
    expect(d.rows.map((r) => r.kind)).toEqual(['removed', 'same', 'same', 'added', 'added']);
    expect(diffScripts(undefined, a).summary).toBe('처음 기록 (단계 3개)');
    expect(diffScripts(a, a).summary).toBe('단계 변화 없음 (서식·주석만)');
  });

  it('pairs only same-action steps as "changed"', () => {
    const a = parse(BASE);
    const b = parse(BASE.replace("  - click: { target: { role: button, name: 로그인 } }\n", '  - wait: { ms: 300 }\n').replace('/login # start', '/signin # start'));
    const d = diffScripts(a, b);
    expect(d.rows.map((r) => r.kind)).toEqual(['changed', 'same', 'removed', 'added']);
    expect(d.summary).toBe('단계 1개 추가, 1개 변경, 1개 삭제');
  });

  it('compares group children with their depth', () => {
    const g = (inner: string) => parse(`version: 1\nname: g\nsteps:\n  - group:\n      name: 로그인\n      steps:\n${inner}`);
    const d = diffScripts(g('        - goto: /a\n'), g('        - goto: /a\n        - goto: /b\n'));
    expect(d.rows).toEqual([
      { kind: 'same', depth: 0, before: '묶음: 로그인', after: '묶음: 로그인' },
      { kind: 'same', depth: 1, before: '/a 으로 이동', after: '/a 으로 이동' },
      { kind: 'added', depth: 1, after: '/b 으로 이동' },
    ]);
  });
});
