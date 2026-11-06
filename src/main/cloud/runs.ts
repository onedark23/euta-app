// Cloud runs in the app (SPEC 클라우드-앱-연동 "실행" · "History · 결과 회수" · "로컬 실행 올리기", ADR-026):
// run location "클라우드" (precheck → request → Live from the feed → cancel), the merged History's cloud
// side (list, open = download the result files into `cloud-runs/<runId>/` with a 2 GB LRU, "파일 만료"),
// and "클라우드에 올리기" (tar of one local run folder's contents). Electron-free.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as tar from 'tar-stream';
import type { CloudHistoryView, CloudPrecheckView, CloudRunInfo, CloudRunItem, CloudRunRequest, CloudUploadResult, LiveSuiteItem, RunView, StepView } from '../../shared/types.js';
import { koSecretRule } from '../../shared/secret-rules.js';
import { InputError } from '../project/project-store.js';
import type { ProjectService } from '../project/service.js';
import type { LiveStore } from '../live-store.js';
import { parseKeyValues } from '../runner.js';
import { CloudError, type CloudClient } from './client.js';
import type { PrecheckProblemDto, RunDetailDto, RunDto } from './types.js';
import { compactId, expandId, type WorkingCopy } from './workcopy.js';

export const CLOUD_CACHE_MAX_BYTES = 2 * 1024 ** 3;
const CACHE_META = '.euta-cache.json';
const ACTIVE = new Set(['queued', 'leased', 'running']);

export const SOURCE_LABEL: Record<string, string> = { web: '웹', app: '앱', ai_mcp: 'AI', schedule: '예약', local_upload: '로컬 올림' };

/** What CloudRuns needs from CloudService (connection, working copies, the project service, Live). */
export interface CloudRunsHost {
  /** A server call with CloudService's offline / login handling; `raw` lets 4xx CloudErrors through. */
  call<T>(fn: (c: CloudClient) => Promise<T>, raw?: boolean): Promise<T>;
  online(): boolean;
  /** Cloud project id (UUID) of an app project id. */
  cloudId(id: string): string;
  wc(id: string): WorkingCopy;
  projects: ProjectService;
  live?: LiveStore;
  /** History / 예약 tab should reload (feed, own actions). */
  changed(id: string): void;
  /** Project ids of every working copy (cache budget is shared). */
  cloudIds(): string[];
}

/** Server status → the Live/History badge status. */
export function liveStatus(s: string): RunView['status'] {
  if (ACTIVE.has(s)) return 'running';
  if (s === 'passed' || s === 'failed') return s;
  return 'error';
}

/** Korean reason for one precheck problem (server codes, SPEC 클라우드-실행-예약 "사전 검사"). */
export function problemText(p: PrecheckProblemDto): string {
  const where = p.script ? `${p.script}: ` : '';
  const issues = (p.issues ?? []).map((i) => `${i.path ? `${i.path} ` : ''}${koSecretRule(i.message)}`).join('; ');
  switch (p.code) {
    case 'ENVIRONMENT_REQUIRED':
      return '환경을 고르세요 (프로젝트에 기본 환경이 없습니다)';
    case 'SCRIPT_INVALID':
      return `${where}스크립트 검증 오류${issues ? ` — ${issues}` : ''}`;
    case 'OS_INPUT_NOT_ALLOWED':
      return `${where}클라우드에서는 OS 입력(input: os)을 쓸 수 없습니다${issues ? ` — ${(p.issues ?? []).map((i) => i.path).join(', ')}` : ''}`;
    case 'SECRET_PLACEMENT':
      return `${where}secrets 규칙 위반 — \${secrets.*} 는 입력 스텝(fill·type) 값에만${issues ? `: ${(p.issues ?? []).map((i) => i.path).join(', ')}` : ''}`;
    case 'CREDENTIALS_MISSING':
      return `${where}클라우드에 등록되지 않은 테스트 계정: ${(p.names ?? []).join(', ')} — 프로젝트 설정 → 환경 → 테스트 계정 "클라우드에도"`;
    case 'TARGET_NOT_PUBLIC':
      return '클라우드에서 접속할 수 없는 주소입니다(사설·사내 주소) — 이 PC 에서 실행하세요';
    default:
      return `${where}${p.message}`;
  }
}

