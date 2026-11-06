// TC auto conversion (SPEC TC-문서-변환 "AI 변환", 2026-11-05 · ADR-046): the app sends one message per
// queue item (a precondition script first when the next TC needs it) and the next item when a message
// ends. A scripted agent (no model, no browser) decides per item and attempt: finish · hit the
// round-trip limit · end without recording · fail · hang until stopped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn, SdkModule } from '../../src/main/ai/chat-engine.js';
import { LiveStore } from '../../src/main/live-store.js';
import { ProjectService } from '../../src/main/project/service.js';
import { itemPrompt, nextConvertItem } from '../../src/main/project/tc-docs.js';
import type { TcConvertProgress, TcDoc } from '../../src/shared/types.js';
import { mockSafeStorage } from './helpers.js';

const sdk: SdkModule = {
  tool,
  createSdkMcpServer,
  query: () => {
    throw new Error('real query() must not be called in tests');
  },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, what = 'condition', ms = 20_000): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

type Behavior = 'done' | 'limit' | 'silent' | 'error' | 'hang' | 'failed';
/** Per item id: what each attempt does (the last entry repeats). Default: done. */
let plan: Record<string, Behavior[]> = {};
const attempts: Record<string, number> = {};
const prompts: string[] = [];

const agent: QueryFn = async function* ({ prompt, options }, { tools }) {
  prompts.push(prompt);
  const session_id = options.resume ?? 'sess-auto';
  const base = { parent_tool_use_id: null, session_id, uuid: 'u' };
  yield { type: 'system', subtype: 'init', ...base };
  const call = async (name: string, input: Record<string, unknown>) => {
    const r = (await tools.byName.get(name)!.handler(input)) as { content: { text?: string }[]; isError?: boolean };
    if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
    return JSON.parse(r.content[0]!.text!) as Record<string, any>;
  };
  const m = /tcConvert:\s*(\w+)\s+(\S+)/.exec(prompt)!;
  const [, docId, item] = m as unknown as [string, string, string];
  const n = (attempts[item] = (attempts[item] ?? 0) + 1);
  const list = plan[item] ?? ['done'];
  const b = list[Math.min(n, list.length) - 1]!;
  const isPre = /^pre-\d+$/.test(item);
  if (!isPre) await call('get_tc', { docId, tcId: item }); // marks the TC 변환 중 for this chat
  if (b === 'error') throw new Error('network down');
  if (b === 'hang') await new Promise((r) => options.abortController!.signal.addEventListener('abort', r));
  if (b === 'limit') {
    yield { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 60, errors: ['Reached maximum number of turns (60)'], ...base };
    return;
  }
  if (b === 'done' || b === 'failed') {
    const file = isPre ? /파일:\s*(\S+)/.exec(prompt)![1]! : `${item}.yaml`;
    await call('save_script', { path: file, yaml: `version: 1\nname: ${item}\nsteps:\n  - goto: /\n`, overwrite: true });
    await call('set_tc_conversion', { docId, id: item, status: b, script: file, ...(b === 'failed' ? { note: 'expect 불일치' } : {}) });
  }
  yield { type: 'assistant', ...base, message: { role: 'assistant', content: [{ type: 'text', text: `${item} 끝` }] } };
  yield { type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'ok', ...base };
};

