// Types shared by main, preload and renderer. Keep this file free of runtime imports
// from Node/Electron so the renderer bundle can use it.

export type StepStatus = 'passed' | 'failed' | 'error' | 'skipped';
export type RunStatus = 'running' | 'passed' | 'failed' | 'error';

/** Where the events of a run came from. `cloud` = a euta cloud run (server summary, SPEC 클라우드-앱-연동). */
export type RunSource = 'app' | 'ai' | 'mcp' | 'history' | 'cloud';

export interface StepView {
  stepId: string;
  index: number;
  action: string;
  name?: string;
  target?: string;
  status: 'running' | StepStatus;
  durationMs?: number;
  error?: string;
  optional?: boolean;
  /** Screenshot path relative to the run dir. */
  screenshot?: string;
  /**
   * A `manual` step (DSL, SPEC_TC-문서-변환): never executed, status `skipped`. Reached (no `error`)
   * = "수동 확인 필요"; not reached after a failure (has `error`) = an ordinary skipped step.
   */
  manual?: { instruction: string; reason?: string };
}

/** A step left to a person that the run reached ("수동 확인 필요"). */
export const isManualCheck = (s: { manual?: unknown; error?: unknown }): boolean => !!s.manual && !s.error;

export interface MetricView {
  name: string;
  value: number;
  unit: string;
  stepId?: string;
}

