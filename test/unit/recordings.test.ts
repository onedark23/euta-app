// Demonstration recordings in a project (SPEC 스크립트-작성-시연녹화, app side) against
// the engine fixture site, no model: recorder via ProjectService (headless in tests),
// recordings storage (restart restore, rename, post-hoc sensitive, delete), "AI 없이
// 저장", get_recording (masking, screenshots), "AI로 정리" through the fake agent
// (get_recording → save_script → run_script for real), and the activity log.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Recording } from '@euta/core';
import { startFixtureServer, FIXTURE_USER, type FixtureServer } from '../../../euta-engine/packages/core/test/fixture-site/server.js';
import { fakeQuery } from '../../src/main/ai/fake-agent.js';
import type { SdkModule } from '../../src/main/ai/chat-engine.js';
import { buildSystemPrompt } from '../../src/main/ai/agent-options.js';
import { createAppTools } from '../../src/main/ai/tools.js';
import { LiveStore } from '../../src/main/live-store.js';
import { ProjectService } from '../../src/main/project/service.js';
import { RecordingStore } from '../../src/main/project/recording-store.js';
import type { RecordingView } from '../../src/shared/types.js';
import { allFiles, mockSafeStorage } from './helpers.js';

const sdk: SdkModule = {
  tool,
  createSdkMcpServer,
  query: () => {
    throw new Error('real query() must not be called in tests');
  },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, what = 'condition', ms = 15_000): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

