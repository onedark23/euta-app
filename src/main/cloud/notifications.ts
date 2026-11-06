// App notifications (SPEC 클라우드-앱-연동 "앱 알림"): while the app runs and is signed in, read
// `GET /api/me/events` (SSE, resumable) and turn each `notification` into an OS notification text. The
// position is kept in `<userData>/cloud/notify.json` so outcomes that happened while the app was closed
// arrive on the next start (a burst of old ones is folded into one summary). Electron-free.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudNotificationView } from '../../shared/types.js';
import { writeTextAtomic } from '../project/fsx.js';
import { CloudError, isNetworkError, type CloudClient } from './client.js';
import type { AccessEventData, UserEventDto } from './types.js';
import { compactId } from './workcopy.js';

const KIND_LABEL: Record<string, string> = { failure: '실패', recovery: '회복', passed: '통과', flaky: '통과 · 불안정', skipped: '건너뜀', aborted: '중단' };
const STATUS_LABEL: Record<string, string> = { passed: '통과', failed: '실패', error: '오류', timeout: '시간 초과', aborted: '중단', cancelled: '취소', skipped: '건너뜀' };

/** OS notification title / body of one user event. Never test credential values (the server sends none). */
const ROLE_NAME: Record<string, string> = { owner: '소유자', editor: '편집자', runner: '실행자', viewer: '보기' };

export function notificationText(e: UserEventDto): CloudNotificationView {
  if (e.kind.startsWith('access.')) {
    // Access requests (권한 요청 — API_CONTRACT §4): `data` is AccessEventData, not a run.
    const a = e.data as unknown as AccessEventData;
    const role = ROLE_NAME[a.role] ?? a.role;
    const title =
      e.kind === 'access.requested'
        ? `[euta] 권한 요청 — ${a.requester?.name ?? '누군가'} (${role})`
        : e.kind === 'access.approved'
          ? `[euta] 권한 요청 승인 — ${ROLE_NAME[a.grantedRole ?? a.role] ?? a.grantedRole ?? role}`
          : `[euta] 권한 요청 거절 — ${role}`;
    const body = [a.projectName, e.kind === 'access.requested' ? (a.memo ? `메모: ${a.memo}` : '프로젝트 설정 > 구성원에서 승인·거절') : ''].filter(Boolean).join(' · ');
    return { projectId: compactId(e.projectId), kind: e.kind, title, body };
  }
  const d = e.data;
  const status = d.flaky && d.status === 'passed' ? '통과 · 불안정' : (STATUS_LABEL[d.status] ?? d.status);
  const title = e.kind === 'run.finished' ? `클라우드 실행 끝: ${status} — ${d.target}` : `[euta] ${KIND_LABEL[e.kind] ?? e.kind} — ${d.target}`;
  const parts = [d.projectName, d.environment, ...(d.scheduleName ? [`예약 ${d.scheduleName}`] : []), ...(d.failedStep ? [`실패 단계: ${d.failedStep}`] : []), ...(d.durationMs !== null && d.durationMs !== undefined ? [`${Math.round(d.durationMs / 1000)}초`] : [])];
  return { projectId: compactId(e.projectId), ...(e.runId ? { runId: e.runId } : {}), kind: e.kind, title, body: parts.filter(Boolean).join(' · ') };
}

export interface NotifierOptions {
  userData: string;
  client: () => CloudClient | undefined;
  serverUrl: () => string;
  enabled: () => boolean;
  notify: (v: CloudNotificationView) => void;
  offline: (e: unknown) => void;
  authLost: () => void;
  /** An `access.*` event arrived (my role may have changed in that project). */
  access?: (cloudProjectId: string, kind: string) => void;
  now?: () => number;
  /** Events older than this (ms before the stream opened) count as backlog. */
  backlogMs?: number;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });

export class CloudNotifier {
  private abort: AbortController | undefined;
  private readonly file: string;

  constructor(private readonly o: NotifierOptions) {
    this.file = join(o.userData, 'cloud', 'notify.json');
  }

  get running(): boolean {
    return !!this.abort;
  }

  private position(): number | null {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as { serverUrl?: string; lastEventId?: number };
      return v.serverUrl === this.o.serverUrl() && typeof v.lastEventId === 'number' ? v.lastEventId : null;
    } catch {
      return null;
    }
  }

  private save(id: number | null): void {
    mkdirSync(join(this.o.userData, 'cloud'), { recursive: true });
    writeTextAtomic(this.file, JSON.stringify({ serverUrl: this.o.serverUrl(), lastEventId: id }));
  }

  /** Turned off in 앱 설정: forget the position, so turning it back on starts from "now" (no flood). */
  reset(): void {
    this.save(null);
  }

  start(): void {
    if (this.abort || !this.o.enabled() || !this.o.client()) return;
    const abort = new AbortController();
    this.abort = abort;
    void this.loop(abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      const client = this.o.client();
      if (!client) break;
      const opened = this.o.now?.() ?? Date.now();
      const backlog: CloudNotificationView[] = [];
      let flush: NodeJS.Timeout | undefined;
      const flushBacklog = () => {
        flush = undefined;
        if (!backlog.length || signal.aborted) return;
        const items = backlog.splice(0);
        if (items.length <= 3) for (const v of items) this.o.notify(v);
        else this.o.notify({ projectId: items[items.length - 1]!.projectId, kind: 'summary', title: `[euta] 앱이 꺼져 있는 동안 클라우드 알림 ${items.length}건`, body: items.slice(-3).map((v) => v.title).join(' / ') });
      };
      try {
        for await (const ev of client.userEvents(this.position(), signal)) {
          attempt = 0;
          if (ev.event === 'notification' && ev.data) {
            if (ev.data.kind.startsWith('access.')) this.o.access?.(ev.data.projectId, ev.data.kind);
            if (this.o.enabled()) {
              const v = notificationText(ev.data);
              const at = Date.parse(ev.data.at);
              if (Number.isFinite(at) && at < opened - (this.o.backlogMs ?? 60_000)) {
                backlog.push(v);
                flush ??= setTimeout(flushBacklog, 500);
              } else this.o.notify(v);
            }
          }
          // ready / resync / notification: the stream position moves on.
          this.save(ev.id);
        }
      } catch (e) {
        if (signal.aborted) break;
        if (isNetworkError(e)) {
          this.stop();
          this.o.offline(e);
          return;
        }
        if (e instanceof CloudError && e.status === 401) {
          this.stop();
          this.o.authLost();
          return;
        }
      } finally {
        if (flush) {
          clearTimeout(flush);
          flushBacklog();
        }
      }
      if (signal.aborted) break;
      await sleep(Math.min(1000 * ++attempt, 5000), signal);
    }
  }
}