export interface ExpectView {
  stepId: string;
  condition: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

export interface ConsoleView {
  level: string;
  text: string;
  stepId?: string;
}

export interface NetworkFailureView {
  url: string;
  method: string;
  status?: number;
  errorText?: string;
  durationMs?: number;
  stepId?: string;
}

export interface RunSummaryView {
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
}

export interface RunView {
  runId: string;
  source: RunSource;
  /** Owning project (app/AI runs, or a run dir under a project's runs/). */
  projectId?: string;
  kind?: 'script' | 'session';
  name: string;
  scriptPath?: string;
  runDir?: string;
  /** `unknown` until run.started or run.finished is seen. */
  status: RunStatus | 'unknown';
  summary?: RunSummaryView;
  durationMs?: number;
  error?: string;
  startedAt?: string;
  browser?: string;
  headless?: boolean;
  baseUrl?: string;
  steps: StepView[];
  /** Latest screenshot (relative to runDir). */
  latestScreenshot?: string;
  metrics: MetricView[];
  expects: ExpectView[];
  consoleErrors: ConsoleView[];
  networkFailures: NetworkFailureView[];
  /** Number of distinct events applied. */
  eventCount: number;
  /** Highest `seq` seen. `maxSeq - eventCount` = events not (yet) received. */
  maxSeq: number;
  /** Set when events were recovered from `steps.jsonl`. */
  recovered?: boolean;
  updatedAt: number;
  /** A euta cloud run (live summary from the server, or its downloaded result files). */
  cloud?: CloudRunInfo;
  /** This PC's test set run the run belongs to (Live groups it under the set, ADR-032). */
  suiteRunId?: string;
  /** Cloud test set parent: its scripts in order (Live shows them as the set's items). */
  suiteItems?: LiveSuiteItem[];
}

/** One script of a cloud test set run in Live (child run of the parent). */
export interface LiveSuiteItem {
  runId: string;
  script: string;
  /** Live status: pending (queued) · running · passed · failed · error · skipped (cancelled / skipped). */
  status: 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'skipped';
  alwaysRun?: boolean;
  durationMs?: number;
}

/** Cloud side of a run shown in Live / History (SPEC 클라우드-앱-연동 "실행 위치 선택" · "History · 결과 회수"). */
export interface CloudRunInfo {
  /** Cloud run id (UUID). */
  runId: string;
  kind: 'script' | 'suite';
  /** Server status: queued · leased · running · passed · failed · error · timeout · aborted · cancelled · skipped. */
  status: string;
  /** web · app · ai_mcp · schedule · local_upload. */
  source: string;
  /** 웹 · 앱 · AI · 예약 · 로컬 올림. */
  sourceLabel: string;
  runnerLocation?: string;
  requestedBy: string;
  flaky: boolean;
  resultFiles: 'none' | 'present' | 'expired';
  queuedAt: string;
  /** Still queued/running and I may cancel it. */
  canCancel: boolean;
  /** Result files of this run were downloaded (Live shows the replay). */
  downloaded?: boolean;
  /** Environment name (set header in Live). */
  envName?: string;
  /** A test set child: the set (parent) run id — Live shows it inside the set. */
  parentRunId?: string;
  /** Finished at (set header elapsed time). */
  finishedAt?: string;
}

export interface RunListItem {
  runId: string;
  name: string;
  source: RunSource;
  projectId?: string;
  status: RunView['status'];
  updatedAt: number;
}

export interface ValidationIssueView {
  path: string;
  message: string;
}

export interface ScriptCheck {
  path: string;
  name?: string;
  issues: ValidationIssueView[];
  /** Names of secrets loaded from the secrets file (values never leave main). */
  secretNames: string[];
  secretsError?: string;
}

export interface HistoryItem {
  id: string;
  kind: string;
  name: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  /** Manual steps in the run (SPEC TC-문서-변환 "수동 확인 필요"; all of them, reached or not). */
  manual?: number;
  dir: string;
  hasReport: boolean;
  scriptPath?: string;
  /** From run.json `meta` (app runs in a project environment). */
  envId?: string;
  envName?: string;
  suiteRunId?: string;
  /** `ai` for runs started by the in-app AI chat. */
  source?: string;
}

// ---- AI activity (Claude Code HTTP hooks) ----

export type HookKind = 'session' | 'prompt' | 'tool' | 'subagent' | 'stop' | 'notification' | 'other';

export interface HookEntry {
  id: number;
  /** Time the entry was first seen (hooks are async and may arrive out of order). */
  ts: string;
  /** Last hook event applied to this entry. */
  event: string;
  kind: HookKind;
  toolName?: string;
  /** PreToolUse/PostToolUse(/Failure) are merged into one entry by session_id + tool_use_id. */
  toolUseId?: string;
  /** Subagent id (SubagentStart/Stop pairing, and tool calls made inside a subagent). */
  agentId?: string;
  agentType?: string;
  /** Tool / subagent lifecycle. */
  status?: 'running' | 'done' | 'failed';
  /** Tool belongs to the euta MCP server (mcp__euta__* or mcp__plugin_euta_euta__*). */
  isEuta: boolean;
  summary: string;
  /** Tool input (truncated JSON). */
  input?: string;
  /** Tool response / error / long prompt (truncated). */
  detail?: string;
}

export interface HookSessionView {
  sessionId: string;
  cwd?: string;
  firstAt: string;
  lastAt: string;
  ended: boolean;
  entries: HookEntry[];
}

// ---- Terminal ----

export type PtyKind = 'shell' | 'claude' | 'codex';

export interface CliInfo {
  found: boolean;
  path?: string;
}

export interface TerminalInfo {
  shell: string;
  claude: CliInfo;
  codex: CliInfo;
}

export interface AppInfo {
  serverUrl: string;
  /** Runs folder of the current project (what the terminal passes as EUTA_RUNS_DIR). */
  runsDir: string;
  userData: string;
  /** Project opened last (app.json) — reopened at start. */
  lastProjectId?: string;
  /** Absolute path to the engine MCP server entry when it can be located (dev layout). */
  mcpServerPath?: string;
  /** euta-claude-plugin folder next to the engine, when present (dev layout). */
  pluginDir?: string;
  platform: string;
  versions: { electron: string; node: string; chrome: string };
}

// ---- AI chat (Agent SDK, ADR-015) ----

export type ClaudeCliSource = 'override' | 'bundled' | 'user';

/** Claude sign-in as reported by the official `claude auth status`. Labels only — never credentials. */
export interface AuthState {
  status: 'signed-in' | 'signed-out' | 'unknown' | 'cli-missing';
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
  apiProvider?: string;
  /** Present when an API key (not the subscription) would be used. */
  apiKeySource?: string;
  /** Signed in, but not through the claude.ai subscription. */
  notSubscription?: boolean;
  cli?: { path: string; source: ClaudeCliSource };
  /** Names of billing-relevant env vars that are set (values are never read out). */
  envWarnings: string[];
  error?: string;
  checkedAt: number;
}

export type ToolCardStatus = 'running' | 'done' | 'error';

export type ChatItem =
  | { kind: 'user'; id: string; ts: number; text: string }
  | { kind: 'assistant'; id: string; ts: number; text: string; streaming?: boolean }
  | {
      kind: 'tool';
      id: string;
      ts: number;
      /** Bare euta tool name (mcp__euta__ prefix removed). */
      name: string;
      /** Short one-line input summary. */
      inputSummary: string;
      /** Input JSON (truncated). */
      input: string;
      status: ToolCardStatus;
      /** Result summary / error (truncated). */
      result?: string;
      /** First image of the result as a data URL (screenshots). */
      image?: string;
      /** euta run id (run_script / session_*), for the Live link. */
      runId?: string;
      runStatus?: string;
    }
  | { kind: 'notice'; id: string; ts: number; level: 'info' | 'error'; text: string };

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
}

