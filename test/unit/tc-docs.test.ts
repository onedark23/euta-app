import { TcDocStore } from '../../src/main/project/tc-doc-store.js';
// TC document conversion, app side (SPEC TC-문서-변환 완료 기준 "앱 단위"): import + preview confirm
// (engine parser on the synthetic block xlsx), the tc-doc store (restart persistence, queue,
// 변환 중 → 대기 on a stopped turn), the AI tools (get_tc_doc · get_tc · set_tc_conversion ·
// get_tc_import · save_tc_extraction, secret masking), conversion chats through the scripted test
// agent against the fixture site (queue order, precondition scripts first, Stop keeps the queue),
// test set plans, mapping, export round trip, and the TC recording draft.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { exportTcDocument, parseTcDocument } from '@euta/tc-doc';
import type { Recording } from '@euta/core';
import { startFixtureServer, type FixtureServer } from '../../../euta-engine/packages/core/test/fixture-site/server.js';
import { fakeQuery } from '../../src/main/ai/fake-agent.js';
import type { SdkModule } from '../../src/main/ai/chat-engine.js';
import { buildSystemPrompt } from '../../src/main/ai/agent-options.js';
import { createAppTools } from '../../src/main/ai/tools.js';
import { LiveStore } from '../../src/main/live-store.js';
import { ProjectService } from '../../src/main/project/service.js';
import { countManualSteps, engineTc, mappingFor, planTestSets, preFileName, tcFileName } from '../../src/main/project/tc-docs.js';
import type { TcDoc, TcImportView, TcInput } from '../../src/shared/types.js';
import { mockSafeStorage } from './helpers.js';

const FIXTURES = resolve(import.meta.dirname, '../../../euta-engine/packages/tc-doc/test/fixtures');
const sdk: SdkModule = {
  tool,
  createSdkMcpServer,
  query: () => {
    throw new Error('real query() must not be called in tests');
  },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, what = 'condition', ms = 60_000): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}
type Res = { content: { type: string; text?: string }[]; isError?: boolean };
const body = (r: Res, i = 0) => JSON.parse(r.content[i]!.text!) as Record<string, any>;

/** The preview edits of the E2E: password line removed, NOTE-03 (no steps) dropped, SHARE-01 renumbered. */
function edited(tcs: TcInput[]): TcInput[] {
  return tcs
    .filter((t) => t.id !== 'NOTE-03')
    .map((t) => (t.id === 'NOTE-02' ? { ...t, precondition: '메모장 웹에 로그인한 상태' } : t))
    .map((t) => ({ ...t, steps: t.steps.map((s, i) => ({ ...s, no: i + 1 })) }));
}

