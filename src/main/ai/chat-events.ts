// Agent SDK message → chat event mapping, and the chat reducer (pure; ADR-015).
import type { ChatItem, ChatView } from '../../shared/types.js';
import { bareToolName, EUTA_SERVER, EUTA_TOOL_PREFIX } from './gate.js';

export type ChatEvent =
  | { type: 'session'; sessionId: string; model?: string }
  | { type: 'setup-warning'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'thinking' }
  | { type: 'assistant-text'; text: string }
  | { type: 'tool-use'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; isError: boolean; texts: string[]; image?: { data: string; mimeType: string } }
  | { type: 'api-error'; code: string }
  | { type: 'result'; ok: boolean; subtype: string; durationMs?: number; numTurns?: number; message?: string }
  | { type: 'error'; message: string }
  | { type: 'aborted' };

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object';

/** Convert one SDK message to chat events. Subagent traffic (parent_tool_use_id) is ignored. */
export function mapSdkMessage(msg: unknown): ChatEvent[] {
  if (!isObj(msg)) return [];
  if (msg.parent_tool_use_id) return [];
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
        const out: ChatEvent[] = [{ type: 'session', sessionId: msg.session_id, ...(typeof msg.model === 'string' ? { model: msg.model } : {}) }];
        // Surface a broken tool setup on the first turn instead of a model saying it has no tools.
        const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers.filter(isObj) : undefined;
        const euta = servers?.find((s) => s.name === EUTA_SERVER);
        const tools = Array.isArray(msg.tools) ? msg.tools.filter((t): t is string => typeof t === 'string') : undefined;
        if (servers && (!euta || euta.status !== 'connected')) out.push({ type: 'setup-warning', text: `euta 도구 서버가 연결되지 않았습니다 (${euta ? String(euta.status) : 'missing'}). 새 채팅으로 다시 시도하세요.` });
        else if (tools && !tools.some((t) => t.startsWith(EUTA_TOOL_PREFIX))) out.push({ type: 'setup-warning', text: 'euta 도구가 에이전트에 등록되지 않았습니다. 새 채팅으로 다시 시도하세요.' });
        return out;
      }
      return [];
    case 'stream_event': {
      const ev = msg.event;
      if (!isObj(ev)) return [];
      if (ev.type === 'content_block_delta' && isObj(ev.delta)) {
        if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') return [{ type: 'text-delta', text: ev.delta.text }];
        if (ev.delta.type === 'thinking_delta') return [{ type: 'thinking' }];
      }
      if (ev.type === 'message_start') return [{ type: 'thinking' }];
      return [];
    }
    case 'assistant': {
      const out: ChatEvent[] = [];
      const m = msg.message;
      const content = isObj(m) && Array.isArray(m.content) ? m.content : [];
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'assistant-text', text: b.text });
        else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') out.push({ type: 'tool-use', id: b.id, name: b.name, input: b.input });
      }
      if (typeof msg.error === 'string') out.push({ type: 'api-error', code: msg.error });
      return out;
    }
    case 'user': {
      const m = msg.message;
      const content = isObj(m) && Array.isArray(m.content) ? m.content : [];
      const out: ChatEvent[] = [];
      for (const b of content) {
        if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const texts: string[] = [];
        let image: { data: string; mimeType: string } | undefined;
        const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : Array.isArray(b.content) ? b.content : [];
        for (const p of parts) {
          if (!isObj(p)) continue;
          if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
          else if (p.type === 'image' && !image) {
            // Anthropic block ({source:{data,media_type}}) or MCP content ({data,mimeType}).
            const src = isObj(p.source) ? p.source : p;
            const data = src.data;
            const mime = src.media_type ?? src.mimeType;
            if (typeof data === 'string' && typeof mime === 'string') image = { data, mimeType: mime };
          }
        }
        out.push({ type: 'tool-result', id: b.tool_use_id, isError: b.is_error === true, texts, ...(image ? { image } : {}) });
      }
      return out;
    }
    case 'result': {
      const ok = msg.subtype === 'success' && msg.is_error !== true;
      const errors = Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === 'string') : [];
      const message = ok ? undefined : errors.join('\n') || (typeof msg.result === 'string' ? msg.result : undefined) || String(msg.subtype);
      return [
        {
          type: 'result',
          ok,
          subtype: String(msg.subtype),
          ...(typeof msg.duration_ms === 'number' ? { durationMs: msg.duration_ms } : {}),
          ...(typeof msg.num_turns === 'number' ? { numTurns: msg.num_turns } : {}),
          ...(message ? { message } : {}),
        },
      ];
    }
    default:
      return [];
  }
}

