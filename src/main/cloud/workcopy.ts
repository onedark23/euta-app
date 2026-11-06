// Cloud project working copy on disk (SPEC 클라우드-앱-연동 "작업 사본 저장 구조"):
//   <userData>/cloud/<serverId>/projects/<projectId>/
//     state.json      last applied change seq · base version per script · my role
//     snapshot.json   project · environments · suites (server copy, read-only here)
//     pending/<n>.json  saves waiting to be sent (order · path · base version · text)
//     project.json · scripts/ · runs/ · chats/ · recordings/ · baselines/ …  (same as a local project)
// Server ids are UUIDs; the app-side id is the UUID without dashes (32 lowercase hex — fits the
// app's id rule, and the vault key "projectId/envId/NAME" stays keyed by the cloud ids, ADR-025).
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../project/fsx.js';
import type { CloudRole, CloudScriptOrigin, CloudSnapshot } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cloud UUID → app id (32 hex). */
export function compactId(uuid: string): string {
  if (!UUID_RE.test(uuid)) throw new Error(`unexpected cloud id: ${uuid}`);
  return uuid.replace(/-/g, '').toLowerCase();
}

/** App id (32 hex) → cloud UUID. */
export function expandId(id: string): string {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`not a cloud id: ${id}`);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export interface ScriptBase {
  /** Server script id. */
  id: string;
  /** Server version the working-copy file corresponds to (the base of my next save). */
  version: number;
  /** contentHash of that version. */
  hash: string;
  author?: string;
}

export interface CloudState {
  schema: 1;
  serverUrl: string;
  /** Cloud project UUID. */
  projectId: string;
  /** Last change-feed seq applied (null = never synced → full snapshot). */
  lastSeq: number | null;
  role: CloudRole;
  can: string[];
  scripts: Record<string, ScriptBase>;
  /** Paths saved on the server by someone else while I have unsent saves for them. */
  remoteNewer: Record<string, { version: number; by?: string }>;
  nextTicket: number;
  /** Set when the server no longer lets me see the project (404 / `access_lost`) — "접근 권한 없음" lock. */
  accessLost?: { at: string };
}

export type PendingStatus = 'queued' | 'conflict' | 'rejected';

export interface ServerCurrent {
  version: number;
  source: string;
  author?: string;
  at?: string;
}

export interface PendingEntry {
  /** Send order. */
  ticket: number;
  path: string;
  /** Base version when the save was made (null = new script). */
  baseVersion: number | null;
  origin: Exclude<CloudScriptOrigin, 'web' | 'revert'>;
  memo?: string;
  source: string;
  at: string;
  status: PendingStatus;
  /** Conflict: the server's current version (null = the script is gone on the server). */
  server?: ServerCurrent | null;
  /** Rejected: why (validation, permission). */
  error?: string;
}

export class WorkingCopy {
  constructor(readonly dir: string) {}

  get stateFile(): string {
    return join(this.dir, 'state.json');
  }
  get snapshotFile(): string {
    return join(this.dir, 'snapshot.json');
  }
  get pendingDir(): string {
    return join(this.dir, 'pending');
  }

  exists(): boolean {
    return existsSync(this.stateFile);
  }

  state(): CloudState {
    const r = readJson<Partial<CloudState>>(this.stateFile);
    if (!r || typeof r.projectId !== 'string') throw new Error(`cloud working copy has no state: ${this.dir}`);
    return {
      schema: 1,
      serverUrl: typeof r.serverUrl === 'string' ? r.serverUrl : '',
      projectId: r.projectId,
      lastSeq: typeof r.lastSeq === 'number' ? r.lastSeq : null,
      role: r.role === 'owner' || r.role === 'editor' || r.role === 'runner' ? r.role : 'viewer',
      can: Array.isArray(r.can) ? r.can.filter((x): x is string => typeof x === 'string') : [],
      scripts: r.scripts && typeof r.scripts === 'object' ? r.scripts : {},
      remoteNewer: r.remoteNewer && typeof r.remoteNewer === 'object' ? r.remoteNewer : {},
      nextTicket: typeof r.nextTicket === 'number' && r.nextTicket > 0 ? r.nextTicket : 1,
      ...(r.accessLost && typeof r.accessLost.at === 'string' ? { accessLost: { at: r.accessLost.at } } : {}),
    };
  }

  saveState(s: CloudState): void {
    writeJsonAtomic(this.stateFile, s);
  }

  /** Read-modify-write of state.json. */
  update(fn: (s: CloudState) => void): CloudState {
    const s = this.state();
    fn(s);
    this.saveState(s);
    return s;
  }

  snapshot(): CloudSnapshot | undefined {
    return readJson<CloudSnapshot>(this.snapshotFile);
  }

  saveSnapshot(s: CloudSnapshot): void {
    writeJsonAtomic(this.snapshotFile, s);
  }

  /** Pending saves in send order. */
  pending(): PendingEntry[] {
    if (!existsSync(this.pendingDir)) return [];
    const out: PendingEntry[] = [];
    for (const n of readdirSync(this.pendingDir)) {
      if (!/^\d+\.json$/.test(n)) continue;
      const e = readJson<PendingEntry>(join(this.pendingDir, n));
      if (e && typeof e.ticket === 'number' && typeof e.path === 'string' && typeof e.source === 'string') out.push(e);
    }
    return out.sort((a, b) => a.ticket - b.ticket);
  }

  hasPending(path: string): boolean {
    return this.pending().some((e) => e.path === path);
  }

  /** Append a save to the queue (the ticket comes from state.json). */
  enqueue(e: Omit<PendingEntry, 'ticket' | 'at' | 'status'> & { status?: PendingStatus; server?: ServerCurrent | null }, now: Date = new Date()): PendingEntry {
    let ticket = 0;
    this.update((s) => {
      ticket = s.nextTicket;
      s.nextTicket += 1;
    });
    const entry: PendingEntry = { ...e, ticket, at: now.toISOString(), status: e.status ?? 'queued' };
    this.putPending(entry);
    return entry;
  }

  putPending(e: PendingEntry): void {
    mkdirSync(this.pendingDir, { recursive: true });
    writeJsonAtomic(join(this.pendingDir, `${e.ticket}.json`), e);
  }

  removePending(ticket: number): void {
    rmSync(join(this.pendingDir, `${ticket}.json`), { force: true });
  }
}
