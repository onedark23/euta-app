// euta cloud HTTP client (main process only). Bearer = the device-authorization token (ADR-023);
// the token never leaves the main process. `fetch` is injectable for unit tests.
import type { AccessRequestDto, ActivityDto, CloudRole, EnvironmentDto, MergeBody, ReceivableProjectDto, FeedEvent, MeDto, MemberDto, PrecheckResultDto, ProjectDto, RunDetailDto, RunDto, RunFileDto, ScheduleDto, ScriptDto, ScriptVersionDto, SuiteDto, UserEventDto } from './types.js';
import { SseParser, type SseMessage } from './sse.js';

export const DEVICE_CLIENT_ID = 'euta-app';
const REQUEST_TIMEOUT_MS = 15_000;
/** Result file downloads and local run uploads can be large (video, trace). */
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

/** The server answered with an error status (`{ error: { code, message, details } }`). */
export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

/** The server could not be reached (offline, DNS, refused, timeout). */
export class CloudNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudNetworkError';
  }
}

export const isNetworkError = (e: unknown): e is CloudNetworkError => e instanceof CloudNetworkError;
export const isAuthError = (e: unknown): boolean => e instanceof CloudError && e.status === 401;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export type DeviceTokenResult = { access_token: string } | { error: string; error_description?: string };

/** Normalize a server address: trimmed, no trailing slash, http(s) only. */
export function normalizeServerUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('서버 주소는 http(s) 로 시작하는 전체 주소여야 합니다');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('서버 주소는 http(s) 로 시작하는 전체 주소여야 합니다');
  if (u.username || u.password) throw new Error('서버 주소에 계정 정보를 넣지 마세요');
  return `${u.origin}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}`;
}

const encPath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

export class CloudClient {
  private readonly fetchFn: FetchLike;