export interface ChatView extends ChatSummary {
  /** Agent working folder for this chat (fixed at creation; SDK sessions are per folder) = the project's scripts/. */
  cwd: string;
  projectId?: string;
  /** Environment the AI's run_script / session_open use (chat header selector). */
  envId?: string;
  model?: string;
  /** Agent SDK session id (multi-turn resume). */
  sdkSessionId?: string;
  /** Agent is thinking / waiting for the model (no text streaming yet). */
  thinking: boolean;
  items: ChatItem[];
}

export interface AiInfo {
  /** Working folder new chats of the project use (its scripts/ folder). */
  workDir: string;
  model: string;
  /** Agent SDK found (main can load it). */
  sdkAvailable: boolean;
  /** Test-only scripted agent is active (EUTA_E2E_FAKE_AGENT). */
  fakeAgent: boolean;
}

// ---- Projects (SPEC 프로젝트-관리, ADR-016) ----

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

export interface ProjectBrowser {
  engine: BrowserEngine;
  /** Playwright device preset (e.g. "iPhone 15"); empty = desktop. */
  device?: string;
  headless: boolean;
}

export interface Environment {
  id: string;
  name: string;
  baseUrl: string;
  /** Extra ${env.*} values (recorded as-is — not for secrets). */
  vars: Record<string, string>;
  /** Names of secrets stored in the vault for this environment (values never leave main). */
  secretNames: string[];
  /** External secrets file (JSON or .env) used instead of the vault. Empty = vault. */
  secretsFile?: string;
  /**
   * Local project: hosts where a secret fill/type step may run (SPEC 프로젝트-관리 "secrets 규칙").
   * Absent = the host of `baseUrl` (computed at use time, never written). [] = nowhere.
   */
  allowedDomains?: string[];
}

export interface Suite {
  id: string;
  name: string;
  /** Script paths relative to the project's scripts/ folder, in run order. */
  scripts: string[];
  /** Environment to run in (default: the project's default environment). */
  envId?: string;
  stopOnFailure: boolean;
  /**
   * "항상 실행" items (SPEC 테스트 세트): script paths (a subset of `scripts`) that still run after
   * a stop-on-failure or a cancel — cleanup scripts. Absent = none (older project.json). ADR-031.
   */
  alwaysRun?: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  defaultEnvId?: string;
  browser: ProjectBrowser;
  pinned: boolean;
  createdAt: string;
  lastOpenedAt: string;
  environments: Environment[];
  suites: Suite[];
  /** Cloud project working copy (SPEC 클라우드-앱-연동): which server and cloud project. */
  cloud?: ProjectCloudLink;
  /** Local project uploaded to the cloud ("클라우드로 올림 — 열기"). */
  uploadedTo?: { serverUrl: string; projectId: string; localId: string; name: string; at: string };
}

export interface ProjectCloudLink {
  serverUrl: string;
  serverId: string;
  /** Cloud project id (UUID). The app id is the same UUID without dashes. */
  projectId: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  pinned: boolean;
  lastOpenedAt: string;
  /** Runs of this project currently running (Live). */
  running: number;
  /** Cloud project: role, unsent saves, a blocked save (conflict). */
  cloud?: { role: CloudRole; pending: number; blocked: boolean; accessLost?: boolean };
}

/** Environment as shown in the UI: the secret names come from the vault or the external file. */
export interface EnvironmentView extends Environment {
  secretSource: 'vault' | 'file';
  /** Hosts the secret rule actually uses for runs in this environment (local: saved list or the address host; cloud: the server's). */
  domains: string[];
  /** Local project: `domains` is the address-host default (nothing saved). */
  domainsDefault?: boolean;
  /** Set when the external secrets file cannot be read. */
  secretsError?: string;
  /** Cloud project: the server side of the environment. `secretNames` stay this PC's vault names. */
  cloud?: { credentialNames: string[]; allowedDomains: string[]; cloudRunnable: boolean; addressReason?: string };
}

export interface ProjectView extends Omit<Project, 'environments'> {
  environments: EnvironmentView[];
  /** Absolute folders (shown for orientation; the renderer never reads them directly). */
  dirs: { root: string; scripts: string; runs: string };
  /** Cloud project state (role, connection, unsent saves, the blocked save). */
  cloudView?: ProjectCloudView;
}

// ---- euta cloud (SPEC 클라우드-앱-연동, ADR-025) ----

export type CloudRole = 'owner' | 'editor' | 'runner' | 'viewer';
export type CloudConnState = 'none' | 'signed_out' | 'online' | 'offline' | 'login_required';

export interface CloudStatusView {
  /** Configured server address ('' = none). */
  serverUrl: string;
  state: CloudConnState;
  user?: { id: string; email: string; name: string; isAdmin?: boolean };
  /** Device login in progress: the code to confirm in the browser. */
  login?: { userCode: string; verificationUri: string; expiresAt: string };
  /** Unsent saves across all cloud projects. */
  pending: number;
  lastError?: string;
}

