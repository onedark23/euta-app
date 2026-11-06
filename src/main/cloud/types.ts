// euta cloud API shapes the app uses (mirror of euta-cloud packages/shared types.ts — the app does
// not depend on that package; ADR-025). Only the fields the app reads are listed.

export type CloudRole = 'owner' | 'editor' | 'runner' | 'viewer';
export type CloudScriptOrigin = 'web' | 'app' | 'ai_mcp' | 'external' | 'revert';

export interface MeDto {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string;
  browser: { engine: 'chromium' | 'firefox' | 'webkit'; device?: string };
  testRules: string;
  defaultEnvironmentId: string | null;
  myRole: CloudRole;
  can?: string[];
  updatedAt: string;
  /** Stage 15 (API_CONTRACT §1) — absent on older servers. */
  visibility?: 'org' | 'members';
  birth?: ProjectBirthDto;
  isMember?: boolean;
  /** POST /api/projects resumed an earlier create with the same originLocalId (§2). */
  resumed?: boolean;
}

/** Birth record (출생 기록): set by the server at creation, never changes. */
export interface ProjectBirthDto {
  origin: 'web' | 'app' | 'unknown';
  originLocalId: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

/** `GET /api/projects/receivable` item (API_CONTRACT §3). */
export interface ReceivableProjectDto {
  id: string;
  name: string;
  description: string;
  createdBy: { id: string; name: string } | null;
  origin: 'web' | 'app' | 'unknown';
  originLocalId: string | null;
  visibility: 'org' | 'members';
  myRole: CloudRole;
  lastRun: { id: string; status: string; flaky: boolean; queuedAt: string; finishedAt: string | null } | null;
  canRequestAccess: boolean;
  openRequest: { id: string; role: 'editor' | 'runner'; createdAt: string; expiresAt: string } | null;
}

/** Access request (권한 요청, API_CONTRACT §4). */
export interface AccessRequestDto {
  id: string;
  projectId: string;
  projectName: string;
  user: { id: string; name: string; email: string };
  role: 'editor' | 'runner';
  memo: string;
  status: 'open' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: { id: string; name: string } | null;
  grantedRole: CloudRole | null;
}

/** Merge request body (합치기, API_CONTRACT §5). */
export interface MergeBody {
  localProjectId: string;
  uploadedTo: { projectId: string; localId: string };
  summary?: { scriptsUploaded: number; scriptsChosen: number; suitesUploaded: number; environmentsUploaded: number; runsMoved: number };
}

export interface EnvironmentDto {
  id: string;
  name: string;
  baseUrl: string;
  vars: Record<string, string>;
  allowedDomains: string[];
  cloudRunnable: boolean;
  addressCheck: { public: boolean; reason?: string };
  isDefault: boolean;
  credentialNames: string[];
}

export interface SuiteDto {
  id: string;
  name: string;
  scripts: { id: string; path: string | null }[];
  /** "항상 실행" script ids (absent from servers before ADR-031). */
  alwaysRun?: string[];
  defaultEnvironmentId: string | null;
}

export interface ScriptDto {
  id: string;
  path: string;
  version: number;
  contentHash: string;
  validationOk: boolean;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
  deletedAt?: string | null;
}

export interface ScriptVersionDto {
  version: number;
  contentHash: string;
  origin: CloudScriptOrigin;
  memo: string | null;
  author: { id: string; name: string } | null;
  createdAt: string;
  validation: { ok: boolean; issues: { path: string; message: string }[] };
  source?: string;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: CloudRole;
  active: boolean;
}

export interface ActivityDto {
  id: string;
  at: string;
  actor: { type: string; id: string | null; label: string };
  kind: string;
  summary: string;
}

export interface FeedEvent {
  /** SSE event name: `change` (a feed row), `ready` (stream position), `resync` (reload everything). */
  event: string;
  /** SSE `id:` = per-project change seq. */
  seq: number;
  kind?: string;
  actorId?: string | null;
  data?: Record<string, unknown>;
}

/** Server copy of a project's settings (snapshot.json — SPEC 작업 사본 저장 구조). */
export interface CloudSnapshot {
  project: ProjectDto;
  environments: EnvironmentDto[];
  suites: SuiteDto[];
  fetchedAt: string;
}

// ---- runs · schedules · app notifications (C3, mirror of euta-cloud shared runs.ts / schedules.ts) ----

export type CloudRunStatus = 'queued' | 'leased' | 'running' | 'passed' | 'failed' | 'error' | 'timeout' | 'aborted' | 'cancelled' | 'skipped';
export type CloudRunSource = 'web' | 'app' | 'ai_mcp' | 'schedule' | 'local_upload';

export interface PrecheckProblemDto {
  code: string;
  message: string;
  script?: string;
  issues?: { path: string; message: string }[];
  names?: string[];
}

export interface PrecheckResultDto {
  ok: boolean;
  problems: PrecheckProblemDto[];
  environment: { id: string; name: string } | null;
  credentialNames: string[];
  scripts: { id: string; path: string; version: number }[];
}

export interface RunSummaryDto {
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
}

export interface RunDto {
  id: string;
  kind: 'script' | 'suite';
  status: CloudRunStatus;
  flaky: boolean;
  parentRunId: string | null;
  orderIndex: number | null;
  /** Test set child marked "항상 실행" (older servers: absent). */
  alwaysRun?: boolean;
  script: { id: string | null; path: string; version: number | null; contentHash: string | null } | null;
  suite: { id: string | null; name: string } | null;
  environment: { id: string | null; name: string };
  source: CloudRunSource;
  requestedBy: { id: string | null; label: string };
  runnerLocation: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  summary: RunSummaryDto | null;
  currentStep: { stepId: string; action: string; name?: string } | null;
  error: string | null;
  stopRequested: 'cancel' | 'timeout' | null;
  resultFiles: 'none' | 'present' | 'expired';
  scheduleId: string | null;
  scheduledFor: string | null;
  attempt: number;
  retryOfRunId: string | null;
  skipReason: 'overlap' | 'missed' | 'daily-cap' | null;
  localModified: boolean;
}

export interface RunStepDto {
  stepId: string;
  index: number;
  action: string;
  name?: string;
  status: string;
  durationMs: number;
  error?: string;
}

export interface RunDetailDto extends RunDto {
  steps: RunStepDto[];
  metrics: { name: string; value: number; unit: string; stepId?: string }[];
  expects: { stepId: string; condition: string; passed: boolean }[];
  children?: RunDto[];
}

export interface RunFileDto {
  path: string;
  size: number;
}

export type CadenceDto =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; dayOfWeek: number; time: string }
  | { kind: 'cron'; expression: string };