/** A 422 of POST /runs (precheck problems, daily cap) → readable Korean. */
export function runRequestError(e: CloudError): InputError | undefined {
  if (e.status !== 422) return undefined;
  if (e.code === 'DAILY_RUN_CAP_REACHED') {
    const d = (e.details ?? {}) as { cap?: number; used?: number; day?: string };
    return new InputError(`오늘 클라우드 실행 상한에 도달했습니다 — ${d.used ?? '?'}/${d.cap ?? '?'}회 (${d.day ?? '오늘'}, Asia/Seoul). 내일 다시 하거나 웹에서 프로젝트의 하루 실행 상한을 올리세요`);
  }
  if (Array.isArray(e.details) && e.details.length && (e.details as PrecheckProblemDto[]).every((p) => typeof p?.code === 'string')) {
    return new InputError(`클라우드에서 실행할 수 없습니다 — ${(e.details as PrecheckProblemDto[]).map(problemText).join(' · ')}`);
  }
  return undefined;
}

const stepStatus = (s: string): StepView['status'] => (s === 'passed' || s === 'failed' || s === 'error' || s === 'skipped' ? s : s === 'running' ? 'running' : 'error');

export function cloudInfo(dto: RunDto, canCancel: boolean): CloudRunInfo {
  return {
    runId: dto.id,
    kind: dto.kind,
    status: dto.status,
    source: dto.source,
    sourceLabel: SOURCE_LABEL[dto.source] ?? dto.source,
    ...(dto.runnerLocation ? { runnerLocation: dto.runnerLocation } : {}),
    requestedBy: dto.requestedBy.label,
    flaky: dto.flaky,
    resultFiles: dto.resultFiles,
    queuedAt: dto.queuedAt,
    canCancel: canCancel && ACTIVE.has(dto.status),
    ...(dto.environment?.name ? { envName: dto.environment.name } : {}),
    ...(dto.parentRunId ? { parentRunId: dto.parentRunId } : {}),
    ...(dto.finishedAt ? { finishedAt: dto.finishedAt } : {}),
  };
}

/** Server child status → the set item status in Live (queued = waiting; cancelled / skipped did not run). */
export function suiteItemStatus(s: string): LiveSuiteItem['status'] {
  if (s === 'running' || s === 'leased') return 'running';
  if (s === 'queued') return 'pending';
  if (s === 'cancelled' || s === 'skipped') return 'skipped';
  if (s === 'passed' || s === 'failed') return s;
  return 'error';
}