describe('TC auto conversion (one message per item)', () => {
  let root: string;
  let live: LiveStore;
  let svc: ProjectService;
  let pid = '';
  let envId = '';
  const progress: TcConvertProgress[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'euta-tcauto-'));
    live = new LiveStore({ throttleMs: 0 });
    svc = new ProjectService({
      userData: join(root, 'userData'),
      safeStorage: mockSafeStorage(),
      live,
      platform: 'darwin',
      processEnv: { ...process.env },
      chat: { loadSdk: async () => sdk, queryFn: agent, throttleMs: 0 },
      watch: false,
      recorderHeadless: true,
      events: {
        tcDocChanged: (p, d) => {
          const v = svc?.tcDocs.view(p, d).progress;
          if (v) progress.push(v);
        },
      },
    });
    const v = svc.create({ name: 'Auto', baseUrl: 'http://127.0.0.1:9' });
    pid = v.id;
    envId = v.environments[0]!.id;
  });

  afterAll(async () => {
    await svc?.dispose();
    live?.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  /** A fresh document: A-1 and A-2 share precondition pre-1, B-1 · B-2 · B-3 have none. */
  const newDoc = (): string => {
    const steps = [{ no: 1, action: '연다', expected: '보인다' }];
    const d = svc.tcDocs.store(pid).create({
      name: '자동 진행',
      source: { fileName: 'auto.xlsx', format: 'xlsx', layout: 'block', importedAt: '' },
      tcs: ['A-1', 'A-2', 'B-1', 'B-2', 'B-3'].map((id) => ({ id, title: `${id} 제목`, ...(id.startsWith('A') ? { precondition: '로그인한 상태' } : {}), steps })),
      preconditions: [{ text: '로그인한 상태', tcIds: ['A-1', 'A-2'] }],
    });
    return d.id;
  };
  const reset = () => {
    plan = {};
    for (const k of Object.keys(attempts)) delete attempts[k];
    prompts.length = 0;
    progress.length = 0;
  };
  const items = () => prompts.map((p) => /tcConvert:\s*\w+\s+(\S+)/.exec(p)![1]);
  const finished = (docId: string) => until(() => !svc.tcDocs.view(pid, docId).activeChatId && svc.tcDocs.view(pid, docId).lastRun, 'run end');
  const statusOf = (docId: string) => Object.fromEntries(svc.tcDocs.view(pid, docId).tcs.map((t) => [t.id, t.conversion.status]));

  it('sends the queue in order, a precondition before the first TC that needs it, in one chat; stops when the queue is empty', async () => {
    reset();
    const docId = newDoc();
    const chat = svc.tcDocs.convert(pid, docId, { tcIds: ['B-1', 'A-1', 'A-2'], envId });
    expect(chat.busy).toBe(true); // the first message is already out
    expect(svc.tcDocs.view(pid, docId).activeChatId).toBe(chat.id);
    const end = await finished(docId);
    expect(items()).toEqual(['B-1', 'pre-1', 'A-1', 'A-2']);
    expect(end).toMatchObject({ reason: 'empty', done: 3, total: 3 });
    expect(statusOf(docId)).toMatchObject({ 'B-1': 'done', 'A-1': 'done', 'A-2': 'done', 'B-2': 'pending' });
    expect(svc.tcDocs.view(pid, docId).preconditions[0]).toMatchObject({ id: 'pre-1', status: 'done' });
    // Same chat (session resumed), one user message per item.
    const c = svc.chatEngine(pid).get(chat.id)!;
    expect(c.items.filter((i) => i.kind === 'user')).toHaveLength(4);
    expect(c.items.at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: expect.stringContaining('대기열을 모두 마쳤습니다 — 3 / 3') });
    // Progress: n / N with the current TC (the precondition shown with its TC).
    expect(progress.filter((p) => p.current).map((p) => `${p.done}/${p.total}:${p.current!.tcId}${p.current!.precondition ? `(${p.current!.precondition})` : ''}`)).toEqual(
      expect.arrayContaining(['0/3:B-1', '1/3:A-1(pre-1)', '1/3:A-1', '2/3:A-2']),
    );
    // Each message carries the judging rule and only its own item.
    expect(prompts[2]).toContain('느슨하게 바꾸지 않습니다');
    expect(progress.find((p) => p.current?.precondition)!.current).toMatchObject({ precondition: 'pre-1', preconditionText: '로그인한 상태' });
    expect(prompts[2]).not.toContain('A-2');
  });

  it('a message that hits the round-trip limit is sent once more; the item then finishes and the run goes on', async () => {
    reset();
    const docId = newDoc();
    plan = { 'B-1': ['limit', 'done'] };
    const chat = svc.tcDocs.convert(pid, docId, { tcIds: ['B-1', 'B-2'], envId });
    await finished(docId);
    expect(items()).toEqual(['B-1', 'B-1', 'B-2']);
    expect(prompts[0]).not.toContain('재시도');
    expect(prompts[1]).toContain('(재시도 2/2)');
    expect(statusOf(docId)).toMatchObject({ 'B-1': 'done', 'B-2': 'done' });
    const c = svc.chatEngine(pid).get(chat.id)!;
    expect(c.items.some((i) => i.kind === 'notice' && i.level === 'info' && i.text.includes('왕복 한도(60회)'))).toBe(true); // not an error
    expect(c.items.some((i) => i.kind === 'notice' && i.text.includes('B-1: 왕복 한도에 닿아 같은 항목을 한 번 더'))).toBe(true);
    expect(c.items.some((i) => i.kind === 'notice' && i.level === 'error')).toBe(false);
  });

  it('an item that does not finish twice in a row becomes 실패 ("두 번 시도에도 끝나지 않음") and the next item follows', async () => {
    reset();
    const docId = newDoc();
    plan = { 'B-1': ['limit', 'limit'], 'B-2': ['silent', 'done'], 'pre-1': ['limit'] };
    svc.tcDocs.convert(pid, docId, { tcIds: ['B-1', 'B-2', 'A-1'], envId });
    const end = await finished(docId);
    expect(items()).toEqual(['B-1', 'B-1', 'B-2', 'B-2', 'pre-1', 'pre-1', 'A-1']);
    const v = svc.tcDocs.view(pid, docId);
    expect(v.tcs.find((t) => t.id === 'B-1')!.conversion).toMatchObject({ status: 'failed', note: '두 번 시도에도 끝나지 않음', by: 'ai' });
    expect(statusOf(docId)).toMatchObject({ 'B-2': 'done', 'A-1': 'done' }); // ended without a record once, then finished
    expect(v.preconditions[0]).toMatchObject({ status: 'failed', note: '두 번 시도에도 끝나지 않음' }); // the TC still went out
    expect(prompts.at(-1)).toContain('사전 조건 pre-1: 실패');
    expect(v.queue).toEqual([]);
    expect(end).toMatchObject({ reason: 'empty', done: 3, total: 3 });
    expect(svc.activity(pid, { kinds: ['tcdoc.converted'] }).some((e) => e.summary.includes('B-1') && e.summary.includes('두 번 시도에도 끝나지 않음'))).toBe(true);
  });

  it('[중지] stops the running message and the run; the item goes back to 대기 and the queue stays; a new start works', async () => {
    reset();
    const docId = newDoc();
    plan = { 'B-2': ['hang', 'done'] };
    const chat = svc.tcDocs.convert(pid, docId, { tcIds: ['B-1', 'B-2', 'B-3'], envId });
    await until(() => svc.tcDocs.view(pid, docId).tcs.find((t) => t.id === 'B-2')!.conversion.status === 'converting', 'B-2 running');
    // While it runs: one conversion per document; the person's own chat messages wait.
    expect(() => svc.tcDocs.convert(pid, docId, { envId })).toThrow(/이미 진행 중/);
    expect(svc.tcDocs.autoChat(pid, chat.id)).toBe(true);
    expect(svc.tcDocs.progress(pid)).toEqual([expect.objectContaining({ docId, chatId: chat.id, done: 1, total: 3, current: expect.objectContaining({ tcId: 'B-2', attempt: 1 }) })]);
    expect(svc.chatEngine(pid).get(chat.id)!.title).toMatch(/^TC 문서 "자동 진행" 자동 변환 \(1 \/ 3\)/);
    svc.tcDocs.stopConvert(pid, docId);
    const end = await finished(docId);
    expect(end).toMatchObject({ reason: 'stopped', done: 1, total: 3 });
    expect(items()).toEqual(['B-1', 'B-2']);
    expect(statusOf(docId)).toMatchObject({ 'B-1': 'done', 'B-2': 'pending', 'B-3': 'pending' });
    expect(svc.tcDocs.view(pid, docId).queue).toEqual(['B-2', 'B-3']);
    expect(svc.tcDocs.progress(pid)).toEqual([]);
    expect(svc.tcDocs.autoChat(pid, chat.id)).toBe(false);
    expect(() => svc.tcDocs.stopConvert(pid, docId)).toThrow(/없습니다/);
    // [이어서 변환]: the same way, in a new chat.
    const next = svc.tcDocs.convert(pid, docId, { envId });
    expect(next.id).not.toBe(chat.id);
    await finished(docId);
    expect(items().slice(2)).toEqual(['B-2', 'B-3']);
    expect(statusOf(docId)).toMatchObject({ 'B-2': 'done', 'B-3': 'done' });
  });

  it("the chat's own Stop also stops the run", async () => {
    reset();
    const docId = newDoc();
    plan = { 'B-1': ['hang'] };
    const chat = svc.tcDocs.convert(pid, docId, { tcIds: ['B-1', 'B-2'], envId });
    await until(() => statusOf(docId)['B-1'] === 'converting', 'B-1 running');
    svc.chatEngine(pid).stop(chat.id);
    expect(await finished(docId)).toMatchObject({ reason: 'stopped', done: 0 });
    expect(items()).toEqual(['B-1']);
    expect(svc.tcDocs.view(pid, docId).queue).toEqual(['B-1', 'B-2']);
  });

  it('stops after the count to convert automatically (자동으로 진행할 개수); the rest stays queued', async () => {
    reset();
    const docId = newDoc();
    svc.tcDocs.convert(pid, docId, { tcIds: ['B-1', 'B-2', 'B-3'], envId, limit: 2 });
    const end = await finished(docId);
    expect(end).toMatchObject({ reason: 'limit', done: 2, total: 2 });
    expect(items()).toEqual(['B-1', 'B-2']);
    expect(svc.tcDocs.view(pid, docId).queue).toEqual(['B-3']);
    expect(prompts[0]).toContain('자동 변환 (1 / 2)');
    // A limit larger than the queue is the queue.
    reset();
    svc.tcDocs.convert(pid, docId, { envId, limit: 10 });
    expect(await finished(docId)).toMatchObject({ reason: 'empty', done: 1, total: 1 });
  });

  it('a model / network error stops the run; that item goes back to 대기', async () => {
    reset();
    const docId = newDoc();
    plan = { 'B-2': ['error'] };
    svc.tcDocs.convert(pid, docId, { tcIds: ['B-1', 'B-2', 'B-3'], envId });
    const end = await finished(docId);
    expect(end).toMatchObject({ reason: 'error', done: 1, message: expect.stringContaining('network down') });
    expect(items()).toEqual(['B-1', 'B-2']);
    expect(statusOf(docId)).toMatchObject({ 'B-1': 'done', 'B-2': 'pending', 'B-3': 'pending' });
    expect(svc.tcDocs.view(pid, docId).queue).toEqual(['B-2', 'B-3']);
  });

  it('a message that cannot be sent (chat busy with the person\'s own turn) stops the run without leaving the item 변환 중', async () => {
    reset();
    const docId = newDoc();
    plan = { 'B-1': ['done'] };
    const engine = svc.chatEngine(pid);
    const real = engine.send.bind(engine);
    let calls = 0;
    engine.send = (id: string, text: string) => (++calls === 2 ? Promise.reject(new Error('chat is busy')) : real(id, text));
    try {
      svc.tcDocs.convert(pid, docId, { tcIds: ['B-1', 'B-2'], envId });
      expect(await finished(docId)).toMatchObject({ reason: 'error', done: 1, message: 'chat is busy' });
    } finally {
      engine.send = real;
    }
    expect(statusOf(docId)).toMatchObject({ 'B-1': 'done', 'B-2': 'pending' });
    expect(svc.tcDocs.view(pid, docId).queue).toEqual(['B-2']);
  });

  it('a TC the AI records as failed counts as finished (the run goes on)', async () => {
    reset();
    const docId = newDoc();
    plan = { 'B-1': ['failed'] };
    svc.tcDocs.convert(pid, docId, { tcIds: ['B-1', 'B-2'], envId });
    expect(await finished(docId)).toMatchObject({ reason: 'empty', done: 2 });
    expect(items()).toEqual(['B-1', 'B-2']);
    expect(svc.tcDocs.view(pid, docId).tcs.find((t) => t.id === 'B-1')!.conversion).toMatchObject({ status: 'failed', note: 'expect 불일치' });
  });
});

