// Cloud service (SPEC 클라우드-앱-연동, ADR-025): connection + device login, cloud projects as
// working copies, the change feed of the open project, the pending queue, conflicts, server
// history and the cloud-side project settings. Electron-free (safeStorage, fetch and the browser
// opener are injected); index.ts maps IPC onto it. The device token never leaves this process.
import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { scriptHash } from '@euta/core';
import type {
  CloudAccessRequestView,
  CloudActivityView,
  CloudConvertPreview,
  CloudConvertResult,
  CloudMergeChoices,
  CloudMergePlan,
  CloudReceiveList,
  CloudRole,
  Suite,
  CloudConflictChoice,
  CloudConflictView,
  CloudConnState,
  CloudMemberView,
  CloudNotice,
  CloudProjectItem,
  CloudStatusView,
  DeletedScript,
  EnvironmentView,
  Project,
  ProjectCloudLink,
  ProjectCloudView,
  ProjectSummary,
  ProjectView,
  ScriptCompareView,
  ScriptEditPayload,
  ScriptEntry,
  ScriptHistoryView,
  ScriptSaveResult,
  ScriptVersionView,
} from '../../shared/types.js';
import { diffScripts } from '../../shared/script-diff.js';
import { cleanScriptPath, InputError } from '../project/project-store.js';
import { changeSummary, parseScript } from '../project/script-history.js';
import type { CloudBridge, ProjectService } from '../project/service.js';
import type { SafeStorageLike } from '../project/vault.js';
import type { LiveStore } from '../live-store.js';
import type { CloudNotificationView } from '../../shared/types.js';
import { CloudAccount } from './account.js';
import { CloudNotifier } from './notifications.js';
import { CloudRuns } from './runs.js';
import { CloudSchedules } from './schedules.js';
import { CloudClient, CloudError, isNetworkError, normalizeServerUrl, type DeviceCode, type FetchLike } from './client.js';
import { laterSaves, ProjectSync, type Outcome, type SyncApi, type SyncHost, type SyncNotice } from './sync.js';
import type { CloudSnapshot, MergeBody, ProjectDto, ReceivableProjectDto, ScriptVersionDto } from './types.js';
import { countRuns, moveLocalData } from './local-move.js';
import { compactId, expandId, WorkingCopy, type PendingEntry } from './workcopy.js';

export interface CloudServiceEvents {
  status?(v: CloudStatusView): void;
  notice?(n: CloudNotice): void;
  projectsChanged?(): void;
  scriptsChanged?(projectId: string): void;
  /** Cloud runs / schedules of a project changed (History, 예약 tab reload). */
  runsChanged?(projectId: string): void;
  /** An app notification (`GET /api/me/events`) to show as an OS notification. */
  notification?(v: CloudNotificationView): void;
}

export interface CloudServiceOptions {
  userData: string;
  safeStorage: SafeStorageLike;
  projects: ProjectService;
  events?: CloudServiceEvents;
  fetch?: FetchLike;
  /** Opens the device-approval page in the system browser. */
  openExternal?: (url: string) => void;
  now?: () => Date;
  /** Reconnect probe delays (ms). */
  retry?: { min: number; max: number };
  /** Live store: cloud runs appear there with a "클라우드" badge. */
  live?: LiveStore;
  /** App notifications on/off (앱 설정 > 클라우드). Default on. */
  notifyEnabled?: () => boolean;
  /** Cloud-run cache budget (default 2 GB) and feed debounce — tests. */
  runs?: { cacheMaxBytes?: number; refreshDelayMs?: number };
}

const ROLE_NAME: Record<string, string> = { owner: '소유자', editor: '편집자', runner: '실행자', viewer: '보기' };
const ORIGIN_ACTOR: Record<string, ScriptVersionView['actor']> = { app: 'user', web: 'user', ai_mcp: 'ai', external: 'external', revert: 'restore' };
const ORIGIN_LABEL: Record<string, string> = { app: '앱', web: '웹', ai_mcp: 'AI', external: '앱 바깥 변경', revert: '되돌리기' };

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });

/** Role table fallback when an older server sends no `can` (API_CONTRACT §0 — decide by `can`). */
const ROLE_CAN: Record<string, string[]> = {
  owner: ['project.view', 'run.execute', 'run.upload', 'schedule.manage', 'script.edit', 'suite.edit', 'environment.edit', 'credential.write', 'project.update', 'member.manage'],
  editor: ['project.view', 'run.execute', 'run.upload', 'schedule.manage', 'script.edit', 'suite.edit', 'environment.edit', 'credential.write', 'project.update'],
  runner: ['project.view', 'run.execute', 'run.upload'],
  viewer: ['project.view'],
};

/** May I perform `action` in this working copy (server `can`, else the role table)? */
export function allows(st: { role: string; can: string[] }, action: string): boolean {
  return (st.can.length ? st.can : (ROLE_CAN[st.role] ?? [])).includes(action);
}

