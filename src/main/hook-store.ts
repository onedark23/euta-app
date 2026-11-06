// AI activity store: Claude Code HTTP hook payloads (POST /hooks/claude), grouped per session.
// Display only — nothing is persisted or sent back to Claude. Long fields are truncated.
//
// Plugin hooks are async (ADR-009), so POSTs can arrive out of order:
//  - PreToolUse / PostToolUse / PostToolUseFailure are merged into one entry keyed by
//    session_id + tool_use_id (whichever arrives first creates it);
//  - SubagentStart / SubagentStop are merged by session_id + agent_id.
import type { HookEntry, HookKind, HookSessionView } from '../shared/types.js';

const MAX_SESSIONS = 20;
const MAX_ENTRIES = 500;
const SUMMARY_MAX = 300;
const DETAIL_MAX = 4000;

/** euta MCP tools: `mcp__euta__*` (claude mcp add) or `mcp__plugin_euta_euta__*` (plugin; any plugin name). */
export function isEutaTool(name: string | undefined): boolean {
  return !!name && /^mcp__(?:plugin_[^_]+(?:_[^_]+)*_)?euta__/.test(name);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s;
}

function compact(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v, (_k, val) => (typeof val === 'string' && val.length > 2000 ? `${val.slice(0, 200)}…[${val.length} chars]` : val), 2);
  } catch {
    s = String(v);
  }
  return clip(s, max);
}

const TOOL_START = new Set(['PreToolUse', 'PermissionRequest']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);

function kindOf(event: string): HookKind {
  if (TOOL_EVENTS.has(event)) return 'tool';
  switch (event) {
    case 'SessionStart':
    case 'SessionEnd':
      return 'session';
    case 'UserPromptSubmit':
      return 'prompt';
    case 'SubagentStart':
    case 'SubagentStop':
      return 'subagent';
    case 'Stop':
    case 'StopFailure':
      return 'stop';
    case 'Notification':
      return 'notification';
    default:
      return 'other';
  }
}

const s = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

export type HookListener = (session: HookSessionView) => void;

export class HookStore {
  private readonly sessions = new Map<string, HookSessionView>();
  /** `${sessionId}\0tool\0${toolUseId}` / `${sessionId}\0agent\0${agentId}` -> entry */
  private readonly pairs = new Map<string, HookEntry>();
  private readonly listeners = new Set<HookListener>();
  private nextId = 1;