export interface ProjectCloudView {
  serverUrl: string;
  projectId: string;
  role: CloudRole;
  /** Server actions I may perform (`can`). */
  can: string[];
  /** No `script.edit` (viewer, runner): editing is hidden. */
  readOnly: boolean;
  /** `run.execute` — runner and up (실행 전용 = readOnly && canRun). */
  canRun: boolean;
  /** `run.upload` — "클라우드에 올리기" of a local run. */
  canUpload: boolean;
  /** `access.request` — show [권한 요청] next to the 보기 전용 / 실행 전용 badge. */
  canRequestAccess: boolean;
  /** "접근 권한 없음": removed, or the project became members-only (or was deleted). Only this PC's runs stay readable. */
  accessLost?: { at: string };
  visibility?: 'org' | 'members';
  /** Birth record (출처 · 만든 사람) for the settings page (참고용). */
  birth?: { origin: 'web' | 'app' | 'unknown'; createdBy?: string; createdAt?: string };
  online: boolean;
  /** Signed out / token rejected: the working copy stays but needs a login to open. */
  needsLogin: boolean;
  pending: number;
  testRules: string;
  /** The save the queue stopped at (conflict or rejected). */
  blocked?: CloudConflictView;
}

/** The conflict screen: my text vs the server's latest, compared as step sentences. */
export interface CloudConflictView {
  projectId: string;
  ticket: number;
  path: string;
  status: 'conflict' | 'rejected';
  origin: string;
  mine: string;
  /** null = the script is gone on the server. */
  server: { version: number; source: string; author?: string; at?: string } | null;
  error?: string;
  /** Server latest → mine. */
  rows: ScriptDiffRowView[];
  header: string[];
  summary: string;
  /** Suggested name for choice ③ (`<name>-<my name>.yaml`). */
  copyPath: string;
  /** Queued saves of the same script after this one (rejected: discarding sends them, ADR-046). */
  laterSaves: number;
}

export type CloudConflictChoice = 'mine' | 'theirs' | 'copy';

export interface CloudNotice {
  projectId: string;
  kind: 'remote-saved' | 'conflict' | 'rejected' | 'sent' | 'resynced' | 'ai-conflict' | 'access';
  path?: string;
  version?: number;
  by?: string;
  message: string;
}

export interface CloudProjectItem {
  id: string;
  name: string;
  description: string;
  role: CloudRole;
  /** App id of the working copy on this PC, when already opened. */
  localId?: string;
  createdBy?: string;
  origin?: 'web' | 'app' | 'unknown';
  visibility?: 'org' | 'members';
  lastRun?: { status: string; flaky: boolean; at: string } | null;
  canRequestAccess?: boolean;
  /** My open access request ("요청 중"). */
  openRequest?: { role: 'editor' | 'runner'; createdAt: string } | null;
}

/** [클라우드에서 받기] list: 내 프로젝트 (I am a member) / 조직 공개 (I see it as 보기). */
export interface CloudReceiveList {
  mine: CloudProjectItem[];
  org: CloudProjectItem[];
}

/** An access request (권한 요청) as the owner sees it in 구성원. */
export interface CloudAccessRequestView {
  id: string;
  user: { id: string; name: string; email: string };
  role: 'editor' | 'runner';
  memo: string;
  status: 'open' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
}

/** "클라우드로 올리기" = conversion: what was sent / moved (the local project became the cloud project). */
export interface CloudConvertResult {
  /** App id of the (same) project now — the cloud working copy. */
  localId: string;
  skippedEnvs: string[];
  flaggedScripts: string[];
  credentialNames: string[];
  movedRuns: number;
  resumed: boolean;
}

/** What "클라우드로 올리기" will do (confirmation dialog). */
export interface CloudConvertPreview {
  scripts: number;
  environments: string[];
  skippedEnvs: string[];
  suites: number;
  credentialNames: string[];
  runs: number;
  suiteRuns: number;
  chats: number;
  recordings: number;
}

/** One script that differs between the local project and its cloud project (합치기). */
export interface CloudMergeScriptView {
  path: string;
  /** The script's `name:` (shown first; the path is secondary). */
  name?: string;
  /** local → server rows (단계 문장 비교). */
  rows: ScriptDiffRowView[];
  summary: string;
  /** Name for "둘 다" (`이름-로컬.yaml`). */
  copyPath: string;
}

export type CloudMergeChoice = 'local' | 'server' | 'both';