  constructor(
    readonly baseUrl: string,
    private readonly token: () => string | undefined,
    fetchFn?: FetchLike,
  ) {
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init));
  }

  private headers(json: boolean): Record<string, string> {
    const t = this.token();
    return { accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) };
  }

  private async send(method: string, path: string, body?: unknown, signal?: AbortSignal, raw?: { body?: Uint8Array; contentType?: string; timeoutMs?: number }): Promise<Response> {
    const timeout = AbortSignal.timeout(raw?.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const headers = raw ? { ...this.headers(false), ...(raw.contentType ? { 'content-type': raw.contentType } : {}) } : this.headers(body !== undefined);
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(raw?.body ? { body: raw.body as unknown as RequestInit["body"] } : body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw new CloudNetworkError(`euta cloud 에 연결할 수 없습니다 (${(e as Error).message})`);
    }
  }

  /** JSON request; error statuses become CloudError, unreachable server CloudNetworkError. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.parse<T>(await this.send(method, path, body));
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text().catch(() => '');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      // A proxy / gateway error page means the server itself is not there.
      if (!err && (res.status === 502 || res.status === 503 || res.status === 504)) throw new CloudNetworkError(`euta cloud 응답 없음 (${res.status})`);
      throw new CloudError(res.status, typeof err?.code === 'string' ? err.code : `HTTP_${res.status}`, typeof err?.message === 'string' ? err.message : res.statusText || `HTTP ${res.status}`, err?.details);
    }
    return json as T;
  }

  // ---- device authorization (RFC 8628 via Better Auth) ---------------------------------------

  deviceCode(): Promise<DeviceCode> {
    return this.request<DeviceCode>('POST', '/api/auth/device/code', { client_id: DEVICE_CLIENT_ID });
  }

  /** One token poll. JSON body only — the server answers 415 to form encoding (ADR-023 결과). */
  async deviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    const res = await this.send('POST', '/api/auth/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: DEVICE_CLIENT_ID });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof j.access_token === 'string') return { access_token: j.access_token };
    const error = typeof j.error === 'string' ? j.error : `http_${res.status}`;
    return { error, ...(typeof j.error_description === 'string' ? { error_description: j.error_description } : {}) };
  }

  async signOut(): Promise<void> {
    await this.send('POST', '/api/auth/sign-out', {}).catch(() => undefined);
  }

  me(): Promise<MeDto> {
    return this.request('GET', '/api/me');
  }

  // ---- projects -----------------------------------------------------------------------------

  async projects(scope: 'mine' | 'all'): Promise<ProjectDto[]> {
    return (await this.request<{ projects: ProjectDto[] }>('GET', `/api/projects?scope=${scope}`)).projects;
  }
  project(id: string): Promise<ProjectDto> {
    return this.request('GET', `/api/projects/${id}`);
  }
  /** Create; `origin: 'app'` + `originLocalId` resumes an earlier create of the same local project (200 + `resumed`). */
  createProject(body: { name: string; description?: string; browser?: { engine: string; device?: string }; origin?: 'web' | 'app'; originLocalId?: string }): Promise<ProjectDto> {
    return this.request('POST', '/api/projects', body);
  }
  /** [클라우드에서 받기] list (API_CONTRACT §3). */
  receivable(): Promise<{ mine: ReceivableProjectDto[]; org: ReceivableProjectDto[] }> {
    return this.request('GET', '/api/projects/receivable');
  }
  setVisibility(id: string, visibility: 'org' | 'members'): Promise<ProjectDto> {
    return this.request('PUT', `/api/projects/${id}/visibility`, { visibility });
  }

  // ---- access requests · merge · leave (stage 15, API_CONTRACT §4·5·7) ----------------------

  requestAccess(id: string, role: 'editor' | 'runner', memo: string): Promise<AccessRequestDto> {
    return this.request('POST', `/api/projects/${id}/access-requests`, { role, ...(memo ? { memo } : {}) });
  }
  async accessRequests(id: string, status?: 'open'): Promise<AccessRequestDto[]> {
    return (await this.request<{ requests: AccessRequestDto[] }>('GET', `/api/projects/${id}/access-requests${status ? `?status=${status}` : ''}`)).requests;
  }
  approveAccess(id: string, requestId: string, role?: CloudRole): Promise<AccessRequestDto> {
    return this.request('POST', `/api/projects/${id}/access-requests/${requestId}/approve`, role ? { role } : {});
  }
  rejectAccess(id: string, requestId: string): Promise<AccessRequestDto> {
    return this.request('POST', `/api/projects/${id}/access-requests/${requestId}/reject`, {});
  }
  mergeCheck(id: string, body: MergeBody): Promise<{ ok: true; origin: 'app' | 'unknown'; project: ProjectDto }> {
    return this.request('POST', `/api/projects/${id}/merge/check`, body);
  }
  merge(id: string, body: MergeBody): Promise<{ ok: true; project: ProjectDto }> {
    return this.request('POST', `/api/projects/${id}/merge`, body);
  }
  leave(id: string): Promise<void> {
    return this.request('POST', `/api/projects/${id}/leave`, {});
  }
  patchProject(id: string, body: Record<string, unknown>): Promise<ProjectDto> {
    return this.request('PATCH', `/api/projects/${id}`, body);
  }

  async environments(id: string): Promise<EnvironmentDto[]> {
    return (await this.request<{ environments: EnvironmentDto[] }>('GET', `/api/projects/${id}/environments`)).environments;
  }
  createEnvironment(id: string, body: Record<string, unknown>): Promise<EnvironmentDto> {
    return this.request('POST', `/api/projects/${id}/environments`, body);
  }
  patchEnvironment(id: string, envId: string, body: Record<string, unknown>): Promise<EnvironmentDto> {
    return this.request('PATCH', `/api/projects/${id}/environments/${envId}`, body);
  }
  deleteEnvironment(id: string, envId: string): Promise<void> {
    return this.request('DELETE', `/api/projects/${id}/environments/${envId}`);
  }
  /** Write-only: the value goes to the server once and is never returned. */
  putCredential(id: string, envId: string, name: string, value: string): Promise<unknown> {
    return this.request('PUT', `/api/projects/${id}/environments/${envId}/credentials/${encodeURIComponent(name)}`, { value });
  }
  deleteCredential(id: string, envId: string, name: string): Promise<void> {
    return this.request('DELETE', `/api/projects/${id}/environments/${envId}/credentials/${encodeURIComponent(name)}`);
  }

  async suites(id: string): Promise<SuiteDto[]> {
    return (await this.request<{ suites: SuiteDto[] }>('GET', `/api/projects/${id}/suites`)).suites;
  }
  createSuite(id: string, body: Record<string, unknown>): Promise<SuiteDto> {
    return this.request('POST', `/api/projects/${id}/suites`, body);
  }
  patchSuite(id: string, suiteId: string, body: Record<string, unknown>): Promise<SuiteDto> {
    return this.request('PATCH', `/api/projects/${id}/suites/${suiteId}`, body);
  }
  deleteSuite(id: string, suiteId: string): Promise<void> {
    return this.request('DELETE', `/api/projects/${id}/suites/${suiteId}`);
  }

  // ---- scripts ------------------------------------------------------------------------------

  async scripts(id: string, deleted = false): Promise<ScriptDto[]> {
    return (await this.request<{ scripts: ScriptDto[] }>('GET', `/api/projects/${id}/scripts${deleted ? '?deleted=1' : ''}`)).scripts;
  }
  script(id: string, path: string): Promise<ScriptDto & { source: string }> {
    return this.request('GET', `/api/projects/${id}/scripts/${encPath(path)}`);
  }
  putScript(id: string, path: string, body: { source: string; baseVersion: number | null; origin: string; memo?: string }): Promise<{ script: ScriptDto; version: ScriptVersionDto; unchanged: boolean }> {
    return this.request('PUT', `/api/projects/${id}/scripts/${encPath(path)}`, body);
  }
  deleteScript(id: string, path: string): Promise<void> {
    return this.request('DELETE', `/api/projects/${id}/scripts/${encPath(path)}`);
  }
  renameScript(id: string, path: string, newPath: string): Promise<ScriptDto> {
    return this.request('POST', `/api/projects/${id}/scripts/${encPath(path)}/rename`, { newPath });
  }
  restoreScript(id: string, path: string): Promise<ScriptDto> {
    return this.request('POST', `/api/projects/${id}/scripts/${encPath(path)}/restore`, {});
  }
  revertScript(id: string, path: string, version: number, baseVersion: number | undefined): Promise<{ script: ScriptDto; version: ScriptVersionDto }> {
    return this.request('POST', `/api/projects/${id}/scripts/${encPath(path)}/revert`, { version, ...(baseVersion ? { baseVersion } : {}) });
  }
  async versions(id: string, path: string): Promise<ScriptVersionDto[]> {
    return (await this.request<{ versions: ScriptVersionDto[] }>('GET', `/api/projects/${id}/scripts/${encPath(path)}/versions`)).versions;
  }
  version(id: string, path: string, n: number): Promise<ScriptVersionDto> {
    return this.request('GET', `/api/projects/${id}/scripts/${encPath(path)}/versions/${n}`);
  }

  // ---- members · activity · admin -----------------------------------------------------------

  async members(id: string): Promise<MemberDto[]> {
    return (await this.request<{ members: MemberDto[] }>('GET', `/api/projects/${id}/members`)).members;
  }
  putMember(id: string, userId: string, role: CloudRole): Promise<MemberDto> {
    return this.request('PUT', `/api/projects/${id}/members/${userId}`, { role });
  }
  deleteMember(id: string, userId: string): Promise<void> {
    return this.request('DELETE', `/api/projects/${id}/members/${userId}`);
  }
  async activity(id: string, limit = 100): Promise<ActivityDto[]> {
    return (await this.request<{ entries: ActivityDto[] }>('GET', `/api/projects/${id}/activity?limit=${limit}`)).entries;
  }
  async adminUsers(): Promise<{ id: string; email: string; name: string; status: string }[]> {
    return (await this.request<{ users: { id: string; email: string; name: string; status: string }[] }>('GET', '/api/admin/users')).users;
  }
  /** Organization user search for invitations (`GET /api/users?q=`, SPEC 클라우드-계정-프로젝트). */
  async searchUsers(q: string): Promise<{ id: string; email: string; name: string }[]> {
    return (await this.request<{ users: { id: string; email: string; name: string }[] }>('GET', `/api/users?q=${encodeURIComponent(q)}`)).users;
  }

  // ---- runs (SPEC 클라우드-실행-예약) ---------------------------------------------------------

  precheck(id: string, body: Record<string, unknown>): Promise<PrecheckResultDto> {
    return this.request('POST', `/api/projects/${id}/runs/precheck`, body);
  }
  startRun(id: string, body: Record<string, unknown>): Promise<RunDetailDto> {
    return this.request('POST', `/api/projects/${id}/runs`, body);
  }
  async runs(id: string, q: Record<string, string | number> = {}): Promise<RunDto[]> {
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]): [string, string] => [k, String(v)])).toString();
    return (await this.request<{ runs: RunDto[] }>('GET', `/api/projects/${id}/runs${qs ? `?${qs}` : ''}`)).runs;
  }
  run(id: string, runId: string): Promise<RunDetailDto> {
    return this.request('GET', `/api/projects/${id}/runs/${runId}`);
  }
  cancelRun(id: string, runId: string): Promise<RunDto> {
    return this.request('POST', `/api/projects/${id}/runs/${runId}/cancel`, {});
  }
  runFiles(id: string, runId: string): Promise<{ resultFiles: RunDto['resultFiles']; files: RunFileDto[] }> {
    return this.request('GET', `/api/projects/${id}/runs/${runId}/files`);
  }
  /** One result file (raw bytes). */
  async download(id: string, runId: string, path: string): Promise<Buffer> {
    const res = await this.send('GET', `/api/projects/${id}/runs/${runId}/files/${encPath(path)}`, undefined, undefined, { timeoutMs: TRANSFER_TIMEOUT_MS });
    if (!res.ok) return this.parse<never>(res);
    try {
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw new CloudNetworkError(`download: ${(e as Error).message}`);
    }
  }
  /** "클라우드에 올리기": a tar of one engine run folder's contents (run.json at the top). */
  async uploadRun(id: string, query: { scriptPath: string; environmentId?: string; environmentName?: string }, tar: Uint8Array): Promise<RunDetailDto> {
    const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => typeof e[1] === 'string')).toString();
    return this.parse(await this.send('POST', `/api/projects/${id}/runs/upload?${qs}`, undefined, undefined, { body: tar, contentType: 'application/x-tar', timeoutMs: TRANSFER_TIMEOUT_MS }));
  }

  // ---- schedules ----------------------------------------------------------------------------

  async schedules(id: string): Promise<ScheduleDto[]> {
    return (await this.request<{ schedules: ScheduleDto[] }>('GET', `/api/projects/${id}/schedules`)).schedules;
  }
  createSchedule(id: string, body: Record<string, unknown>): Promise<ScheduleDto> {
    return this.request('POST', `/api/projects/${id}/schedules`, body);
  }
  patchSchedule(id: string, scheduleId: string, body: Record<string, unknown>): Promise<ScheduleDto> {
    return this.request('PATCH', `/api/projects/${id}/schedules/${scheduleId}`, body);
  }
  deleteSchedule(id: string, scheduleId: string): Promise<void> {
    return this.request('DELETE', `/api/projects/${id}/schedules/${scheduleId}`);
  }

  // ---- change feed (SSE) --------------------------------------------------------------------

  /**
   * Stream the project's change feed. `lastEventId` resumes after that seq (`?lastEventId=`);
   * without it the server starts with `ready` at its current seq. Ends when the stream closes;
   * throws CloudError (e.g. 401) / CloudNetworkError.
   */
  async *events(projectId: string, lastEventId: number | null, signal: AbortSignal): AsyncGenerator<FeedEvent> {
    for await (const m of this.sse(`/api/projects/${projectId}/events${lastEventId !== null ? `?lastEventId=${lastEventId}` : ''}`, signal, 'change feed')) {
      // I can no longer see the project (API_CONTRACT §6) — may come without an `id:`.
      if (m.event === 'access_lost') {
        yield { event: 'access_lost', seq: Number.isFinite(Number(m.id)) ? Number(m.id) : -1 };
        return;
      }
      const seq = Number(m.id);
      if (!Number.isFinite(seq)) continue;
      let data: Record<string, unknown> = {};
      try {
        data = m.data ? (JSON.parse(m.data) as Record<string, unknown>) : {};
      } catch {
        continue;
      }
      if (m.event === 'change') {
        yield { event: 'change', seq, kind: String(data.kind ?? ''), actorId: (data.actorId as string | null) ?? null, data: (data.data as Record<string, unknown>) ?? {} };
      } else yield { event: m.event, seq };
    }
  }

  /**
   * App notifications (`GET /api/me/events`, SPEC 클라우드-앱-연동 "앱 알림"): `notification` events carry a
   * UserEventDto; `ready` / `resync` carry only the position (`id:` = global user-event id).
   */
  async *userEvents(lastEventId: number | null, signal: AbortSignal): AsyncGenerator<{ event: string; id: number; data?: UserEventDto }> {
    for await (const m of this.sse(`/api/me/events${lastEventId !== null ? `?lastEventId=${lastEventId}` : ''}`, signal, 'app notifications')) {
      const id = Number(m.id);
      if (!Number.isFinite(id)) continue;
      if (m.event !== 'notification') {
        yield { event: m.event, id };
        continue;
      }
      try {
        yield { event: 'notification', id, data: JSON.parse(m.data) as UserEventDto };
      } catch {
        /* malformed event: skip */
      }
    }
  }

  /** Read an SSE stream with the Bearer header (EventSource cannot send it). */
  private async *sse(path: string, signal: AbortSignal, label: string): AsyncGenerator<SseMessage> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, { method: 'GET', headers: { ...this.headers(false), accept: 'text/event-stream' }, signal });
    } catch (e) {
      throw new CloudNetworkError(`${label}: ${(e as Error).message}`);
    }
    if (!res.ok || !res.body) {
      const j = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new CloudError(res.status, j.error?.code ?? `HTTP_${res.status}`, j.error?.message ?? `HTTP ${res.status}`);
    }
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (signal.aborted) return;
          throw new CloudNetworkError(`${label}: ${(e as Error).message}`);
        }
        if (chunk.done) return;
        for (const m of parser.push(decoder.decode(chunk.value, { stream: true }))) yield m;
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
}