describe('TC documents (ProjectService, fixture site)', () => {
  let site: FixtureServer;
  let root: string;
  let userData: string;
  let live: LiveStore;
  let svc: ProjectService;
  const docEvents: string[] = [];
  const importEvents: TcImportView[] = [];
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
      events: { tcDocChanged: (_p, d) => docEvents.push(d), tcImportUpdate: (v) => importEvents.push(v) },
    });
  let pid = '';
  let envId = '';
  let docId = '';
  let file = '';

  beforeAll(async () => {
    site = await startFixtureServer();
    root = mkdtempSync(join(tmpdir(), 'euta-tcdoc-'));
    userData = join(root, 'userData');
    file = join(root, 'block.xlsx');
    copyFileSync(join(FIXTURES, 'block.xlsx'), file);
    live = new LiveStore({ throttleMs: 0, projectOf: (d) => svc?.projectOfRunDir(d) });
    svc = make();
    const v = svc.create({ name: 'Memo QA', baseUrl: site.url });
    pid = v.id;
    envId = v.environments[0]!.id;
    svc.update(pid, { browser: { engine: 'chromium', headless: true } });
    svc.setSecret(pid, envId, 'MEMO_PASSWORD', 'abcd1234');
  });

  afterAll(async () => {
    await svc?.dispose();
    live?.dispose();
    await site?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('imports a block xlsx into a preview, confirms the edited TCs, and keeps no original file', () => {
    const v = svc.tcDocs.importFile(pid, file);
    expect(v).toMatchObject({ format: 'xlsx', layout: 'block', status: 'ready', fileName: 'block.xlsx' });
    expect(v.tcs.map((t) => t.id)).toEqual(['NOTE-01', 'NOTE-02', 'NOTE-03', 'SHARE-01']);
    expect(v.warnings.map((w) => w.code).sort()).toEqual(['credential', 'no-steps', 'step-number-duplicate', 'step-number-missing']);
    expect(svc.tcDocs.importView(v.importId)).toBeDefined();
    expect(() => svc.tcDocs.importFile(pid, join(FIXTURES, 'make-fixtures.py'))).toThrow(/xlsx/);

    const tcs = edited(v.tcs);
    const doc = svc.tcDocs.confirmImport(pid, v.importId, {
      name: '메모장 QA',
      tcs,
      preconditions: [
        { text: '메모장 웹에 로그인한 상태', tcIds: ['NOTE-01', 'NOTE-02'] },
        { text: '메모가 1개 이상 있는 상태', tcIds: ['SHARE-01'] },
      ],
    });
    docId = doc.id;
    expect(svc.tcDocs.importView(v.importId)).toBeUndefined(); // session (and any grid text) dropped
    expect(doc.preconditions.map((p) => [p.id, p.text, p.status])).toEqual([
      ['pre-1', '메모장 웹에 로그인한 상태', 'pending'],
      ['pre-2', '메모가 1개 이상 있는 상태', 'pending'],
    ]);
    expect(doc.tcs.map((t) => [t.id, t.preconditionId, t.steps.map((s) => s.no).join(',')])).toEqual([
      ['NOTE-01', 'pre-1', '1,2,3'],
      ['NOTE-02', 'pre-1', '1,2'],
      ['SHARE-01', 'pre-2', '1,2,3,4'],
    ]);
    const dir = join(userData, 'projects', pid, 'tc-docs', docId);
    const onDisk = JSON.parse(readFileSync(join(dir, 'tc-doc.json'), 'utf8')) as TcDoc;
    expect(onDisk).toMatchObject({ version: 1, id: docId, name: '메모장 QA', source: { fileName: 'block.xlsx', format: 'xlsx', layout: 'block' }, queue: [] });
    expect(onDisk.tcs[0]!.conversion).toMatchObject({ status: 'pending', manualSteps: 0, missingInfo: [] });
    expect(readFileSync(join(dir, 'tc-doc.json'), 'utf8')).not.toContain('abcd1234');
    expect(svc.tcDocs.list(pid)).toEqual([expect.objectContaining({ id: docId, tcCount: 3, done: 0, queued: 0 })]);
    expect(svc.activity(pid, { kinds: ['tcdoc.imported'] })[0]!.summary).toContain('TC 3개');
    // A confirm with an invalid TC is refused (validateTcs).
    const again = svc.tcDocs.importFile(pid, file);
    expect(() => svc.tcDocs.confirmImport(pid, again.importId, { name: 'x', tcs: [{ id: '', title: '', steps: [] }], preconditions: [] })).toThrow(/TC 를 확인하세요/);
    svc.tcDocs.cancelImport(again.importId);
  });

  it('AI tools: get_tc_doc · get_tc (marks 변환 중) · set_tc_conversion · masking · releaseChat', async () => {
    svc.tcDocs.setQueue(pid, docId, ['SHARE-01', 'NOTE-01']);
    const ctx = svc.chatContext(pid, svc.chatEngine(pid).create(envId));
    const app = createAppTools({ config: ctx.config, workDir: ctx.workDir, tcDocs: ctx.tcDocs! });
    const call = (n: string, a: Record<string, unknown>) => app.byName.get(n)!.handler(a) as Promise<Res>;
    for (const n of ['get_tc_doc', 'get_tc', 'set_tc_conversion', 'get_tc_import', 'save_tc_extraction']) expect(app.names.has(n)).toBe(true);

    const list = body(await call('get_tc_doc', {}));
    expect(list.documents).toEqual([expect.objectContaining({ id: docId, name: '메모장 QA' })]);
    const d = body(await call('get_tc_doc', { docId }));
    expect(d.queue).toEqual(['SHARE-01', 'NOTE-01']);
    expect(d.preconditions.map((p: { id: string }) => p.id)).toEqual(['pre-1', 'pre-2']);

    const tc = body(await call('get_tc', { docId, tcId: 'NOTE-01' }));
    expect(tc).toMatchObject({ file: 'NOTE-01-새-메모-만들기.yaml', description: 'TC ID: NOTE-01', precondition: { id: 'pre-1', exists: false, file: 'pre-1-메모장-웹에-로그인한-상태.yaml', usedBy: ['NOTE-01', 'NOTE-02'] } });
    expect(tc.tc.steps).toHaveLength(3);
    expect(svc.tcDocs.view(pid, docId).tcs.find((t) => t.id === 'NOTE-01')!.conversion).toMatchObject({ status: 'converting', chatId: expect.any(String) });
    // A TC not in the queue is only read.
    body(await call('get_tc', { docId, tcId: 'NOTE-02' }));
    expect(svc.tcDocs.view(pid, docId).tcs.find((t) => t.id === 'NOTE-02')!.conversion.status).toBe('pending');
    expect((await call('get_tc', { docId, tcId: 'NOPE' })).isError).toBe(true);

    // The script must exist in the library before it is recorded as the TC's script.
    const missing = await call('set_tc_conversion', { docId, id: 'NOTE-01', status: 'done', script: 'nope.yaml' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('save_script it first');

    // Secret values in tool results are masked (the document text is data).
    writeFileSync(join(ctx.workDir, 'x.yaml'), 'version: 1\nname: x\nsteps:\n  - manual: abcd1234 확인\n');
    const set = await call('set_tc_conversion', { docId, id: 'NOTE-01', status: 'failed', script: 'x.yaml', note: 'abcd1234 로그인 실패' });
    expect(set.isError).toBeFalsy();
    expect(set.content[0]!.text).not.toContain('abcd1234');
    expect(body(set)).toMatchObject({ recorded: 'NOTE-01', status: 'failed', manualSteps: 1, queue: ['SHARE-01'], then: expect.stringContaining('end your reply') });
    expect(svc.activity(pid, { kinds: ['tcdoc.converted'] })[0]!.summary).not.toContain('abcd1234');

    // Stop: TCs a chat left in 변환 중 go back to 대기 and stay queued.
    body(await call('get_tc', { docId, tcId: 'SHARE-01' }));
    const chatId = svc.tcDocs.view(pid, docId).tcs.find((t) => t.id === 'SHARE-01')!.conversion.chatId!;
    svc.tcDocs.chatTurnEnded(pid, chatId);
    const after = svc.tcDocs.view(pid, docId);
    expect(after.tcs.find((t) => t.id === 'SHARE-01')!.conversion.status).toBe('pending');
    expect(after.queue).toEqual(['SHARE-01']);
    expect(docEvents).toContain(docId);
    rmSync(join(ctx.workDir, 'x.yaml'));
  });

  it('AI extraction: unknown layout → get_tc_import (grid) → save_tc_extraction (issues, then a preview)', async () => {
    const md = join(root, 'unknown.md');
    copyFileSync(join(FIXTURES, 'unknown.md'), md);
    // A grid the parser cannot read: a table without TC headers.
    const odd = join(root, 'odd.csv');
    writeFileSync(odd, '항목,내용,비고\n메모 앱 점검,목록 화면 열기,목록이 보임\n');
    const v = svc.tcDocs.importFile(pid, odd);
    expect(v).toMatchObject({ layout: 'unknown', status: 'needs-ai' });
    const ctx = svc.chatContext(pid, svc.chatEngine(pid).create(envId));
    const app = createAppTools({ config: ctx.config, workDir: ctx.workDir, tcDocs: ctx.tcDocs! });
    const call = (n: string, a: Record<string, unknown>) => app.byName.get(n)!.handler(a) as Promise<Res>;
    const grid = await call('get_tc_import', { importId: v.importId });
    expect(grid.content[1]!.text).toContain('A2=메모 앱 점검');
    const bad = await call('save_tc_extraction', { importId: v.importId, tcs: [{ id: '', title: 'x', steps: [{ no: 1 }] }] });
    expect(bad.isError).toBe(true);
    expect(body(bad).issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(['[0].id', '[0].steps[0].action']));
    const ok = await call('save_tc_extraction', { importId: v.importId, tcs: [{ id: 'EXT-01', title: '메모 앱 점검', steps: [{ no: 1, action: '목록 화면 열기', expected: '목록이 보임' }] }] });
    expect(body(ok)).toMatchObject({ saved: 1, ids: ['EXT-01'] });
    expect(importEvents.at(-1)).toMatchObject({ importId: v.importId, status: 'ready', extractedByAi: true, tcs: [{ id: 'EXT-01' }] });
    // The grid stays in main: not in the view the renderer gets.
    expect(JSON.stringify(svc.tcDocs.importView(v.importId))).not.toContain('A2=');
    svc.tcDocs.cancelImport(v.importId);
    expect((await call('get_tc_import', { importId: v.importId })).isError).toBe(true);
    // The fake agent's extraction chat goes through the same tools.
    const v2 = svc.tcDocs.importFile(pid, odd);
    const chat = svc.tcDocs.extractWithAi(pid, v2.importId, envId);
    await until(() => !svc.chatEngine(pid).get(chat.id)?.busy && svc.chatEngine(pid).get(chat.id)!.items.length > 2, 'extraction chat');
    expect(svc.tcDocs.importView(v2.importId)).toMatchObject({ status: 'ready', extractedByAi: true, tcs: [{ id: 'EXT-01', title: '항목' }] });
    expect(JSON.stringify(svc.chatEngine(pid).get(chat.id))).not.toContain('A2=메모 앱 점검'); // no grid in the saved chat
    svc.tcDocs.cancelImport(v2.importId);
  }, 60_000);

  it('converts the queue one item per message (precondition scripts first) through the test agent; restart keeps everything', async () => {
    svc.tcDocs.store(pid).reset(docId, ['NOTE-01', 'SHARE-01']);
    const chat = svc.tcDocs.convert(pid, docId, { tcIds: ['SHARE-01', 'NOTE-01'], envId, message: 'pauseBetween: 0' });
    expect(svc.tcDocs.view(pid, docId).queue).toEqual(['SHARE-01', 'NOTE-01']);
    await until(() => !svc.tcDocs.view(pid, docId).activeChatId && svc.tcDocs.view(pid, docId).queue.length === 0, 'conversion', 180_000);
    const c = svc.chatEngine(pid).get(chat.id)!;
    const tools = c.items.flatMap((i) => (i.kind === 'tool' ? [i.name] : []));
    expect(tools.slice(0, 8)).toEqual(['save_script', 'validate_script', 'set_tc_conversion', 'get_tc', 'save_script', 'validate_script', 'run_script', 'set_tc_conversion']);
    const v = svc.tcDocs.view(pid, docId);
    expect(v.preconditions.map((p) => [p.id, p.status, p.script])).toEqual([
      ['pre-1', 'done', 'pre-1-메모장-웹에-로그인한-상태.yaml'],
      ['pre-2', 'done', 'pre-2-메모가-1개-이상-있는-상태.yaml'],
    ]);
    const share = v.tcs.find((t) => t.id === 'SHARE-01')!;
    expect(share.conversion).toMatchObject({ status: 'done', script: 'SHARE-01-공유-링크-만들기.yaml', manualSteps: 3, by: 'ai', missingInfo: ['가짜 에이전트: 3단계 이후 화면 정보 없음'] });
    expect(v.scripts['SHARE-01-공유-링크-만들기.yaml']).toMatchObject({ exists: true, name: '공유 링크 만들기', lastRun: { status: 'passed' } });
    expect(v.tcs.find((t) => t.id === 'NOTE-01')!.conversion.status).toBe('done');
    // One message per item, in queue order, each precondition right before the first TC that needs it.
    expect(c.items.flatMap((i) => (i.kind === 'user' ? [/tcConvert: \w+ (\S+)/.exec(i.text)![1]] : []))).toEqual(['pre-2', 'SHARE-01', 'pre-1', 'NOTE-01']);
    const userTexts = c.items.flatMap((i) => (i.kind === 'user' ? [i.text] : []));
    expect(userTexts.find((t) => t.includes(`tcConvert: ${docId} SHARE-01`))).toContain('느슨하게 바꾸지 않습니다');
    expect(svc.tcDocs.view(pid, docId).lastRun).toMatchObject({ reason: 'empty', done: 2, total: 2 });
    const conv = svc.activity(pid, { kinds: ['tcdoc.converted'] }).map((e) => e.summary);
    expect(conv.some((s) => s.includes('완료') && s.includes('SHARE-01') && s.includes('수동 3'))).toBe(true);
    // Mapping (TC 줄 펼치기): step 1 automated, the others manual.
    const m = svc.tcDocs.mapping(pid, docId, 'SHARE-01');
    expect(m.steps.map((s) => [s.no, s.kind])).toEqual([
      [1, 'auto'],
      [2, 'manual'],
      [3, 'manual'],
      [4, 'manual'],
    ]);
    // Restart: documents, conversion state and queue come back.
    svc.tcDocs.setQueue(pid, docId, ['NOTE-02']);
    await svc.dispose();
    svc = make();
    const back = svc.tcDocs.view(pid, docId);
    expect(back.queue).toEqual(['NOTE-02']);
    expect(back.tcs.map((t) => t.conversion.status)).toEqual(['done', 'pending', 'done']);
  }, 240_000);

  it('releaseAll: a 변환 중 left by a quit mid-turn goes back to 대기 on the first use after a restart (not within the same run)', () => {
    const st = svc.tcDocs.store(pid);
    st.setConversion(docId, 'NOTE-02', { status: 'converting', chatId: 'chat-gone' });
    // Same app run: the mark stays (a live conversion may own it).
    expect(svc.tcDocs.store(pid).require(docId).tcs.find((t) => t.id === 'NOTE-02')!.conversion.status).toBe('converting');
    // A restart = a fresh store releases everything still marked.
    const fresh = new TcDocStore(st.root);
    expect(fresh.releaseAll()).toEqual([docId]);
    expect(fresh.require(docId).tcs.find((t) => t.id === 'NOTE-02')!.conversion.status).toBe('pending');
    expect(fresh.releaseAll()).toEqual([]);
  });

  it('a second conversion start is refused while the document conversion runs (before its first get_tc too)', async () => {
    svc.tcDocs.store(pid).reset(docId, ['NOTE-01']);
    const chat = svc.tcDocs.convert(pid, docId, { tcIds: ['NOTE-01'], envId, message: 'pauseBetween: 20000' });
    // Synchronously after the start — the agent has not called get_tc yet; the app marks the item it sent.
    expect(svc.tcDocs.view(pid, docId).tcs.find((t) => t.id === 'NOTE-01')!.conversion).toMatchObject({ status: 'converting', chatId: chat.id });
    expect(svc.tcDocs.view(pid, docId).activeChatId).toBe(chat.id);
    expect(() => svc.tcDocs.convert(pid, docId, { envId })).toThrow(/이미 진행 중/);
    expect(() => svc.tcDocs.convert(pid, docId, { tcIds: ['NOTE-01'], redo: true, envId })).toThrow(/이미 진행 중/);
    expect(svc.chatEngine(pid).list().filter((c) => c.busy).map((c) => c.id)).toEqual([chat.id]);
    svc.chatEngine(pid).stop(chat.id);
    await until(() => !svc.chatEngine(pid).get(chat.id)?.busy, 'stopped');
    expect(svc.tcDocs.view(pid, docId).activeChatId).toBeUndefined(); // the lock goes with the turn
    expect(svc.tcDocs.view(pid, docId).queue).toEqual(['NOTE-01']);
  }, 120_000);

  it('Stop keeps the queue; [이어서 변환] finishes it in a new chat', async () => {
    svc.tcDocs.store(pid).reset(docId, ['NOTE-01', 'SHARE-01']);
    const chat = svc.tcDocs.convert(pid, docId, { tcIds: ['NOTE-01', 'NOTE-02', 'SHARE-01'], envId, message: 'pauseBetween: 20000' });
    await until(() => svc.tcDocs.view(pid, docId).tcs.find((t) => t.id === 'NOTE-01')!.conversion.status === 'done', 'first TC', 120_000);
    svc.chatEngine(pid).stop(chat.id);
    await until(() => !svc.chatEngine(pid).get(chat.id)?.busy, 'stopped');
    let v = svc.tcDocs.view(pid, docId);
    expect(v.queue).toEqual(['NOTE-02', 'SHARE-01']);
    expect(v.tcs.map((t) => t.conversion.status)).toEqual(['done', 'pending', 'pending']);
    const next = svc.tcDocs.convert(pid, docId, { envId, message: 'pauseBetween: 0' });
    expect(next.id).not.toBe(chat.id);
    await until(() => !svc.chatEngine(pid).get(next.id)?.busy && svc.tcDocs.view(pid, docId).queue.length === 0, 'resume', 180_000);
    v = svc.tcDocs.view(pid, docId);
    expect(v.tcs.map((t) => t.conversion.status)).toEqual(['done', 'done', 'done']);
    expect(() => svc.tcDocs.convert(pid, docId, {})).toThrow(/변환할 TC 가 없습니다/);
    expect(() => svc.tcDocs.convert(pid, docId, { tcIds: ['NOTE-01'] })).toThrow(/다시 변환/);
  }, 300_000);

  it('test set plans: 문서 전체 · 분류별 · 체크한 TC, precondition scripts first, unconverted TCs skipped', () => {
    const all = svc.tcDocs.planSets(pid, docId, 'all');
    expect(all.sets).toEqual([
      expect.objectContaining({ name: '메모장 QA', scripts: ['pre-1-메모장-웹에-로그인한-상태.yaml', 'pre-2-메모가-1개-이상-있는-상태.yaml', 'NOTE-01-새-메모-만들기.yaml', 'NOTE-02-메모-저장-확인.yaml', 'SHARE-01-공유-링크-만들기.yaml'] }),
    ]);
    const cat = svc.tcDocs.planSets(pid, docId, 'category');
    expect(cat.sets.map((s) => [s.name, s.scripts])).toEqual([
      ['메모장 QA · Editor', ['pre-1-메모장-웹에-로그인한-상태.yaml', 'NOTE-01-새-메모-만들기.yaml', 'NOTE-02-메모-저장-확인.yaml']],
      ['메모장 QA · Sharing', ['pre-2-메모가-1개-이상-있는-상태.yaml', 'SHARE-01-공유-링크-만들기.yaml']],
    ]);
    svc.tcDocs.exclude(pid, docId, 'NOTE-02', true);
    const checked = svc.tcDocs.planSets(pid, docId, 'checked', ['NOTE-02', 'NOTE-01']);
    expect(checked.sets.map((s) => [s.name, s.scripts, s.tcIds])).toEqual([['메모장 QA · 선택한 TC', ['pre-1-메모장-웹에-로그인한-상태.yaml', 'NOTE-01-새-메모-만들기.yaml'], ['NOTE-01']]]);
    expect(checked.skipped).toEqual([{ tcId: 'NOTE-02', title: '메모 저장 확인', reason: '제외' }]);
    svc.tcDocs.exclude(pid, docId, 'NOTE-02', false);
    expect(svc.tcDocs.view(pid, docId).tcs.find((t) => t.id === 'NOTE-02')!.conversion.status).toBe('pending');
    // Pure planner: a category with nothing converted makes no set; its TCs are listed as skipped.
    const doc = svc.tcDocs.store(pid).require(docId);
    const p = planTestSets(doc, 'category', [], () => true);
    expect(p.sets.map((s) => s.category)).toEqual(['Editor', 'Sharing']);
    expect(p.skipped.map((s) => [s.tcId, s.reason])).toEqual([['NOTE-02', '변환 안 됨']]);
    expect(planTestSets(doc, 'all', [], () => false).sets).toEqual([]);
  });

  it('export: the document as its original TC text (xlsx round trip) and scripts (doc TCs + other scripts)', () => {
    const doc = svc.tcDocs.store(pid).require(docId);
    const x = svc.tcDocs.exportDoc(pid, docId, 'xlsx');
    const back = parseTcDocument(x.bytes, 'export.xlsx');
    expect(back.layout).toBe('block');
    expect(back.tcs).toEqual(doc.tcs.map(engineTc));
    const md = new TextDecoder().decode(svc.tcDocs.exportDoc(pid, docId, 'md').bytes);
    expect(md).toContain('# 메모장 QA');
    // Scripts: TC scripts → original TC text; precondition scripts are not TCs; other scripts from their steps.
    writeFileSync(join(userData, 'projects', pid, 'scripts', 'plain.yaml'), 'version: 1\nname: 로그인 화면 확인\nsteps:\n  - goto: /login\n  - expect: { visible: { role: heading, name: 로그인 } }\n');
    const s = svc.tcDocs.exportScripts(pid, ['pre-1-메모장-웹에-로그인한-상태.yaml', 'NOTE-01-새-메모-만들기.yaml', 'plain.yaml'], '세트', 'xlsx');
    expect(s.count).toBe(2);
    const tcs = parseTcDocument(s.bytes, 's.xlsx').tcs;
    expect(tcs[0]).toEqual(engineTc(doc.tcs[0]!));
    expect(tcs[1]).toMatchObject({ id: 'plain', title: '로그인 화면 확인' });
    expect(() => svc.tcDocs.exportScripts(pid, ['pre-1-메모장-웹에-로그인한-상태.yaml'], 'x', 'md')).toThrow(/내보낼/);
  });

  it('a TC recording: step marks → grouped draft named after the TC, saved as <TC ID>-<slug>.yaml and recorded as 완료', () => {
    const recId = 'tcrec00000001';
    const dir = join(userData, 'projects', pid, 'recordings', recId);
    mkdirSync(dir, { recursive: true });
    const rec: Recording = {
      version: 1,
      id: recId,
      name: 'NOTE-01 새 메모 만들기',
      envId,
      baseUrl: site.url,
      startUrl: `${site.url}/login`,
      startedAt: '2026-10-26T10:00:00.000Z',
      browser: { engine: 'chromium', viewport: { width: 1280, height: 800 } },
      events: [
        { seq: 1, at: 10, kind: 'navigate', url: `${site.url}/login`, nav: 'start' },
        { seq: 2, at: 20, kind: 'checkpoint', url: `${site.url}/login`, target: { chosen: { role: 'heading', name: '로그인' }, candidates: [] }, checkpoint: { kind: 'visible' } },
        { seq: 3, at: 30, kind: 'click', url: `${site.url}/login`, interactive: true, target: { chosen: { role: 'button', name: '로그인' }, candidates: [] } },
      ],
      notes: [],
      tcRef: { docId, tcId: 'NOTE-01' },
      stepMarks: [
        { no: 1, fromSeq: 1, toSeq: 2 },
        { no: 2, fromSeq: 3, toSeq: 3 },
      ],
      euta: '0.1.0',
    };
    writeFileSync(join(dir, 'recording.json'), JSON.stringify(rec));
    expect(svc.recordings(pid).find((r) => r.id === recId)?.tcRef).toEqual({ docId, tcId: 'NOTE-01' });
    const d = svc.saveRecordingDraft(pid, recId, envId);
    expect(d.path).toBe('NOTE-01-새-메모-만들기-2.yaml'); // the AI's file exists already → a free name next to it
    const text = readFileSync(join(userData, 'projects', pid, 'scripts', d.path!), 'utf8');
    expect(text).toContain('name: 새 메모 만들기');
    expect(text).toContain('TC ID: NOTE-01');
    expect(text).toContain('name: 1. 메모 목록 화면을 연다.');
    expect(text).toContain('instruction: 빈 편집기가 열린다.'); // step 2 had no checkpoint
    expect(countManualSteps(text)).toBe(2); // step 2 expected + step 3 never demonstrated
    expect(svc.tcDocs.view(pid, docId).tcs[0]!.conversion).toMatchObject({ status: 'done', script: d.path, manualSteps: 2, by: 'recording' });
    expect(svc.activity(pid, { kinds: ['tcdoc.converted'] })[0]!.summary).toContain('시연');
  });

  it('script renames keep the TC document pointing at the script', () => {
    const before = svc.tcDocs.view(pid, docId).tcs.find((t) => t.id === 'SHARE-01')!.conversion.script!;
    const to = svc.renameScript(pid, before, 'share/share-01.yaml');
    expect(svc.tcDocs.view(pid, docId).tcs.find((t) => t.id === 'SHARE-01')!.conversion.script).toBe(to);
    expect(svc.tcDocs.view(pid, docId).scripts[to]!.exists).toBe(true);
  });

  it('the system prompt carries the TC guide and the engine cheat sheet with manual steps', () => {
    const p = buildSystemPrompt({ workDir: '/w', runsDir: '/r', secretNames: [] });
    expect(p).toContain('tcConvert: <docId> <tcId>');
    expect(p).toContain('ONE ITEM PER MESSAGE');
    expect(p).toContain('do NOT loosen the check');
    expect(p).toContain('full match `^…$`');
    expect(p).toContain('only "writes it down"');
    expect(p).toContain('never "the first row"');
    expect(p).toContain('get_schema when unsure');
    expect(p).toContain('manual');
    expect(p).toMatch(/\| manual \|/); // DSL cheat sheet row from @euta/mcp-server (stale dist would fail here)
    expect(p).toMatch(/enabled/);
  });
});

describe('TC helpers', () => {
  it('file names keep Hangul; the TC id comes first', () => {
    expect(tcFileName({ id: 'NOTE-01', title: '새 메모 만들기!' })).toBe('NOTE-01-새-메모-만들기.yaml');
    expect(tcFileName({ id: 'A/B 1', title: '' })).toBe('A-B-1.yaml');
    expect(preFileName({ id: 'pre-2', text: 'Logged in\nsecond line' })).toBe('pre-2-logged-in.yaml');
  });

  it('mapping: groups by "<no>. " name; missing / auto / manual / partial', () => {
    const tc = { id: 'T-1', title: 't', steps: [1, 2, 3, 4].map((no) => ({ no, action: `a${no}` })), conversion: { status: 'done' as const, manualSteps: 0, missingInfo: [], updatedAt: '' } };
    const src = [
      'version: 1',
      'name: t',
      'steps:',
      '  - goto: /',
      '  - group: { name: "1. a1", steps: [ { click: { target: { text: x } } } ] }',
      '  - group: { name: "2) a2", steps: [ { manual: "check" } ] }',
      '  - group: { name: "3. a3", steps: [ { click: { target: { text: y } } }, { manual: { instruction: "see" } } ] }',
    ].join('\n');
    const m = mappingFor(tc, src);
    expect(m.steps.map((s) => [s.no, s.kind, s.manual])).toEqual([
      [1, 'auto', []],
      [2, 'manual', ['check']],
      [3, 'partial', ['see']],
      [4, 'missing', []],
    ]);
    expect(m.ungrouped).toBe(1);
    expect(mappingFor(tc, undefined).steps.every((s) => s.kind === 'missing')).toBe(true);
  });

  it('engine export of a synthetic document parses back to the same TCs (fixture sanity)', () => {
    const tcs = [{ id: 'X-1', title: '제목', category: 'C', steps: [{ no: 1, action: '연다', expected: '보인다' }] }];
    expect(parseTcDocument(exportTcDocument({ name: 'D', tcs }, 'xlsx'), 'd.xlsx').tcs).toEqual(tcs);
    expect(existsSync(join(FIXTURES, 'block.xlsx'))).toBe(true);
  });
});

describe('manual steps shown as "수동 확인 필요"', () => {
  it('Live: step.finished carries the manual marker; reached vs not reached', async () => {
    const { applyEvent, createRunState } = await import('../../src/main/live-reducer.js');
    const { isManualCheck } = await import('../../src/shared/types.js');
    const st = createRunState('r1', 'app');
    const base = { runId: 'r1', ts: '2026-10-26T00:00:00.000Z' };
    applyEvent(st, { ...base, seq: 1, type: 'step.finished', stepId: '1', index: 0, action: 'manual', status: 'skipped', durationMs: 0, manual: { instruction: '텍스트가 제거됨', reason: '사람 판단' } });
    applyEvent(st, { ...base, seq: 2, type: 'step.finished', stepId: '2', index: 1, action: 'manual', status: 'skipped', durationMs: 0, error: 'skipped after step 1 failed', manual: { instruction: '두 번째' } });
    const [a, b] = st.view.steps;
    expect(a!.manual).toEqual({ instruction: '텍스트가 제거됨', reason: '사람 판단' });
    expect(isManualCheck(a!)).toBe(true);
    expect(isManualCheck(b!)).toBe(false);
  });

  it('set report: per-item manual count, summary card (all manual steps), and the check list', async () => {
    const { buildSuiteReport } = await import('../../src/main/project/suite-report.js');
    const dir = mkdtempSync(join(tmpdir(), 'euta-sr-man-'));
    const runDir = join(dir, 'run1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        name: 'TC A',
        status: 'passed',
        steps: [
          { stepId: '1', action: 'group', status: 'passed', name: '1. 연다', children: [{ stepId: '1.1', action: 'manual', status: 'skipped', manual: { instruction: '보인다', reason: '판단' } }] },
          { stepId: '2', action: 'manual', status: 'skipped', error: 'skipped after step 1 failed', manual: { instruction: '못 감' } },
        ],
      }),
    );
    const run = { id: 'sr1', projectId: 'p', suiteId: 's', suiteName: '세트', envId: 'e', envName: 'dev', stopOnFailure: false, startedAt: '2026-10-26T00:00:00.000Z', finishedAt: '2026-10-26T00:01:00.000Z', status: 'passed' as const, items: [{ script: 'a.yaml', runId: 'r1', status: 'passed' as const }] };
    const file = await buildSuiteReport({ run, projectName: 'P', history: [run], runDir: () => runDir, names: new Map(), suiteRunsDir: dir, redact: (s) => s });
    const html = readFileSync(file, 'utf8');
    expect(html).toContain('data-testid="sr-manual-count">수동 확인 필요<b>2</b>');
    expect(html).toContain('data-testid="sr-item-manual">수동 확인 2');
    expect(html.match(/data-testid="sr-manual" data-reached="1"/g)).toHaveLength(1);
    expect(html).toContain('수동 확인: 보인다');
    expect(html).toContain('이유: 판단');
    expect(html).toContain('skipped after step 1 failed');
    rmSync(dir, { recursive: true, force: true });
  });
});
