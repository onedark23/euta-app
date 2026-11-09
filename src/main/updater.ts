// App updates (SPEC 앱-배포-업데이트 "업데이트 방식", ADR-042 · ADR-047). Checks 30 s after start, every 6 h and on
// [업데이트 확인]. Each check first resolves the source (connected cloud server or GitHub Releases — both an
// electron-updater generic feed). `auto`: electron-updater downloads in the background and the header offers
// [다시 시작해서 업데이트]; `manual` (ad-hoc-signed Mac, non-AppImage Linux): read the feed's latest*.yml and offer
// the installer download. Never restarts on its own; failures are quiet until the next check.
import { parse as parseYaml } from 'yaml';
import { compareVersions, filesFromMeta, metaFileOf, pickInstaller, type UpdateMode } from '../shared/app-version.js';
import type { BusyWork, UpdateRestartResult, UpdateView } from '../shared/types.js';
import type { UpdateSource } from './update-source.js';

export const FIRST_CHECK_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
const IDLE_POLL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** The electron-updater side (a fake in tests). */
export interface UpdaterBackend {
  /** Point electron-updater at a feed (generic provider base URL) — called before each check. */
  setFeed(url: string): void;
  /** A newer version on the feed, or null. */
  check(): Promise<{ version: string; notes?: string } | null>;
  /** Download (and verify) it; resolves when it is ready to install. */
  download(): Promise<void>;
  /** Quit, install, relaunch. */
  install(): void;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AppUpdaterOptions {
  version: string;
  channel: string;
  mode: UpdateMode;
  platform: string;
  arch: string;
  /** Where to look this time (ADR-047) — resolved before every check. */
  source(): Promise<UpdateSource>;
  backend?: UpdaterBackend;
  fetch?: FetchLike;
  busy(): BusyWork;
  emit(v: UpdateView): void;
  openExternal(url: string): void;
  now?: () => Date;
}

export const busyCount = (b: BusyWork): number => b.runs + (b.recording ? 1 : 0) + b.chats;

export class AppUpdater {
  private view: UpdateView;
  private timers: NodeJS.Timeout[] = [];
  private idleTimer: NodeJS.Timeout | undefined;
  private running: Promise<UpdateView> | undefined;
  private readonly fetchFn: FetchLike;

  constructor(private readonly o: AppUpdaterOptions) {
    this.view = { version: o.version, channel: o.channel, mode: o.mode, checking: false };
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
  }

  state(): UpdateView {
    return structuredClone(this.view);
  }

  private set(patch: Partial<UpdateView>): void {
    this.view = { ...this.view, ...patch };
    for (const k of Object.keys(patch) as (keyof UpdateView)[]) if (patch[k] === undefined) delete this.view[k];
    this.o.emit(this.state());
  }

  /** Background schedule: 30 s after start, then every 6 h. */
  start(): void {
    if (this.o.mode === 'off') return;
    const first = setTimeout(() => void this.check(), FIRST_CHECK_MS);
    const every = setInterval(() => void this.check(), CHECK_EVERY_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** One check (concurrent calls share it). */
  check(): Promise<UpdateView> {
    if (this.o.mode === 'off') return Promise.resolve(this.state());
    this.running ??= this.doCheck().finally(() => (this.running = undefined));
    return this.running;
  }

  private async doCheck(): Promise<UpdateView> {
    this.set({ checking: true });
    const at = (this.o.now?.() ?? new Date()).toISOString();
    try {
      const src = await this.o.source();
      this.set({ source: src.label });
      const found = this.o.mode === 'auto' ? await this.checkAuto(src) : await this.checkManual(src);
      this.set({ checking: false, lastCheck: { at, result: found ? 'available' : 'latest' } });
    } catch (e) {
      // Quiet: keep what we had (a ready update stays ready); the next check tries again.
      this.set({ checking: false, lastCheck: { at, result: 'error', message: oneLine(e) } });
    }
    return this.state();
  }

  private async checkAuto(src: UpdateSource): Promise<boolean> {
    const backend = this.o.backend;
    if (!backend) throw new Error('updater unavailable');
    backend.setFeed(src.feedUrl);
    const info = await backend.check();
    if (!info || compareVersions(info.version, this.o.version) <= 0) return !!this.view.available;
    const cur = this.view.available;
    if (cur?.ready && cur.version === info.version) return true;
    this.set({ available: { version: info.version, ...(info.notes ? { notes: info.notes } : {}), ready: false } });
    await backend.download();
    this.set({ available: { version: info.version, ...(info.notes ? { notes: info.notes } : {}), ready: true } });
    return true;
  }

  private async checkManual(src: UpdateSource): Promise<boolean> {
    const url = new URL(metaFileOf(this.o.platform), src.feedUrl).toString();
    const res = await this.fetchFn(url, { headers: { accept: 'text/yaml, */*', 'x-euta-app-version': this.o.version }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${metaFileOf(this.o.platform)}: HTTP ${res.status}`);
    const meta = (parseYaml(await res.text()) ?? {}) as { version?: unknown; releaseNotes?: unknown; files?: unknown };
    const version = typeof meta.version === 'string' ? meta.version : undefined;
    if (!version || compareVersions(version, this.o.version) <= 0) {
      this.set({ available: undefined });
      return false;
    }
    const notes = notesText(meta.releaseNotes);
    const file = pickInstaller({ version, publishedAt: '', notes: notes ?? '', files: filesFromMeta(meta, src.feedUrl) }, this.o.platform, this.o.arch);
    this.set({ available: { version, ...(notes ? { notes } : {}), ready: false, ...(file ? { downloadUrl: file.url } : {}) } });
    return true;
  }

  /** [내려받기] (manual): the installer in the system browser. */
  openDownload(): boolean {
    const url = this.view.available?.downloadUrl;
    if (!url) return false;
    this.o.openExternal(url);
    return true;
  }

  /**
   * [다시 시작해서 업데이트]: restart now when nothing is running (or `force` — "끊고 업데이트"); otherwise
   * report what would be cut off so the screen can ask.
   */
  restart(force = false): UpdateRestartResult {
    if (this.o.mode !== 'auto' || !this.view.available?.ready || !this.o.backend) throw new Error('no update ready to install');
    const busy = this.o.busy();
    if (!force && busyCount(busy) > 0) return { restarting: false, busy };
    this.stopWaiting();
    this.o.backend.install();
    return { restarting: true };
  }

  /**
   * "끝나면 업데이트": wait for this PC's work to finish, then ask again (the notice comes back without the
   * waiting line). No automatic restart — the update also installs when the app quits.
   */
  restartWhenIdle(): UpdateView {
    if (!this.view.available?.ready) throw new Error('no update ready to install');
    this.set({ waiting: true });
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      if (busyCount(this.o.busy()) === 0) this.stopWaiting();
    }, IDLE_POLL_MS);
    this.idleTimer.unref();
    return this.state();
  }

  stopWaiting(): UpdateView {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    if (this.view.waiting) this.set({ waiting: undefined });
    return this.state();
  }
}

function oneLine(e: unknown): string {
  return String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 200);
}

/** electron-updater release notes (string, or per-version list) → text. */
export function notesText(n: unknown): string | undefined {
  if (typeof n === 'string') return n.trim() || undefined;
  if (Array.isArray(n)) {
    const s = n
      .map((x) => (x && typeof x === 'object' && typeof (x as { note?: unknown }).note === 'string' ? (x as { note: string }).note : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();
    return s || undefined;
  }
  return undefined;
}