/** File-name-safe form of a person's name for choice ③ (`<name>-<my name>.yaml`). */
export function nameSlug(name: string | undefined): string {
  const s = (name ?? '').trim().replace(/[\s/\\:*?"<>|.#%]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'me';
}

export class CloudService implements CloudBridge {
  readonly account: CloudAccount;
  private client: CloudClient | undefined;
  private conn: CloudConnState;
  private lastError: string | undefined;
  private loginState: { userCode: string; verificationUri: string; expiresAt: string; abort: AbortController } | undefined;
  private readonly syncs = new Map<string, ProjectSync>();
  private feed: { id: string; abort: AbortController } | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private retryDelay: number;
  private readonly versionCache = new Map<string, ScriptVersionDto>();
  private readonly deletedKeys = new Map<string, string>();
  private disposed = false;
  readonly runs: CloudRuns;
  readonly schedules: CloudSchedules;
  readonly notifier: CloudNotifier;

  constructor(private readonly o: CloudServiceOptions) {
    this.account = new CloudAccount(o.userData, o.safeStorage);
    this.retryDelay = o.retry?.min ?? 1000;
    if (this.account.serverUrl) this.client = this.newClient(this.account.serverUrl);
    this.conn = !this.account.serverUrl ? 'none' : this.account.hasToken() ? 'offline' : 'signed_out';
    o.projects.setCloud(this);
    const changed = (id: string) => this.o.events?.runsChanged?.(id);
    this.runs = new CloudRuns(
      {
        call: (fn, raw) => this.call(fn, raw),
        online: () => this.online,
        cloudId: (id) => this.link(id).projectId,
        wc: (id) => this.wc(id),
        projects: o.projects,
        ...(o.live ? { live: o.live } : {}),
        changed,
        cloudIds: () => this.cloudIds(),
      },
      o.runs ?? {},
    );
    this.schedules = new CloudSchedules({ call: (fn) => this.call(fn), cloudId: (id) => this.link(id).projectId, wc: (id) => this.wc(id), projects: o.projects, changed });
    this.notifier = new CloudNotifier({
      userData: o.userData,
      client: () => (this.account.hasToken() ? this.client : undefined),
      serverUrl: () => this.account.serverUrl,
      enabled: () => o.notifyEnabled?.() ?? true,
      notify: (v) => this.o.events?.notification?.(v),
      offline: (e) => this.markOffline(e),
      authLost: () => this.authLost(),
      // 승인·거절 of my request (or a request to me): read that working copy's role again.
      access: (cloudId, kind) => {
        const id = compactId(cloudId);
        if (!this.svc.store.get(id)?.cloud) return;
        if (kind === 'access.requested') this.o.events?.notice?.({ projectId: id, kind: 'access', message: '권한 요청이 왔습니다 — 프로젝트 설정 > 구성원에서 승인하거나 거절하세요' });
        else void this.refreshAccess(id);
      },
    });
  }

  /** 앱 설정 > 클라우드 > 알림 toggled. */
  notifyChanged(enabled: boolean): void {
    if (!enabled) {
      this.notifier.stop();
      this.notifier.reset();
    } else if (this.online) this.notifier.start();
  }

  private get svc(): ProjectService {
    return this.o.projects;
  }

  private newClient(url: string): CloudClient {
    return new CloudClient(url, () => this.account.token(), this.o.fetch);
  }

  /** Check the saved login (startup). */
  start(): void {
    if (this.account.hasToken() && this.client) void this.probe();
  }

  dispose(): void {
    this.disposed = true;
    this.stopFeed();
    this.notifier.stop();
    this.runs.dispose();
    this.loginState?.abort.abort();
    if (this.probeTimer) clearTimeout(this.probeTimer);
  }

  // ---- connection & login --------------------------------------------------------------------

  status(): CloudStatusView {
    const u = this.account.user;
    return {
      serverUrl: this.account.serverUrl,
      state: this.conn,
      ...(u ? { user: { id: u.id, email: u.email, name: u.name, ...(u.isAdmin ? { isAdmin: true } : {}) } } : {}),
      ...(this.loginState ? { login: { userCode: this.loginState.userCode, verificationUri: this.loginState.verificationUri, expiresAt: this.loginState.expiresAt } } : {}),
      pending: this.cloudIds().reduce((n, id) => n + this.wc(id).pending().length, 0),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private emitStatus(): void {
    this.o.events?.status?.(this.status());
  }

  get online(): boolean {
    return this.conn === 'online';
  }

  setServer(raw: string): CloudStatusView {
    const url = normalizeServerUrl(raw);
    if (url !== this.account.serverUrl) {
      this.stopFeed();
      this.loginState?.abort.abort();
      this.loginState = undefined;
      this.account.setServer(url);
      this.client = this.newClient(url);
      this.conn = 'signed_out';
      this.lastError = undefined;
      this.o.events?.projectsChanged?.();
    }
    this.emitStatus();
    return this.status();
  }

  /** Device authorization (ADR-023): code → browser approval → the app polls for the token. */
  async login(): Promise<CloudStatusView> {
    const client = this.client;
    if (!client) throw new InputError('먼저 서버 주소를 입력하세요');
    this.loginState?.abort.abort();
    let code: DeviceCode;
    try {
      code = await client.deviceCode();
    } catch (e) {
      throw new InputError(isNetworkError(e) ? '서버에 연결할 수 없습니다 — 주소와 네트워크를 확인하세요' : `로그인을 시작하지 못했습니다: ${(e as Error).message}`);
    }
    const abort = new AbortController();
    const expiresAt = new Date(Date.now() + code.expires_in * 1000).toISOString();
    this.loginState = { userCode: code.user_code, verificationUri: code.verification_uri_complete ?? code.verification_uri, expiresAt, abort };
    this.lastError = undefined;
    this.o.openExternal?.(this.loginState.verificationUri);
    this.emitStatus();
    void this.pollLogin(client, code, abort.signal);
    return this.status();
  }

  cancelLogin(): CloudStatusView {
    this.loginState?.abort.abort();
    this.loginState = undefined;
    this.emitStatus();
    return this.status();
  }

  private async pollLogin(client: CloudClient, code: DeviceCode, signal: AbortSignal): Promise<void> {
    let interval = Math.max(1, code.interval ?? 5) * 1000;
    const until = Date.now() + code.expires_in * 1000;
    const done = (error?: string) => {
      if (signal.aborted) return;
      this.loginState = undefined;
      this.lastError = error;
      this.emitStatus();
    };
    while (!signal.aborted && Date.now() < until) {
      await sleep(interval, signal);
      if (signal.aborted) return;
      let r;
      try {
        r = await client.deviceToken(code.device_code);
      } catch {
        continue; // network blip: keep polling until the code expires
      }
      if ('access_token' in r) {
        try {
          const token = r.access_token;
          const me = await new CloudClient(client.baseUrl, () => token, this.o.fetch).me();
          this.account.setToken(token, { id: me.id, email: me.email, name: me.name, ...(me.isAdmin ? { isAdmin: true } : {}) });
        } catch (e) {
          return done(`로그인 정보를 저장하지 못했습니다: ${(e as Error).message}`);
        }
        done();
        await this.probe();
        return;
      }
      if (r.error === 'authorization_pending') continue;
      if (r.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      return done(r.error === 'access_denied' ? '브라우저에서 로그인을 거절했습니다' : r.error === 'expired_token' ? '로그인 코드가 만료되었습니다 — 다시 로그인하세요' : `로그인 실패: ${r.error_description ?? r.error}`);
    }
    if (!signal.aborted) done('로그인 코드가 만료되었습니다 — 다시 로그인하세요');
  }

  async logout(): Promise<CloudStatusView> {
    this.stopFeed();
    this.notifier.stop();
    this.loginState?.abort.abort();
    this.loginState = undefined;
    if (this.client && this.account.hasToken()) await this.client.signOut();
    this.account.clearToken();
    this.conn = this.account.serverUrl ? 'signed_out' : 'none';
    this.lastError = undefined;
    this.emitStatus();
    this.o.events?.projectsChanged?.();
    return this.status();
  }

  /** GET /api/me: online, or offline (retry scheduled), or login required. */
  async probe(): Promise<void> {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    const client = this.client;
    if (!client || !this.account.hasToken() || this.disposed) return;
    try {
      const me = await client.me();
      const u = this.account.user;
      if (!u || u.name !== me.name || u.email !== me.email || !!u.isAdmin !== !!me.isAdmin) this.account.setUser({ id: me.id, email: me.email, name: me.name, ...(me.isAdmin ? { isAdmin: true } : {}) });
      this.goOnline();
    } catch (e) {
      if (e instanceof CloudError && e.status === 401) this.authLost();
      else this.markOffline(e);
    }
  }

  private goOnline(): void {
    const was = this.conn;
    this.conn = 'online';
    this.lastError = undefined;
    this.retryDelay = this.o.retry?.min ?? 1000;
    if (was !== 'online') {
      this.emitStatus();
      this.o.events?.projectsChanged?.();
    }
    // Reconnected: send what waited, in order, per project; resume the open project's feed.
    for (const id of this.cloudIds()) if (!this.wc(id).state().accessLost && this.wc(id).pending().some((e) => e.status === 'queued')) void this.sync(id).drain().catch(() => undefined);
    const cur = this.svc.current();
    if (cur && this.svc.isCloud(cur) && this.feed?.id !== cur) void this.openFollow(cur);
    this.notifier.start();
  }

  private markOffline(e: unknown): void {
    if (this.disposed) return;
    const was = this.conn;
    if (this.conn !== 'login_required') this.conn = 'offline';
    this.lastError = (e as Error)?.message;
    this.stopFeed();
    this.notifier.stop();
    if (was !== this.conn) {
      this.emitStatus();
      this.o.events?.projectsChanged?.();
    }
    if (this.conn === 'offline' && !this.probeTimer) {
      const delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, this.o.retry?.max ?? 5000);
      this.probeTimer = setTimeout(() => {
        this.probeTimer = undefined;
        void this.probe();
      }, delay);
    }
  }

  private authLost(): void {
    this.conn = 'login_required';
    this.lastError = '로그인이 만료되었습니다 — 다시 로그인하세요';
    this.stopFeed();
    this.notifier.stop();
    this.emitStatus();
    this.o.events?.projectsChanged?.();
  }

  /**
   * Run a server call: network → offline, 401 → login required, other errors → readable InputError
   * (`raw`: other CloudErrors are rethrown as they are, for callers that read the error code/details).
   */
  private async call<T>(fn: (c: CloudClient) => Promise<T>, raw = false): Promise<T> {
    const c = this.client;
    if (!c) throw new InputError('클라우드 서버가 설정되지 않았습니다 (앱 설정 → 클라우드)');
    if (!this.account.hasToken()) throw new InputError('클라우드에 로그인하세요 (앱 설정 → 클라우드)');
    if (this.conn !== 'online') throw new InputError(this.conn === 'login_required' ? '로그인이 필요합니다 (앱 설정 → 클라우드)' : '오프라인 — 다시 연결된 뒤에 할 수 있습니다 (읽기만)');
    try {
      return await fn(c);
    } catch (e) {
      if (isNetworkError(e)) {
        this.markOffline(e);
        throw new InputError('클라우드에 연결할 수 없습니다 — 오프라인으로 전환합니다');
      }
      if (e instanceof CloudError) {
        if (e.status === 401) {
          this.authLost();
          throw new InputError('로그인이 필요합니다 (앱 설정 → 클라우드)');
        }
        if (raw) throw e;
        const issues = (e.details as { path?: string; message?: string }[] | { issues?: { path?: string; message?: string }[] } | undefined) ?? undefined;
        const list = Array.isArray(issues) ? issues : issues?.issues;
        throw new InputError(`${e.status === 403 ? '권한이 없습니다' : e.message}${list?.length ? ` — ${list.map((i) => `${i.path ? `${i.path}: ` : ''}${i.message ?? ''}`).join('; ')}` : ''}`);
      }
      throw e;
    }
  }

  // ---- working copies -------------------------------------------------------------------------

  private cloudIds(): string[] {
    return this.svc.store
      .list()
      .filter((p) => p.cloud)
      .map((p) => p.id);
  }

  private wc(id: string): WorkingCopy {
    return new WorkingCopy(this.svc.store.dir(id));
  }

  private link(id: string): ProjectCloudLink {
    const l = this.svc.store.require(id).cloud;
    if (!l) throw new InputError('not a cloud project');
    return l;
  }

  private api(): SyncApi {
    const get = (): CloudClient => {
      if (!this.client) throw new CloudError(0, 'NO_SERVER', 'no cloud server');
      return this.client;
    };
    return {
      project: (id) => get().project(id),
      environments: (id) => get().environments(id),
      suites: (id) => get().suites(id),
      scripts: (id) => get().scripts(id),
      script: (id, path) => get().script(id, path),
      putScript: (id, path, body) => get().putScript(id, path, body),
    };
  }

  /** The project's sync engine (one per working copy). */
  sync(id: string): ProjectSync {
    let s = this.syncs.get(id);
    if (s) return s;
    s = new ProjectSync(this.wc(id), this.api(), this.makeHost(id), this.o.now);
    this.syncs.set(id, s);
    return s;
  }

  private makeHost(id: string): SyncHost {
    return {
      readLocal: (p) => this.svc.readLocalScript(id, p),
      writeLocal: (p, t) => this.svc.writeLocalScript(id, p, t),
      deleteLocal: (p) => this.svc.deleteLocalScript(id, p),
      renameLocal: (a, b) => this.svc.renameLocalScript(id, a, b),
      listLocal: () => this.svc.listLocalScripts(id),
      snapshotChanged: (snap) => this.applySnapshot(id, snap),
      notice: (n) => this.notice(id, n),
      changed: () => {
        this.o.events?.scriptsChanged?.(id);
        this.o.events?.projectsChanged?.();
        this.emitStatus();
      },
      offline: (e) => this.markOffline(e),
      authLost: () => this.authLost(),
      myUserId: () => this.account.user?.id,
      runEvent: (kind, data) => this.runs.onFeed(id, kind, data),
    };
  }

  private notice(id: string, n: SyncNotice): void {
    const msg =
      n.kind === 'remote-saved'
        ? `${n.path}: 다른 사람이 저장함 (버전 ${n.version}${n.by ? ` · ${n.by}` : ''})${n.pending ? ' — 보내기 대기 중인 내 저장이 있어 충돌할 수 있습니다' : ''}`
        : n.kind === 'conflict'
          ? `${n.path}: 충돌 — 서버에 더 새로운 버전이 있습니다. 충돌 화면에서 고르세요`
          : n.kind === 'rejected'
            ? `${n.path}: 클라우드가 저장을 거절함 — ${n.error}`
            : n.kind === 'sent'
              ? `보내기 대기 ${n.count}건을 클라우드에 보냈습니다`
              : '클라우드에서 전체를 다시 받았습니다';
    this.o.events?.notice?.({ projectId: id, kind: n.kind, ...('path' in n ? { path: n.path } : {}), ...('version' in n ? { version: n.version } : {}), ...('by' in n && n.by ? { by: n.by } : {}), message: msg });
    if (n.kind === 'remote-saved') this.svc.log(id, 'script.changed', 'user', `클라우드: ${msg}`, { script: n.path });
  }

  /** Server settings changed → rebuild the project from the snapshot (keeping this PC's preferences). */
  private applySnapshot(id: string, snap: CloudSnapshot): void {
    const existing = this.svc.store.get(id);
    const link = existing?.cloud ?? this.pendingLinks.get(id);
    if (!link) return;
    const now = (this.o.now?.() ?? new Date()).toISOString();
    const p = snap.project;
    const envId = (u: string | null | undefined): string | undefined => (u ? compactId(u) : undefined);
    const project: Project = {
      id,
      name: p.name,
      description: p.description ?? '',
      ...(envId(p.defaultEnvironmentId) ? { defaultEnvId: envId(p.defaultEnvironmentId)! } : {}),
      browser: { engine: p.browser?.engine ?? 'chromium', ...(p.browser?.device ? { device: p.browser.device } : {}), headless: existing?.browser.headless ?? true },
      pinned: existing?.pinned ?? false,
      createdAt: existing?.createdAt ?? now,
      lastOpenedAt: existing?.lastOpenedAt ?? now,
      environments: snap.environments.map((e) => ({ id: compactId(e.id), name: e.name, baseUrl: e.baseUrl, vars: { ...e.vars }, secretNames: this.svc.vault.names(id, compactId(e.id)) })),
      suites: snap.suites.map((s) => {
        const sid = compactId(s.id);
        const alwaysRun = [...new Set(s.scripts.filter((x) => typeof x.path === 'string' && s.alwaysRun?.includes(x.id)).map((x) => x.path!))];
        return {
          id: sid,
          name: s.name,
          scripts: s.scripts.map((x) => x.path).filter((x): x is string => typeof x === 'string'),
          ...(envId(s.defaultEnvironmentId) ? { envId: envId(s.defaultEnvironmentId)! } : {}),
          stopOnFailure: existing?.suites.find((x) => x.id === sid)?.stopOnFailure ?? false,
          ...(alwaysRun.length ? { alwaysRun } : {}),
        };
      }),
      cloud: link,
    };
    this.svc.store.putCloud(project, this.svc.store.isCloud(id) ? this.svc.store.dir(id) : this.svc.store.cloudDir(link.serverId, link.projectId));
    this.pendingLinks.delete(id);
    this.o.events?.projectsChanged?.();
  }

  /** Links of working copies whose first snapshot is being fetched. */
  private readonly pendingLinks = new Map<string, ProjectCloudLink>();

  // ---- change feed of the open project ---------------------------------------------------------

  private startFeed(id: string): void {
    this.stopFeed();
    if (this.conn !== 'online' || this.wc(id).state().accessLost) return;
    const abort = new AbortController();
    this.feed = { id, abort };
    void this.feedLoop(id, abort.signal);
  }

  private stopFeed(): void {
    this.feed?.abort.abort();
    this.feed = undefined;
  }

  private async feedLoop(id: string, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted && this.conn === 'online' && this.client) {
      const sync = this.sync(id);
      const st = sync.wc.state();
      try {
        for await (const ev of this.client.events(st.projectId, st.lastSeq, signal)) {
          attempt = 0;
          if (ev.event === 'access_lost') return this.lockAccess(id);
          if (ev.event === 'resync' || (ev.event === 'ready' && sync.wc.state().lastSeq === null)) await sync.resync(ev.seq);
          else if (ev.event === 'change') await sync.apply(ev);
        }
      } catch (e) {
        if (signal.aborted) return;
        if (isNetworkError(e)) return this.markOffline(e);
        if (e instanceof CloudError && e.status === 401) return this.authLost();
        // 404 = gone or no longer visible to me (API_CONTRACT §6 — not told apart) → "접근 권한 없음".
        if (e instanceof CloudError && e.status === 404) return this.lockAccess(id);
        if (e instanceof CloudError && e.status === 403) {
          // My role went down: read `can` again, then keep following.
          await this.refreshAccess(id);
          if (this.wc(id).state().accessLost) return;
        }
      }
      if (signal.aborted) return;
      await sleep(Math.min(1000 * ++attempt, 5000), signal);
    }
  }

  // ---- CloudBridge (ProjectService side) ---------------------------------------------------------

  assertWritable(id: string): void {
    if (!this.account.hasToken()) throw new InputError('클라우드에 로그인해야 저장할 수 있습니다 (앱 설정 → 클라우드)');
    const st = this.wc(id).state();
    if (st.accessLost) throw new InputError('접근 권한 없음 — 이 클라우드 프로젝트를 더 볼 수 없어 저장할 수 없습니다');
    if (!allows(st, 'script.edit')) throw new InputError(allows(st, 'run.execute') ? '실행 전용 프로젝트입니다 — 스크립트를 저장할 수 없습니다' : '보기 전용 프로젝트입니다 — 스크립트를 저장할 수 없습니다');
  }

  enqueue(id: string, rel: string, content: string, origin: 'app' | 'ai_mcp' | 'external'): { ticket: number; outcome: Promise<Outcome> } {
    const sync = this.sync(id);
    const e = sync.enqueue(rel, content, origin);
    const outcome = sync.push(e.ticket, this.online);
    this.emitStatus();
    return { ticket: e.ticket, outcome };
  }

  async aiConflict(id: string, ticket: number, rel: string): Promise<string> {
    const e = this.wc(id).pending().find((x) => x.ticket === ticket);
    const server = e?.server;
    await this.sync(id).dropForAi(ticket);
    const who = server ? `버전 ${server.version}${server.author ? `, ${server.author}` : ''}` : '삭제됨';
    this.o.events?.notice?.({ projectId: id, kind: 'ai-conflict', path: rel, ...(server ? { version: server.version } : {}), message: `AI 저장 충돌: ${rel} 이 서버에서 바뀌어(${who}) AI 의 저장을 보내지 않았습니다. 서버 최신을 받았고 AI 에게 다시 읽도록 알렸습니다.` });
    return `conflict: ${rel} was changed on the euta cloud server (${who}) — your save was NOT stored. The working copy now holds the latest server version: read it again with read_file and re-apply the requested change, then save_script again. (충돌 — 최신을 다시 읽으세요)`;
  }

  aiStale(id: string, rel: string, readVersion: number | undefined): string | undefined {
    const base = this.scriptBase(id, rel);
    if (!base || base.version === readVersion) return undefined;
    const who = `버전 ${base.version}${base.author ? `, ${base.author}` : ''}`;
    this.o.events?.notice?.({ projectId: id, kind: 'ai-conflict', path: rel, version: base.version, message: `AI 저장 충돌: ${rel} 이 AI 가 읽은 뒤 서버에서 바뀌어(${who}) AI 의 저장을 하지 않았습니다. AI 에게 최신을 다시 읽도록 알렸습니다.` });
    return `conflict: ${rel} was changed on the euta cloud server after you read it (${who}) — your save was NOT stored. Read the latest with read_file, re-apply the requested change, then save_script again. (충돌 — 최신을 다시 읽으세요)`;
  }

  projectView(id: string): ProjectCloudView | undefined {
    const p = this.svc.store.get(id);
    if (!p?.cloud) return undefined;
    const wc = this.wc(id);
    const st = wc.state();
    const snap = wc.snapshot();
    const pending = wc.pending();
    const blocked = pending.find((e) => e.status !== 'queued');
    return {
      serverUrl: p.cloud.serverUrl,
      projectId: p.cloud.projectId,
      role: st.role,
      can: st.can,
      readOnly: !allows(st, 'script.edit') || !!st.accessLost,
      canRun: allows(st, 'run.execute') && !st.accessLost,
      canUpload: allows(st, 'run.upload') && !st.accessLost,
      canRequestAccess: st.can.includes('access.request') && !st.accessLost,
      ...(st.accessLost ? { accessLost: st.accessLost } : {}),
      ...(snap?.project.visibility ? { visibility: snap.project.visibility } : {}),
      ...(snap?.project.birth ? { birth: { origin: snap.project.birth.origin, ...(snap.project.birth.createdBy ? { createdBy: snap.project.birth.createdBy.name } : {}), createdAt: snap.project.birth.createdAt } } : {}),
      online: this.online && p.cloud.serverUrl === this.account.serverUrl,
      needsLogin: !this.account.hasToken() || this.conn === 'login_required' || p.cloud.serverUrl !== this.account.serverUrl,
      pending: pending.length,
      testRules: snap?.project.testRules ?? '',
      ...(blocked ? { blocked: this.conflictView(id, blocked) } : {}),
    };
  }

  envExtra(id: string, envId: string): EnvironmentView['cloud'] {
    const e = this.wc(id)
      .snapshot()
      ?.environments.find((x) => compactId(x.id) === envId);
    return e ? { credentialNames: [...e.credentialNames], allowedDomains: [...e.allowedDomains], cloudRunnable: e.cloudRunnable, ...(e.addressCheck?.reason ? { addressReason: e.addressCheck.reason } : {}) } : undefined;
  }

  summary(id: string): ProjectSummary['cloud'] {
    const wc = this.wc(id);
    const pending = wc.pending();
    const st = wc.state();
    return { role: st.role, pending: pending.length, blocked: pending.some((e) => e.status !== 'queued'), ...(st.accessLost ? { accessLost: true } : {}) };
  }

  scriptExtras(id: string): Record<string, NonNullable<ScriptEntry['cloud']>> {
    const wc = this.wc(id);
    const st = wc.state();
    const out: Record<string, NonNullable<ScriptEntry['cloud']>> = {};
    for (const [path, b] of Object.entries(st.scripts)) out[path] = { version: b.version, ...(b.author ? { author: b.author } : {}), pending: false };
    for (const e of wc.pending()) {
      const cur = out[e.path] ?? { pending: false };
      out[e.path] = { ...cur, pending: true, ...(e.status !== 'queued' && !cur.blocked ? { blocked: e.status } : {}) };
    }
    for (const [path, r] of Object.entries(st.remoteNewer)) if (out[path]) out[path] = { ...out[path], remoteNewer: r.version };
    return out;
  }

  scriptBase(id: string, rel: string): { id: string; version: number; hash: string; author?: string } | undefined {
    return this.wc(id).state().scripts[rel];
  }

  opened(id: string): void {
    if (!this.online || this.svc.store.get(id)?.cloud?.serverUrl !== this.account.serverUrl) return;
    if (this.feed?.id !== id) void this.openFollow(id);
    else void this.sync(id).drain().catch(() => undefined);
  }

  /**
   * Opening a cloud project (or reconnecting with it open): read the project again — my role / `can`
   * change shows at once, a 404 locks it as "접근 권한 없음", a 200 lifts that lock — then follow
   * its feed, seed the cloud runs and send what waited.
   */
  private async openFollow(id: string): Promise<void> {
    await this.refreshAccess(id);
    if (!this.online || this.svc.current() !== id || this.wc(id).state().accessLost) return;
    if (this.feed?.id !== id) {
      this.startFeed(id);
      void this.runs.seed(id).catch(() => undefined);
    }
    void this.sync(id).drain().catch(() => undefined);
  }

  /** GET the project (+ environments, suites) again; 404 → lock. Network trouble is left to the caller. */
  async refreshAccess(id: string): Promise<void> {
    if (!this.online || !this.svc.store.get(id)?.cloud) return;
    const was = this.wc(id).state();
    try {
      await this.sync(id).refreshSnapshot();
    } catch (e) {
      if (e instanceof CloudError && e.status === 404) this.lockAccess(id);
      else if (isNetworkError(e)) this.markOffline(e);
      else if (e instanceof CloudError && e.status === 401) this.authLost();
      return;
    }
    const now = this.wc(id).state();
    if (was.accessLost && !now.accessLost) {
      this.o.events?.notice?.({ projectId: id, kind: 'access', message: '이 클라우드 프로젝트에 다시 접근할 수 있습니다 — 잠금이 풀렸습니다' });
      this.emitStatus();
    } else if (was.role !== now.role) {
      this.o.events?.notice?.({ projectId: id, kind: 'access', message: `내 역할이 바뀌었습니다: ${ROLE_NAME[was.role] ?? was.role} → ${ROLE_NAME[now.role] ?? now.role}` });
    }
    this.o.events?.projectsChanged?.();
  }

  /** "접근 권한 없음" (SPEC 권한 변화 반영): stop following; only this PC's runs stay readable. */
  private lockAccess(id: string): void {
    const wc = this.wc(id);
    if (!wc.exists()) return;
    const already = !!wc.state().accessLost;
    if (!already) wc.update((s) => (s.accessLost = { at: (this.o.now?.() ?? new Date()).toISOString() }));
    if (this.feed?.id === id) this.stopFeed();
    if (!already) {
      this.svc.log(id, 'settings.changed', 'user', '클라우드: 접근 권한 없음 — 내보내졌거나 구성원만 공개로 바뀌었거나 삭제되었습니다. 이 PC 실행 기록만 볼 수 있습니다.');
      this.o.events?.notice?.({ projectId: id, kind: 'access', message: '접근 권한 없음 — 이 클라우드 프로젝트를 더 볼 수 없습니다. 이 PC 의 실행 기록만 남아 있습니다.' });
    }
    this.o.events?.projectsChanged?.();
    this.emitStatus();
  }

  removed(id: string): void {
    if (this.feed?.id === id) this.stopFeed();
    this.syncs.delete(id);
  }

  // ---- conflicts --------------------------------------------------------------------------------

  private copyPathFor(id: string, path: string): string {
    const ext = extname(path) || '.yaml';
    const stem = path.slice(0, -ext.length);
    const taken = new Set([...this.svc.listLocalScripts(id), ...Object.keys(this.wc(id).state().scripts)]);
    const base = `${stem}-${nameSlug(this.account.user?.name)}`;
    for (let i = 1; i < 1000; i++) {
      const cand = cleanScriptPath(`${base}${i === 1 ? '' : `-${i}`}${ext}`);
      if (!taken.has(cand)) return cand;
    }
    throw new InputError('too many copies');
  }

  conflictView(id: string, e: PendingEntry): CloudConflictView {
    const before = e.server ? (parseScript(e.server.source) ?? {}) : undefined;
    const d = diffScripts(before, parseScript(e.source) ?? {});
    return {
      projectId: id,
      ticket: e.ticket,
      path: e.path,
      status: e.status === 'rejected' ? 'rejected' : 'conflict',
      origin: ORIGIN_LABEL[e.origin] ?? e.origin,
      mine: e.source,
      server: e.server ?? null,
      ...(e.error ? { error: e.error } : {}),
      rows: d.rows,
      header: d.header,
      summary: d.summary,
      copyPath: this.copyPathFor(id, e.path),
      laterSaves: laterSaves(this.wc(id).pending(), e),
    };
  }

  async resolveConflict(id: string, ticket: number, choice: CloudConflictChoice): Promise<ProjectView> {
    if (!this.online) throw new InputError('오프라인 — 다시 연결된 뒤에 충돌을 해결할 수 있습니다');
    const e = this.wc(id).pending().find((x) => x.ticket === ticket);
    if (!e) throw new InputError('이 충돌은 이미 해결되었습니다');
    const copyPath = choice === 'copy' ? this.copyPathFor(id, e.path) : undefined;
    try {
      await this.sync(id).resolve(ticket, choice, copyPath);
    } catch (err) {
      if (isNetworkError(err)) throw new InputError('클라우드에 연결할 수 없습니다 — 오프라인으로 전환합니다');
      if (err instanceof CloudError) throw new InputError(err.message);
      throw err;
    }
    this.svc.log(id, 'script.changed', 'user', `충돌 해결: ${e.path} — ${choice === 'mine' ? '내 것으로 새 버전' : choice === 'theirs' ? '서버 것 받기' : `내 것을 사본(${copyPath})으로`}`, { script: copyPath ?? e.path });
    this.emitStatus();
    return this.svc.view(id);
  }

  // ---- script editor / history (cloud projects) ---------------------------------------------------

  /** [저장] in the editor: the server answer decides — saved, waiting (offline), or the conflict screen. */
  async saveScript(id: string, rel: string, baseText: string, edit: ScriptEditPayload, envId?: string): Promise<ScriptSaveResult> {
    const check = this.svc.checkDraft(id, baseText, edit, envId);
    if (check.issues.length) return { ok: false, issues: check.issues };
    const text = this.svc.renderEdit(baseText, edit);
    const clean = this.svc.library(id).rel(this.svc.library(id).abs(rel)) ?? rel;
    const disk = this.svc.readLocalScript(id, clean);
    if (disk !== undefined && scriptHash(disk) !== scriptHash(baseText)) return this.editorConflict(id, clean, text, disk);
    const r = this.svc.writeScript(id, clean, text, 'user', { baseHash: scriptHash(baseText) });
    if (r.conflict) return this.editorConflict(id, clean, text, this.svc.readLocalScript(id, clean) ?? '');
    if (!r.cloud) return { ok: true, path: r.path, hash: r.hash };
    const out = await r.cloud.outcome;
    if (out.kind === 'saved') {
      return { ok: true, path: r.path, hash: r.hash, version: { version: out.version, at: new Date().toISOString(), actor: 'user', kind: 'save', path: r.path, hash: r.hash, summary: changeSummary(baseText, text), ...(this.account.user ? { author: this.account.user.name } : {}) } };
    }
    if (out.kind === 'queued') return { ok: true, path: r.path, hash: r.hash, pending: true };
    if (out.kind === 'conflict') return { ok: false, issues: [], cloudConflict: this.conflictView(id, out.entry) };
    return { ok: false, issues: [{ path: '', message: `클라우드가 저장을 거절했습니다: ${out.error}` }] };
  }

  /** The working copy changed under the editor (someone else's save arrived) → the same 3-choice screen. */
  private editorConflict(id: string, rel: string, mine: string, current: string): ScriptSaveResult {
    this.assertWritable(id);
    const wc = this.wc(id);
    const base = wc.state().scripts[rel];
    const e = wc.enqueue({ path: rel, baseVersion: base?.version ?? null, origin: 'app', source: mine, status: 'conflict', server: base ? { version: base.version, source: current, ...(base.author ? { author: base.author } : {}) } : null }, this.o.now?.());
    this.o.events?.scriptsChanged?.(id);
    this.emitStatus();
    return { ok: false, issues: [], cloudConflict: this.conflictView(id, e) };
  }

  private pathOfKey(id: string, key: string): string {
    const st = this.wc(id).state();
    const hit = Object.entries(st.scripts).find(([, b]) => b.id === key)?.[0];
    if (!hit) throw new InputError('script not found');
    return hit;
  }

  private versionView(dto: ScriptVersionDto, path: string, first: number): ScriptVersionView {
    return {
      version: dto.version,
      at: dto.createdAt,
      actor: ORIGIN_ACTOR[dto.origin] ?? 'user',
      kind: dto.origin === 'revert' ? 'restore' : dto.origin === 'external' ? 'external' : dto.version === first ? 'create' : 'save',
      path,
      hash: dto.contentHash,
      summary: [dto.memo, dto.validation && !dto.validation.ok ? '검증 오류' : ''].filter(Boolean).join(' · '),
      ...(dto.author ? { author: dto.author.name } : {}),
      origin: ORIGIN_LABEL[dto.origin] ?? dto.origin,
    };
  }

  /** Server history of a script (SPEC "이력·비교·되돌리기 화면은 서버 이력"). */
  async scriptVersions(id: string, rel: string): Promise<ScriptHistoryView> {
    const base = this.scriptBase(id, rel);
    if (!base) return { path: rel, versions: [] };
    const pid = this.link(id).projectId;
    const list = await this.call((c) => c.versions(pid, rel));
    const first = Math.min(...list.map((v) => v.version));
    return { key: base.id, path: rel, versions: list.map((v) => this.versionView(v, rel, first)).sort((a, b) => a.version - b.version) };
  }

  private async versionSource(id: string, path: string, scriptId: string, n: number): Promise<ScriptVersionDto> {
    const k = `${scriptId}:${n}`;
    const hit = this.versionCache.get(k);
    if (hit) return hit;
    const pid = this.link(id).projectId;
    const v = await this.call((c) => c.version(pid, path, n));
    this.versionCache.set(k, v);
    return v;
  }

  async compareVersions(id: string, key: string, to: number, from?: number): Promise<ScriptCompareView> {
    const path = this.pathOfKey(id, key);
    const pid = this.link(id).projectId;
    const list = (await this.call((c) => c.versions(pid, path))).sort((a, b) => a.version - b.version);
    const first = list[0]?.version ?? 1;
    const target = list.find((v) => v.version === to);
    if (!target) throw new InputError('version not found');
    const baseDto = from !== undefined ? list.find((v) => v.version === from) : [...list].reverse().find((v) => v.version < to);
    const after = (await this.versionSource(id, path, key, to)).source ?? '';
    const before = baseDto ? (await this.versionSource(id, path, key, baseDto.version)).source : undefined;
    const d = diffScripts(before === undefined ? undefined : (parseScript(before) ?? {}), parseScript(after) ?? {});
    return { key, ...(baseDto ? { from: this.versionView(baseDto, path, first) } : {}), to: { ...this.versionView(target, path, first), summary: d.summary }, rows: d.rows, header: d.header, summary: d.summary };
  }

  /** "이 버전으로 되돌리기" = server revert (a new version), then the working copy follows. */
  async restoreVersion(id: string, key: string, version: number): Promise<{ path: string }> {
    const path = this.pathOfKey(id, key);
    this.assertWritable(id);
    if (this.wc(id).hasPending(path)) throw new InputError('보내기 대기 중인 저장이 있어 되돌릴 수 없습니다 — 먼저 보내거나 충돌을 해결하세요');
    const pid = this.link(id).projectId;
    const base = this.scriptBase(id, path)?.version;
    await this.call((c) => c.revertScript(pid, path, version, base));
    await this.pull(id, path);
    this.svc.log(id, 'script.restored', 'user', `스크립트 되돌리기 (클라우드): ${path} → 버전 ${version}`, { script: path });
    return { path };
  }

  /** Bring one script from the server into the working copy. */
  private async pull(id: string, path: string): Promise<void> {
    const sync = this.sync(id);
    const pid = this.link(id).projectId;
    const s = await this.call((c) => c.script(pid, path));
    await sync.run(async () => {
      const local = this.svc.readLocalScript(id, path);
      if (local === undefined || scriptHash(local) !== s.contentHash) this.svc.writeLocalScript(id, path, s.source);
      sync.wc.update((st) => {
        st.scripts[path] = { id: s.id, version: s.version, hash: s.contentHash, ...(s.updatedBy?.name ? { author: s.updatedBy.name } : {}) };
        delete st.remoteNewer[path];
      });
    });
    this.o.events?.scriptsChanged?.(id);
  }

  async deletedScripts(id: string): Promise<DeletedScript[]> {
    if (!this.online) return [];
    const pid = this.link(id).projectId;
    try {
      const list = await this.call((c) => c.scripts(pid, true));
      for (const s of list) this.deletedKeys.set(s.id, s.path);
      return list.map((s) => ({ key: s.id, path: s.path, at: s.deletedAt ?? s.updatedAt }));
    } catch {
      return [];
    }
  }

  async undeleteScript(id: string, key: string): Promise<string> {
    this.assertWritable(id);
    const path = this.deletedKeys.get(key);
    if (!path) throw new InputError('deleted script not found');
    const pid = this.link(id).projectId;
    await this.call((c) => c.restoreScript(pid, path));
    await this.pull(id, path);
    this.svc.log(id, 'script.restored', 'user', `삭제된 스크립트 복원 (클라우드): ${path}`, { script: path });
    return path;
  }

  async renameScript(id: string, from: string, to: string): Promise<string> {
    this.assertWritable(id);
    const toClean = cleanScriptPath(to);
    const wc = this.wc(id);
    if (wc.hasPending(from)) throw new InputError('보내기 대기 중인 저장이 있어 이름을 바꿀 수 없습니다 — 먼저 보내세요');
    if (this.svc.readLocalScript(id, toClean) !== undefined) throw new InputError('a script with that name already exists');
    const pid = this.link(id).projectId;
    await this.call((c) => c.renameScript(pid, from, toClean));
    await this.sync(id).run(async () => {
      this.svc.renameLocalScript(id, from, toClean);
      wc.update((st) => {
        if (st.scripts[from]) st.scripts[toClean] = st.scripts[from]!;
        delete st.scripts[from];
      });
    });
    this.svc.log(id, 'script.renamed', 'user', `스크립트 이름 변경 (클라우드): ${from} → ${toClean}`, { script: toClean });
    return toClean;
  }

  async deleteScript(id: string, rel: string): Promise<void> {
    this.assertWritable(id);
    const wc = this.wc(id);
    if (wc.hasPending(rel)) throw new InputError('보내기 대기 중인 저장이 있어 삭제할 수 없습니다 — 먼저 보내세요');
    const pid = this.link(id).projectId;
    if (wc.state().scripts[rel]) await this.call((c) => c.deleteScript(pid, rel));
    await this.sync(id).run(async () => {
      this.svc.deleteLocalScript(id, rel);
      wc.update((st) => delete st.scripts[rel]);
    });
    this.svc.log(id, 'script.deleted', 'user', `스크립트 삭제 (클라우드, 30일 안에 복원 가능): ${rel}`, { script: rel });
  }

  // ---- cloud projects: find · open · upload ---------------------------------------------------------

  /** Create (or reuse) the working copy of a cloud project; the scripts arrive when it is opened. */
  async openRemote(cloudProjectId: string): Promise<string> {
    const id = compactId(cloudProjectId);
    if (this.svc.store.get(id)?.cloud) return id;
    if (this.svc.store.get(id)) throw new InputError('id collision with a local project');
    const serverUrl = this.account.serverUrl;
    const link: ProjectCloudLink = { serverUrl, serverId: this.account.serverId, projectId: cloudProjectId };
    const dir = this.svc.store.cloudDir(link.serverId, cloudProjectId);
    const wc = new WorkingCopy(dir);
    if (!wc.exists()) wc.saveState({ schema: 1, serverUrl, projectId: cloudProjectId, lastSeq: null, role: 'viewer', can: [], scripts: {}, remoteNewer: {}, nextTicket: 1 });
    this.pendingLinks.set(id, link);
    // Not registered in the store yet: the first snapshot registers it (applySnapshot).
    this.syncs.set(id, new ProjectSync(wc, this.api(), this.makeHost(id), this.o.now));
    try {
      await this.call(() => this.sync(id).refreshSnapshot());
    } finally {
      this.pendingLinks.delete(id);
    }
    if (!this.svc.store.get(id)) throw new InputError('클라우드 프로젝트를 받지 못했습니다');
    return id;
  }

  // ---- [클라우드에서 받기] · 권한 요청 (SPEC 프로젝트 종류, API_CONTRACT §3·4) ---------------------

  private receiveItem(p: ReceivableProjectDto): CloudProjectItem {
    const localId = compactId(p.id);
    return {
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      role: p.myRole,
      ...(this.svc.store.get(localId)?.cloud ? { localId } : {}),
      ...(p.createdBy?.name ? { createdBy: p.createdBy.name } : {}),
      origin: p.origin,
      visibility: p.visibility,
      lastRun: p.lastRun ? { status: p.lastRun.status, flaky: p.lastRun.flaky, at: p.lastRun.finishedAt ?? p.lastRun.queuedAt } : null,
      canRequestAccess: p.canRequestAccess,
      openRequest: p.openRequest ? { role: p.openRequest.role, createdAt: p.openRequest.createdAt } : null,
    };
  }

  /** "내 프로젝트" (I am a member) / "조직 공개" (보기). Older servers (no `/receivable`): split by role. */
  async receiveList(): Promise<CloudReceiveList> {
    try {
      const r = await this.call((c) => c.receivable(), true);
      return { mine: r.mine.map((p) => this.receiveItem(p)), org: r.org.map((p) => this.receiveItem(p)) };
    } catch (e) {
      if (!(e instanceof CloudError)) throw e;
      if (e.status !== 404) throw new InputError(e.message);
    }
    const all = await this.call((c) => c.projects('all'));
    const item = (p: ProjectDto): CloudProjectItem => ({ id: p.id, name: p.name, description: p.description ?? '', role: p.myRole, ...(this.svc.store.get(compactId(p.id))?.cloud ? { localId: compactId(p.id) } : {}) });
    return { mine: all.filter((p) => p.myRole !== 'viewer').map(item), org: all.filter((p) => p.myRole === 'viewer').map(item) };
  }

  private cloudUuid(idOrUuid: string): string {
    return /^[0-9a-f]{32}$/.test(idOrUuid) ? expandId(idOrUuid) : idOrUuid;
  }

  /** [권한 요청]: 편집자 / 실행자 + memo (≤ 200). `project` = app id of a working copy or a cloud UUID. */
  async requestAccess(project: string, role: 'editor' | 'runner', memo: string): Promise<{ role: 'editor' | 'runner'; createdAt: string }> {
    if (role !== 'editor' && role !== 'runner') throw new InputError('요청할 역할은 편집자 또는 실행자입니다');
    const pid = this.cloudUuid(project);
    try {
      const r = await this.call((c) => c.requestAccess(pid, role, memo.trim().slice(0, 200)), true);
      this.o.events?.projectsChanged?.();
      return { role: r.role, createdAt: r.createdAt };
    } catch (e) {
      if (!(e instanceof CloudError)) throw e;
      throw new InputError(
        e.code === 'REQUEST_OPEN'
          ? '이미 권한을 요청했습니다 — 소유자가 답할 때까지 기다리세요 (요청 중)'
          : e.code === 'ALREADY_HAS_ROLE'
            ? '이미 그 역할 이상입니다 — 더 높은 역할만 요청할 수 있습니다'
            : e.status === 404
              ? '이 클라우드 프로젝트를 볼 수 없습니다'
              : e.status === 403
                ? '권한을 요청할 수 없습니다 (소유자이거나 읽기 전용 토큰)'
                : e.message,
      );
    }
  }

  /** My open request on a working copy (the header "요청 중" state), or null. */
  async myOpenRequest(id: string): Promise<{ role: 'editor' | 'runner'; createdAt: string } | null> {
    if (!this.online) return null;
    const me = this.account.user?.id;
    const pid = this.link(id).projectId;
    try {
      const list = await this.call((c) => c.accessRequests(pid, 'open'), true);
      const r = list.find((x) => x.status === 'open' && (!me || x.user.id === me));
      return r ? { role: r.role, createdAt: r.createdAt } : null;
    } catch {
      return null;
    }
  }

  /** Owner: open access requests of the project (구성원). */
  async accessRequests(id: string): Promise<CloudAccessRequestView[]> {
    const pid = this.link(id).projectId;
    return (await this.call((c) => c.accessRequests(pid, 'open'))).map((r) => ({ id: r.id, user: r.user, role: r.role, memo: r.memo, status: r.status, createdAt: r.createdAt }));
  }

  async decideAccess(id: string, requestId: string, approve: boolean, role?: CloudRole): Promise<CloudAccessRequestView[]> {
    const pid = this.link(id).projectId;
    try {
      await this.call((c) => (approve ? c.approveAccess(pid, requestId, role) : c.rejectAccess(pid, requestId)), true);
    } catch (e) {
      if (!(e instanceof CloudError)) throw e;
      if (e.code !== 'REQUEST_CLOSED') throw new InputError(e.status === 403 ? '권한 요청은 소유자만 처리합니다' : e.message);
      // Already decided / expired elsewhere: just show the fresh list.
    }
    return this.accessRequests(id);
  }

  // ---- 올리기 = 전환 (SPEC "로컬 프로젝트를 클라우드로 올리기 — 전환") -----------------------------------

  /** What the conversion sends and moves (confirmation dialog) — no server call. */
  convertPreview(localId: string): CloudConvertPreview {
    const p = this.svc.store.require(localId);
    const dir = this.svc.store.dir(localId);
    const count = (sub: string, f: (n: string) => boolean = () => true) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter(f).length : 0);
    const view = this.svc.view(localId);
    return {
      scripts: this.svc.listLocalScripts(localId).length,
      environments: p.environments.filter((e) => e.baseUrl).map((e) => e.name),
      skippedEnvs: p.environments.filter((e) => !e.baseUrl).map((e) => e.name),
      suites: p.suites.length,
      credentialNames: [...new Set(view.environments.filter((e) => e.baseUrl).flatMap((e) => e.secretNames))].sort(),
      runs: countRuns(join(dir, 'runs')),
      suiteRuns: count('suite-runs', (n) => n.endsWith('.json')),
      chats: count('chats', (n) => n.endsWith('.json') || n.endsWith('.jsonl')),
      recordings: count('recordings'),
    };
  }

  /** Environments by name on the server: reuse (resumed conversion / merge) or create. */
  private async pushEnvs(localId: string, pid: string, o: { createMissing: boolean }): Promise<{ envMap: Map<string, string>; skippedEnvs: string[]; credentialNames: string[]; created: number }> {
    const p = this.svc.store.require(localId);
    const onServer = await this.call((c) => c.environments(pid));
    const envMap = new Map<string, string>();
    const skippedEnvs: string[] = [];
    const credentialNames = new Set<string>();
    let created = 0;
    for (const env of p.environments) {
      const hit = onServer.find((e) => e.name === env.name);
      if (hit) envMap.set(env.id, hit.id);
      else if (!env.baseUrl || !o.createMissing) {
        if (!env.baseUrl) skippedEnvs.push(env.name);
        continue;
      } else {
        const e = await this.call((c) => c.createEnvironment(pid, { name: env.name, baseUrl: env.baseUrl, vars: env.vars, makeDefault: env.id === p.defaultEnvId && !onServer.length }));
        envMap.set(env.id, e.id);
        created++;
      }
      for (const n of this.svc.view(localId).environments.find((x) => x.id === env.id)?.secretNames ?? []) credentialNames.add(n);
    }
    return { envMap, skippedEnvs, credentialNames: [...credentialNames].sort(), created };
  }

  /** PUT one script; an invalid one is kept as an "앱 바깥 변경" version (검증 오류 on the server) rather than dropped. */
  private async putScriptKeep(pid: string, path: string, source: string, baseVersion: number | null): Promise<{ id: string; flagged: boolean }> {
    try {
      const r = await this.call((c) => c.putScript(pid, path, { source, baseVersion, origin: 'app' }));
      return { id: r.script.id, flagged: false };
    } catch (e) {
      if (!/did not pass validation/.test((e as Error).message)) throw e;
      const r = await this.call((c) => c.putScript(pid, path, { source, baseVersion, origin: 'external', memo: '올리기 — 검증 오류' }));
      return { id: r.script.id, flagged: true };
    }
  }

  private suiteBody(s: Suite, ids: Map<string, string>, envMap: Map<string, string>): Record<string, unknown> {
    const toIds = (paths: string[]) => paths.map((x) => ids.get(x)).filter((x): x is string => !!x);
    return { name: s.name, scriptIds: toIds(s.scripts), alwaysRun: [...new Set(toIds(s.alwaysRun ?? []))], defaultEnvironmentId: (s.envId && envMap.get(s.envId)) || null };
  }

  /**
   * The local phase of 전환 / 합치기 — synchronous, so no IPC sees a half-moved project: this PC's data
   * moves into the working copy, this PC's test credential values move to the cloud environment keys,
   * the working copy takes the local project's place in the sidebar and the local entry is removed.
   */
  private adopt(localId: string, wcId: string, envMap: Map<string, string>, suiteMap: Record<string, string>, o: { withScripts: boolean; keepExistingValues: boolean }): number {
    const p = this.svc.store.require(localId);
    const envs: Record<string, string> = {};
    for (const [l, c] of envMap) envs[l] = compactId(c);
    const { runs } = moveLocalData(this.svc.store.dir(localId), this.svc.store.dir(wcId), { fromProjectId: localId, toProjectId: wcId, envs, suites: suiteMap }, { withScripts: o.withScripts });
    for (const [l, c] of Object.entries(envs)) if (!p.environments.find((e) => e.id === l)?.secretsFile) this.svc.vault.moveEnv(localId, l, wcId, c, !o.keepExistingValues);
    for (const e of this.svc.store.require(wcId).environments) this.svc.store.setSecretNames(wcId, e.id, this.svc.vault.names(wcId, e.id));
    this.svc.converted(localId, wcId);
    return runs;
  }

  /**
   * "클라우드로 올리기" = 전환: settings · environments (no test credential values) · current scripts ·
   * test sets go to a new cloud project born from this local project (`origin: app`), then this PC's
   * runs · test set runs · reports · baselines · chats · recordings · activity move into its working
   * copy and the local entry is replaced by it (one project in the sidebar). A failure before the move
   * leaves the local project as it was; trying again resumes the same server project.
   */
  async upload(localId: string): Promise<CloudConvertResult> {
    const p = this.svc.store.require(localId);
    if (p.cloud) throw new InputError('이미 클라우드 프로젝트입니다');
    if (p.uploadedTo) throw new InputError('예전에 올린 적이 있는 프로젝트입니다 — 위쪽의 [클라우드 프로젝트와 합치기]를 쓰세요');
    const blocker = this.svc.deleteBlocker(localId);
    if (blocker) throw new InputError(`지금은 올릴 수 없습니다 — ${blocker}`);
    const created = await this.call((c) => c.createProject({ name: p.name, description: p.description.slice(0, 500), browser: { engine: p.browser.engine, ...(p.browser.device ? { device: p.browser.device } : {}) }, origin: 'app', originLocalId: localId }));
    const pid = created.id;
    const { envMap, skippedEnvs, credentialNames } = await this.pushEnvs(localId, pid, { createMissing: true });
    const onServer = new Map((await this.call((c) => c.scripts(pid))).map((s) => [s.path, s] as const));
    const scriptIds = new Map<string, string>();
    const flaggedScripts: string[] = [];
    for (const path of this.svc.listLocalScripts(localId)) {
      const source = this.svc.readLocalScript(localId, path);
      if (source === undefined) continue;
      const hit = onServer.get(path);
      if (hit && hit.contentHash === scriptHash(source)) {
        scriptIds.set(path, hit.id); // resumed: already there
        continue;
      }
      const r = await this.putScriptKeep(pid, path, source, hit?.version ?? null);
      scriptIds.set(path, r.id);
      if (r.flagged) flaggedScripts.push(path);
    }
    const serverSuites = await this.call((c) => c.suites(pid));
    const suiteIds = new Map<string, string>();
    for (const s of p.suites) {
      const hit = serverSuites.find((x) => x.name === s.name);
      suiteIds.set(s.id, hit ? hit.id : (await this.call((c) => c.createSuite(pid, this.suiteBody(s, scriptIds, envMap)))).id);
    }
    // Local phase. Stop the watcher / AI chat on the folder first; any failure up to the move keeps the local project.
    await this.svc.release(localId);
    let newId: string;
    try {
      newId = await this.openRemote(pid);
    } catch (e) {
      this.svc.reattach(localId);
      throw e;
    }
    const suiteMap: Record<string, string> = {};
    for (const [l, c] of suiteIds) suiteMap[l] = compactId(c);
    const movedRuns = this.adopt(localId, newId, envMap, suiteMap, { withScripts: true, keepExistingValues: false });
    // "실패 시 중단" is this PC's option (not on the server): carry it into the working copy.
    for (const s of p.suites) if (s.stopOnFailure && suiteMap[s.id] && this.svc.store.require(newId).suites.some((x) => x.id === suiteMap[s.id])) this.svc.store.upsertSuite(newId, suiteMap[s.id], { stopOnFailure: true });
    this.svc.log(newId, 'project.uploaded', 'user', `클라우드로 올림(전환): ${p.name} — 환경 ${envMap.size}개, 스크립트 ${scriptIds.size}개, 테스트 세트 ${p.suites.length}개, 이 PC 실행 ${movedRuns}건 이관${skippedEnvs.length ? ` (주소 없는 환경 제외: ${skippedEnvs.join(', ')})` : ''}`);
    this.o.events?.projectsChanged?.();
    return { localId: newId, skippedEnvs, flaggedScripts, credentialNames, movedRuns, resumed: !!created.resumed };
  }

  // ---- 합치기 (SPEC "이미 갈라진 프로젝트 합치기", API_CONTRACT §5) ---------------------------------------

  private mergeBody(p: Project): MergeBody {
    if (!p.uploadedTo) throw new InputError('클라우드로 올린 기록이 없는 프로젝트입니다');
    return { localProjectId: p.id, uploadedTo: { projectId: p.uploadedTo.projectId, localId: p.uploadedTo.localId } };
  }

  /** Korean reason for a refused merge (ORIGIN_MISMATCH · not owner · not visible). */
  private mergeRefusal(e: CloudError): string {
    const reason = (e.details as { reason?: string } | undefined)?.reason;
    if (e.code === 'ORIGIN_MISMATCH') {
      if (reason === 'web_origin') return '웹에서 만든 클라우드 프로젝트에는 로컬 프로젝트를 붙일 수 없습니다 — [클라우드에서 받기]로 받아서 쓰세요';
      if (reason === 'link_mismatch') return '이 로컬 프로젝트의 연결 기록이 그 클라우드 프로젝트와 맞지 않아 합칠 수 없습니다 — 받아서 쓰세요';
      return '이 로컬 프로젝트에서 만든 클라우드 프로젝트가 아니라 합칠 수 없습니다(다른 사람 또는 다른 로컬 프로젝트의 것) — 받아서 쓰세요';
    }
    if (e.status === 403) return '그 클라우드 프로젝트의 소유자만 합칠 수 있습니다 — 다른 사람의 프로젝트는 [클라우드에서 받기]로 받아서 쓰세요';
    if (e.status === 404) return '그 클라우드 프로젝트를 볼 수 없습니다 (삭제되었거나 접근 권한 없음)';
    return e.message;
  }

  /** Server gate (birth record · owner): whether [클라우드 프로젝트와 합치기] is offered, and why not. */
  async mergeStatus(localId: string): Promise<{ ok: boolean; message?: string; targetName?: string }> {
    const p = this.svc.store.require(localId);
    if (!p.uploadedTo) return { ok: false, message: '클라우드로 올린 기록이 없습니다' };
    if (!this.online) return { ok: false, message: '클라우드에 연결되면 합칠 수 있는지 확인합니다' };
    if (p.uploadedTo.serverUrl !== this.account.serverUrl) return { ok: false, message: `다른 서버(${p.uploadedTo.serverUrl})에 올린 프로젝트입니다` };
    const body = this.mergeBody(p);
    try {
      const r = await this.call((c) => c.mergeCheck(p.uploadedTo!.projectId, body), true);
      return { ok: true, targetName: r.project.name };
    } catch (e) {
      if (e instanceof CloudError) return { ok: false, message: this.mergeRefusal(e) };
      throw e;
    }
  }

  private async mergeGate(p: Project): Promise<void> {
    try {
      await this.call((c) => c.mergeCheck(p.uploadedTo!.projectId, this.mergeBody(p)), true);
    } catch (e) {
      if (e instanceof CloudError) throw new InputError(this.mergeRefusal(e));
      throw e;
    }
  }

  private localCopyPath(path: string, taken: Set<string>): string {
    const ext = extname(path) || '.yaml';
    const stem = path.slice(0, -ext.length);
    for (let i = 1; i < 1000; i++) {
      const cand = cleanScriptPath(`${stem}-로컬${i === 1 ? '' : `-${i}`}${ext}`);
      if (!taken.has(cand)) return cand;
    }
    throw new InputError('too many copies');
  }

  /** Compare the local project with its (fixed) cloud project: what goes up, what to pick. */
  async mergePlan(localId: string): Promise<CloudMergePlan> {
    const p = this.svc.store.require(localId);
    await this.mergeGate(p);
    const pid = p.uploadedTo!.projectId;
    const [project, scripts, suites, envs] = await Promise.all([this.call((c) => c.project(pid)), this.call((c) => c.scripts(pid)), this.call((c) => c.suites(pid)), this.call((c) => c.environments(pid))]);
    const onServer = new Map(scripts.map((s) => [s.path, s] as const));
    const local = this.svc.listLocalScripts(localId);
    const taken = new Set([...local, ...onServer.keys()]);
    const plan: CloudMergePlan = { localId, target: { projectId: pid, name: project.name }, uploadScripts: [], sameScripts: [], serverOnlyScripts: [], differ: [], suiteChoices: [], uploadSuites: [], uploadEnvs: [], runs: countRuns(join(this.svc.store.dir(localId), 'runs')) };
    for (const path of local) {
      const source = this.svc.readLocalScript(localId, path);
      if (source === undefined) continue;
      const srv = onServer.get(path);
      if (!srv) plan.uploadScripts.push(path);
      else if (srv.contentHash === scriptHash(source)) plan.sameScripts.push(path);
      else {
        const full = await this.call((c) => c.script(pid, path));
        const parsed = parseScript(source) as { name?: unknown } | undefined;
        const d = diffScripts(parseScript(full.source) ?? {}, parsed ?? {});
        const copyPath = this.localCopyPath(path, taken);
        taken.add(copyPath);
        plan.differ.push({ path, ...(typeof parsed?.name === 'string' && parsed.name ? { name: parsed.name } : {}), rows: d.rows, summary: d.summary, copyPath });
      }
    }
    plan.serverOnlyScripts = [...onServer.keys()].filter((x) => !local.includes(x));
    for (const s of p.suites) {
      const srv = suites.find((x) => x.name === s.name);
      if (!srv) plan.uploadSuites.push(s.name);
      else {
        const server = srv.scripts.map((x) => x.path).filter((x): x is string => !!x);
        if (server.join('\n') !== s.scripts.join('\n')) plan.suiteChoices.push({ name: s.name, local: [...s.scripts], server });
      }
    }
    plan.uploadEnvs = p.environments.filter((e) => e.baseUrl && !envs.some((x) => x.name === e.name)).map((e) => e.name);
    return plan;
  }

  /**
   * Merge with the chosen answers: upload what is missing / chosen, record the merge on the server,
   * then move this PC's data into the working copy and remove the local entry (one project).
   */
  async mergeApply(localId: string, choices: CloudMergeChoices): Promise<{ localId: string; movedRuns: number }> {
    const p = this.svc.store.require(localId);
    const plan = await this.mergePlan(localId);
    for (const d of plan.differ) if (!choices.scripts?.[d.path]) throw new InputError(`고르지 않은 스크립트가 있습니다: ${d.path}`);
    for (const s of plan.suiteChoices) if (!choices.suites?.[s.name]) throw new InputError(`고르지 않은 테스트 세트가 있습니다: ${s.name}`);
    const pid = plan.target.projectId;
    const wcId = compactId(pid);
    if (this.svc.store.get(wcId)?.cloud && this.wc(wcId).pending().length) throw new InputError('클라우드 작업 사본에 보내기 대기 중인 저장이 있습니다 — 먼저 보내거나 충돌을 해결한 뒤 합치세요');
    const blocker = this.svc.deleteBlocker(localId);
    if (blocker) throw new InputError(`지금은 합칠 수 없습니다 — ${blocker}`);
    const onServer = new Map((await this.call((c) => c.scripts(pid))).map((s) => [s.path, s] as const));
    let scriptsUploaded = 0;
    for (const path of plan.uploadScripts) {
      await this.putScriptKeep(pid, path, this.svc.readLocalScript(localId, path) ?? '', null);
      scriptsUploaded++;
    }
    for (const d of plan.differ) {
      const c = choices.scripts[d.path]!;
      const source = this.svc.readLocalScript(localId, d.path) ?? '';
      if (c === 'local') await this.putScriptKeep(pid, d.path, source, onServer.get(d.path)?.version ?? null);
      else if (c === 'both') await this.putScriptKeep(pid, d.copyPath, source, null);
    }
    const { envMap, created: envsCreated } = await this.pushEnvs(localId, pid, { createMissing: true });
    const ids = new Map((await this.call((c) => c.scripts(pid))).map((s) => [s.path, s.id] as const));
    const serverSuites = await this.call((c) => c.suites(pid));
    const suiteMap: Record<string, string> = {};
    let suitesUploaded = 0;
    for (const s of p.suites) {
      const hit = serverSuites.find((x) => x.name === s.name);
      if (!hit) {
        const made = await this.call((c) => c.createSuite(pid, this.suiteBody(s, ids, envMap)));
        suiteMap[s.id] = compactId(made.id);
        suitesUploaded++;
        continue;
      }
      suiteMap[s.id] = compactId(hit.id);
      if (choices.suites?.[s.name] === 'local') {
        const b = this.suiteBody(s, ids, envMap);
        await this.call((c) => c.patchSuite(pid, hit.id, { scriptIds: b.scriptIds, alwaysRun: b.alwaysRun }));
      }
    }
    try {
      await this.call((c) => c.merge(pid, { ...this.mergeBody(p), summary: { scriptsUploaded, scriptsChosen: plan.differ.length, suitesUploaded, environmentsUploaded: envsCreated, runsMoved: plan.runs } }), true);
    } catch (e) {
      if (e instanceof CloudError) throw new InputError(this.mergeRefusal(e));
      throw e;
    }
    await this.svc.release(localId);
    try {
      if (!this.svc.store.get(wcId)?.cloud) await this.openRemote(pid);
      const sync = this.sync(wcId);
      await sync.resync(sync.wc.state().lastSeq ?? 0);
    } catch (e) {
      this.svc.reattach(localId);
      throw e;
    }
    const movedRuns = this.adopt(localId, wcId, envMap, suiteMap, { withScripts: false, keepExistingValues: true });
    this.svc.log(wcId, 'project.uploaded', 'user', `로컬 프로젝트 "${p.name}" 과 합침 — 올린 스크립트 ${scriptsUploaded}개, 고른 스크립트 ${plan.differ.length}개, 테스트 세트 ${suitesUploaded}개, 이 PC 실행 ${movedRuns}건 이관`);
    this.o.events?.projectsChanged?.();
    return { localId: wcId, movedRuns };
  }

  /** Manual "전체 다시 받기". */
  async resync(id: string): Promise<void> {
    const sync = this.sync(id);
    await this.call(() => sync.resync(sync.wc.state().lastSeq ?? 0));
  }

  // ---- cloud project settings (online only, server-side permission) -------------------------------

  private async refreshed(id: string): Promise<ProjectView> {
    await this.call(() => this.sync(id).refreshSnapshot());
    return this.svc.view(id);
  }

  async updateProject(id: string, patch: Record<string, unknown>): Promise<ProjectView> {
    const p = this.svc.store.require(id);
    const local: Record<string, unknown> = {};
    if (typeof patch.pinned === 'boolean') local.pinned = patch.pinned;
    const b = (patch.browser && typeof patch.browser === 'object' ? patch.browser : undefined) as { engine?: string; device?: string; headless?: boolean } | undefined;
    if (b && typeof b.headless === 'boolean' && b.headless !== p.browser.headless) local.browser = { ...p.browser, headless: b.headless };
    const server: Record<string, unknown> = {};
    if (typeof patch.name === 'string' && patch.name !== p.name) server.name = patch.name;
    if (typeof patch.description === 'string' && patch.description !== p.description) server.description = patch.description;
    if (typeof patch.testRules === 'string') server.testRules = patch.testRules;
    if (b && ((b.engine && b.engine !== p.browser.engine) || (b.device !== undefined && (b.device || undefined) !== p.browser.device))) {
      server.browser = { engine: b.engine ?? p.browser.engine, ...((b.device ?? p.browser.device) ? { device: b.device ?? p.browser.device } : {}) };
    }
    if (patch.defaultEnvId !== undefined) server.defaultEnvironmentId = patch.defaultEnvId ? expandId(String(patch.defaultEnvId)) : null;
    if (Object.keys(local).length) this.svc.store.update(id, local);
    if (!Object.keys(server).length) {
      this.o.events?.projectsChanged?.();
      return this.svc.view(id);
    }
    const pid = this.link(id).projectId;
    await this.call((c) => c.patchProject(pid, server));
    return this.refreshed(id);
  }

  async upsertEnv(id: string, envId: string | undefined, input: Record<string, unknown>): Promise<ProjectView> {
    if (typeof input.secretsFile === 'string' && input.secretsFile) throw new InputError('클라우드 프로젝트의 이 PC 값은 vault 에 넣습니다 (외부 secrets 파일 미지원)');
    const pid = this.link(id).projectId;
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = String(input.name);
    if (input.baseUrl !== undefined) body.baseUrl = String(input.baseUrl);
    if (input.vars !== undefined) body.vars = input.vars;
    if (Array.isArray(input.allowedDomains)) body.allowedDomains = input.allowedDomains.map(String).filter(Boolean);
    if (!Object.keys(body).length) return this.svc.view(id);
    if (envId) await this.call((c) => c.patchEnvironment(pid, expandId(envId), body));
    else await this.call((c) => c.createEnvironment(pid, { vars: {}, ...body, makeDefault: !this.svc.store.require(id).environments.length }));
    return this.refreshed(id);
  }

  async deleteEnv(id: string, envId: string): Promise<ProjectView> {
    const pid = this.link(id).projectId;
    await this.call((c) => c.deleteEnvironment(pid, expandId(envId)));
    this.svc.vault.removePrefix(id, envId);
    return this.refreshed(id);
  }

  /** Test credential on the server (write-only; the value is passed through, never stored here). */
  async setCredential(id: string, envId: string, name: string, value: string): Promise<ProjectView> {
    const pid = this.link(id).projectId;
    await this.call((c) => c.putCredential(pid, expandId(envId), name, value));
    this.svc.log(id, 'secret.set', 'user', `클라우드 테스트 계정 저장: ${name} (${this.svc.store.env(id, envId).name})`, { envId });
    return this.refreshed(id);
  }

  async removeCredential(id: string, envId: string, name: string): Promise<ProjectView> {
    const pid = this.link(id).projectId;
    await this.call((c) => c.deleteCredential(pid, expandId(envId), name));
    return this.refreshed(id);
  }

  async upsertSuite(id: string, suiteId: string | undefined, input: Record<string, unknown>): Promise<ProjectView> {
    const keys = Object.keys(input).filter((k) => input[k] !== undefined);
    if (suiteId && keys.length === 1 && keys[0] === 'stopOnFailure') {
      // "실패 시 중단" is this PC's option (the server suite has no such field).
      this.svc.store.upsertSuite(id, suiteId, { stopOnFailure: input.stopOnFailure });
      this.o.events?.projectsChanged?.();
      return this.svc.view(id);
    }
    const pid = this.link(id).projectId;
    const st = this.wc(id).state();
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = String(input.name);
    const toIds = (paths: unknown[]) =>
      paths.map((p) => {
        const sid = st.scripts[String(p)]?.id;
        if (!sid) throw new InputError(`아직 클라우드에 없는 스크립트입니다: ${String(p)} — 먼저 보내세요`);
        return sid;
      });
    if (Array.isArray(input.scripts)) body.scriptIds = toIds(input.scripts);
    if (Array.isArray(input.alwaysRun)) body.alwaysRun = [...new Set(toIds(input.alwaysRun))];
    if (input.envId !== undefined) body.defaultEnvironmentId = input.envId ? expandId(String(input.envId)) : null;
    if (suiteId) await this.call((c) => c.patchSuite(pid, expandId(suiteId), body));
    else await this.call((c) => c.createSuite(pid, { scriptIds: [], ...body }));
    return this.refreshed(id);
  }

  async deleteSuite(id: string, suiteId: string): Promise<ProjectView> {
    const pid = this.link(id).projectId;
    await this.call((c) => c.deleteSuite(pid, expandId(suiteId)));
    return this.refreshed(id);
  }

  async members(id: string): Promise<CloudMemberView[]> {
    const pid = this.link(id).projectId;
    return (await this.call((c) => c.members(pid))).map((m) => ({ userId: m.userId, email: m.email, name: m.name, role: m.role, active: m.active }));
  }

  /**
   * Invite / change a member by email. The server has no organization directory for non-admins
   * (server gap, ADR-025): existing members by their email, new ones only when I am an administrator.
   */
  async setMember(id: string, email: string, role: CloudRole): Promise<CloudMemberView[]> {
    const pid = this.link(id).projectId;
    const want = email.trim().toLowerCase();
    if (!['owner', 'editor', 'runner', 'viewer'].includes(role)) throw new InputError('역할은 소유자 · 편집자 · 실행자 · 보기 중 하나입니다');
    let userId = (await this.members(id)).find((m) => m.email.toLowerCase() === want)?.userId;
    if (!userId) {
      const found = await this.searchUsers(want);
      if (found) userId = found.find((u) => u.email.toLowerCase() === want)?.id;
      else {
        // Older server without `GET /api/users?q=`: only an administrator can look people up.
        if (!this.account.user?.isAdmin) throw new InputError('이 서버에는 구성원 검색 기능이 없어 관리자만 이메일로 초대할 수 있습니다 (웹 화면에서 초대)');
        userId = (await this.call((c) => c.adminUsers())).find((u) => u.email.toLowerCase() === want)?.id;
      }
      if (!userId) throw new InputError(`가입한(활성) 구성원이 아닙니다: ${email}`);
    }
    await this.call((c) => c.putMember(pid, userId, role));
    return this.members(id);
  }

  /**
   * Organization user search for the invite box (`GET /api/users?q=` — active users, prefix match on name
   * or email). undefined = this server has no such route (404 → the caller falls back).
   */
  async searchUsers(q: string): Promise<{ id: string; email: string; name: string }[] | undefined> {
    try {
      return await this.call((c) => c.searchUsers(q.trim().slice(0, 100)), true);
    } catch (e) {
      if (e instanceof CloudError && e.status === 404) return undefined;
      if (e instanceof CloudError) throw new InputError(e.message);
      throw e;
    }
  }

  async removeMember(id: string, userId: string): Promise<CloudMemberView[]> {
    const pid = this.link(id).projectId;
    await this.call((c) => c.deleteMember(pid, userId));
    return this.members(id);
  }

  async activity(id: string): Promise<CloudActivityView[]> {
    if (!this.online) return [];
    const pid = this.link(id).projectId;
    return (await this.call((c) => c.activity(pid))).map((a) => ({ at: a.at, actor: a.actor.label, kind: a.kind, summary: a.summary }));
  }
}
