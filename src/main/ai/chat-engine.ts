// In-app AI chat engine (ADR-015): one Agent SDK query() per user message, continued
// with `resume: <sdk session id>`; euta tools via an in-process SDK MCP server.
import type { McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk';
import type { ServerConfig } from '@euta/mcp-server/tools';
import type { ChatView } from '../../shared/types.js';
import type { LiveStore } from '../live-store.js';
import { buildQueryOptions, buildSystemPrompt, type SystemPromptInput } from './agent-options.js';
import { applyChatEvent, mapSdkMessage, notice, type ChatEvent } from './chat-events.js';
import { ChatStore, summaryOf } from './chat-store.js';
import { createEutaSdkServer, type SdkToolApi } from './sdk-server.js';
import type { RecordingAccess } from './recording-tools.js';
import type { TcDocAccess } from '../project/tc-docs.js';
import { createAppTools, type AppTools } from './tools.js';

/** The query() shape the engine needs; `ctx` lets a test/fake agent reach the real tools. */
export type QueryFn = (params: { prompt: string; options: Options }, ctx: { tools: AppTools }) => AsyncIterable<unknown>;

export interface SdkModule extends SdkToolApi {
  query: (params: { prompt: string; options?: Options }) => AsyncIterable<unknown>;
}

/** Tool configuration for one chat, from its project environment (ADR-016). */
export interface ChatContext {
  /** Changes when the configuration changes (environment switch, env/secret edits): the runtime is rebuilt between turns. */
  key: string;
  config: ServerConfig;
  workDir: string;
  projectId?: string;
  /** External secrets file of the environment (never readable by read_file). */
  secretsFile?: string;
  project?: SystemPromptInput['project'];
  /** Runs/sessions the AI starts with this configuration. */
  onRunStarted?: (runId: string) => void;
  /** Demonstration recordings of the project (get_recording). */
  recordings?: RecordingAccess;
  /** History-aware script writes for save_script (ADR-018). */
  writeScript?: (absPath: string, content: string) => void | Promise<void>;
  /** read_file results (cloud projects remember which version the AI read). */
  onRead?: (absPath: string, text: string) => void;
  /** TC documents of the project (SPEC TC-문서-변환 AI tools). */
  tcDocs?: TcDocAccess;
}

export interface TurnInfo {
  prompt: string;
  /** euta tools called during the turn (bare names, in order). */
  tools: string[];
  /** First user message of the chat. */
  first: boolean;
}

/**
 * How a turn ended: success · max-turns (the per-message round-trip bound — a limit reached, not a
 * failure; TC auto conversion sends the item again) · aborted (Stop) · error (model, network, CLI).
 */
export interface TurnOutcome {
  kind: 'success' | 'max-turns' | 'aborted' | 'error';
  subtype?: string;
  message?: string;
}

export interface ChatEngineDeps {
  store: ChatStore;
  /** Configuration for a chat (called before each turn). */
  context: (chat: ChatView) => ChatContext;
  /** Defaults for new chats. */
  defaults: () => { workDir: string; model: string; projectId?: string; envId?: string };
  live?: LiveStore;
  /** Loads @anthropic-ai/claude-agent-sdk (lazily, on first message). */
  loadSdk: () => Promise<SdkModule>;
  /** Replace the SDK's query() (tests, EUTA_E2E_FAKE_AGENT). */
  queryFn?: QueryFn;
  /** CLI the SDK spawns (bundled binary, asar-unpacked in the packaged app). */
  claudeExecutable?: () => string | undefined;
  onUpdate: (chat: ChatView) => void;
  /** Turn started (before the agent runs) / finished — activity log. */
  onTurnStart?: (chat: ChatView, t: TurnInfo) => void;
  onTurnEnd?: (chat: ChatView, t: TurnInfo) => void;
  /** Push throttle (ms). */
  throttleMs?: number;
}

interface Runtime {
  key: string;
  tools: AppTools;
  server?: McpSdkServerConfigWithInstance;
}

const isAbort = (e: unknown, signal: AbortSignal): boolean => signal.aborted || (e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message)));