describe('item selection and messages (pure)', () => {
  const doc = (over: Partial<TcDoc> = {}): TcDoc => ({
    version: 1,
    id: 'doc1',
    name: 'D',
    source: { fileName: 'd.xlsx', format: 'xlsx', layout: 'block', importedAt: '' },
    preconditions: [{ id: 'pre-1', text: '로그인한 상태', status: 'pending' }],
    tcs: [
      { id: 'T-1', title: '하나', preconditionId: 'pre-1', steps: [], conversion: { status: 'done', manualSteps: 0, missingInfo: [], updatedAt: '' } },
      { id: 'T-2', title: '둘', preconditionId: 'pre-1', steps: [], conversion: { status: 'pending', manualSteps: 0, missingInfo: [], updatedAt: '' } },
    ],
    queue: ['T-1', 'T-2'],
    ...over,
  });

  it('passes over done TCs; a precondition not final comes first; a failed one does not block', () => {
    expect(nextConvertItem(doc())).toMatchObject({ kind: 'precondition', tc: { id: 'T-2' }, pre: { id: 'pre-1' } });
    expect(nextConvertItem(doc({ preconditions: [{ id: 'pre-1', text: 'x', status: 'failed' }] }))).toMatchObject({ kind: 'tc', tc: { id: 'T-2' } });
    expect(nextConvertItem(doc({ queue: ['T-1'] }))).toBeUndefined();
  });

  it('messages: one item, its file, the retry mark, redo and the person\'s note', () => {
    const d = doc();
    const pre = itemPrompt(d, nextConvertItem(d)!, { n: 1, total: 2, attempt: 1, extra: '비밀값 USER_PW' });
    expect(pre).toContain('tcConvert: doc1 pre-1');
    expect(pre).toContain('파일: pre-1-로그인한-상태.yaml');
    expect(pre).toContain('이 사전 조건을 쓰는 TC: T-1, T-2');
    expect(pre).toContain('덧붙일 말: 비밀값 USER_PW');
    const tc = itemPrompt(d, { kind: 'tc', tc: d.tcs[1]! }, { n: 2, total: 2, attempt: 2, redo: true });
    expect(tc).toContain('tcConvert: doc1 T-2');
    expect(tc).toContain('(재시도 2/2)');
    expect(tc).toContain('덮어써도 됩니다');
    expect(tc).toContain('자동 변환 (2 / 2)');
    expect(tc).toContain('`^…$` 전체 일치');
    expect(tc).toContain('모르면 get_schema');
    expect(pre).not.toContain('get_schema'); // the precondition message stays short
  });
});