/** 합치기 plan: target fixed = `uploadedTo.projectId`. */
export interface CloudMergePlan {
  localId: string;
  target: { projectId: string; name: string };
  /** Only on the local side → uploaded. */
  uploadScripts: string[];
  /** Same on both / server only → kept. */
  sameScripts: string[];
  serverOnlyScripts: string[];
  /** Different on both → pick per script. */
  differ: CloudMergeScriptView[];
  /** Test sets with the same name on both sides → pick local / server. */
  suiteChoices: { name: string; local: string[]; server: string[] }[];
  uploadSuites: string[];
  uploadEnvs: string[];
  runs: number;
}

export interface CloudMergeChoices {
  scripts: Record<string, CloudMergeChoice>;
  suites: Record<string, 'local' | 'server'>;
}

export interface CloudMemberView {
  userId: string;
  email: string;
  name: string;
  role: CloudRole;
  active: boolean;
}

export interface CloudActivityView {
  at: string;
  actor: string;
  kind: string;
  summary: string;
}

export interface VaultStatus {
  /** Secrets can be stored (OS-backed encryption). */
  available: boolean;
  backend?: string;
  /** Why storing is refused (shown as a warning). */
  reason?: string;
}

export type SuiteItemStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'skipped';

export interface SuiteRun {
  id: string;
  projectId: string;
  suiteId: string;
  suiteName: string;
  envId: string;
  envName: string;
  stopOnFailure: boolean;
  startedAt: string;
  finishedAt?: string;
  /** Worst status of the executed scripts; `running` until finished. */
  status: 'running' | 'passed' | 'failed' | 'error';
  cancelled?: boolean;
  /** Set when the app quit while the suite was running. */
  interrupted?: boolean;
  items: { script: string; runId?: string; status: SuiteItemStatus; alwaysRun?: boolean }[];
  /** `suite-runs/<id>/report.html` exists (computed when listed, never stored — ADR-032). */
  hasReport?: boolean;
}

export type ActivityActor = 'user' | 'ai' | 'mcp' | 'suite';

export interface ActivityEvent {
  at: string;
  kind: string;
  actor: ActivityActor;
  summary: string;
  ref?: { runId?: string; chatId?: string; script?: string; suiteRunId?: string; envId?: string; recordingId?: string; tcDocId?: string; tcId?: string };
}

export interface ActivityQuery {
  kinds?: string[];
  actors?: ActivityActor[];
  limit?: number;
}

export interface ScriptEntry {
  /** Path relative to scripts/ (forward slashes). */
  path: string;
  /** Script `name:` (when readable). */
  name?: string;
  mtimeMs: number;
  lastRun?: { runId: string; status: string; startedAt: string };
  /** Cloud project: server version, unsent save ("보내기 대기"), blocked save, saved by someone else meanwhile. */
  cloud?: { version?: number; author?: string; pending: boolean; blocked?: 'conflict' | 'rejected'; remoteNewer?: number };
}

/** 앱 설정 "화면 테마" (SPEC UI-디자인-시스템 "테마"): follow the OS, or fix light / dark. */
export type AppTheme = 'system' | 'light' | 'dark';

export interface AppSettings {
  /** AI chat model id/alias. Empty = SDK default. */
  aiModel: string;
  /** OS notifications for euta cloud events while the app runs (앱 설정 > 클라우드). Default on. */
  cloudNotify: boolean;
  /** Screen theme; main applies it as nativeTheme.themeSource. Default 'system'. */
  theme: AppTheme;
}

/** Cloud precheck next to the run button (SPEC 클라우드-앱-연동 "실행 위치 선택"). */
export interface CloudPrecheckView {
  ok: boolean;
  /** Why it cannot run in the cloud (Korean, one line each). */
  reasons: string[];
  /** Unsent local saves block a cloud run ("먼저 보내기"). */
  needsSend?: boolean;
  credentialNames?: string[];
}

export interface CloudRunRequest {
  /** Script path (scripts/) — or a suite. */
  script?: string;
  suiteId?: string;
  envId?: string;
  /** KEY=VALUE lines (${vars.*}). */
  vars?: string;
}

/** One cloud run in History (top-level; suite children on demand). */
export interface CloudRunItem {
  id: string;
  kind: 'script' | 'suite';
  status: string;
  flaky: boolean;
  /** Script path or suite name. */
  name: string;
  /** Suite runs: the (compact) suite id — matches `Suite.id` of the working copy. */
  suiteId?: string;
  scriptPath?: string;
  scriptVersion?: number;
  envName: string;
  source: string;
  sourceLabel: string;
  requestedBy: string;
  runnerLocation?: string;
  /** Time order key: started → scheduled → queued. */
  at: string;
  durationMs: number | null;
  summary?: RunSummaryView;
  resultFiles: 'none' | 'present' | 'expired';
  localModified: boolean;
  skipReason?: string;
  attempt: number;
  error?: string;
  children?: CloudRunItem[];
}