  onUpdate(fn: HookListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): HookSessionView[] {
    return [...this.sessions.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  /** Validate and record one hook payload. Returns the (new or merged) entry, or undefined for non-hook shapes. */
  ingest(payload: unknown): HookEntry | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const p = payload as Record<string, unknown>;
    const event = s(p.hook_event_name, 64);
    if (!event) return undefined;
    const sessionId = s(p.session_id, 128) ?? 'unknown';
    const kind = kindOf(event);
    const ts = new Date().toISOString();
    const session = this.session(sessionId, ts);
    if (typeof p.cwd === 'string') session.cwd = p.cwd.slice(0, 500);
    if (event === 'SessionEnd') session.ended = true;
    if (event === 'SessionStart') session.ended = false;

    const toolName = s(p.tool_name);
    const toolUseId = s(p.tool_use_id, 128);
    const agentId = s(p.agent_id, 128);
    const agentType = s(p.agent_type, 128);

    let entry: HookEntry;
    if (kind === 'tool') {
      const key = toolUseId ? `${sessionId}\0tool\0${toolUseId}` : undefined;
      entry = (key && this.pairs.get(key)) || this.add(session, { ts, event, kind, isEuta: false, summary: '', status: 'running' }, key);
      if (toolName) entry.toolName = toolName;
      entry.isEuta = isEutaTool(entry.toolName);
      if (toolUseId) entry.toolUseId = toolUseId;
      if (agentId) entry.agentId = agentId;
      if (agentType) entry.agentType = agentType;
      if (p.tool_input !== undefined) entry.input = compact(p.tool_input, DETAIL_MAX);
      if (event === 'PostToolUse') {
        entry.status = 'done';
        entry.detail = compact(p.tool_response, DETAIL_MAX);
      } else if (event === 'PostToolUseFailure' || event === 'PermissionDenied') {
        entry.status = 'failed';
        entry.detail = compact(p.error ?? p.reason ?? p.tool_response, DETAIL_MAX);
      }
      // A late PreToolUse must not reopen or relabel a finished call.
      if (!(TOOL_START.has(event) && entry.status !== 'running')) entry.event = event;
      const brief = entry.input ? entry.input.replace(/\s+/g, ' ').slice(0, 160) : '';
      entry.summary = `${entry.toolName ?? '?'} ${brief}`.trim();
    } else if (kind === 'subagent') {
      const key = agentId ? `${sessionId}\0agent\0${agentId}` : undefined;
      entry = (key && this.pairs.get(key)) || this.add(session, { ts, event, kind, isEuta: false, summary: '', status: 'running' }, key);
      entry.event = event;
      if (agentId) entry.agentId = agentId;
      if (agentType) entry.agentType = agentType;
      if (event === 'SubagentStop') entry.status = 'done';
      entry.summary = `subagent ${entry.agentType ?? entry.agentId ?? ''}`.trim() + (entry.status === 'done' ? ' finished' : ' started');
    } else {
      let summary: string;
      let detail: string | undefined;
      let status: HookEntry['status'];
      switch (kind) {
        case 'prompt':
          summary = clip(typeof p.prompt === 'string' ? p.prompt : '', SUMMARY_MAX);
          detail = typeof p.prompt === 'string' && p.prompt.length > SUMMARY_MAX ? clip(p.prompt, DETAIL_MAX) : undefined;
          break;
        case 'notification':
          summary = clip(typeof p.message === 'string' ? p.message : 'notification', SUMMARY_MAX);
          break;
        case 'session':
          summary = event === 'SessionStart' ? `session started${s(p.source) ? ` (${s(p.source)})` : ''}` : `session ended${s(p.reason) ? ` (${s(p.reason)})` : ''}`;
          break;
        case 'stop':
          if (event === 'StopFailure') {
            status = 'failed';
            summary = `turn failed${s(p.error, 200) ? `: ${s(p.error, 200)}` : ''}`;
            detail = compact(p.error ?? p.error_details, DETAIL_MAX);
          } else summary = 'turn finished';
          break;
        default:
          summary = event;
      }
      entry = this.add(session, { ts, event, kind, isEuta: false, summary, ...(detail ? { detail } : {}), ...(status ? { status } : {}), ...(agentId ? { agentId } : {}) });
    }

    session.lastAt = ts;
    for (const l of this.listeners) l(session);
    return entry;
  }

  private session(sessionId: string, ts: string): HookSessionView {
    let sess = this.sessions.get(sessionId);
    if (!sess) {
      sess = { sessionId, firstAt: ts, lastAt: ts, ended: false, entries: [] };
      this.sessions.set(sessionId, sess);
      if (this.sessions.size > MAX_SESSIONS) {
        const oldest = [...this.sessions.values()].sort((a, b) => a.lastAt.localeCompare(b.lastAt))[0];
        if (oldest) this.dropSession(oldest.sessionId);
      }
    }
    return sess;
  }

  private dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const k of [...this.pairs.keys()]) if (k.startsWith(`${sessionId}\0`)) this.pairs.delete(k);
  }

  private add(session: HookSessionView, e: Omit<HookEntry, 'id'>, pairKey?: string): HookEntry {
    const entry: HookEntry = { id: this.nextId++, ...e };
    session.entries.push(entry);
    if (pairKey) this.pairs.set(pairKey, entry);
    if (session.entries.length > MAX_ENTRIES) {
      const removed = session.entries.splice(0, session.entries.length - MAX_ENTRIES);
      const gone = new Set(removed);
      for (const [k, v] of this.pairs) if (gone.has(v)) this.pairs.delete(k);
    }
    return entry;
  }
}