/** Server run detail → the Live view (steps from the server; a suite shows its scripts as rows). */
export function toRunView(projectId: string, dto: RunDetailDto, canCancel: boolean): RunView {
  const done = !ACTIVE.has(dto.status);
  let steps: StepView[];
  if (dto.kind === 'suite') {
    steps = (dto.children ?? []).map((c, i) => ({
      stepId: String(i + 1),
      index: i,
      action: 'script',
      name: c.script?.path ?? `#${i + 1}`,
      // queued children wait (shown as not run yet), cancelled / skipped ones did not run
      status: c.status === 'running' || c.status === 'leased' ? 'running' : c.status === 'queued' || c.status === 'cancelled' || c.status === 'skipped' ? 'skipped' : stepStatus(c.status),
      ...(c.durationMs !== null ? { durationMs: c.durationMs } : {}),
      ...(c.error ? { error: koSecretRule(c.error) } : {}),
    }));
  } else {
    steps = dto.steps.map((s) => ({ stepId: s.stepId, index: s.index, action: s.action, ...(s.name ? { name: s.name } : {}), status: stepStatus(s.status), durationMs: s.durationMs, ...(s.error ? { error: koSecretRule(s.error) } : {}) }));
    if (!done && dto.currentStep && !steps.some((s) => s.stepId === dto.currentStep!.stepId)) {
      steps.push({ stepId: dto.currentStep.stepId, index: steps.length, action: dto.currentStep.action, ...(dto.currentStep.name ? { name: dto.currentStep.name } : {}), status: 'running' });
    }
  }
  const name = dto.kind === 'suite' ? `테스트 세트: ${dto.suite?.name ?? '?'}` : (dto.script?.path ?? dto.id);
  return {
    runId: dto.id,
    source: 'cloud',
    projectId,
    kind: 'script',
    name,
    ...(dto.script?.path ? { scriptPath: dto.script.path } : {}),
    status: liveStatus(dto.status),
    ...(dto.summary ? { summary: dto.summary } : {}),
    ...(dto.durationMs !== null ? { durationMs: dto.durationMs } : {}),
    ...(dto.error ? { error: koSecretRule(dto.error) } : dto.skipReason ? { error: `건너뜀 (${dto.skipReason === 'overlap' ? '겹침' : dto.skipReason === 'missed' ? '놓침' : '하루 실행 상한'})` } : {}),
    startedAt: dto.startedAt ?? dto.queuedAt,
    headless: true,
    steps,
    metrics: dto.metrics ?? [],
    expects: (dto.expects ?? []).map((x) => ({ stepId: x.stepId, condition: x.condition, passed: x.passed, expected: undefined, actual: undefined })),
    consoleErrors: [],
    networkFailures: [],
    eventCount: 0,
    maxSeq: 0,
    updatedAt: Date.now(),
    cloud: cloudInfo(dto, canCancel),
    ...(dto.kind === 'suite'
      ? {
          suiteItems: (dto.children ?? []).map((c) => ({
            runId: c.id,
            script: c.script?.path ?? '?',
            status: suiteItemStatus(c.status),
            ...(c.alwaysRun ? { alwaysRun: true } : {}),
            ...(c.durationMs !== null ? { durationMs: c.durationMs } : {}),
          })),
        }
      : {}),
  };
}

export function toItem(dto: RunDto, children?: RunDto[]): CloudRunItem {
  return {
    id: dto.id,
    kind: dto.kind,
    status: dto.status,
    flaky: dto.flaky,
    name: dto.kind === 'suite' ? (dto.suite?.name ?? '?') : (dto.script?.path ?? dto.id),
    ...(dto.kind === 'suite' && dto.suite?.id && /^[0-9a-f-]{36}$/i.test(dto.suite.id) ? { suiteId: compactId(dto.suite.id) } : {}),
    ...(dto.script?.path ? { scriptPath: dto.script.path } : {}),
    ...(dto.script?.version ? { scriptVersion: dto.script.version } : {}),
    envName: dto.environment.name,
    source: dto.source,
    sourceLabel: SOURCE_LABEL[dto.source] ?? dto.source,
    requestedBy: dto.requestedBy.label,
    ...(dto.runnerLocation ? { runnerLocation: dto.runnerLocation } : {}),
    at: dto.startedAt ?? dto.scheduledFor ?? dto.queuedAt,
    durationMs: dto.durationMs,
    ...(dto.summary ? { summary: dto.summary } : {}),
    resultFiles: dto.resultFiles,
    localModified: dto.localModified,
    ...(dto.skipReason ? { skipReason: dto.skipReason } : {}),
    attempt: dto.attempt,
    ...(dto.error ? { error: koSecretRule(dto.error) } : {}),
    ...(children ? { children: children.map((c) => toItem(c)) } : {}),
  };
}

/** Files of a run folder (relative, forward slashes), skipping the app's cache marker. */
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) out.push(...listFiles(p, base));
    else if (n.isFile() && n.name !== CACHE_META) out.push(relative(base, p).split(sep).join('/'));
  }
  return out.sort((a, b) => (a === 'run.json' ? -1 : b === 'run.json' ? 1 : a.localeCompare(b)));
}