// ---- reducer ----------------------------------------------------------------

const MAX_INPUT = 4000;
const MAX_RESULT = 4000;
const MAX_SUMMARY = 160;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… (+${s.length - n})` : s;
}

/** Long strings inside JSON (e.g. YAML) are shortened for display. */
function compactJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'string' && x.length > 600 ? `${x.slice(0, 600)}…` : x), 2) ?? '';
  } catch {
    return String(v);
  }
}

export function summarizeInput(name: string, input: unknown): string {
  if (!isObj(input)) return '';
  const pick = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  if (name === 'session_step' && isObj(input.step)) return clip(JSON.stringify(input.step), MAX_SUMMARY);
  const main = pick('path') ?? pick('savePath') ?? pick('baseUrl') ?? pick('file') ?? pick('runId') ?? pick('sessionId') ?? pick('dir') ?? (pick('yaml') ? '(inline YAML)' : undefined);
  return main ? clip(main, MAX_SUMMARY) : clip(JSON.stringify(input), MAX_SUMMARY);
}

const ERROR_HINT: Record<string, string> = {
  authentication_failed: 'Claude 로그인이 필요합니다. 위의 Login 버튼으로 로그인하세요.',
  oauth_org_not_allowed: '이 조직 계정으로는 사용할 수 없습니다.',
  billing_error: '구독/결제 상태를 확인하세요.',
  rate_limit: '사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.',
  overloaded: '모델이 혼잡합니다. 잠시 후 다시 시도하세요.',
};

let seq = 0;
const newId = (p: string): string => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

function lastStreaming(chat: ChatView): Extract<ChatItem, { kind: 'assistant' }> | undefined {
  const last = chat.items[chat.items.length - 1];
  return last?.kind === 'assistant' && last.streaming ? last : undefined;
}

function closeStreaming(chat: ChatView): void {
  const s = lastStreaming(chat);
  if (s) s.streaming = false;
}

export function notice(chat: ChatView, level: 'info' | 'error', text: string): void {
  chat.items.push({ kind: 'notice', id: newId('n'), ts: Date.now(), level, text });
}

/** Summarize a euta tool result (first text block is JSON for most tools). */
function summarizeResult(texts: string[], isError: boolean): { summary: string; runId?: string; runStatus?: string } {
  const first = texts[0] ?? '';
  let j: unknown;
  try {
    j = JSON.parse(first);
  } catch {
    j = undefined;
  }
  if (isObj(j)) {
    const runId = typeof j.runId === 'string' ? j.runId : typeof j.sessionId === 'string' ? j.sessionId : undefined;
    const runStatus = typeof j.status === 'string' && (typeof j.runId === 'string' || typeof j.sessionId === 'string') ? j.status : undefined;
    if (typeof j.error === 'string') return { summary: clip(j.error + (Array.isArray(j.issues) ? `\n${compactJson(j.issues)}` : ''), MAX_RESULT), ...(runId ? { runId } : {}) };
    const sum = isObj(j.summary) ? ` · ${j.summary.passed}/${j.summary.total} passed` : '';
    if (runStatus) return { summary: `${runStatus}${sum}`, ...(runId ? { runId } : {}), runStatus };
    if (typeof j.valid === 'boolean') return { summary: j.valid ? 'valid' : `${(j.issues as unknown[] | undefined)?.length ?? 0} issue(s)` };
    // A tool whose later blocks must not be kept in the saved chat (get_tc_import: the document grid).
    if (typeof j.cardSummary === 'string') return { summary: clip(j.cardSummary, MAX_RESULT) };
  }
  const joined = texts.join('\n');
  return { summary: clip(joined || (isError ? 'error' : 'done'), MAX_RESULT) };
}

/** Apply one event to a chat (mutates). */
export function applyChatEvent(chat: ChatView, ev: ChatEvent): void {
  chat.updatedAt = Date.now();
  switch (ev.type) {
    case 'session':
      chat.sdkSessionId = ev.sessionId;
      if (ev.model) chat.model = ev.model;
      return;
    case 'thinking':
      if (!lastStreaming(chat)) chat.thinking = true;
      return;
    case 'text-delta': {
      chat.thinking = false;
      const s = lastStreaming(chat);
      if (s) s.text += ev.text;
      else chat.items.push({ kind: 'assistant', id: newId('a'), ts: Date.now(), text: ev.text, streaming: true });
      return;
    }
    case 'assistant-text': {
      chat.thinking = false;
      const s = lastStreaming(chat);
      // The complete block replaces what was streamed (never appended twice).
      if (s) {
        s.text = ev.text;
        s.streaming = false;
      } else if (ev.text.trim()) chat.items.push({ kind: 'assistant', id: newId('a'), ts: Date.now(), text: ev.text });
      return;
    }
    case 'tool-use': {
      closeStreaming(chat);
      chat.thinking = false;
      const name = bareToolName(ev.name);
      if (chat.items.some((i) => i.kind === 'tool' && i.id === ev.id)) return;
      chat.items.push({ kind: 'tool', id: ev.id, ts: Date.now(), name, inputSummary: summarizeInput(name, ev.input), input: clip(compactJson(ev.input), MAX_INPUT), status: 'running' });
      return;
    }
    case 'tool-result': {
      chat.thinking = true;
      const card = chat.items.find((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool' && i.id === ev.id);
      if (!card) return;
      const s = summarizeResult(ev.texts, ev.isError);
      card.status = ev.isError ? 'error' : 'done';
      card.result = s.summary;
      if (s.runId) card.runId = s.runId;
      if (s.runStatus) card.runStatus = s.runStatus;
      if (ev.image) card.image = `data:${ev.image.mimeType};base64,${ev.image.data}`;
      return;
    }
    case 'setup-warning':
      notice(chat, 'error', ev.text);
      return;
    case 'api-error':
      notice(chat, 'error', ERROR_HINT[ev.code] ?? `Claude API error: ${ev.code}`);
      return;
    case 'result':
      closeStreaming(chat);
      chat.thinking = false;
      // The per-message round-trip bound is a limit reached, not a failure (SPEC TC-문서-변환 2026-11-05).
      if (!ev.ok && ev.subtype === 'error_max_turns') notice(chat, 'info', `이 메시지의 AI 왕복 한도(${ev.numTurns ?? '최대'}회)에 닿아 여기서 멈췄습니다. 이어서 하려면 메시지를 보내세요.`);
      else if (!ev.ok) notice(chat, 'error', `턴이 오류로 끝났습니다 (${ev.subtype})${ev.message ? `: ${clip(ev.message, 600)}` : ''}`);
      return;
    case 'error':
      closeStreaming(chat);
      chat.thinking = false;
      notice(chat, 'error', clip(ev.message, 1000));
      return;
    case 'aborted':
      closeStreaming(chat);
      chat.thinking = false;
      for (const i of chat.items) {
        if (i.kind === 'tool' && i.status === 'running') {
          i.status = 'error';
          i.result = 'stopped (an euta run already started may still finish — see Live)';
        }
      }
      notice(chat, 'info', '중지했습니다.');
      return;
  }
}