export interface ScheduleDto {
  id: string;
  name: string;
  target: { kind: 'script'; script: { id: string | null; path: string | null } } | { kind: 'suite'; suite: { id: string | null; name: string | null } };
  environment: { id: string | null; name: string | null };
  cadence: CadenceDto;
  cron: string;
  timezone: string;
  timeLimitSec: number | null;
  retryOnFailure: boolean;
  enabled: boolean;
  disabledReason: string | null;
  nextRunAt: string | null;
  intervalMin: number;
  createdBy: { id: string | null; label: string };
  lastRun: { id: string; status: string; flaky: boolean; skipReason: string | null; finishedAt: string | null } | null;
  durationWarning: { avgDurationMs: number; intervalMs: number } | null;
}

export interface UserEventDto {
  id: number;
  /** `access.*` (stage 15) carry AccessEventData in `data` instead — read `kind` first. */
  kind: 'failure' | 'recovery' | 'passed' | 'flaky' | 'skipped' | 'aborted' | 'run.finished' | 'access.requested' | 'access.approved' | 'access.rejected';
  at: string;
  projectId: string;
  runId: string | null;
  data: {
    projectName: string;
    target: string;
    environment: string;
    status: CloudRunStatus;
    flaky: boolean;
    source: CloudRunSource;
    scheduleName?: string;
    failedStep?: string;
    durationMs: number | null;
    url: string;
  };
}

/** `data` of the `access.*` app notifications (API_CONTRACT §4). */
export interface AccessEventData {
  projectName: string;
  requestId: string;
  requester?: { id: string; name: string };
  role: 'editor' | 'runner';
  memo?: string;
  grantedRole?: CloudRole;
}