/** Tar of a run folder's CONTENTS (`run.json` at the top level — the server's upload contract). */
export async function packRunDir(dir: string): Promise<Buffer> {
  if (!existsSync(join(dir, 'run.json'))) throw new InputError('run.json 이 없는 실행입니다 — 끝난 실행만 올릴 수 있습니다');
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((res, rej) => {
    pack.on('data', (c: unknown) => chunks.push(c as Buffer));
    pack.on('end', () => res());
    pack.on('error', rej);
  });
  for (const rel of listFiles(dir)) {
    const data = readFileSync(join(dir, rel));
    await new Promise<void>((res, rej) => pack.entry({ name: rel, size: data.length, mode: 0o644, mtime: statSync(join(dir, rel)).mtime }, data, (e) => (e ? rej(e) : res())));
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

interface CacheMeta {
  cloudRunId: string;
  engineRunId?: string;
  bytes: number;
  lastUsed: number;
}

export class CloudRuns {
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly host: CloudRunsHost,
    private readonly o: { cacheMaxBytes?: number; refreshDelayMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private canRun(id: string): boolean {
    const st = this.host.wc(id).state();
    return !st.accessLost && st.role !== 'viewer' && (st.can.length === 0 || st.can.includes('run.execute'));
  }

  private canUpload(id: string): boolean {
    const st = this.host.wc(id).state();
    return !st.accessLost && st.role !== 'viewer' && (st.can.length === 0 || st.can.includes('run.upload'));
  }

  /** Target body for precheck / request: a script path (must be on the server, nothing unsent) or a suite. */
  private target(id: string, req: CloudRunRequest): { body: Record<string, unknown>; reasons: string[]; needsSend: boolean } {
    const wc = this.host.wc(id);
    const st = wc.state();
    const reasons: string[] = [];
    let needsSend = false;
    const body: Record<string, unknown> = { ...(req.envId ? { environmentId: expandId(req.envId) } : {}) };
    const paths: string[] = [];
    if (req.suiteId) {
      body.suiteId = expandId(req.suiteId);
      const suite = this.host.projects.store.require(id).suites.find((s) => s.id === req.suiteId);
      if (!suite) throw new InputError('suite not found');
      paths.push(...suite.scripts);
    } else if (req.script) {
      body.scriptPath = req.script;
      paths.push(req.script);
    } else throw new InputError('스크립트나 테스트 세트를 고르세요');
    for (const p of paths) {
      if (wc.hasPending(p)) {
        needsSend = true;
        reasons.push(`${p}: 보내기 대기 중인 저장이 있습니다 — 먼저 보내기 (클라우드는 서버에 저장된 버전으로 돕니다)`);
      } else if (!st.scripts[p]) {
        needsSend = true;
        reasons.push(`${p}: 아직 클라우드에 없는 스크립트입니다 — 먼저 보내기`);
      }
    }
    return { body, reasons, needsSend };
  }

  /** Precheck next to the button: local blockers first, then the server's `POST …/runs/precheck`. */
  async precheck(id: string, req: CloudRunRequest): Promise<CloudPrecheckView> {
    if (!this.host.online()) return { ok: false, reasons: ['오프라인 — 클라우드에 다시 연결된 뒤에 클라우드에서 실행할 수 있습니다'] };
    if (!this.canRun(id)) return { ok: false, reasons: ['보기 역할은 클라우드 실행을 할 수 없습니다 (실행자 이상)'] };
    const t = this.target(id, req);
    if (t.reasons.length) return { ok: false, reasons: t.reasons, needsSend: t.needsSend };
    const r = await this.host.call((c) => c.precheck(this.host.cloudId(id), t.body));
    return { ok: r.ok, reasons: r.problems.map(problemText), credentialNames: r.credentialNames };
  }

  /** "클라우드에서 실행" → a server run request (source app). The run appears in Live at once. */
  async start(id: string, req: CloudRunRequest): Promise<{ runId: string }> {
    if (!this.canRun(id)) throw new InputError('보기 역할은 클라우드 실행을 할 수 없습니다 (실행자 이상)');
    const t = this.target(id, req);
    if (t.reasons.length) throw new InputError(t.reasons.join(' · '));
    const vars = parseKeyValues(req.vars ?? '');
    const pid = this.host.cloudId(id);
    let dto: RunDetailDto;
    try {
      dto = await this.host.call((c) => c.startRun(pid, { ...t.body, ...(Object.keys(vars).length ? { vars } : {}), source: 'app' }), true);
    } catch (e) {
      if (e instanceof CloudError) throw runRequestError(e) ?? new InputError(e.status === 403 ? '권한이 없습니다' : e.message);
      throw e;
    }
    this.host.live?.setCloudRun(toRunView(id, dto, true));
    this.host.projects.log(id, 'run.started', 'user', `클라우드 실행 요청: ${toItem(dto).name}${dto.environment.name ? ` @ ${dto.environment.name}` : ''}`, {});
    this.host.changed(id);
    return { runId: dto.id };
  }

  async cancel(id: string, runId: string): Promise<void> {
    const pid = this.host.cloudId(id);
    await this.host.call((c) => c.cancelRun(pid, runId));
    await this.refresh(id, runId);
  }

  /** Re-read one run into Live. A test set parent also re-reads its running child (Live shows it inside the set). */
  async refresh(id: string, runId: string): Promise<RunView | undefined> {
    const pid = this.host.cloudId(id);
    const dto = await this.host.call((c) => c.run(pid, runId));
    const v = toRunView(id, dto, this.canRun(id));
    // A downloaded replay keeps its own view (engine run id); this one is the live summary.
    this.host.live?.setCloudRun(v);
    if (dto.kind === 'suite') {
      for (const c of dto.children ?? []) {
        // The running child, and children shown before (their final state).
        if (ACTIVE.has(c.status) && c.status !== 'queued') await this.refresh(id, c.id).catch(() => undefined);
        else if (this.host.live?.get(c.id)?.status === 'running') await this.refresh(id, c.id).catch(() => undefined);
      }
    }
    return v;
  }

  /** Web run detail of a cloud run (a test set run's report screen, ADR-032). */
  webRunUrl(id: string, runId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw new InputError('invalid cloud run id');
    const link = this.host.projects.store.require(id).cloud;
    if (!link?.serverUrl) throw new InputError('클라우드 프로젝트가 아닙니다');
    return `${link.serverUrl.replace(/\/+$/, '')}/projects/${this.host.cloudId(id)}/runs/${runId}`;
  }

  /** A `run.*` / `schedule.*` feed row of the open project (debounced per run). */
  onFeed(id: string, kind: string, data: Record<string, unknown>): void {
    this.host.changed(id);
    if (!kind.startsWith('run.') || kind === 'run.uploaded' || kind === 'run.skipped') return;
    const runId = typeof data.parentRunId === 'string' ? data.parentRunId : typeof data.runId === 'string' ? data.runId : undefined;
    if (!runId) return;
    const key = `${id}:${runId}`;
    if (this.refreshTimers.has(key)) return;
    this.refreshTimers.set(
      key,
      setTimeout(() => {
        this.refreshTimers.delete(key);
        void this.refresh(id, runId).catch(() => undefined);
      }, this.o.refreshDelayMs ?? 300),
    );
  }

  /** Opening a cloud project: queued / running runs into Live (the feed takes over from there). */
  async seed(id: string): Promise<void> {
    const pid = this.host.cloudId(id);
    const lists = await Promise.all(['queued', 'leased', 'running'].map((status) => this.host.call((c) => c.runs(pid, { status, limit: 20 })).catch(() => [] as RunDto[])));
    for (const r of lists.flat()) await this.refresh(id, r.id).catch(() => undefined);
  }

  dispose(): void {
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
  }

  // ---- History (cloud side) ---------------------------------------------------------------------

  private uploadsFile(id: string): string {
    return join(this.host.projects.store.dir(id), 'cloud-uploads.json');
  }

  uploads(id: string): Record<string, string> {
    try {
      const v = JSON.parse(readFileSync(this.uploadsFile(id), 'utf8')) as unknown;
      return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
    } catch {
      return {};
    }
  }

  async history(id: string): Promise<CloudHistoryView> {
    const uploads = this.uploads(id);
    if (!this.host.online()) return { runs: [], uploads, online: false, error: '오프라인 — 클라우드 실행 기록은 다시 연결되면 보입니다', canUpload: false };
    const pid = this.host.cloudId(id);
    try {
      const list = await this.host.call((c) => c.runs(pid, { limit: 100 }));
      return { runs: list.map((r) => toItem(r)), uploads, online: true, canUpload: this.canUpload(id) };
    } catch (e) {
      return { runs: [], uploads, online: this.host.online(), error: (e as Error).message, canUpload: false };
    }
  }

  /** Children of a cloud suite run (History expansion). */
  async children(id: string, runId: string): Promise<CloudRunItem[]> {
    const dto = await this.host.call((c) => c.run(this.host.cloudId(id), runId));
    return (dto.children ?? []).map((c) => toItem(c));
  }

  // ---- open = download into the cache, then the existing detail / report / replay screens -------------

  cacheRoot(id: string): string {
    return join(this.host.projects.store.dir(id), 'cloud-runs');
  }

  private meta(dir: string): CacheMeta | undefined {
    try {
      return JSON.parse(readFileSync(join(dir, CACHE_META), 'utf8')) as CacheMeta;
    } catch {
      return undefined;
    }
  }

  /** Cached run folder of a cloud run, when complete. */
  cachedDir(id: string, runId: string): string | undefined {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) return undefined;
    const dir = join(this.cacheRoot(id), runId);
    return this.meta(dir) ? dir : undefined;
  }

  /**
   * "열기": a run with result files is downloaded (once) into `cloud-runs/<runId>/` and replayed from its
   * steps.jsonl like a local run (Live, screenshots, report). Without files ("파일 만료", not uploaded yet,
   * a suite parent) the server summary is shown instead. Returns the Live run id.
   */
  async open(id: string, runId: string): Promise<{ liveId: string; expired?: boolean; files: boolean }> {
    const pid = this.host.cloudId(id);
    const dto = await this.host.call((c) => c.run(pid, runId));
    if (dto.kind === 'suite' || dto.resultFiles !== 'present') {
      this.host.live?.setCloudRun(toRunView(id, dto, this.canRun(id)));
      return { liveId: dto.id, files: false, ...(dto.resultFiles === 'expired' ? { expired: true } : {}) };
    }
    const dir = this.cachedDir(id, runId) ?? (await this.download(id, runId));
    const m = this.meta(dir)!;
    this.touch(dir, m);
    const engineId = m.engineRunId ?? runId;
    const live = this.host.live;
    if (live) {
      if (!live.get(engineId) || live.get(engineId)?.source === 'cloud') live.loadFromRunDir(engineId, dir, 'history');
      // steps.jsonl's run.started carries the runner's temp folder — screenshots live in the cache folder.
      live.patch(engineId, { projectId: id, runDir: dir, cloud: { ...cloudInfo(dto, false), downloaded: true } });
    }
    return { liveId: engineId, files: true };
  }

  private touch(dir: string, m: CacheMeta): void {
    writeFileSync(join(dir, CACHE_META), JSON.stringify({ ...m, lastUsed: this.now() }));
  }

  private async download(id: string, runId: string): Promise<string> {
    const pid = this.host.cloudId(id);
    const { resultFiles, files } = await this.host.call((c) => c.runFiles(pid, runId));
    if (resultFiles !== 'present') throw new InputError(resultFiles === 'expired' ? '파일 만료 — 보관 기간이 지나 결과 파일이 지워졌습니다 (요약만 볼 수 있습니다)' : '아직 결과 파일이 없습니다');
    const root = this.cacheRoot(id);
    const final = join(root, runId);
    const tmp = join(root, `.${runId}.part`);
    rmSync(tmp, { recursive: true, force: true });
    let bytes = 0;
    try {
      for (const f of files) {
        const out = resolve(tmp, f.path);
        if (!out.startsWith(resolve(tmp) + sep)) continue; // never write outside the run folder
        const data = await this.host.call((c) => c.download(pid, runId, f.path));
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, data);
        bytes += data.length;
      }
      let engineRunId: string | undefined;
      try {
        const rj = JSON.parse(readFileSync(join(tmp, 'run.json'), 'utf8')) as { id?: unknown };
        if (typeof rj.id === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(rj.id)) engineRunId = rj.id;
      } catch {
        /* no run.json: summary replay only */
      }
      writeFileSync(join(tmp, CACHE_META), JSON.stringify({ cloudRunId: runId, ...(engineRunId ? { engineRunId } : {}), bytes, lastUsed: this.now() } satisfies CacheMeta));
      rmSync(final, { recursive: true, force: true });
      renameSync(tmp, final);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    this.evict(final);
    return final;
  }

  /** Keep all cloud-run caches under the budget: least recently opened first (never `keep`). */
  evict(keep?: string): void {
    const max = this.o.cacheMaxBytes ?? CLOUD_CACHE_MAX_BYTES;
    const all: { dir: string; m: CacheMeta }[] = [];
    for (const pid of this.host.cloudIds()) {
      const root = this.cacheRoot(pid);
      if (!existsSync(root)) continue;
      for (const n of readdirSync(root)) {
        const dir = join(root, n);
        const m = this.meta(dir);
        if (m) all.push({ dir, m });
      }
    }
    let total = all.reduce((n, x) => n + x.m.bytes, 0);
    for (const x of all.sort((a, b) => a.m.lastUsed - b.m.lastUsed)) {
      if (total <= max) break;
      if (keep && resolve(x.dir) === resolve(keep)) continue;
      rmSync(x.dir, { recursive: true, force: true });
      total -= x.m.bytes;
    }
  }

  /** Cached run folder that owns `engineRunId` (report / artifacts of a downloaded cloud run). */
  dirOfEngineRun(id: string, engineRunId: string): string | undefined {
    const root = this.cacheRoot(id);
    if (!existsSync(root)) return undefined;
    for (const n of readdirSync(root)) {
      const m = this.meta(join(root, n));
      if (m && (m.engineRunId === engineRunId || m.cloudRunId === engineRunId)) return join(root, n);
    }
    return undefined;
  }

  // ---- "클라우드에 올리기" -------------------------------------------------------------------------------

  async upload(id: string, localRunId: string): Promise<CloudUploadResult> {
    if (!this.canUpload(id)) throw new InputError('보기 역할은 실행을 올릴 수 없습니다 (실행자 이상)');
    const done = this.uploads(id)[localRunId];
    if (done) throw new InputError('이미 클라우드에 올린 실행입니다');
    const run = this.host.projects.findRun(id, localRunId);
    if (!run) throw new InputError('run not found');
    let rj: { status?: unknown; scriptPath?: unknown; meta?: Record<string, unknown> };
    try {
      rj = JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')) as typeof rj;
    } catch {
      throw new InputError('run.json 을 읽을 수 없습니다 — 끝난 실행만 올릴 수 있습니다');
    }
    if (rj.status !== 'passed' && rj.status !== 'failed' && rj.status !== 'error') throw new InputError('아직 끝나지 않은 실행입니다');
    const scriptsDir = this.host.projects.view(id).dirs.scripts;
    const abs = typeof rj.scriptPath === 'string' ? rj.scriptPath : '';
    const rel = abs ? relative(scriptsDir, abs).split(sep).join('/') : '';
    if (!rel || rel.startsWith('..')) throw new InputError('이 실행의 스크립트가 이 프로젝트의 스크립트 라이브러리에 없습니다');
    const envId = typeof rj.meta?.envId === 'string' ? rj.meta.envId : undefined;
    const envName = typeof rj.meta?.envName === 'string' ? rj.meta.envName : undefined;
    const tarball = await packRunDir(run.dir);
    const pid = this.host.cloudId(id);
    const dto = await this.host.call((c) => c.uploadRun(pid, { scriptPath: rel, ...(envId && /^[0-9a-f]{32}$/.test(envId) ? { environmentId: expandId(envId) } : envName ? { environmentName: envName.slice(0, 40) } : {}) }, tarball));
    const map = { ...this.uploads(id), [localRunId]: dto.id };
    writeFileSync(this.uploadsFile(id), JSON.stringify(map, null, 2));
    this.host.projects.log(id, 'run.uploaded', 'user', `클라우드에 올림: ${rel} (${localRunId}) — ${dto.localModified ? '로컬 수정본' : `버전 ${dto.script?.version ?? '?'}`}`, { runId: localRunId, script: rel });
    this.host.changed(id);
    return { cloudRunId: dto.id, ...(dto.script?.version ? { version: dto.script.version } : {}), localModified: dto.localModified };
  }
}