export class ChatEngine {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly d: ChatEngineDeps) {}

  list() {
    return this.d.store.list();
  }

  get(id: string): ChatView | undefined {
    return this.d.store.get(id);
  }

  create(envId?: string): ChatView {
    const d = this.d.defaults();
    const env = envId ?? d.envId;
    const c = this.d.store.create(d.workDir, d.model || undefined, { ...(d.projectId ? { projectId: d.projectId } : {}), ...(env ? { envId: env } : {}) });
    this.d.store.save(c);
    return c;
  }

  /** Select the environment for the chat's next turns (not while a turn is running). */
  setEnv(id: string, envId: string | undefined): ChatView {
    const c = this.d.store.get(id);
    if (!c) throw new Error('chat not found');
    if (c.busy) throw new Error('chat is busy');
    if (envId) c.envId = envId;
    else delete c.envId;
    c.updatedAt = Date.now();
    this.d.store.save(c);
    this.emit(c, true);
    return c;
  }

  /** Any chat of this engine running a turn. */
  busy(): boolean {
    return this.d.store.list().some((c) => c.busy);
  }

  async delete(id: string): Promise<void> {
    this.stop(id);
    const rt = this.runtimes.get(id);
    this.runtimes.delete(id);
    this.d.store.delete(id);
    await rt?.tools.shutdown().catch(() => undefined);
  }

  stop(id: string): boolean {
    const a = this.aborts.get(id);
    if (!a) return false;
    a.abort();
    return true;
  }

  private emit(chat: ChatView, now = false): void {
    const ms = this.d.throttleMs ?? 60;
    if (now || ms <= 0) {
      const t = this.timers.get(chat.id);
      if (t) clearTimeout(t);
      this.timers.delete(chat.id);
      this.d.onUpdate(chat);
      return;
    }
    if (this.timers.has(chat.id)) return;
    this.timers.set(
      chat.id,
      setTimeout(() => {
        this.timers.delete(chat.id);
        this.d.onUpdate(chat);
      }, ms),
    );
  }

  /** The chat's tools for `ctx`; rebuilt (AI sessions closed) when the configuration changed. */
  private async runtime(chat: ChatView, ctx: ChatContext): Promise<Runtime> {
    let rt = this.runtimes.get(chat.id);
    if (rt && rt.key !== ctx.key) {
      this.runtimes.delete(chat.id);
      await rt.tools.shutdown().catch(() => undefined);
      rt = undefined;
    }
    if (!rt) {
      rt = {
        key: ctx.key,
        tools: createAppTools({
          config: ctx.config,
          workDir: ctx.workDir,
          ...(this.d.live ? { live: this.d.live } : {}),
          ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
          ...(ctx.secretsFile ? { secretsFile: ctx.secretsFile } : {}),
          ...(ctx.onRunStarted ? { onRunStarted: ctx.onRunStarted } : {}),
          ...(ctx.recordings ? { recordings: ctx.recordings } : {}),
          ...(ctx.writeScript ? { writeScript: ctx.writeScript } : {}),
          ...(ctx.onRead ? { onRead: ctx.onRead } : {}),
          ...(ctx.tcDocs ? { tcDocs: ctx.tcDocs } : {}),
        }),
      };
      this.runtimes.set(chat.id, rt);
    }
    return rt;
  }

  /** An app notice in a chat (not while its turn runs — it would interleave with the stream). */
  note(id: string, level: 'info' | 'error', text: string): void {
    const chat = this.d.store.get(id);
    if (!chat) return;
    notice(chat, level, text);
    chat.updatedAt = Date.now();
    try {
      this.d.store.save(chat);
    } catch {
      /* keep in memory */
    }
    this.emit(chat, true);
  }

  /** Run one user message to completion (resolves when the turn ends, with how it ended). */
  async send(id: string, text: string): Promise<TurnOutcome> {
    const chat = this.d.store.get(id);
    if (!chat) throw new Error('chat not found');
    if (chat.busy) throw new Error('chat is busy');
    const prompt = text.trim();
    if (!prompt) return { kind: 'error', message: 'empty message' };
    const first = !chat.items.some((i) => i.kind === 'user');
    if (first) chat.title = prompt.replace(/\s+/g, ' ').slice(0, 48);
    const startIndex = chat.items.length;
    chat.items.push({ kind: 'user', id: `u-${Date.now().toString(36)}`, ts: Date.now(), text: prompt });
    chat.busy = true;
    chat.thinking = true;
    chat.updatedAt = Date.now();
    this.emit(chat, true);
    const turn = (): TurnInfo => ({
      prompt,
      first,
      tools: chat.items.slice(startIndex).flatMap((i) => (i.kind === 'tool' ? [i.name] : [])),
    });
    try {
      this.d.onTurnStart?.(chat, turn());
    } catch {
      /* activity logging never blocks a turn */
    }

    const abort = new AbortController();
    this.aborts.set(chat.id, abort);
    let rt: Runtime | undefined;
    const apply = (ev: ChatEvent): void => {
      applyChatEvent(chat, ev);
      this.emit(chat);
    };
    let stderrTail = '';
    let outcome: TurnOutcome = { kind: 'error', message: 'The agent ended without a result.' };
    try {
      const ctx = this.d.context(chat);
      rt = await this.runtime(chat, ctx);
      const sdk = await this.d.loadSdk();
      rt.server ??= createEutaSdkServer(sdk, rt.tools.tools);
      const model = chat.model || this.d.defaults().model;
      const exe = this.d.claudeExecutable?.();
      const options = buildQueryOptions({
        mcpServer: rt.server,
        allowedTools: rt.tools.names,
        abortController: abort,
        cwd: chat.cwd,
        systemPrompt: buildSystemPrompt({ workDir: rt.tools.workDir, runsDir: ctx.config.runsDir, secretNames: rt.tools.secretNames, ...(ctx.project ? { project: ctx.project } : {}) }),
        ...(chat.sdkSessionId ? { resume: chat.sdkSessionId } : {}),
        ...(model ? { model } : {}),
        ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
        stderr: (s) => {
          stderrTail = (stderrTail + s).slice(-2000);
        },
      });
      const tools = rt.tools;
      const q = this.d.queryFn ? this.d.queryFn({ prompt, options }, { tools }) : sdk.query({ prompt, options });
      let sawResult = false;
      for await (const msg of q) {
        for (const ev of mapSdkMessage(msg)) {
          if (ev.type === 'result') {
            sawResult = true;
            outcome = ev.ok ? { kind: 'success', subtype: ev.subtype } : { kind: ev.subtype === 'error_max_turns' ? 'max-turns' : 'error', subtype: ev.subtype, ...(ev.message ? { message: ev.message } : {}) };
          }
          apply(ev);
        }
        if (abort.signal.aborted) break;
      }
      if (abort.signal.aborted) {
        apply({ type: 'aborted' });
        outcome = { kind: 'aborted' };
      } else if (!sawResult) apply({ type: 'error', message: 'The agent ended without a result.' });
    } catch (e) {
      if (isAbort(e, abort.signal)) {
        apply({ type: 'aborted' });
        outcome = { kind: 'aborted' };
      } else {
        const msg = (e as Error)?.message ?? String(e);
        outcome = { kind: 'error', message: msg };
        apply({ type: 'error', message: `Agent error: ${msg}` });
        // CLI stderr is not shown verbatim; it only selects a hint.
        if (/log ?in|logged out|auth|credential|expired/i.test(stderrTail + msg)) notice(chat, 'error', 'Claude 로그인 상태를 확인하세요 (위의 상태 칩 → Login).');
        else if (/not found|ENOENT|spawn|failed to launch/i.test(msg)) notice(chat, 'error', 'Claude Code CLI 를 실행하지 못했습니다. 상태 칩에서 설치 상태를 확인하세요.');
      }
    } finally {
      this.aborts.delete(chat.id);
      chat.busy = false;
      chat.thinking = false;
      chat.updatedAt = Date.now();
      try {
        this.d.store.save(chat);
      } catch {
        /* disk full etc.: keep in memory */
      }
      this.emit(chat, true);
      try {
        this.d.onTurnEnd?.(chat, turn());
      } catch {
        /* activity logging never breaks a turn */
      }
    }
    return outcome;
  }

  summaries() {
    return this.d.store.list();
  }

  /** Abort all turns and close AI-opened browser sessions (app quit). */
  dispose(): Promise<unknown> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const a of this.aborts.values()) a.abort();
    return Promise.allSettled([...this.runtimes.values()].map((rt) => rt.tools.shutdown()));
  }
}

export { summaryOf };
