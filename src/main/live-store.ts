// Live run store (main process). One RunState per runId, fed by:
//  - in-app runs (core EventBus),
//  - events forwarded by the MCP server (POST /events),
//  - steps.jsonl replays (history "open" and gap recovery).
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { RunListItem, RunSource, RunView } from '../shared/types.js';
import { applyEvent, createRunState, hasGap, isLooseEvent, parseEventLines, type LooseEvent, type RunState } from './live-reducer.js';

const MAX_RUNS = 100;
const STEPS_FILE = 'steps.jsonl';

export type RunListener = (view: RunView) => void;
export type LifecycleListener = (view: RunView, type: 'run.started' | 'run.finished') => void;

/**
 * A run dir reported by an event is accepted only when it is absolute and its
 * folder name equals the run id (engine layout `<runsRoot>/<runId>`). This keeps an
 * event payload from pointing the app at arbitrary folders.
 */
export function acceptRunDir(runId: string, runDir: unknown): string | undefined {
  if (typeof runDir !== 'string' || !isAbsolute(runDir)) return undefined;
  return basename(runDir) === runId ? runDir : undefined;
}

export class LiveStore {
  private readonly runs = new Map<string, RunState>();
  private readonly listeners = new Set<RunListener>();
  private readonly lifecycle = new Set<LifecycleListener>();
  private readonly pending = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly opts: {
      throttleMs?: number;
      recoveryDelayMs?: number;
      /** Project that owns a run dir (`<userData>/projects/<id>/runs/<runId>`), for runs reported by MCP/history. */
      projectOf?: (runDir: string) => string | undefined;
    } = {},
  ) {}

  onUpdate(fn: RunListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called once per run for run.started / run.finished applied from live events (not history replays). */
  onLifecycle(fn: LifecycleListener): () => void {
    this.lifecycle.add(fn);
    return () => this.lifecycle.delete(fn);
  }

  get(runId: string): RunView | undefined {
    return this.runs.get(runId)?.view;
  }

  list(): RunListItem[] {
    return [...this.runs.values()]
      .map((s) => ({ runId: s.view.runId, name: s.view.name, source: s.view.source, status: s.view.status, updatedAt: s.view.updatedAt, ...(s.view.projectId ? { projectId: s.view.projectId } : {}) }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Register a run started by the app itself (runDir is trusted: it comes from core's RunHandle). */
  registerAppRun(runId: string, runDir: string, source: 'app' | 'ai' = 'app', projectId?: string): void {
    const s = this.ensure(runId, source);
    s.view.runDir = runDir;
    if (projectId) s.view.projectId = projectId;
    this.touch(runId);
  }

  /** Ingest events. Unknown/malformed entries are skipped. Returns accepted count. */
  ingest(events: unknown[], source: RunSource): number {
    let n = 0;
    const gapRuns = new Set<string>();
    for (const raw of events) {
      if (!isLooseEvent(raw)) continue;
      const s = this.ensure(raw.runId, source);
      const trustedDir = s.view.runDir;
      if (!applyEvent(s, raw)) continue;
      n++;
      // Only the app itself is trusted to set runDir for app runs; for others validate.
      if (raw.type === 'run.started') {
        s.view.runDir = (s.view.source === 'app' || s.view.source === 'ai') && trustedDir ? trustedDir : acceptRunDir(raw.runId, raw.runDir) ?? trustedDir;
        if (!s.view.projectId && s.view.runDir) {
          const p = this.opts.projectOf?.(s.view.runDir);
          if (p) s.view.projectId = p;
        }
      }
      if (raw.type === 'run.started' || raw.type === 'run.finished') {
        for (const l of this.lifecycle) {
          try {
            l(s.view, raw.type);
          } catch {
            /* listener errors never break ingestion */
          }
        }
      }
      this.touch(raw.runId);
      if (source === 'mcp' && (hasGap(s) || raw.type === 'run.finished')) gapRuns.add(raw.runId);
    }
    for (const id of gapRuns) this.scheduleRecovery(id);
    return n;
  }

  /**
   * A euta cloud run (SPEC 클라우드-앱-연동): the view is rebuilt from the server's run detail on every
   * `run.*` feed event — no engine events reach the app, so the whole view is replaced.
   */
  setCloudRun(view: RunView): void {
    const s = this.ensure(view.runId, 'cloud');
    s.view = { ...view, source: 'cloud', updatedAt: Date.now() };
    this.touch(view.runId);
  }

  /** Extra fields on a run already in the store (e.g. the cloud info of a downloaded cloud run). */
  patch(runId: string, patch: Partial<RunView>): void {
    const s = this.runs.get(runId);
    if (!s) return;
    Object.assign(s.view, patch);
    this.touch(runId);
  }

  /** Replay steps.jsonl of a run dir into the store (history view / recovery). */
  loadFromRunDir(runId: string, runDir: string, source: RunSource): RunView | undefined {
    const file = join(runDir, STEPS_FILE);
    if (!existsSync(file)) return undefined;
    const s = this.ensure(runId, source);
    const before = s.seen.size;
    for (const e of parseEventLines(readFileSync(file, 'utf8'))) {
      if (e.runId === runId) applyEvent(s, e);
    }
    s.view.runDir = s.view.runDir ?? runDir;
    if (!s.view.projectId) {
      const p = this.opts.projectOf?.(runDir);
      if (p) s.view.projectId = p;
    }
    if (s.seen.size > before && before > 0) s.view.recovered = true;
    this.touch(runId);
    return s.view;
  }

  /** Recover missing events from steps.jsonl (debounced). */
  scheduleRecovery(runId: string): void {
    const delay = this.opts.recoveryDelayMs ?? 500;
    clearTimeout(this.recoveryTimers.get(runId));
    this.recoveryTimers.set(
      runId,
      setTimeout(() => {
        this.recoveryTimers.delete(runId);
        this.recover(runId);
      }, delay),
    );
  }

  /** Synchronous recovery (exposed for tests). */
  recover(runId: string): boolean {
    const s = this.runs.get(runId);
    const dir = s?.view.runDir;
    if (!s || !dir || !hasGap(s)) return false;
    const before = s.seen.size;
    this.loadFromRunDir(runId, dir, s.view.source);
    return s.seen.size > before;
  }

  /** Runs whose run dir is known — used by the artifact reader. */
  runDirOf(runId: string): string | undefined {
    return this.runs.get(runId)?.view.runDir;
  }

  dispose(): void {
    clearTimeout(this.flushTimer);
    for (const t of this.recoveryTimers.values()) clearTimeout(t);
    this.recoveryTimers.clear();
  }

  private ensure(runId: string, source: RunSource): RunState {
    let s = this.runs.get(runId);
    if (!s) {
      s = createRunState(runId, source);
      this.runs.set(runId, s);
      this.evict();
    }
    return s;
  }

  private evict(): void {
    if (this.runs.size <= MAX_RUNS) return;
    const oldest = [...this.runs.values()]
      .filter((s) => s.view.status !== 'running')
      .sort((a, b) => a.view.updatedAt - b.view.updatedAt)[0];
    if (oldest) this.runs.delete(oldest.view.runId);
  }

  private touch(runId: string): void {
    this.pending.add(runId);
    const ms = this.opts.throttleMs ?? 100;
    if (ms <= 0) return this.flush();
    this.flushTimer ??= setTimeout(() => this.flush(), ms);
  }

  private flush(): void {
    this.flushTimer = undefined;
    const ids = [...this.pending];
    this.pending.clear();
    for (const id of ids) {
      const v = this.runs.get(id)?.view;
      if (v) for (const l of this.listeners) l(v);
    }
  }
}

export type { LooseEvent };
