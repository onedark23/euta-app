// SDK message → chat mapping and the chat engine, driven by MOCKED query() generators
// (no model, no CLI).
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runScript } from '@euta/core';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { applyChatEvent, mapSdkMessage } from '../../src/main/ai/chat-events.js';
import { ChatEngine, type QueryFn, type SdkModule } from '../../src/main/ai/chat-engine.js';
import { ChatStore } from '../../src/main/ai/chat-store.js';
import { fakeQuery } from '../../src/main/ai/fake-agent.js';
import type { ChatView } from '../../src/shared/types.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'euta-chat-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const S = 'sess-123';
const base = { parent_tool_use_id: null, session_id: S, uuid: 'u' };
const init = { type: 'system', subtype: 'init', model: 'claude-test', ...base };
const delta = (text: string) => ({ type: 'stream_event', ...base, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const assistantText = (text: string) => ({ type: 'assistant', ...base, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'assistant', ...base, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, content: unknown[], is_error = false) => ({ type: 'user', ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const result = (ok = true) => (ok ? { type: 'result', subtype: 'success', is_error: false, duration_ms: 10, num_turns: 2, result: 'done', ...base } : { type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 10, num_turns: 60, errors: ['too many turns'], ...base });

const RUN_JSON = JSON.stringify({ runId: '20261002-101010_login_abc123', shortId: 'abc123', status: 'failed', summary: { total: 5, passed: 4 } });
const PNG = 'iVBORw0KGgo=';

function emptyChat(): ChatView {
  return { id: 'c', title: 't', createdAt: 0, updatedAt: 0, busy: true, thinking: true, cwd: '/w', items: [] };
}

describe('mapSdkMessage', () => {
  it('maps init, deltas, text, tool_use, tool_result (image), result; ignores subagent traffic', () => {
    expect(mapSdkMessage(init)).toEqual([{ type: 'session', sessionId: S, model: 'claude-test' }]);
    const ok = { ...init, tools: ['mcp__euta__run_script'], mcp_servers: [{ name: 'euta', status: 'connected' }] };
    expect(mapSdkMessage(ok)).toHaveLength(1);
    expect(mapSdkMessage({ ...ok, mcp_servers: [{ name: 'euta', status: 'failed' }] })[1]).toMatchObject({ type: 'setup-warning' });
    expect(mapSdkMessage({ ...ok, tools: ['Read'] })[1]).toMatchObject({ type: 'setup-warning' });
    expect(mapSdkMessage(delta('he'))).toEqual([{ type: 'text-delta', text: 'he' }]);
    expect(mapSdkMessage({ type: 'stream_event', ...base, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } } })).toEqual([{ type: 'thinking' }]);
    expect(mapSdkMessage(assistantText('hello'))).toEqual([{ type: 'assistant-text', text: 'hello' }]);
    expect(mapSdkMessage(toolUse('t1', 'mcp__euta__run_script', { path: 'a.yaml' }))).toEqual([{ type: 'tool-use', id: 't1', name: 'mcp__euta__run_script', input: { path: 'a.yaml' } }]);
    expect(mapSdkMessage(toolResult('t1', [{ type: 'text', text: RUN_JSON }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]))).toEqual([
      { type: 'tool-result', id: 't1', isError: false, texts: [RUN_JSON], image: { data: PNG, mimeType: 'image/png' } },
    ]);
    expect(mapSdkMessage(result())).toEqual([{ type: 'result', ok: true, subtype: 'success', durationMs: 10, numTurns: 2 }]);
    expect(mapSdkMessage(result(false))[0]).toMatchObject({ type: 'result', ok: false, message: 'too many turns' });
    expect(mapSdkMessage({ ...assistantText('sub'), parent_tool_use_id: 'task1' })).toEqual([]);
    expect(mapSdkMessage({ ...assistantText('Please log in'), error: 'authentication_failed' })).toEqual([
      { type: 'assistant-text', text: 'Please log in' },
      { type: 'api-error', code: 'authentication_failed' },
    ]);
    expect(mapSdkMessage({ type: 'rate_limit_event' })).toEqual([]);
    expect(mapSdkMessage(null)).toEqual([]);
  });
});

describe('chat reducer', () => {
  it('streamed text is replaced by the complete block, never duplicated', () => {
    const c = emptyChat();
    for (const m of [delta('안녕'), delta('하세요'), assistantText('안녕하세요.')]) for (const e of mapSdkMessage(m)) applyChatEvent(c, e);
    expect(c.items).toHaveLength(1);
    expect(c.items[0]).toMatchObject({ kind: 'assistant', text: '안녕하세요.', streaming: false });
    expect(c.thinking).toBe(false);
  });

  it('tool card: running → done with run link, summary and image', () => {
    const c = emptyChat();
    for (const m of [toolUse('t1', 'mcp__euta__run_script', { path: '/x/login.yaml' }), toolResult('t1', [{ type: 'text', text: RUN_JSON }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }])]) {
      for (const e of mapSdkMessage(m)) applyChatEvent(c, e);
    }
    expect(c.items[0]).toMatchObject({ kind: 'tool', name: 'run_script', inputSummary: '/x/login.yaml', status: 'done', runId: '20261002-101010_login_abc123', runStatus: 'failed', result: 'failed · 4/5 passed', image: `data:image/png;base64,${PNG}` });
  });

  it('error results and aborts become notices; running tools are closed on abort', () => {
    const c = emptyChat();
    for (const e of mapSdkMessage(toolUse('t2', 'mcp__euta__session_step', { sessionId: 's', step: { goto: '/' } }))) applyChatEvent(c, e);
    applyChatEvent(c, { type: 'aborted' });
    expect(c.items[0]).toMatchObject({ kind: 'tool', status: 'error', inputSummary: '{"goto":"/"}' });
    expect(c.items[1]).toMatchObject({ kind: 'notice', level: 'info' });
    // The round-trip bound is a limit reached (info), not an error; other failed results stay errors.
    for (const e of mapSdkMessage(result(false))) applyChatEvent(c, e);
    expect(c.items[2]).toMatchObject({ kind: 'notice', level: 'info' });
    expect((c.items[2] as { text: string }).text).toContain('왕복 한도(60회)');
    for (const e of mapSdkMessage({ ...result(false), subtype: 'error_during_execution' })) applyChatEvent(c, e);
    expect(c.items[3]).toMatchObject({ kind: 'notice', level: 'error' });
    expect((c.items[3] as { text: string }).text).toContain('too many turns');
  });
});

// ---- engine -----------------------------------------------------------------

function engine(queryFn: QueryFn, userData = tmp()) {
  const store = new ChatStore(join(userData, 'chats'));
  const updates: ChatView[] = [];
  const turns: string[] = [];
  const sdk: SdkModule = {
    tool,
    createSdkMcpServer,
    query: () => {
      throw new Error('real query() must not be called in tests');
    },
  };
  const config = { runsDir: join(userData, 'runs'), secrets: {}, env: {}, runHeadless: true, sessionHeadless: false, stepImage: 'on-failure' as const };
  let envKey = 'k1';
  const e = new ChatEngine({
    store,
    context: () => ({ key: envKey, config, workDir: userData, projectId: 'proj001', project: { name: 'P', environments: [{ name: 'dev', baseUrl: 'http://127.0.0.1:1' }], envName: 'dev' } }),
    defaults: () => ({ workDir: userData, model: '', projectId: 'proj001', envId: 'env0001' }),
    loadSdk: async () => sdk,
    queryFn,
    onUpdate: (c) => updates.push(structuredClone(c)),
    onTurnStart: (_c, t) => turns.push(`start:${t.first}`),
    onTurnEnd: (_c, t) => turns.push(`end:${t.tools.join(',')}`),
    throttleMs: 0,
  });
  return { e, store, updates, userData, turns, setKey: (k: string) => (envKey = k) };
}

describe('ChatEngine (mocked query generator)', () => {
  it('send() resolves with how the turn ended: success · max-turns · error · aborted', async () => {
    let mode = 'ok';
    const q: QueryFn = async function* (p) {
      yield init;
      if (mode === 'throw') throw new Error('network down');
      if (mode === 'wait') await new Promise((r) => p.options.abortController!.signal.addEventListener('abort', r));
      yield mode === 'limit' ? result(false) : mode === 'fail' ? { ...result(false), subtype: 'error_during_execution' } : result();
    };
    const { e } = engine(q);
    const chat = e.create();
    expect(await e.send(chat.id, 'a')).toMatchObject({ kind: 'success' });
    mode = 'limit';
    expect(await e.send(chat.id, 'b')).toMatchObject({ kind: 'max-turns', subtype: 'error_max_turns' });
    mode = 'fail';
    expect(await e.send(chat.id, 'c')).toMatchObject({ kind: 'error', subtype: 'error_during_execution' });
    mode = 'throw';
    expect(await e.send(chat.id, 'd')).toMatchObject({ kind: 'error', message: 'network down' });
    mode = 'wait';
    const p = e.send(chat.id, 'e');
    e.stop(chat.id);
    expect(await p).toEqual({ kind: 'aborted' });
    e.note(chat.id, 'info', '앱 알림');
    expect(e.get(chat.id)!.items.at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: '앱 알림' });
    await e.dispose();
  });

  it('streams a turn, records the SDK session and resumes it on the next message; persists to disk', async () => {
    const calls: { prompt: string; options: Options }[] = [];
    const q: QueryFn = async function* (p) {
      calls.push(p);
      yield init;
      yield delta('실행');
      yield delta('할게요');
      yield assistantText('실행할게요');
      const id = `t${calls.length}`;
      yield toolUse(id, 'mcp__euta__run_script', { path: 'a.yaml' });
      yield toolResult(id, [{ type: 'text', text: RUN_JSON }]);
      yield assistantText('1개 실패했습니다.');
      yield result();
    };
    const { e, updates, userData, turns } = engine(q);
    const chat = e.create();
    expect(chat).toMatchObject({ projectId: 'proj001', envId: 'env0001', cwd: userData });
    await e.send(chat.id, '로그인 테스트 실행해줘');
    const c = e.get(chat.id)!;
    expect(c.title).toBe('로그인 테스트 실행해줘');
    expect(c.sdkSessionId).toBe(S);
    expect(c.busy).toBe(false);
    expect(c.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(updates.some((u) => u.items.some((i) => i.kind === 'assistant' && i.streaming))).toBe(true); // streamed
    expect(calls[0]!.options.resume).toBeUndefined();
    expect(calls[0]!.options.cwd).toBe(userData);
    expect(calls[0]!.options.settingSources).toEqual([]);
    expect(Object.keys(calls[0]!.options.mcpServers!)).toEqual(['euta']);
    expect(calls[0]!.options.systemPrompt).toContain('Project: P');
    expect(calls[0]!.options.systemPrompt).toContain('dev (http://127.0.0.1:1)');
    expect(turns).toEqual(['start:true', 'end:run_script']);

    await e.send(chat.id, '다시 해줘');
    expect(calls[1]!.options.resume).toBe(S);
    expect(existsSync(join(userData, 'chats', `${chat.id}.json`))).toBe(true);
    expect(turns.slice(2)).toEqual(['start:false', 'end:run_script']);

    const reopened = new ChatStore(join(userData, 'chats'));
    expect(reopened.list().map((s) => s.id)).toEqual([chat.id]);
    expect(reopened.get(chat.id)!.items).toHaveLength(8);
    await e.dispose();
  });

  it('environment switch: setEnv is refused while busy; a changed context rebuilds the tools', async () => {
    const seen: unknown[] = [];
    const q: QueryFn = async function* (_p, { tools }) {
      seen.push(tools);
      yield init;
      yield result();
    };
    const { e, setKey } = engine(q);
    const chat = e.create();
    await e.send(chat.id, 'one');
    await e.send(chat.id, 'two');
    expect(seen[0]).toBe(seen[1]); // same configuration: same tools (sessions survive turns)
    expect(e.setEnv(chat.id, 'env0002').envId).toBe('env0002');
    setKey('k2');
    await e.send(chat.id, 'three');
    expect(seen[2]).not.toBe(seen[1]);
    await e.dispose();
  });

  it('a thrown error becomes an error notice and frees the chat', async () => {
    const q: QueryFn = async function* () {
      yield init;
      throw new Error('Claude Code process exited with code 1');
    };
    const { e } = engine(q);
    const chat = e.create();
    await e.send(chat.id, 'hi');
    const c = e.get(chat.id)!;
    expect(c.busy).toBe(false);
    expect(c.items.at(-1)).toMatchObject({ kind: 'notice', level: 'error' });
    await e.dispose();
  });

  it('stop() aborts the turn', async () => {
    const q: QueryFn = async function* ({ options }) {
      yield init;
      yield toolUse('t9', 'mcp__euta__run_script', { path: 'slow.yaml' });
      await new Promise((_r, rej) => options.abortController!.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    };
    const { e } = engine(q);
    const chat = e.create();
    const done = e.send(chat.id, 'run slow');
    await new Promise((r) => setTimeout(r, 50));
    expect(e.get(chat.id)!.busy).toBe(true);
    await expect(e.send(chat.id, 'again')).rejects.toThrow(/busy/);
    expect(e.stop(chat.id)).toBe(true);
    await done;
    const c = e.get(chat.id)!;
    expect(c.busy).toBe(false);
    expect(c.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'error' });
    expect(c.items.at(-1)).toMatchObject({ kind: 'notice', level: 'info' });
    await e.dispose();
  });

  it('fake agent: get_page_map and check_script_targets run without confirmation on a recorded run', async () => {
    const userData = tmp();
    const page = join(userData, 'clips.html');
    writeFileSync(page, '<html><body><h1>클립</h1><label><input type="radio" name="s">초안</label><button>삭제</button><button>삭제</button></body></html>');
    const head = `version: 1\nname: clips\nrecord: { video: false, trace: false, har: false, screenshots: none }\nsteps:\n  - goto: "${pathToFileURL(page).href}"\n`;
    const draft = runScript({ source: `${head}  - check: { target: { role: radio, name: 초안 } }\n` }, { runsDir: join(userData, 'runs'), headless: true });
    expect((await draft.result).status).toBe('passed');
    writeFileSync(join(userData, 'wrong.yaml'), `${head}  - click: { target: { role: button, name: 삭제 } }\n`);

    const gated: string[] = [];
    const { e } = engine(async function* (p, ctx) {
      const hook = p.options.hooks!.PreToolUse![0]!.hooks[0]!;
      const wrapped = { ...p, options: { ...p.options, hooks: { PreToolUse: [{ hooks: [async (...a: Parameters<typeof hook>) => {
        const out = await hook(...a);
        gated.push(`${(a[0] as { tool_name: string }).tool_name}:${(out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision}`);
        return out;
      }] }] } } };
      yield* fakeQuery(wrapped, ctx);
    }, userData);
    const chat = e.create();
    await e.send(chat.id, `selectorCheck: ${draft.runId} wrong.yaml`);
    const cards = e.get(chat.id)!.items.filter((i) => i.kind === 'tool');
    expect(cards.map((c) => [(c as { name: string }).name, (c as { status: string }).status])).toEqual([
      ['get_page_map', 'done'],
      ['check_script_targets', 'done'],
    ]);
    expect(gated).toEqual(['mcp__euta__get_page_map:allow', 'mcp__euta__check_script_targets:allow']);
    expect((e.get(chat.id)!.items.at(-1) as { text: string }).text).toBe('화면 1개 · 대상 점검: ambiguous 1.');
    await e.dispose();
  });

  it('fake agent: a non-euta tool is denied by the real gate hook', async () => {
    const { e } = engine(fakeQuery);
    const chat = e.create();
    await e.send(chat.id, 'bash 로 ls 해줘');
    const card = e.get(chat.id)!.items.find((i) => i.kind === 'tool');
    expect(card).toMatchObject({ name: 'Bash', status: 'error' });
    expect((card as { result: string }).result).toMatch(/not available in euta chat/);
    await e.dispose();
  });
});