export interface CloudHistoryView {
  runs: CloudRunItem[];
  /** Local run id → cloud run id of the runs this PC uploaded ("클라우드에 올리기"). */
  uploads: Record<string, string>;
  /** Server reachable now (otherwise the list is empty and `error` says why). */
  online: boolean;
  error?: string;
  /** Can upload local runs (editor+, online). */
  canUpload: boolean;
}

export interface CloudUploadResult {
  cloudRunId: string;
  /** Linked cloud script version (same content hash), or "로컬 수정본". */
  version?: number;
  localModified: boolean;
}

export type CloudCadence =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; dayOfWeek: number; time: string }
  | { kind: 'cron'; expression: string };

export interface CloudScheduleView {
  id: string;
  name: string;
  target: { kind: 'script'; path: string | null } | { kind: 'suite'; suiteId?: string; name: string | null };
  envId?: string;
  envName: string | null;
  cadence: CloudCadence;
  /** "매일 09:00" … */
  cadenceLabel: string;
  cron: string;
  timeLimitSec: number | null;
  retryOnFailure: boolean;
  enabled: boolean;
  disabledReason: string | null;
  nextRunAt: string | null;
  intervalMin: number;
  createdBy: string;
  lastRun: { id: string; status: string; flaky: boolean; skipReason: string | null; finishedAt: string | null } | null;
  /** Average of the last 3 runs is longer than the interval. */
  warning?: string;
}

export interface CloudScheduleForm {
  name?: string;
  script?: string;
  suiteId?: string;
  envId?: string;
  cadence?: CloudCadence;
  timeLimitSec?: number | null;
  retryOnFailure?: boolean;
  enabled?: boolean;
}

/** An app notification (`GET /api/me/events`) as the OS notification shows it. */
export interface CloudNotificationView {
  /** App project id (cloud UUID without dashes). */
  projectId: string;
  runId?: string;
  kind: string;
  title: string;
  body: string;
}

export interface ProjectRunRequest {
  projectId: string;
  /** Script path relative to the project's scripts/ folder. */
  script: string;
  envId?: string;
  /** KEY=VALUE lines. */
  vars: string;
  /** KEY=VALUE lines merged over the environment for ${env.*}. */
  env: string;
  headless?: boolean;
  browser?: BrowserEngine;
}

// ---- demonstration recordings (SPEC 스크립트-작성-시연녹화) ----------------------

export type CheckpointKind = 'visible' | 'hidden' | 'textEquals' | 'textContains' | 'url' | 'count';

/** One recorded event as the panel shows it (engine RecordingEvent subset — never secret values). */
export interface RecEvent {
  seq: number;
  at: number;
  kind: string;
  url: string;
  target?: { chosen: Record<string, unknown> };
  value?: string;
  values?: string[];
  key?: string;
  files?: string[];
  download?: { name: string };
  nav?: 'start' | 'direct' | 'action';
  checkpoint?: { kind: CheckpointKind; value?: string | number };
  interactive?: boolean;
  sensitive?: boolean;
  secretHint?: string;
  note?: string;
  shot?: string;
  reason?: 'popup' | 'iframe';
}

export interface RecordingSummary {
  id: string;
  name: string;
  envId?: string;
  startUrl: string;
  startedAt: string;
  finishedAt?: string;
  events: number;
  checkpoints: number;
  notes: number;
  sensitive: number;
  /** Made with "시연으로 변환" for one TC (SPEC_TC-문서-변환). */
  tcRef?: { docId: string; tcId: string };
}

/** Live (or just finished) recording in the panel. */
export interface RecordingView {
  projectId: string;
  id: string;
  name: string;
  envId?: string;
  status: 'recording' | 'paused' | 'stopping' | 'stopped';
  checkpoint?: CheckpointKind;
  url: string;
  events: RecEvent[];
  notes: { afterSeq: number; at: number; text: string }[];
  startedAt: string;
  /** "시연으로 변환": the TC being demonstrated and the TC steps closed so far ([다음 단계]). */
  tcRef?: { docId: string; tcId: string };
  stepMarks?: { no: number; fromSeq: number; toSeq: number }[];
}

export interface RecordingStartRequest {
  envId?: string;
  /** Path relative to the environment's base URL (default "/") or an absolute URL. */
  startPath?: string;
  name?: string;
  /** "시연으로 변환": demonstrate this TC (the panel shows its steps). */
  tc?: { docId: string; tcId: string };
}

export type RecordingAction = 'pause' | 'resume' | 'checkpoint' | 'undo' | 'delete' | 'sensitive' | 'annotate' | 'expected' | 'note' | 'stop' | 'markStep';

export interface DraftView {
  yaml: string;
  /** Secret names the draft references / the environment lacks. */
  secrets: string[];
  missingSecrets: string[];
  /** Library path when saved. */
  path?: string;
}

