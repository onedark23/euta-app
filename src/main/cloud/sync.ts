// Sync engine for one cloud project's working copy (SPEC 클라우드-앱-연동 "동기화", ARCH_euta-cloud
// 동기화, ADR-025). Electron-free; the server API and the file side are injected.
//   - Saves are queued first (pending/), then sent in order with the base version. A 409 stops
//     the queue at that save and becomes a conflict (3 choices); offline keeps the queue.
//   - Change-feed events update the working copy (unless I have unsent saves for that script),
//     a `resync` / first open replaces everything from a fresh snapshot (pending saves are kept).
// Every operation runs on one serial chain per project, so feed events, sends and conflict
// resolution never interleave.
import { scriptHash } from '@euta/core';
import { CloudError, isNetworkError } from './client.js';
import type { CloudSnapshot, EnvironmentDto, FeedEvent, ProjectDto, ScriptDto, ScriptVersionDto, SuiteDto } from './types.js';
import type { PendingEntry, ServerCurrent, WorkingCopy } from './workcopy.js';

export interface SyncApi {
  project(id: string): Promise<ProjectDto>;
  environments(id: string): Promise<EnvironmentDto[]>;
  suites(id: string): Promise<SuiteDto[]>;
  scripts(id: string): Promise<ScriptDto[]>;
  script(id: string, path: string): Promise<ScriptDto & { source: string }>;
  putScript(id: string, path: string, body: { source: string; baseVersion: number | null; origin: string; memo?: string }): Promise<{ script: ScriptDto; version: ScriptVersionDto; unchanged: boolean }>;
}

export type SyncNotice =
  | { kind: 'remote-saved'; path: string; version: number; by?: string; pending: boolean }
  | { kind: 'conflict'; path: string; ticket: number }
  | { kind: 'rejected'; path: string; ticket: number; error: string }
  | { kind: 'sent'; count: number }
  | { kind: 'resynced' };

export interface SyncHost {
  /** Text of the working-copy file, or undefined when it does not exist. */
  readLocal(path: string): string | undefined;
  /** Replace the working-copy file (an own write — not reported as an outside change). */
  writeLocal(path: string, text: string): void;
  deleteLocal(path: string): void;
  renameLocal(from: string, to: string): void;
  /** Library paths currently in the working copy. */
  listLocal(): string[];
  snapshotChanged(snap: CloudSnapshot): void;
  notice(n: SyncNotice): void;
  /** Script list / badges changed. */
  changed(): void;
  offline(e: unknown): void;
  authLost(): void;
  myUserId(): string | undefined;
  /** `run.*` / `schedule.*` feed rows (C3: Live, History, 예약 tab) — nothing to apply to the working copy. */
  runEvent?(kind: string, data: Record<string, unknown>): void;
}

export type Outcome =
  | { kind: 'saved'; version: number; unchanged: boolean }
  | { kind: 'conflict'; entry: PendingEntry }
  | { kind: 'queued'; reason: 'offline' | 'blocked' }
  | { kind: 'rejected'; error: string };

export type ConflictChoice = 'mine' | 'theirs' | 'copy';

const SCRIPT_KINDS = new Set(['script.created', 'script.saved', 'script.reverted', 'script.restored']);
const SNAPSHOT_PREFIXES = ['project.', 'environment.', 'credential.', 'suite.', 'member.', 'access.'];

function issuesText(details: unknown): string {
  const issues = (details as { issues?: { path?: string; message?: string }[] } | undefined)?.issues;
  return Array.isArray(issues) && issues.length ? ` — ${issues.slice(0, 5).map((i) => `${i.path ? `${i.path}: ` : ''}${i.message ?? ''}`).join('; ')}` : '';
}

function currentOf(details: unknown): ServerCurrent | null {
  const c = (details as { current?: { version?: number; source?: string; author?: { name?: string } | null; createdAt?: string } | null } | undefined)?.current;
  if (!c || typeof c.version !== 'number' || typeof c.source !== 'string') return null;
  return { version: c.version, source: c.source, ...(c.author?.name ? { author: c.author.name } : {}), ...(c.createdAt ? { at: c.createdAt } : {}) };
}

/** Queued saves of the same script after `e` (their text is newer). */
export function laterSaves(pending: readonly PendingEntry[], e: PendingEntry): number {
  return pending.filter((x) => x.path === e.path && x.ticket > e.ticket).length;
}

export class ProjectSync {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly waiters = new Map<number, (o: Outcome) => void>();