describe('recordings (ProjectService, fixture site)', () => {
  let site: FixtureServer;
  let root: string;
  let userData: string;
  let live: LiveStore;
  let svc: ProjectService;
  const views: RecordingView[] = [];
  const make = (): ProjectService =>
    new ProjectService({
      userData,
      safeStorage: mockSafeStorage(),
      live,
      platform: 'darwin',
      processEnv: { ...process.env, BASE_URL: 'http://127.0.0.1:9/wrong-if-used' },
      chat: { loadSdk: async () => sdk, queryFn: fakeQuery, throttleMs: 0 },
      watch: false,
      recorderHeadless: true,
      events: { recordingUpdate: (v) => views.push(v) },
    });
  let pid = '';
  let envId = '';
  let recId = '';
  const view = (): RecordingView => svc.recordingView()!;
  const lastEv = (kind: string, pred: (e: RecordingView['events'][number]) => boolean = () => true) =>
    until(() => [...view().events].reverse().find((e) => e.kind === kind && pred(e)), kind);

  beforeAll(async () => {
    site = await startFixtureServer();
    root = mkdtempSync(join(tmpdir(), 'euta-rec-'));
    userData = join(root, 'userData');
    live = new LiveStore({ throttleMs: 0, projectOf: (d) => svc?.projectOfRunDir(d) });
    svc = make();
    const v = svc.create({ name: 'Rec portal', baseUrl: site.url });
    pid = v.id;
    envId = v.environments[0]!.id;
    svc.setSecret(pid, envId, 'USER_PASSWORD', FIXTURE_USER.password);
  });

  afterAll(async () => {
    await svc?.dispose();
    live?.dispose();
    await site?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('records a demonstration in the project environment and stores it under recordings/', async () => {
    const started = await svc.startRecording(pid, { envId, startPath: '/login', name: 'Login demo' });
    recId = started.id;
    expect(started).toMatchObject({ projectId: pid, envId, name: 'Login demo', status: 'recording' });
    await expect(svc.startRecording(pid, {})).rejects.toThrow(/이미 진행 중/);
    expect(svc.deleteBlocker(pid)).toMatch(/녹화/);
    const page = svc.activeRecorderPage()!;
    await lastEv('navigate');
    await page.getByLabel('이메일').pressSequentially(FIXTURE_USER.email, { delay: 2 });
    const email = await lastEv('fill', (e) => e.value === FIXTURE_USER.email);
    await svc.recordingControl(pid, recId, 'sensitive', { seq: email.seq });
    await page.getByLabel('비밀번호').pressSequentially(FIXTURE_USER.password, { delay: 2 });
    await lastEv('fill', (e) => !!e.sensitive && e.secretHint === 'PASSWORD');
    await svc.recordingControl(pid, recId, 'note', { text: '여기서 로그인' });
    await page.getByRole('button', { name: '로그인' }).click();
    await page.waitForURL(/dashboard/);
    await svc.recordingControl(pid, recId, 'checkpoint', { kind: 'textEquals' });
    expect(view().checkpoint).toBe('textEquals');
    await page.getByTestId('total').click();
    const cp = await lastEv('checkpoint');
    expect(cp.checkpoint).toEqual({ kind: 'textEquals', value: '1,200' });
    await svc.recordingControl(pid, recId, 'annotate', { seq: cp.seq, text: '합계 확인' });
    await svc.recordingControl(pid, recId, 'pause');
    expect(view().status).toBe('paused');
    await svc.recordingControl(pid, recId, 'resume');
    const stopped = (await svc.recordingControl(pid, recId, 'stop')) as RecordingView;
    expect(stopped.status).toBe('stopped');
    expect(svc.activeRecorderPage()).toBeUndefined();
    expect(views.length).toBeGreaterThan(5);
    expect(JSON.stringify(views)).not.toContain(FIXTURE_USER.password);

    const dir = join(userData, 'projects', pid, 'recordings', recId);
    const rec = JSON.parse(readFileSync(join(dir, 'recording.json'), 'utf8')) as Recording;
    expect(rec).toMatchObject({ id: recId, name: 'Login demo', envId, baseUrl: site.url, startUrl: `${site.url}/login` });
    expect(readdirSync(join(dir, 'shots')).length).toBeGreaterThan(0);
    expect(svc.recordings(pid)).toEqual([expect.objectContaining({ id: recId, name: 'Login demo', checkpoints: 1, sensitive: 2 })]);
    const kinds = svc.activity(pid, { kinds: ['recording.started', 'recording.finished'] });
    expect(kinds.map((k) => k.kind).sort()).toEqual(['recording.finished', 'recording.started']);
    expect(kinds.find((k) => k.kind === 'recording.finished')!.summary).toContain('체크포인트 1개');
    expect(kinds[0]!.ref?.recordingId).toBe(recId);
  }, 120_000);

  it('"AI 없이 저장" puts the draft in the library with the missing secret names; it runs green', async () => {
    const d = svc.saveRecordingDraft(pid, recId, envId);
    expect(d.path).toBe('login-demo.yaml');
    expect(d.secrets).toEqual(['USER_EMAIL', 'USER_PASSWORD']); // PASSWORD → existing USER_PASSWORD
    expect(d.missingSecrets).toEqual(['USER_EMAIL']);
    expect(svc.scripts(pid).map((s) => s.path)).toContain('login-demo.yaml');
    // History (SPEC 스크립트-보기-편집): the draft save is a `recording` version.
    expect(svc.scriptVersions(pid, 'login-demo.yaml').versions.map((v) => [v.version, v.actor, v.kind])).toEqual([[1, 'recording', 'create']]);
    expect(readFileSync(join(userData, 'projects', pid, 'scripts', 'login-demo.yaml'), 'utf8')).toContain('# 등록 필요 secret: USER_EMAIL');
    const conv = svc.activity(pid, { kinds: ['recording.converted'] })[0]!;
    expect(conv.summary).toContain('login-demo.yaml');
    expect(conv.summary).toContain('USER_EMAIL');
    svc.setSecret(pid, envId, 'USER_EMAIL', FIXTURE_USER.email);
    expect(svc.recordingDraft(pid, recId).missingSecrets).toEqual([]);
    const r = await svc.startRun({ projectId: pid, script: 'login-demo.yaml', envId, vars: '', env: '', headless: true }).result;
    expect(r.steps.filter((s) => s.status !== 'passed').map((s) => [s.stepId, s.error])).toEqual([]);
    expect(r.status).toBe('passed');
  }, 120_000);

  it('"AI로 정리" opens a project chat; the test agent calls get_recording → save_script → run_script', async () => {
    const chat = svc.tidyRecording(pid, recId, envId, '결제 단계는 없어요');
    const engine = svc.chatEngine(pid);
    const done = await until(() => {
      const c = engine.get(chat.id);
      return c && !c.busy && c.items.some((i) => i.kind === 'assistant' && i.text.includes('실행 결과')) ? c : undefined;
    }, 'tidy chat', 120_000);
    const user = done.items.find((i) => i.kind === 'user') as { text: string };
    expect(user.text).toContain(`recordingId: ${recId}`);
    expect(user.text).toContain('결제 단계는 없어요');
    const tools = done.items.filter((i) => i.kind === 'tool') as { name: string; status: string; runStatus?: string; result?: string }[];
    expect(tools.map((t) => t.name)).toEqual(['get_recording', 'save_script', 'run_script']);
    expect(tools.every((t) => t.status === 'done')).toBe(true);
    expect(tools[2]!.runStatus).toBe('passed');
    expect(done.envId).toBe(envId);
    expect(svc.scripts(pid).map((s) => s.path)).toContain('login-demo-ai.yaml');
    // AI save_script goes through the history-aware write path (actor ai).
    expect(svc.scriptVersions(pid, 'login-demo-ai.yaml').versions.map((v) => v.actor)).toEqual(['ai']);
    expect(svc.activity(pid, { kinds: ['script.created'] }).find((e) => e.ref?.script === 'login-demo-ai.yaml')?.actor).toBe('ai');
    const acts = svc.activity(pid);
    expect(acts.some((a) => a.kind === 'recording.converted' && a.ref?.chatId === chat.id)).toBe(true);
    expect(acts.some((a) => a.kind === 'chat.turn' && a.summary.includes('get_recording, save_script, run_script'))).toBe(true);
    expect(JSON.stringify(engine.get(chat.id))).not.toContain(FIXTURE_USER.password);
  }, 180_000);

  it('get_recording masks secret values, returns screenshots on request, and reports unknown ids', async () => {
    const store = new RecordingStore(join(userData, 'projects', pid, 'recordings'));
    const rec = store.require(recId);
    // A value the person typed into a normal field that happens to equal a secret.
    rec.events.push({ seq: 999, at: 99_999, kind: 'fill', url: `${site.url}/x`, target: { chosen: { label: 'Note' }, candidates: [] }, value: `copy of ${FIXTURE_USER.password}` });
    const shotSeq = rec.events.find((e) => e.shot)!.seq;
    const tools = createAppTools({
      config: { runsDir: join(root, 'runs-x'), secrets: { USER_PASSWORD: FIXTURE_USER.password }, env: {}, runHeadless: true, sessionHeadless: true, stepImage: 'on-failure' },
      workDir: join(userData, 'projects', pid, 'scripts'),
      recordings: { get: (id) => (id === recId ? rec : undefined), list: () => store.list(), file: (id, rel) => store.file(id, rel), secretNames: () => ['USER_PASSWORD'] },
    });
    const t = tools.byName.get('get_recording')!;
    const r = await t.handler({ recordingId: recId, screenshots: [shotSeq] });
    expect(r.isError).toBeFalsy();
    const all = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(all).not.toContain(FIXTURE_USER.password);
    expect(all).toContain('copy of ***');
    const meta = JSON.parse((r.content[0] as { text: string }).text) as { events: { el?: string }[]; secretsNeeded: string[]; missingSecrets: string[] };
    expect(meta.secretsNeeded).toEqual(['USER_EMAIL', 'USER_PASSWORD']);
    expect(meta.missingSecrets).toEqual(['USER_EMAIL']);
    expect(meta.events.every((e) => e.el === undefined)).toBe(true);
    expect((r.content[1] as { text: string }).text).toContain('version: 1');
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    const bad = await t.handler({ recordingId: 'zzzzzz999' });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toContain(recId);
    expect((await t.handler({ recordingId: recId, screenshots: [1, 2, 3, 4, 5, 6, 7] })).isError).toBe(true);
    await tools.shutdown();
  });

  it('system prompt carries the tidy-up and "말로 시키기" guidance', () => {
    const p = buildSystemPrompt({ workDir: '/w', runsDir: '/r', secretNames: [] });
    for (const s of ['recordingId', 'get_recording', 'validate_script → run_script', 'at most 3 runs', '${secrets.NAME}', '말로 시키기', 'session_export']) expect(p).toContain(s);
  });

  it('a restart restores recordings; rename, post-hoc sensitive marking and delete work', async () => {
    await svc.dispose();
    svc = make();
    expect(svc.recordingView()).toBeUndefined();
    expect(svc.recordings(pid).map((r) => r.id)).toEqual([recId]);
    expect(svc.renameRecording(pid, recId, '로그인 시연').name).toBe('로그인 시연');
    expect(svc.recordings(pid)[0]!.name).toBe('로그인 시연');
    const store = svc.recordingStore(pid);
    const fill = store.require(recId).events.find((e) => e.kind === 'fill' && !e.sensitive);
    expect(fill).toBeUndefined(); // both login fields are already sensitive
    await expect(svc.recordingControl(pid, recId, 'pause')).rejects.toThrow(/진행 중이 아닙니다/);
    // Mark a synthetic plain fill sensitive after the fact.
    const rec = store.require(recId);
    rec.events.push({ seq: 500, at: 1, kind: 'fill', url: 'u', doc: 'zz', el: 'zz:1', value: 'plain-but-private', field: { tag: 'input', selectors: ['#p'] } });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(store.dir(recId), 'recording.json'), JSON.stringify(rec));
    await svc.recordingControl(pid, recId, 'sensitive', { seq: 500 });
    expect(readFileSync(join(store.dir(recId), 'recording.json'), 'utf8')).not.toContain('plain-but-private');
    expect(() => store.file(recId, '../../project.json')).toThrow();
    svc.deleteRecording(pid, recId);
    expect(svc.recordings(pid)).toEqual([]);
    expect(existsSync(join(userData, 'projects', pid, 'recordings', recId))).toBe(false);
  });

  it('no plaintext secret anywhere under userData', () => {
    const needles = [FIXTURE_USER.password, FIXTURE_USER.email, encodeURIComponent(FIXTURE_USER.password)];
    const hits = allFiles(userData).filter((f) => needles.some((n) => readFileSync(f).includes(Buffer.from(n))));
    expect(hits).toEqual([]);
  });
});