// ---- script view · edit · history (SPEC 스크립트-보기-편집) -------------------------------

/** Who made a script version: app editor, AI save_script, recording "AI 없이 저장", an outside change, a restore. */
export type ScriptHistoryActor = 'user' | 'ai' | 'recording' | 'external' | 'restore';
export type ScriptHistoryKind = 'baseline' | 'create' | 'save' | 'external' | 'restore' | 'rename' | 'delete' | 'undelete';

export interface ScriptVersionView {
  version: number;
  at: string;
  actor: ScriptHistoryActor;
  kind: ScriptHistoryKind;
  /** Library path at that version. */
  path: string;
  /** sha256 of the content (engine scriptHash). */
  hash: string;
  /** "단계 2개 추가, 1개 변경" … */
  summary: string;
  /** Cloud project (server history): who saved it and from where (웹 · 앱 · AI · 앱 바깥 변경 · 되돌리기). */
  author?: string;
  origin?: string;
}

export interface DeletedScript {
  key: string;
  path: string;
  name?: string;
  at: string;
}

export interface ScriptHistoryView {
  key?: string;
  path: string;
  versions: ScriptVersionView[];
}

/** Latest run of a script, per step id ("3", "4.2"). */
export interface ScriptRunOverlay {
  runId: string;
  status: string;
  startedAt: string;
  envName?: string;
  /** The run executed exactly the current content (run.json scriptHash). */
  hashMatch: boolean;
  steps: Record<string, { status: string; durationMs: number; error?: string; screenshot?: string; manual?: { instruction: string; reason?: string } }>;
}

export interface ScriptDetailView {
  path: string;
  /** History key (stable across renames). */
  key?: string;
  /** Exact file text and its hash (the base of an edit). */
  text: string;
  hash: string;
  name?: string;
  /** Parsed script as written (undefined when the YAML does not parse). */
  script?: Record<string, unknown>;
  /** Blocking problems (YAML syntax, schema, vars references). */
  issues: ValidationIssueView[];
  /** Referenced secret names the selected environment lacks (names only — a warning). */
  missingSecrets: string[];
  /** Secret names of the selected environment (for the editor's secret picker). */
  secretNames: string[];
  envId?: string;
  envName?: string;
  /** CSS targets (unstable). */
  unstable: number;
  /** Secret-rule violations (`${secrets.*}` outside fill/type values) — a warning: saving is allowed, running errors. */
  ruleIssues: ValidationIssueView[];
  lastRun?: ScriptRunOverlay;
  latest?: ScriptVersionView;
}

/** Live validation of an edit (the serialized result). */
export interface ScriptDraftCheck {
  issues: ValidationIssueView[];
  missingSecrets: string[];
  unstable: number;
  ruleIssues: ValidationIssueView[];
}

export type ScriptSaveResult =
  | { ok: true; path: string; hash: string; version?: ScriptVersionView; pending?: boolean }
  | { ok: false; conflict: true; hash: string }
  /** `cloudConflict`: a cloud save met a newer server version (issues is empty then) — the conflict screen. */
  | { ok: false; conflict?: false; issues: ValidationIssueView[]; cloudConflict?: CloudConflictView };

export interface ScriptDiffRowView {
  kind: 'same' | 'added' | 'removed' | 'changed';
  depth: number;
  before?: string;
  after?: string;
}

export interface ScriptCompareView {
  key: string;
  from?: ScriptVersionView;
  to: ScriptVersionView;
  rows: ScriptDiffRowView[];
  header: string[];
  summary: string;
}

/** Edited script sent from the editor: header + steps with their source paths (engine ScriptEdit). */
export interface ScriptEditPayload {
  header: Record<string, unknown>;
  steps: StepEditPayload[];
}
export interface StepEditPayload {
  src?: (string | number)[];
  step: Record<string, unknown>;
  children?: StepEditPayload[];
}

// ---- TC documents (SPEC TC-문서-변환) ----------------------------------------------------

/** Conversion state of a TC or a precondition group: 대기 · 변환 중 · 완료 · 실패 · 제외. */
export type TcConversionStatus = 'pending' | 'converting' | 'done' | 'failed' | 'excluded';

export interface TcStepItem {
  no: number;
  action: string;
  expected?: string;
}

/** The normalized TC (engine `@euta/tc-doc` Tc) — preview and AI extraction shape. */
export interface TcInput {
  id: string;
  title: string;
  category?: string;
  description?: string;
  precondition?: string;
  screens?: string[];
  steps: TcStepItem[];
}