  constructor(
    readonly wc: WorkingCopy,
    private readonly api: SyncApi,
    private readonly host: SyncHost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get projectId(): string {
    return this.wc.state().projectId;
  }

  /** Run `fn` after everything queued before it (one chain per project). */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  // ---- saves ----------------------------------------------------------------------------------

  /** Queue a save (the caller already wrote the file). */
  enqueue(path: string, source: string, origin: PendingEntry['origin'], memo?: string): PendingEntry {
    const base = this.wc.state().scripts[path]?.version ?? null;
    const e = this.wc.enqueue({ path, baseVersion: base, origin, source, ...(memo ? { memo } : {}) }, this.now());
    this.host.changed();
    return e;
  }

  /** Outcome of a queued save: sent now when online, otherwise it waits in the queue. */
  push(ticket: number, online: boolean): Promise<Outcome> {
    if (!online) return Promise.resolve({ kind: 'queued', reason: 'offline' });
    const p = new Promise<Outcome>((resolve) => this.waiters.set(ticket, resolve));
    void this.drain().catch(() => undefined);
    return p;
  }

  private settle(ticket: number, o: Outcome): void {
    const w = this.waiters.get(ticket);
    if (w) {
      this.waiters.delete(ticket);
      w(o);
    }
  }

  /** Send queued saves in order; stops at a conflict / rejection / network error. */
  drain(): Promise<void> {
    return this.run(() => this.drainNow());
  }

  private async drainNow(): Promise<void> {
    let sent = 0;
    let reason: 'offline' | 'blocked' = 'blocked';
    // Only the saves seen here are settled at the end; later ones belong to the next drain.
    const list = this.wc.pending();
    try {
      for (const e of list) {
        if (e.status !== 'queued') break;
        const r = await this.send(e);
        if (r === 'sent') sent++;
        else {
          if (r === 'offline') reason = 'offline';
          break;
        }
      }
    } finally {
      if (sent) this.host.notice({ kind: 'sent', count: sent });
      for (const e of list) this.settle(e.ticket, { kind: 'queued', reason });
      this.host.changed();
    }
  }

  private async send(e: PendingEntry): Promise<'sent' | 'stopped' | 'offline'> {
    const pid = this.projectId;
    const base = this.wc.state().scripts[e.path]?.version ?? null;
    try {
      const r = await this.api.putScript(pid, e.path, { source: e.source, baseVersion: base, origin: e.origin, ...(e.memo ? { memo: e.memo } : {}) });
      this.wc.update((s) => {
        s.scripts[e.path] = { id: r.script.id, version: r.script.version, hash: r.script.contentHash, ...(r.script.updatedBy?.name ? { author: r.script.updatedBy.name } : {}) };
        delete s.remoteNewer[e.path];
      });
      this.wc.removePending(e.ticket);
      this.settle(e.ticket, { kind: 'saved', version: r.script.version, unchanged: r.unchanged });
      return 'sent';
    } catch (err) {
      if (isNetworkError(err)) {
        this.host.offline(err);
        return 'offline';
      }
      if (err instanceof CloudError && err.status === 401) {
        this.host.authLost();
        return 'offline';
      }
      if (err instanceof CloudError && err.status === 409) {
        const conflict: PendingEntry = { ...e, status: 'conflict', server: currentOf(err.details) };
        this.wc.putPending(conflict);
        this.settle(e.ticket, { kind: 'conflict', entry: conflict });
        this.host.notice({ kind: 'conflict', path: e.path, ticket: e.ticket });
        return 'stopped';
      }
      const error = err instanceof CloudError ? `${err.message}${issuesText(err.details)}` : String((err as Error)?.message ?? err);
      this.wc.putPending({ ...e, status: 'rejected', error });
      this.settle(e.ticket, { kind: 'rejected', error });
      this.host.notice({ kind: 'rejected', path: e.path, ticket: e.ticket, error });
      return 'stopped';
    }
  }

  /** The first blocked save (conflict / rejected) — what the conflict screen shows. */
  blocked(): PendingEntry | undefined {
    return this.wc.pending().find((e) => e.status !== 'queued');
  }

  /**
   * Resolve a conflict (SPEC 충돌 3 choices): ① `mine` = my text as a new version on top of the
   * server's latest · ② `theirs` = take the server's version (my change dropped) · ③ `copy` = my
   * text saved as `copyPath`, the original takes the server's version. A rejected save accepts
   * `theirs` (discard) or `mine` (send again); discarding a rejected save that has later saves of the
   * same script drops only that one (the later ones are sent, the local file stays). Returns the
   * entry when it is still in conflict.
   */
  resolve(ticket: number, choice: ConflictChoice, copyPath?: string): Promise<PendingEntry | undefined> {
    return this.run(async () => {
      const e = this.wc.pending().find((x) => x.ticket === ticket);
      if (!e || e.status === 'queued') throw new Error('이 충돌은 이미 해결되었습니다');
      const pid = this.projectId;
      if (choice === 'mine') {
        try {
          const base = e.status === 'conflict' ? (e.server?.version ?? null) : (this.wc.state().scripts[e.path]?.version ?? null);
          const r = await this.api.putScript(pid, e.path, { source: e.source, baseVersion: base, origin: e.origin, ...(e.memo ? { memo: e.memo } : {}) });
          this.wc.update((s) => {
            s.scripts[e.path] = { id: r.script.id, version: r.script.version, hash: r.script.contentHash };
            delete s.remoteNewer[e.path];
          });
          this.wc.removePending(e.ticket);
          if (this.host.readLocal(e.path) !== e.source && !this.laterFor(e)) this.host.writeLocal(e.path, e.source);
        } catch (err) {
          if (err instanceof CloudError && err.status === 409) {
            const again: PendingEntry = { ...e, status: 'conflict', server: currentOf(err.details) };
            this.wc.putPending(again);
            this.host.changed();
            return again;
          }
          if (isNetworkError(err)) this.host.offline(err);
          throw err;
        }
      } else if (choice === 'theirs' && e.status === 'rejected' && this.laterFor(e)) {
        // A refused save with a later save of the same script (e.g. the AI fixed it): drop only the
        // refused one and send the later one — the working copy already holds that newer text (ADR-046).
        this.wc.removePending(e.ticket);
      } else {
        if (choice === 'copy') {
          if (!copyPath) throw new Error('copy path is required');
          const r = await this.api.putScript(pid, copyPath, { source: e.source, baseVersion: null, origin: e.origin === 'external' ? 'app' : e.origin });
          this.wc.update((s) => {
            s.scripts[copyPath] = { id: r.script.id, version: r.script.version, hash: r.script.contentHash };
          });
          this.host.writeLocal(copyPath, e.source);
        }
        await this.takeServer(e.path);
        // Later queued saves of the same script were built on the dropped text.
        for (const x of this.wc.pending()) if (x.path === e.path) this.wc.removePending(x.ticket);
      }
      this.host.changed();
      await this.drainNow();
      return undefined;
    });
  }

  /** Is there a later queued save of the same script (its text is newer than `e`)? */
  private laterFor(e: PendingEntry): boolean {
    return laterSaves(this.wc.pending(), e) > 0;
  }

  /** Make the working copy hold the server's current version of `path` (or remove it if gone). */
  private async takeServer(path: string): Promise<void> {
    const pid = this.projectId;
    try {
      const s = await this.api.script(pid, path);
      if (this.host.readLocal(path) === undefined || scriptHash(this.host.readLocal(path)!) !== s.contentHash) this.host.writeLocal(path, s.source);
      this.wc.update((st) => {
        st.scripts[path] = { id: s.id, version: s.version, hash: s.contentHash, ...(s.updatedBy?.name ? { author: s.updatedBy.name } : {}) };
        delete st.remoteNewer[path];
      });
    } catch (err) {
      if (err instanceof CloudError && err.status === 404) {
        this.host.deleteLocal(path);
        this.wc.update((st) => {
          delete st.scripts[path];
          delete st.remoteNewer[path];
        });
        return;
      }
      throw err;
    }
  }

  /** AI save conflict: take the server's latest at once (the AI re-reads it), drop the AI's text. */
  dropForAi(ticket: number): Promise<void> {
    return this.run(async () => {
      const e = this.wc.pending().find((x) => x.ticket === ticket);
      if (!e) return;
      await this.takeServer(e.path);
      for (const x of this.wc.pending()) if (x.path === e.path) this.wc.removePending(x.ticket);
      this.host.changed();
      await this.drainNow();
    });
  }

  // ---- receiving changes -----------------------------------------------------------------------

  /** Apply one change-feed event. */
  apply(ev: FeedEvent): Promise<void> {
    return this.run(async () => {
      if (ev.event === 'change') await this.applyChange(ev);
      this.wc.update((s) => {
        if (s.lastSeq === null || ev.seq > s.lastSeq) s.lastSeq = ev.seq;
      });
    });
  }

  private async applyChange(ev: FeedEvent): Promise<void> {
    const kind = ev.kind ?? '';
    const d = ev.data ?? {};
    const st = this.wc.state();
    if (SCRIPT_KINDS.has(kind) && typeof d.path === 'string') {
      const path = d.path;
      const version = typeof d.version === 'number' ? d.version : undefined;
      if (version !== undefined && (st.scripts[path]?.version ?? 0) >= version) return; // my own save / already applied
      if (this.wc.hasPending(path)) {
        const v = version ?? (st.scripts[path]?.version ?? 0) + 1;
        this.wc.update((s) => {
          s.remoteNewer[path] = { version: v };
        });
        this.host.notice({ kind: 'remote-saved', path, version: v, pending: true });
        this.host.changed();
        return;
      }
      const s = await this.fetchInto(path);
      if (s && ev.actorId !== this.host.myUserId()) this.host.notice({ kind: 'remote-saved', path, version: s.version, ...(s.updatedBy?.name ? { by: s.updatedBy.name } : {}), pending: false });
      this.host.changed();
      return;
    }
    if (kind === 'script.renamed' && typeof d.from === 'string' && typeof d.to === 'string') {
      const { from, to } = d;
      if (!st.scripts[from] || this.wc.hasPending(from) || this.wc.hasPending(to)) return;
      if (this.host.readLocal(from) !== undefined) this.host.renameLocal(from, to);
      this.wc.update((s) => {
        s.scripts[to] = s.scripts[from]!;
        delete s.scripts[from];
      });
      this.host.changed();
      return;
    }
    if (kind === 'script.deleted' && typeof d.path === 'string') {
      if (this.wc.hasPending(d.path)) return; // my unsent save will meet "gone on the server" → conflict
      const path = d.path;
      this.host.deleteLocal(path);
      this.wc.update((s) => {
        delete s.scripts[path];
      });
      this.host.changed();
      return;
    }
    if (SNAPSHOT_PREFIXES.some((p) => kind.startsWith(p))) {
      await this.refreshSnapshot();
      return;
    }
    if (kind.startsWith('run.') || kind.startsWith('schedule.')) this.host.runEvent?.(kind, d);
  }

  /** GET the script and write it if the working copy differs; records the base version. */
  private async fetchInto(path: string): Promise<(ScriptDto & { source: string }) | undefined> {
    let s: ScriptDto & { source: string };
    try {
      s = await this.api.script(this.projectId, path);
    } catch (err) {
      if (err instanceof CloudError && err.status === 404) return undefined;
      throw err;
    }
    const local = this.host.readLocal(path);
    if (local === undefined || scriptHash(local) !== s.contentHash) this.host.writeLocal(path, s.source);
    this.wc.update((st) => {
      st.scripts[path] = { id: s.id, version: s.version, hash: s.contentHash, ...(s.updatedBy?.name ? { author: s.updatedBy.name } : {}) };
      delete st.remoteNewer[path];
    });
    return s;
  }

  /** Re-read project · environments · suites (settings changed on the server). */
  refreshSnapshot(): Promise<CloudSnapshot> {
    return this.fetchSnapshot();
  }

  private async fetchSnapshot(): Promise<CloudSnapshot> {
    const pid = this.projectId;
    const [project, environments, suites] = await Promise.all([this.api.project(pid), this.api.environments(pid), this.api.suites(pid)]);
    const snap: CloudSnapshot = { project, environments, suites, fetchedAt: this.now().toISOString() };
    this.wc.saveSnapshot(snap);
    this.wc.update((s) => {
      s.role = project.myRole;
      s.can = project.can ?? [];
      // I can see it again (re-invited / back to 조직 공개): the "접근 권한 없음" lock lifts.
      delete s.accessLost;
    });
    this.host.snapshotChanged(snap);
    return snap;
  }

  /**
   * Full reload (first open, or the server's `resync` signal): snapshot + every script.
   * Scripts with unsent saves keep my text; scripts gone on the server are removed.
   */
  resync(seq: number): Promise<void> {
    return this.run(async () => {
      const first = this.wc.state().lastSeq === null;
      await this.fetchSnapshot();
      const list = await this.api.scripts(this.projectId);
      const pendingPaths = new Set(this.wc.pending().map((e) => e.path));
      const st = this.wc.state();
      const onServer = new Set<string>();
      for (const s of list) {
        onServer.add(s.path);
        if (pendingPaths.has(s.path)) {
          if (st.scripts[s.path] && s.version > st.scripts[s.path]!.version) this.wc.update((x) => (x.remoteNewer[s.path] = { version: s.version }));
          continue;
        }
        const local = this.host.readLocal(s.path);
        if (st.scripts[s.path]?.version === s.version && local !== undefined && scriptHash(local) === s.contentHash) continue;
        await this.fetchInto(s.path);
      }
      for (const path of new Set([...Object.keys(st.scripts), ...this.host.listLocal()])) {
        if (onServer.has(path) || pendingPaths.has(path)) continue;
        // Known before but gone on the server → deleted there. Unknown local files stay (the
        // watcher queues new files as outside changes).
        if (!st.scripts[path]) continue;
        this.host.deleteLocal(path);
        this.wc.update((x) => delete x.scripts[path]);
      }
      this.wc.update((x) => {
        x.lastSeq = seq;
      });
      if (!first) this.host.notice({ kind: 'resynced' });
      this.host.changed();
    });
  }
}