export interface TcConversion {
  status: TcConversionStatus;
  /** Library script path (relative to scripts/). */
  script?: string;
  manualSteps: number;
  /** "정보 부족" notes: what the document does not say. */
  missingInfo: string[];
  /** One-line cause (실패) or remark. */
  note?: string;
  chatId?: string;
  /** How it was converted. */
  by?: 'ai' | 'recording';
  updatedAt: string;
}

export interface TcDocTc {
  id: string;
  title: string;
  category?: string;
  description?: string;
  /** Original precondition sentence (kept for export). */
  precondition?: string;
  preconditionId?: string;
  screens?: string[];
  steps: TcStepItem[];
  conversion: TcConversion;
}

export interface TcPrecondition {
  id: string;
  text: string;
  script?: string;
  status: TcConversionStatus;
  note?: string;
  chatId?: string;
  updatedAt?: string;
}

/** projects/<id>/tc-docs/<docId>/tc-doc.json (SPEC 저장). The original file is never stored. */
export interface TcDoc {
  version: 1;
  id: string;
  name: string;
  source: { fileName: string; format: 'xlsx' | 'csv' | 'docx' | 'md'; layout: 'block' | 'table' | 'unknown'; importedAt: string; extractedByAi?: boolean };
  preconditions: TcPrecondition[];
  tcs: TcDocTc[];
  /** TC ids in check order — the conversion queue ([이어서 변환]). */
  queue: string[];
}

export interface TcDocSummary {
  id: string;
  name: string;
  fileName: string;
  importedAt: string;
  tcCount: number;
  done: number;
  failed: number;
  queued: number;
}

/**
 * A running auto conversion of a document (memory only): the app sends one AI message per queue item
 * — a precondition script first when the next TC needs one — and the next item when a message ends
 * (SPEC TC-문서-변환 "AI 변환", 2026-11-05).
 */
export interface TcConvertProgress {
  docId: string;
  docName: string;
  chatId: string;
  /** TCs this run finished (done · failed · excluded). */
  done: number;
  /** TCs this run converts at most (자동으로 진행할 개수). */
  total: number;
  /** The item of the message now running: its TC, and the precondition id when it is that TC's precondition script. */
  current?: { tcId: string; title: string; precondition?: string; preconditionText?: string; attempt: number };
  /** [중지] pressed; the running message is being stopped. */
  stopping?: boolean;
}

/** How the last auto conversion of a document stopped (memory only). */
export interface TcConvertEnd {
  reason: 'empty' | 'stopped' | 'limit' | 'error';
  done: number;
  total: number;
  message?: string;
  at: string;
}

/** Detail screen: the document plus what its scripts look like now. */
export interface TcDocView extends TcDoc {
  scripts: Record<string, { exists: boolean; name?: string; lastRun?: { status: string; startedAt: string } }>;
  /** The conversion chat working this document right now (a second start is refused). */
  activeChatId?: string;
  progress?: TcConvertProgress;
  lastRun?: TcConvertEnd;
}

export interface TcWarningView {
  code: string;
  message: string;
  tcId?: string;
  location?: string;
}

/** An import in progress (in memory until 확정 / 취소; the grid text never leaves main). */
export interface TcImportView {
  importId: string;
  projectId: string;
  fileName: string;
  format: TcDoc['source']['format'];
  layout: TcDoc['source']['layout'];
  tcs: TcInput[];
  warnings: TcWarningView[];
  /** ready = TCs to preview · needs-ai = layout not recognized · extracting = an AI chat is reading the grid. */
  status: 'ready' | 'needs-ai' | 'extracting';
  extractedByAi?: boolean;
  chatId?: string;
}

export interface TcImportConfirm {
  name: string;
  tcs: TcInput[];
  /** Precondition groups as the person left them (TCs without a precondition are in none). */
  preconditions: { text: string; tcIds: string[] }[];
}

export interface TcStepMapping {
  no: number;
  action: string;
  expected?: string;
  /** Script group for this TC step ("<no>. …"). */
  group?: string;
  /** auto = only automated steps · manual = only manual steps · partial = both · missing = no group. */
  kind: 'auto' | 'manual' | 'partial' | 'missing';
  manual: string[];
}

export interface TcMappingView {
  tcId: string;
  script?: string;
  exists: boolean;
  steps: TcStepMapping[];
  /** Steps of the script outside any TC-step group. */
  ungrouped: number;
}

export type TcSetGrouping = 'all' | 'category' | 'checked';

export interface TcSetPlan {
  sets: { key: string; name: string; category?: string; scripts: string[]; tcIds: string[]; preconditionScripts: string[] }[];
  /** TCs left out: not converted yet (or excluded, or the script is gone). */
  skipped: { tcId: string; title: string; reason: string }[];
}

export type TcExportFormat = 'xlsx' | 'md';
export type TcExportSource = { docId: string } | { suiteId: string } | { scripts: string[]; name: string };
