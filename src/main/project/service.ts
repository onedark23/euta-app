// Project service (SPEC 프로젝트-관리, ADR-016): one place that owns the project stores,
// the secret vault, activity logs, script libraries (+ watchers), runs in a project
// environment, suites and the per-project AI chat engines. Electron-free (safeStorage is
// injected) so it is unit-tested directly; index.ts only maps IPC onto it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { checkTargets, openRecorder, recordingToScript, Redactor, rewriteScript, runScript, scriptHash, slugify, validateScript, type Recorder, type RecorderView, type Recording, type RunHandle, type ScriptEdit } from '@euta/core';
import type { Page } from 'playwright';
import type {
  BusyWork,
  ActivityActor,
  ActivityEvent,
  ActivityQuery,
  AppSettings,
  ChatView,
  CheckpointKind,
  DraftView,
  Environment,
  EnvironmentView,
  HistoryItem,
  Project,
  ProjectRunRequest,
  ProjectSummary,
  ProjectView,
  RecordingAction,
  RecordingStartRequest,
  RecordingSummary,
  RecordingView,
  DeletedScript,
  ScriptCheck,
  ScriptCompareView,
  ScriptDetailView,
  ScriptDraftCheck,
  ScriptEditPayload,
  ScriptEntry,
  ScriptHistoryActor,
  ScriptHistoryKind,
  ScriptHistoryView,
  ScriptSaveResult,
  ScriptVersionView,
  SuiteRun,
  VaultStatus,
  ProjectCloudView,
  TcDocTc,
  TcImportView,
} from '../../shared/types.js';
import type { Outcome } from '../cloud/sync.js';
import { ChatEngine, type ChatContext, type QueryFn, type SdkModule } from '../ai/chat-engine.js';
import { ChatStore } from '../ai/chat-store.js';
import { findRunDir, listHistory } from '../history.js';
import type { LiveStore } from '../live-store.js';
import { loadSecrets, osInputOption, parseKeyValues } from '../runner.js';
import { ActivityLog } from './activity-log.js';
import { AppStateStore } from './app-state.js';
import { isId, writeTextAtomic } from './fsx.js';
import { diffScripts } from '../../shared/script-diff.js';
import { editorCheck, latestRunOverlay, secretRuleIssues } from './script-detail.js';
import { defaultDomains, koSecretRule } from '../../shared/secret-rules.js';
import { changeSummary, parseScript, ScriptHistory } from './script-history.js';
import { InputError, ProjectStore, type EnvInput, type SuiteInput } from './project-store.js';
import { RecordingStore, summarize } from './recording-store.js';
import { aiServerConfig, assembleRun, projectDirs, type ProjectRunContext } from './run-options.js';
import { NEW_SCRIPT_TEMPLATE, ScriptLibrary, scriptName } from './script-library.js';
import { listSuiteRuns, reviveSuiteRun, startSuite, type SuiteExecution } from './suite-runner.js';
import { buildSuiteReport, suiteReportPath, type SelectorCheck } from './suite-report.js';
import { Vault, type SafeStorageLike } from './vault.js';
import { countManualSteps, TcDocs, tcFileName } from './tc-docs.js';

export interface ProjectServiceEvents {
  projectsChanged?(): void;
  scriptsChanged?(projectId: string): void;
  suiteUpdate?(run: SuiteRun): void;
  activity?(projectId: string, e: ActivityEvent): void;
  chatUpdate?(projectId: string, chat: ChatView): void;
  recordingUpdate?(view: RecordingView): void;
  /** A TC document changed (conversion state, queue, rename, delete). */
  tcDocChanged?(projectId: string, docId: string): void;
  /** An import in progress changed (AI extraction submitted / ended). */
  tcImportUpdate?(view: TcImportView): void;
}

export interface ProjectServiceOptions {
  userData: string;
  safeStorage: SafeStorageLike;
  live: LiveStore;
  events?: ProjectServiceEvents;
  processEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => Date;
  /** AI chat engine dependencies (absent = chats unavailable, e.g. in some tests). */
  chat?: { loadSdk: () => Promise<SdkModule>; queryFn?: QueryFn; claudeExecutable?: () => string | undefined; throttleMs?: number };
  /** Recorder browser headless (tests only; the recorder is headed for people). */
  recorderHeadless?: boolean;
  /** Watch scripts/ folders for outside changes (default true). */
  watch?: boolean;
  watchDebounceMs?: number;
  /** Selector check for the set report's failed scripts (default engine checkTargets; false = off). */
  selectorCheck?: SelectorCheck | false;
}

interface RunInfo {
  projectId: string;
  actor: ActivityActor;
  envId?: string;
  envName?: string;
  script?: string;
  suiteRunId?: string;
  chatId?: string;
}

const SELF_CHANGE_MS = 2000;
const THEME_LABEL: Record<AppSettings['theme'], string> = { system: '시스템', light: '밝게', dark: '어둡게' };

/** Activity-log actor for a script history actor. */
const activityActor = (a: ScriptHistoryActor): ActivityActor => (a === 'ai' ? 'ai' : 'user');

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export type ScriptWriteResult =
  | { conflict?: false; path: string; hash: string; version?: ScriptVersionView; cloud?: { ticket: number; outcome: Promise<Outcome> } }
  | { conflict: true; hash: string };

/** Cloud side of a cloud project (CloudService, ADR-025) — what ProjectService needs from it. */
export interface CloudBridge {
  /** Throws InputError when this project cannot take script saves (viewer, signed out). */
  assertWritable(projectId: string): void;
  /** Queue a save of the (already written) working-copy file; sent at once when online. */
  enqueue(projectId: string, rel: string, content: string, origin: 'app' | 'ai_mcp' | 'external'): { ticket: number; outcome: Promise<Outcome> };
  /** An AI save met a conflict: take the server's latest; returns the message for the AI. */
  aiConflict(projectId: string, ticket: number, rel: string): Promise<string>;
  /** The script moved to a newer server version since the AI read it → the conflict message (nothing saved). */
  aiStale(projectId: string, rel: string, readVersion: number | undefined): string | undefined;
  projectView(projectId: string): ProjectCloudView | undefined;
  envExtra(projectId: string, envId: string): EnvironmentView['cloud'];
  summary(projectId: string): ProjectSummary['cloud'];
  scriptExtras(projectId: string): Record<string, NonNullable<ScriptEntry['cloud']>>;
  scriptBase(projectId: string, rel: string): { id: string; version: number; hash: string; author?: string } | undefined;
  opened(projectId: string): void;
  removed(projectId: string): void;
}

/** Cloud save origin for a script-history actor. */
const cloudOrigin = (a: ScriptHistoryActor): 'app' | 'ai_mcp' | 'external' => (a === 'ai' ? 'ai_mcp' : a === 'external' ? 'external' : 'app');

export class ProjectService {
  readonly store: ProjectStore;
  readonly vault: Vault;
  readonly appState: AppStateStore;
  private readonly live: LiveStore;
  private readonly ev: ProjectServiceEvents;
  private readonly logs = new Map<string, ActivityLog>();
  private readonly redactors = new Map<string, Redactor>();
  private readonly watchers = new Map<string, () => void>();
  private readonly knownScripts = new Map<string, Set<string>>();
  /** Own writes the watcher must not report: until when, and (for content writes) the hash written. */
  private readonly selfChanges = new Map<string, { until: number; hash?: string }>();
  private readonly suites = new Map<string, SuiteExecution>();
  private readonly chats = new Map<string, ChatEngine>();
  private readonly runInfo = new Map<string, RunInfo>();
  private readonly logged = new Set<string>();
  private currentId: string | undefined;
  private readonly disposeLive: () => void;
  /** The one recording in progress (or just finished, until the next one starts). */
  private rec?: { projectId: string; id: string; envId?: string; recorder: Recorder; view: RecordingView };
  private cloud?: CloudBridge;
  /** Cloud projects: per chat, the server version of each script when the AI read it. */
  private readonly aiReads = new Map<string, Map<string, number | undefined>>();
  /** TC documents (SPEC TC-문서-변환): imports, documents, conversion chats, sets, export. */
  readonly tcDocs: TcDocs;

  constructor(private readonly o: ProjectServiceOptions) {
    this.store = new ProjectStore(o.userData, o.now);
    this.vault = new Vault(o.userData, o.safeStorage, o.platform);
    this.appState = new AppStateStore(o.userData);
    this.live = o.live;
    this.ev = o.events ?? {};
    this.disposeLive = this.live.onLifecycle((view, type) => this.onRunLifecycle(view.runId, view.projectId, type, view));
    this.tcDocs = new TcDocs({
      projectDir: (id) => (this.store.require(id), this.store.dir(id)),
      log: (id, kind, actor, summary, ref) => this.log(id, kind, actor, summary, ref),
      scripts: (id) => this.scripts(id),
      readScript: (id, rel) => this.readScriptText(id, rel),
      chatEngine: (id) => this.chatEngine(id),
      docChanged: (id, docId) => this.ev.tcDocChanged?.(id, docId),
      importChanged: (v) => this.ev.tcImportUpdate?.(v),
      ...(o.now ? { now: o.now } : {}),
    });
  }

  /** Attach the cloud side (cloud projects route script saves and views through it). */
  setCloud(bridge: CloudBridge): void {
    this.cloud = bridge;
  }

  isCloud(projectId: string): boolean {
    return this.store.isCloud(projectId);
  }

  // ---- projects -------------------------------------------------------------

  /** Project that owns a run dir `<project folder>/runs/<runId>` (local or cloud working copy). */
  projectOfRunDir(runDir: string): string | undefined {
    const d = resolve(runDir);
    for (const p of this.store.list()) {
      for (const sub of ['runs', 'cloud-runs']) {
        const runs = resolve(this.store.dir(p.id), sub) + sep;
        if (d.startsWith(runs) && !d.slice(runs.length).includes(sep)) return p.id;
      }
    }
    return undefined;
  }

  current(): string | undefined {
    return this.currentId && this.store.get(this.currentId) ? this.currentId : undefined;
  }

  /** Runs dir of the current project (terminal EUTA_RUNS_DIR). */
  currentRunsDir(): string | undefined {
    const id = this.current();
    return id ? projectDirs(this.store.dir(id)).runs : undefined;
  }

  list(): ProjectSummary[] {
    const recent = this.appState.get().recent;
    const rank = (id: string): number => {
      const i = recent.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const running = new Map<string, number>();
    for (const r of this.live.list()) if (r.projectId && r.status === 'running') running.set(r.projectId, (running.get(r.projectId) ?? 0) + 1);
    return this.store
      .list()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || rank(a.id) - rank(b.id) || b.lastOpenedAt.localeCompare(a.lastOpenedAt))
      .map((p) => {
        const cloud = p.cloud ? this.cloud?.summary(p.id) : undefined;
        return { id: p.id, name: p.name, pinned: p.pinned, lastOpenedAt: p.lastOpenedAt, running: running.get(p.id) ?? 0, ...(cloud ? { cloud } : {}) };
      });
  }

  view(id: string): ProjectView {
    const p = this.store.require(id);
    const dir = this.store.dir(id);
    const cloudView = p.cloud ? this.cloud?.projectView(id) : undefined;
    return {
      ...structuredClone(p),
      environments: p.environments.map((e) => this.envView(id, e)),
      dirs: { root: dir, scripts: join(dir, 'scripts'), runs: join(dir, 'runs') },
      ...(cloudView ? { cloudView } : {}),
    };
  }

  private envView(projectId: string, e: Environment): EnvironmentView {
    const domains = { domains: this.domainsFor(projectId, e), ...(!this.store.isCloud(projectId) && !e.allowedDomains ? { domainsDefault: true } : {}) };
    if (e.secretsFile) {
      const r = loadSecrets(e.secretsFile);
      return { ...structuredClone(e), secretNames: Object.keys(r.secrets).sort(), secretSource: 'file', ...domains, ...(r.error ? { secretsError: r.error } : {}) };
    }
    const cloud = this.store.isCloud(projectId) ? this.cloud?.envExtra(projectId, e.id) : undefined;
    return { ...structuredClone(e), secretNames: this.vault.names(projectId, e.id), secretSource: 'vault', ...domains, ...(cloud ? { cloud } : {}) };
  }

  /**
   * Allowed domains of the secret rule for runs in an environment (SPEC 프로젝트-관리 "secrets 규칙"):
   * local = the saved list or the address host; cloud project = the server environment's list.
   */
  domainsFor(projectId: string, env: Environment | undefined): string[] {
    if (!env) return [];
    if (this.store.isCloud(projectId)) return [...(this.cloud?.envExtra(projectId, env.id)?.allowedDomains ?? [])];
    return defaultDomains(env);
  }

  /** The advanced terminal is not tied to an environment: the union of the project's allowed domains. */
  terminalDomains(projectId: string): string[] {
    const p = this.store.get(projectId);
    return p ? [...new Set(p.environments.flatMap((e) => this.domainsFor(projectId, e)))] : [];
  }

  create(input: { name?: unknown; description?: unknown; baseUrl?: unknown }): ProjectView {
    const p = this.store.create(input);
    this.log(p.id, 'project.created', 'user', `프로젝트 생성: ${p.name}`);
    if (typeof input.baseUrl === 'string' && input.baseUrl.trim()) {
      try {
        this.upsertEnv(p.id, undefined, { name: 'default', baseUrl: input.baseUrl });
      } catch (e) {
        this.store.delete(p.id);
        throw e;
      }
    }
    this.open(p.id);
    return this.view(p.id);
  }

  open(id: string): ProjectView {
    this.store.touch(id);
    this.appState.touchProject(id);
    this.currentId = id;
    this.ensureWatcher(id);
    if (this.store.isCloud(id)) this.cloud?.opened(id);
    this.ev.projectsChanged?.();
    return this.view(id);
  }

  update(id: string, patch: Record<string, unknown>): ProjectView {
    const { project, changed } = this.store.update(id, patch ?? {});
    const info = changed.filter((k) => k === 'name' || k === 'description' || k === 'pinned');
    const settings = changed.filter((k) => k === 'browser' || k === 'defaultEnvId');
    if (info.length) this.log(id, 'project.updated', 'user', `프로젝트 정보 변경: ${info.join(', ')}${info.includes('name') ? ` → ${project.name}` : ''}`);
    if (settings.length) this.log(id, 'settings.changed', 'user', `프로젝트 설정 변경: ${settings.map((k) => (k === 'browser' ? `browser=${project.browser.engine}${project.browser.device ? `/${project.browser.device}` : ''}${project.browser.headless ? ' headless' : ' headed'}` : `기본 환경=${project.environments.find((e) => e.id === project.defaultEnvId)?.name ?? '-'}`)).join(', ')}`);
    if (changed.length) this.ev.projectsChanged?.();
    return this.view(id);
  }

  /** This PC's work an app restart would cut off (SPEC 앱-배포-업데이트 "실행 중 보호"). */
  busyWork(): BusyWork {
    const runs = this.live.list().filter((r) => r.status === 'running' && r.source !== 'cloud').length;
    const chats = [...this.chats.values()].filter((c) => c.busy()).length;
    return { runs, recording: !!this.rec && !this.rec.recorder.isStopped, chats };
  }

  /** Why the project cannot be deleted right now, or undefined. */
  deleteBlocker(id: string): string | undefined {
    // Cloud runs keep going on the server — they do not block removing this PC's working copy.
    const running = this.live.list().filter((r) => r.projectId === id && r.status === 'running' && r.source !== 'cloud').length;
    if (running) return `실행 중인 run 이 ${running}개 있습니다. 끝난 뒤 삭제하세요.`;
    if ([...this.suites.values()].some((s) => s.run.projectId === id)) return '테스트 세트가 실행 중입니다.';
    if (this.chats.get(id)?.busy()) return 'AI 채팅이 응답 중입니다.';
    if (this.rec?.projectId === id && !this.rec.recorder.isStopped) return '시연 녹화가 진행 중입니다. 녹화를 끝낸 뒤 삭제하세요.';
    return undefined;
  }

  async delete(id: string): Promise<void> {
    this.store.require(id);
    const blocker = this.deleteBlocker(id);
    if (blocker) throw new InputError(blocker);
    this.watchers.get(id)?.();
    this.watchers.delete(id);
    if (this.store.isCloud(id)) this.cloud?.removed(id);
    const chats = this.chats.get(id);
    this.chats.delete(id);
    await chats?.dispose();
    this.store.delete(id);
    this.vault.removePrefix(id);
    this.appState.forgetProject(id);
    this.logs.delete(id);
    this.redactors.delete(id);
    this.knownScripts.delete(id);
    if (this.currentId === id) this.currentId = undefined;
    this.ev.projectsChanged?.();
  }

  /** Stop watching / chatting a project whose folder is about to move (올리기 = 전환 · 합치기). */
  async release(id: string): Promise<void> {
    this.store.require(id);
    const blocker = this.deleteBlocker(id);
    if (blocker) throw new InputError(blocker);
    this.watchers.get(id)?.();
    this.watchers.delete(id);
    const chats = this.chats.get(id);
    this.chats.delete(id);
    await chats?.dispose();
  }

  /** The move did not happen after `release`: watch the project again if it is open. */
  reattach(id: string): void {
    if (this.currentId === id && this.store.get(id)) this.ensureWatcher(id);
  }

  /**
   * The local project `from` became the cloud project `to` (its data was moved there): `to` takes
   * its place in the sidebar (pinned · recent order) and `from` is removed. Emits nothing — the
   * caller emits once at the end of the local phase.
   */
  converted(from: string, to: string): void {
    const p = this.store.require(from);
    this.store.setMeta(to, { pinned: p.pinned, createdAt: p.createdAt, lastOpenedAt: p.lastOpenedAt });
    this.store.delete(from);
    this.vault.removePrefix(from);
    this.appState.replaceProject(from, to);
    for (const id of [from, to]) {
      this.logs.delete(id);
      this.redactors.delete(id);
      this.knownScripts.delete(id);
      this.watchers.get(id)?.();
      this.watchers.delete(id);
    }
    if (this.currentId === from) this.currentId = to;
    if (this.currentId === to) this.ensureWatcher(to);
  }

  // ---- environments & secrets ------------------------------------------------

  upsertEnv(projectId: string, envId: string | undefined, input: EnvInput): ProjectView {
    const before = envId ? structuredClone(this.store.env(projectId, envId)) : undefined;
    const { env, created } = this.store.upsertEnv(projectId, envId || undefined, input);
    this.redactors.delete(projectId);
    if (created) this.log(projectId, 'env.created', 'user', `환경 추가: ${env.name}${env.baseUrl ? ` (${env.baseUrl})` : ''}`, { envId: env.id });
    else {
      const what: string[] = [];
      if (before?.name !== env.name) what.push(`이름 ${before?.name} → ${env.name}`);
      if (before?.baseUrl !== env.baseUrl) what.push(`주소 ${env.baseUrl || '-'}`);
      if (JSON.stringify(before?.vars) !== JSON.stringify(env.vars)) what.push(`변수 ${Object.keys(env.vars).join(', ') || '없음'}`);
      if ((before?.secretsFile ?? '') !== (env.secretsFile ?? '')) what.push(env.secretsFile ? 'secrets: 외부 파일' : 'secrets: vault');
      if (JSON.stringify(before?.allowedDomains ?? null) !== JSON.stringify(env.allowedDomains ?? null)) what.push(`허용 도메인 ${env.allowedDomains ? env.allowedDomains.join(', ') || '없음' : '기본(주소 호스트)'}`);
      if (what.length) this.log(projectId, 'env.updated', 'user', `환경 변경: ${env.name} — ${what.join(' · ')}`, { envId: env.id });
    }
    return this.view(projectId);
  }

  deleteEnv(projectId: string, envId: string): ProjectView {
    const env = this.store.deleteEnv(projectId, envId);
    this.vault.removePrefix(projectId, envId);
    this.redactors.delete(projectId);
    this.log(projectId, 'env.deleted', 'user', `환경 삭제: ${env.name}`, { envId });
    return this.view(projectId);
  }

  vaultStatus(): VaultStatus {
    return this.vault.status();
  }

  /** Store a secret value (write-only: the value is never returned). */
  setSecret(projectId: string, envId: string, name: string, value: string): string[] {
    const env = this.store.env(projectId, envId);
    if (env.secretsFile) throw new InputError('this environment reads secrets from an external file');
    const existed = this.vault.names(projectId, envId).includes(name);
    this.vault.set(projectId, envId, name, value);
    const names = this.vault.names(projectId, envId);
    this.store.setSecretNames(projectId, envId, names);
    this.redactors.delete(projectId);
    this.log(projectId, 'secret.set', 'user', `secret ${existed ? '교체' : '설정'}: ${name} (${env.name})`, { envId });
    return names;
  }

  removeSecret(projectId: string, envId: string, name: string): string[] {
    const env = this.store.env(projectId, envId);
    if (this.vault.remove(projectId, envId, name)) {
      this.log(projectId, 'secret.removed', 'user', `secret 삭제: ${name} (${env.name})`, { envId });
    }
    const names = this.vault.names(projectId, envId);
    this.store.setSecretNames(projectId, envId, names);
    this.redactors.delete(projectId);
    return names;
  }

  /** Secret values of an environment — main process only. */
  private secretsFor(projectId: string, env: Environment | undefined): { secrets: Record<string, string>; error?: string } {
    if (!env) return { secrets: {} };
    if (env.secretsFile) return loadSecrets(env.secretsFile);
    const r = this.vault.resolve(projectId, env.id);
    return { secrets: r.secrets, ...(r.failed.length ? { error: `secret 을 복호화하지 못했습니다: ${r.failed.join(', ')} — 다시 입력하세요` } : {}) };
  }

  /** Masks every secret value of the project (activity summaries, chat log lines). */
  private redactor(projectId: string): Redactor {
    let r = this.redactors.get(projectId);
    if (!r) {
      const p = this.store.get(projectId);
      const values = p ? p.environments.flatMap((e) => Object.values(this.secretsFor(projectId, e).secrets)) : [];
      r = new Redactor(values);
      this.redactors.set(projectId, r);
    }
    return r;
  }

  private envFor(p: Project, envId: string | undefined): Environment | undefined {
    if (envId) {
      const e = p.environments.find((x) => x.id === envId);
      if (!e) throw new InputError('environment not found');
      return e;
    }
    return p.environments.find((x) => x.id === p.defaultEnvId) ?? p.environments[0];
  }

  runContext(projectId: string, envId?: string): ProjectRunContext {
    const p = this.store.require(projectId);
    const env = this.envFor(p, envId);
    const { secrets } = this.secretsFor(projectId, env);
    return {
      project: structuredClone(p),
      projectDir: this.store.dir(projectId),
      ...(env ? { env: structuredClone(env) } : {}),
      secrets,
      allowedDomains: this.domainsFor(projectId, env),
      ...(this.o.processEnv ? { processEnv: this.o.processEnv } : {}),
    };
  }

  // ---- activity --------------------------------------------------------------

  activityLog(projectId: string): ActivityLog {
    let l = this.logs.get(projectId);
    if (!l) {
      l = new ActivityLog(this.store.dir(projectId), {
        ...(this.o.now ? { now: this.o.now } : {}),
        redact: (s) => this.redactor(projectId).redactString(s),
        onAppend: (e) => this.ev.activity?.(projectId, e),
      });
      this.logs.set(projectId, l);
    }
    return l;
  }

  log(projectId: string, kind: string, actor: ActivityActor, summary: string, ref?: ActivityEvent['ref']): void {
    if (!this.store.get(projectId)) return;
    this.activityLog(projectId).append(kind, actor, summary, ref);
  }

  activity(projectId: string, q: ActivityQuery = {}): ActivityEvent[] {
    this.store.require(projectId);
    return this.activityLog(projectId).list(q);
  }

  private onRunLifecycle(runId: string, projectId: string | undefined, type: 'run.started' | 'run.finished', view: { name: string; status: string; source: string; summary?: { total: number; passed: number } }): void {
    const info = this.runInfo.get(runId);
    const pid = info?.projectId ?? projectId;
    if (!pid || !this.store.get(pid)) return;
    const key = `${runId}:${type}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    if (this.logged.size > 20_000) this.logged.clear();
    const actor: ActivityActor = info?.actor ?? (view.source === 'ai' ? 'ai' : view.source === 'mcp' ? 'mcp' : 'user');
    const where = info?.envName ? ` @ ${info.envName}` : '';
    const ref = { runId, ...(info?.envId ? { envId: info.envId } : {}), ...(info?.script ? { script: info.script } : {}), ...(info?.suiteRunId ? { suiteRunId: info.suiteRunId } : {}), ...(info?.chatId ? { chatId: info.chatId } : {}) };
    if (type === 'run.started') this.log(pid, 'run.started', actor, `실행 시작: ${view.name}${where}`, ref);
    else {
      const s = view.summary;
      this.log(pid, 'run.finished', actor, `실행 종료: ${view.name}${where} → ${view.status}${s ? ` (${s.passed}/${s.total})` : ''}`, ref);
      this.runInfo.delete(runId);
    }
  }

  // ---- scripts -----------------------------------------------------------------

  library(projectId: string): ScriptLibrary {
    const d = projectDirs(this.store.dir(projectId));
    return new ScriptLibrary(d.scripts, d.runs);
  }

  scripts(projectId: string): ScriptEntry[] {
    this.store.require(projectId);
    const list = this.library(projectId).list();
    this.knownScripts.set(projectId, new Set(list.map((s) => s.path)));
    if (this.store.isCloud(projectId) && this.cloud) {
      const extra = this.cloud.scriptExtras(projectId);
      return list.map((s) => ({ ...s, cloud: extra[s.path] ?? { pending: false } }));
    }
    return list;
  }

  // ---- cloud working-copy file helpers (the sync engine's file side) ---------------------------

  readLocalScript(projectId: string, rel: string): string | undefined {
    return this.readScriptText(projectId, rel);
  }

  /** Replace a working-copy file with server content (an own write — the watcher ignores it). */
  writeLocalScript(projectId: string, rel: string, text: string): void {
    const lib = this.library(projectId);
    const abs = lib.abs(rel);
    this.selfChanges.set(`${projectId}:${lib.rel(abs) ?? rel}`, { until: Date.now() + SELF_CHANGE_MS, hash: scriptHash(text) });
    writeTextAtomic(abs, text);
    this.afterScriptOp(projectId);
  }

  deleteLocalScript(projectId: string, rel: string): void {
    const abs = this.library(projectId).abs(rel);
    if (!existsSync(abs)) return;
    this.markSelf(projectId, rel);
    rmSync(abs, { force: true });
    this.afterScriptOp(projectId);
  }

  renameLocalScript(projectId: string, from: string, to: string): void {
    const lib = this.library(projectId);
    const a = lib.abs(from);
    const b = lib.abs(to);
    if (!existsSync(a)) return;
    this.markSelf(projectId, from, to);
    mkdirSync(dirname(b), { recursive: true });
    renameSync(a, b);
    this.renameTcRefs(projectId, from, to);
    this.afterScriptOp(projectId);
  }

  /** TC documents keep pointing at a renamed script. */
  private renameTcRefs(projectId: string, from: string, to: string): void {
    try {
      for (const docId of this.tcDocs.store(projectId).renameScriptRefs(from, to)) this.ev.tcDocChanged?.(projectId, docId);
    } catch {
      /* never blocks a rename */
    }
  }

  listLocalScripts(projectId: string): string[] {
    return this.library(projectId).list().map((s) => s.path);
  }

  private markSelf(projectId: string, ...paths: string[]): void {
    const until = Date.now() + SELF_CHANGE_MS;
    for (const p of paths) this.selfChanges.set(`${projectId}:${p}`, { until });
  }

  private isSelf(projectId: string, rel: string, t = Date.now()): boolean {
    const self = this.selfChanges.get(`${projectId}:${rel}`);
    if (!self || self.until <= t) return false;
    if (self.hash === undefined) return true;
    // A content write: only our own bytes count as "self" — an outside edit right after it does not.
    const disk = this.readScriptText(projectId, rel);
    return disk !== undefined && scriptHash(disk) === self.hash;
  }

  private readScriptText(projectId: string, rel: string): string | undefined {
    try {
      return readFileSync(this.library(projectId).abs(rel), 'utf8');
    } catch {
      return undefined;
    }
  }

  private afterScriptOp(projectId: string): void {
    this.knownScripts.set(projectId, new Set(this.library(projectId).list().map((s) => s.path)));
    this.ev.scriptsChanged?.(projectId);
  }

  createScript(projectId: string, path?: string, name?: string): string {
    this.store.require(projectId);
    const lib = this.library(projectId);
    const rel = lib.freePath(path || 'new-script.yaml');
    this.writeScript(projectId, rel, NEW_SCRIPT_TEMPLATE(name || basename(rel, extname(rel))), 'user', { exclusive: true, kind: 'create' });
    this.log(projectId, 'script.created', 'user', `스크립트 생성: ${rel}`, { script: rel });
    return rel;
  }

  importScript(projectId: string, source: string): string {
    this.store.require(projectId);
    const { rel: got, content } = this.library(projectId).readImport(source);
    this.writeScript(projectId, got, content, 'user', { exclusive: true, kind: 'create' });
    this.log(projectId, 'script.imported', 'user', `스크립트 가져오기: ${got}`, { script: got });
    return got;
  }

  renameScript(projectId: string, from: string, to: string): string {
    this.store.require(projectId);
    const lib = this.library(projectId);
    this.markSelf(projectId, from, to);
    const before = this.readScriptText(projectId, from);
    const rel = lib.rename(from, to);
    this.markSelf(projectId, rel);
    this.scriptHistory(projectId).rename(lib.rel(lib.abs(from)) ?? from, rel, before, 'user');
    this.store.renameScriptRefs(projectId, from, rel);
    this.renameTcRefs(projectId, from, rel);
    this.log(projectId, 'script.renamed', 'user', `스크립트 이름 변경: ${from} → ${rel}`, { script: rel });
    this.afterScriptOp(projectId);
    return rel;
  }

  deleteScript(projectId: string, rel: string): void {
    this.store.require(projectId);
    this.markSelf(projectId, rel);
    const before = this.readScriptText(projectId, rel);
    this.library(projectId).delete(rel);
    this.scriptHistory(projectId).remove(rel, before, 'user', before ? scriptName(before) : undefined);
    this.store.renameScriptRefs(projectId, rel, undefined);
    this.log(projectId, 'script.deleted', 'user', `스크립트 삭제: ${rel}`, { script: rel });
    this.afterScriptOp(projectId);
  }

  exportScript(projectId: string, rel: string, dest: string): void {
    this.store.require(projectId);
    this.library(projectId).export(rel, dest);
  }

  scriptAbsPath(projectId: string, rel: string): string {
    this.store.require(projectId);
    const p = this.library(projectId).abs(rel);
    if (!existsSync(p)) throw new InputError('script not found');
    return p;
  }

  checkScript(projectId: string, rel: string, envId: string | undefined, varsText: string, envText: string): ScriptCheck {
    const ctx = this.runContext(projectId, envId);
    const { error } = this.secretsFor(projectId, ctx.env);
    const a = assembleRun(ctx, { env: parseKeyValues(envText) });
    let path = rel;
    let source: string;
    try {
      path = this.library(projectId).abs(rel);
      source = readFileSync(path, 'utf8');
    } catch {
      return { path, issues: [{ path: '(file)', message: 'cannot read script file' }], secretNames: Object.keys(a.secrets), ...(error ? { secretsError: error } : {}) };
    }
    const issues = [...validateScript(source, { env: a.env, vars: parseKeyValues(varsText), secrets: a.secrets }), ...secretRuleIssues(source)].map((i) => ({ ...i, message: koSecretRule(i.message) }));
    const name = scriptName(source);
    return { path: rel, ...(name ? { name } : {}), issues, secretNames: Object.keys(a.secrets), ...(error ? { secretsError: error } : {}) };
  }

  // ---- script view · edit · history (SPEC 스크립트-보기-편집, ADR-018) ---------------------

  scriptHistory(projectId: string): ScriptHistory {
    return new ScriptHistory(this.store.dir(projectId), this.o.now);
  }

  /**
   * The one write path for library scripts: app editor, AI save_script, recording draft,
   * restore, create/import. Conflict check against `baseHash`, an `external` version first when
   * the file changed behind the app's back, atomic replace, a history version, activity.
   */
  writeScript(
    projectId: string,
    rel: string,
    content: string,
    actor: ScriptHistoryActor,
    o: { kind?: ScriptHistoryKind; baseHash?: string; force?: boolean; exclusive?: boolean } = {},
  ): ScriptWriteResult {
    this.store.require(projectId);
    const lib = this.library(projectId);
    const abs = lib.abs(rel);
    const clean = lib.rel(abs) ?? rel;
    const hist = this.scriptHistory(projectId);
    let disk: string | undefined;
    try {
      disk = readFileSync(abs, 'utf8');
    } catch {
      disk = undefined;
    }
    if (disk !== undefined && o.exclusive) throw new InputError('a script with that name already exists');
    if (disk !== undefined && o.baseHash && !o.force && scriptHash(disk) !== o.baseHash) return { conflict: true, hash: scriptHash(disk) };
    if (this.store.isCloud(projectId) && this.cloud) return this.writeCloudScript(projectId, abs, clean, content, disk, actor, o.kind);
    if (disk !== undefined) hist.sync(clean, disk, 'external');
    this.selfChanges.set(`${projectId}:${clean}`, { until: Date.now() + SELF_CHANGE_MS, hash: scriptHash(content) });
    writeTextAtomic(abs, content);
    const kind: ScriptHistoryKind = o.kind ?? (disk === undefined ? 'create' : 'save');
    const v = hist.record(clean, content, actor, kind, { force: kind === 'restore' || kind === 'undelete' });
    if (v && kind === 'save') this.log(projectId, 'script.changed', activityActor(actor), `스크립트 수정${actor === 'ai' ? ' (AI)' : ''}: ${clean} — ${v.summary}`, { script: clean });
    // New files from the AI (save_script): the other create callers log their own kind.
    if (kind === 'create' && actor === 'ai') this.log(projectId, 'script.created', 'ai', `스크립트 추가 (AI): ${clean}`, { script: clean });
    this.afterScriptOp(projectId);
    return { path: clean, hash: scriptHash(content), ...(v ? { version: v } : {}) };
  }

  /**
   * writeScript for a cloud project (SPEC 클라우드-앱-연동 "스크립트 저장"): the working copy is written,
   * then the save is queued for the server with its base version — sent at once when online,
   * kept in pending/ when offline. Server history replaces the local script-history here.
   */
  private writeCloudScript(projectId: string, abs: string, clean: string, content: string, disk: string | undefined, actor: ScriptHistoryActor, kind?: ScriptHistoryKind): ScriptWriteResult {
    const cloud = this.cloud!;
    cloud.assertWritable(projectId);
    const hash = scriptHash(content);
    if (disk !== undefined && scriptHash(disk) === hash && cloud.scriptBase(projectId, clean)?.hash === hash) return { path: clean, hash };
    this.selfChanges.set(`${projectId}:${clean}`, { until: Date.now() + SELF_CHANGE_MS, hash });
    writeTextAtomic(abs, content);
    const q = cloud.enqueue(projectId, clean, content, cloudOrigin(actor));
    const k: ScriptHistoryKind = kind ?? (disk === undefined ? 'create' : 'save');
    if (k === 'save' || (k === 'restore' && disk !== undefined)) this.log(projectId, 'script.changed', activityActor(actor), `스크립트 수정${actor === 'ai' ? ' (AI)' : ''}: ${clean} — ${changeSummary(disk, content)}`, { script: clean });
    if (k === 'create' && actor === 'ai') this.log(projectId, 'script.created', 'ai', `스크립트 추가 (AI): ${clean}`, { script: clean });
    this.afterScriptOp(projectId);
    return { path: clean, hash, cloud: q };
  }

  /** Detail screen: text, parsed script, validation, warnings, latest-run overlay, history head. */
  scriptDetail(projectId: string, rel: string, envId?: string): ScriptDetailView {
    const p = this.store.require(projectId);
    const lib = this.library(projectId);
    const abs = this.scriptAbsPath(projectId, rel);
    const clean = lib.rel(abs) ?? rel;
    const text = readFileSync(abs, 'utf8');
    const hash = scriptHash(text);
    const hist = this.scriptHistory(projectId);
    const cloudBase = this.store.isCloud(projectId) ? this.cloud?.scriptBase(projectId, clean) : undefined;
    if (!this.store.isCloud(projectId)) hist.sync(clean, text, 'external');
    const env = this.envFor(p, envId || undefined);
    const ctx = this.runContext(projectId, env?.id);
    const a = assembleRun(ctx);
    const secretNames = env ? this.envView(projectId, env).secretNames : [];
    const c = editorCheck(text, a.env, secretNames);
    const key = this.store.isCloud(projectId) ? cloudBase?.id : hist.keyOf(clean);
    const latest: ScriptVersionView | undefined = this.store.isCloud(projectId)
      ? cloudBase && { version: cloudBase.version, at: '', actor: 'user', kind: 'save', path: clean, hash: cloudBase.hash, summary: '', ...(cloudBase.author ? { author: cloudBase.author } : {}) }
      : key
        ? hist.latest(key)
        : undefined;
    const lastRun = latestRunOverlay(projectDirs(this.store.dir(projectId)).runs, abs, hash);
    const name = c.script && typeof c.script.name === 'string' ? c.script.name : scriptName(text);
    return {
      path: clean,
      ...(key ? { key } : {}),
      text,
      hash,
      ...(name ? { name } : {}),
      ...(c.script ? { script: c.script } : {}),
      issues: c.issues,
      missingSecrets: c.missingSecrets,
      secretNames,
      ...(env ? { envId: env.id, envName: env.name } : {}),
      unstable: c.unstable,
      ruleIssues: c.ruleIssues,
      ...(lastRun ? { lastRun } : {}),
      ...(latest ? { latest } : {}),
    };
  }

  /** Serialize an edit onto its base text (comments/order kept for untouched parts). */
  renderEdit(baseText: string, edit: ScriptEditPayload): string {
    return rewriteScript(baseText, edit as ScriptEdit);
  }

  /** Live validation of an edit (what would be saved). */
  checkDraft(projectId: string, baseText: string, edit: ScriptEditPayload, envId?: string): ScriptDraftCheck {
    const p = this.store.require(projectId);
    const env = this.envFor(p, envId || undefined);
    const a = assembleRun(this.runContext(projectId, env?.id));
    const c = editorCheck(this.renderEdit(baseText, edit), a.env, env ? this.envView(projectId, env).secretNames : []);
    return { issues: c.issues, missingSecrets: c.missingSecrets, unstable: c.unstable, ruleIssues: c.ruleIssues };
  }

  /** [저장]: only when the result validates; `force` = "내 것으로 저장" over an outside change. */
  saveScript(projectId: string, rel: string, baseText: string, edit: ScriptEditPayload, o: { envId?: string; force?: boolean } = {}): ScriptSaveResult {
    const check = this.checkDraft(projectId, baseText, edit, o.envId);
    if (check.issues.length) return { ok: false, issues: check.issues };
    const text = this.renderEdit(baseText, edit);
    const r = this.writeScript(projectId, rel, text, 'user', { baseHash: scriptHash(baseText), ...(o.force ? { force: true } : {}) });
    if (r.conflict) return { ok: false, conflict: true, hash: r.hash };
    return { ok: true, path: r.path, hash: r.hash, ...(r.version ? { version: r.version } : {}) };
  }

  scriptVersions(projectId: string, rel: string): ScriptHistoryView {
    this.store.require(projectId);
    const hist = this.scriptHistory(projectId);
    const clean = this.library(projectId).rel(this.library(projectId).abs(rel)) ?? rel;
    const key = hist.keyOf(clean);
    return { ...(key ? { key } : {}), path: clean, versions: key ? hist.versions(key) : [] };
  }

  /** Step-sentence comparison of version `to` against `from` (default: the version before `to`). */
  compareVersions(projectId: string, key: string, to: number, from?: number): ScriptCompareView {
    this.store.require(projectId);
    const hist = this.scriptHistory(projectId);
    const list = hist.versions(key);
    const target = list.find((v) => v.version === to);
    if (!target) throw new InputError('version not found');
    const base = from !== undefined ? list.find((v) => v.version === from) : [...list].reverse().find((v) => v.version < to);
    const after = hist.content(key, to) ?? '';
    const before = base ? hist.content(key, base.version) : undefined;
    const d = diffScripts(before === undefined ? undefined : (parseScript(before) ?? {}), parseScript(after) ?? {});
    return { key, ...(base ? { from: base } : {}), to: target, rows: d.rows, header: d.header, summary: d.summary };
  }

  /** "이 버전으로 되돌리기": the current content stays in history, then the old one replaces it. */
  restoreVersion(projectId: string, key: string, version: number): ScriptWriteResult {
    this.store.require(projectId);
    const hist = this.scriptHistory(projectId);
    const content = hist.content(key, version);
    if (content === undefined) throw new InputError('version not found');
    const cur = hist.pathOf(key);
    if (!cur) throw new InputError('this script was deleted — restore it from 삭제된 스크립트');
    const r = this.writeScript(projectId, cur, content, 'restore', { kind: 'restore' });
    if (!r.conflict) this.log(projectId, 'script.restored', 'user', `스크립트 되돌리기: ${cur} → 버전 ${version}`, { script: cur });
    return r;
  }

  deletedScripts(projectId: string): DeletedScript[] {
    this.store.require(projectId);
    return this.scriptHistory(projectId).deleted();
  }

  /** Restore a deleted script at its old path (or a free one next to it). */
  undeleteScript(projectId: string, key: string): string {
    this.store.require(projectId);
    const hist = this.scriptHistory(projectId);
    const d = hist.deletedContent(key);
    if (!d) throw new InputError('deleted script not found');
    const rel = this.library(projectId).freePath(d.entry.path);
    hist.attach(key, rel);
    this.writeScript(projectId, rel, d.content, 'restore', { kind: 'undelete', exclusive: true });
    this.log(projectId, 'script.restored', 'user', `삭제된 스크립트 복원: ${rel}`, { script: rel });
    return rel;
  }

  private ensureWatcher(projectId: string): void {
    if (this.o.watch === false || this.watchers.has(projectId)) return;
    if (!this.knownScripts.has(projectId)) this.knownScripts.set(projectId, new Set(this.library(projectId).list().map((s) => s.path)));
    const close = this.library(projectId).watch((paths) => this.onScriptsChanged(projectId, paths), this.o.watchDebounceMs);
    this.watchers.set(projectId, close);
  }

  private onScriptsChanged(projectId: string, paths: string[]): void {
    if (!this.store.get(projectId)) return;
    const before = this.knownScripts.get(projectId) ?? new Set<string>();
    const now = new Set(this.library(projectId).list().map((s) => s.path));
    this.knownScripts.set(projectId, now);
    if (this.store.isCloud(projectId) && this.cloud) return this.onCloudScriptsChanged(projectId, paths, before, now);
    const busy = !!this.chats.get(projectId)?.busy();
    const actor: ActivityActor = busy ? 'ai' : 'user';
    const histActor: ScriptHistoryActor = busy ? 'ai' : 'external';
    const hist = this.scriptHistory(projectId);
    const t = Date.now();
    const candidates = new Set([...paths.filter((p) => /\.ya?ml$/i.test(p)), ...[...now].filter((p) => !before.has(p)), ...[...before].filter((p) => !now.has(p))]);
    const fresh = [...candidates].filter((p) => !this.isSelf(projectId, p, t));
    const vanished = fresh.filter((p) => before.has(p) && !now.has(p));
    const renamedFrom = new Set<string>();
    for (const p of fresh) {
      const kind = !before.has(p) && now.has(p) ? 'script.created' : before.has(p) && !now.has(p) ? 'script.deleted' : now.has(p) ? 'script.changed' : undefined;
      if (!kind || kind === 'script.deleted') continue;
      const text = this.readScriptText(projectId, p);
      if (text === undefined) continue;
      // An outside rename looks like "one file gone + one new file with the same content".
      const from = kind === 'script.created' ? hist.matchByHash(vanished.filter((v) => !renamedFrom.has(v)), scriptHash(text)) : undefined;
      if (from) {
        renamedFrom.add(from);
        hist.rename(from, p, text, histActor);
        this.store.renameScriptRefs(projectId, from, p);
        this.renameTcRefs(projectId, from, p);
        this.log(projectId, 'script.renamed', actor, `스크립트 이름 바뀜 (바깥): ${from} → ${p}`, { script: p });
        continue;
      }
      const v = hist.sync(p, text, histActor);
      this.log(projectId, kind, actor, `${kind === 'script.created' ? '스크립트 추가' : '스크립트 수정'}: ${p}${v && kind === 'script.changed' ? ` — ${v.summary}` : ''}`, { script: p });
    }
    for (const p of vanished) {
      if (renamedFrom.has(p)) continue;
      hist.remove(p, undefined, histActor);
      this.log(projectId, 'script.deleted', actor, `스크립트 없어짐: ${p}`, { script: p });
    }
    for (const [k, v] of this.selfChanges) if (v.until <= t) this.selfChanges.delete(k);
    this.ev.scriptsChanged?.(projectId);
  }

  /**
   * Outside changes in a cloud working copy (default editor, other tools): sent to the server as
   * "앱 바깥 변경" through the same queue. A file removed outside the app stays on the server.
   */
  private onCloudScriptsChanged(projectId: string, paths: string[], before: Set<string>, now: Set<string>): void {
    const t = Date.now();
    const candidates = new Set([...paths.filter((p) => /\.ya?ml$/i.test(p)), ...[...now].filter((p) => !before.has(p)), ...[...before].filter((p) => !now.has(p))]);
    for (const p of [...candidates].filter((x) => !this.isSelf(projectId, x, t))) {
      if (!now.has(p)) {
        if (before.has(p)) this.log(projectId, 'script.deleted', 'user', `스크립트 없어짐 (바깥): ${p} — 클라우드에는 남아 있습니다`, { script: p });
        continue;
      }
      const text = this.readScriptText(projectId, p);
      if (text === undefined) continue;
      if (this.cloud!.scriptBase(projectId, p)?.hash === scriptHash(text)) continue;
      try {
        this.cloud!.assertWritable(projectId);
        this.cloud!.enqueue(projectId, p, text, 'external');
        this.log(projectId, before.has(p) ? 'script.changed' : 'script.created', 'user', `${before.has(p) ? '스크립트 수정' : '스크립트 추가'} (바깥): ${p}`, { script: p });
      } catch (e) {
        this.log(projectId, 'script.changed', 'user', `바깥 변경을 보내지 못함: ${p} — ${(e as Error).message}`, { script: p });
      }
    }
    for (const [k, v] of this.selfChanges) if (v.until <= t) this.selfChanges.delete(k);
    this.ev.scriptsChanged?.(projectId);
  }

  // ---- runs --------------------------------------------------------------------

  /** Run a library script in a project environment (Run tab, suites). */
  startRun(req: ProjectRunRequest, actor: 'user' | 'suite' = 'user', metaExtra: Record<string, string> = {}): RunHandle {
    const projectId = String(req.projectId ?? '');
    if (!isId(projectId)) throw new InputError('invalid project id');
    const abs = this.scriptAbsPath(projectId, String(req.script ?? ''));
    const ctx = this.runContext(projectId, req.envId || undefined);
    const a = assembleRun(
      ctx,
      {
        vars: parseKeyValues(req.vars ?? ''),
        env: parseKeyValues(req.env ?? ''),
        ...(typeof req.headless === 'boolean' ? { headless: req.headless } : {}),
        ...(req.browser === 'chromium' || req.browser === 'firefox' || req.browser === 'webkit' ? { browser: req.browser } : {}),
      },
      metaExtra,
    );
    const h = runScript(
      { path: abs },
      {
        env: a.env,
        vars: a.vars,
        secrets: a.secrets,
        runsDir: a.runsDir,
        ...(a.baselineDir ? { baselineDir: a.baselineDir } : {}),
        headless: a.headless,
        browserEngine: a.browserEngine,
        ...(a.browserDevice ? { browserDevice: a.browserDevice } : {}),
        meta: a.meta,
        restrictSecrets: a.restrictSecrets,
        allowedDomains: a.allowedDomains,
        ...osInputOption(),
      },
    );
    this.runInfo.set(h.runId, {
      projectId,
      actor,
      ...(ctx.env ? { envId: ctx.env.id, envName: ctx.env.name } : {}),
      script: req.script,
      ...(metaExtra.suiteRunId ? { suiteRunId: metaExtra.suiteRunId } : {}),
    });
    this.live.registerAppRun(h.runId, h.runDir, 'app', projectId);
    if (metaExtra.suiteRunId) this.live.patch(h.runId, { suiteRunId: metaExtra.suiteRunId });
    h.events.onAny((e) => this.live.ingest([e], 'app'), { replay: true });
    h.result.catch(() => undefined);
    return h;
  }

  history(projectId: string): { runs: HistoryItem[]; suiteRuns: SuiteRun[] } {
    this.store.require(projectId);
    const d = projectDirs(this.store.dir(projectId));
    return { runs: listHistory(d.runs), suiteRuns: this.suiteRuns(projectId) };
  }

  findRun(projectId: string, runId: string): { id: string; dir: string } | undefined {
    this.store.require(projectId);
    return findRunDir(projectDirs(this.store.dir(projectId)).runs, runId);
  }

  // ---- suites ------------------------------------------------------------------

  upsertSuite(projectId: string, suiteId: string | undefined, input: SuiteInput): ProjectView {
    this.store.upsertSuite(projectId, suiteId || undefined, input);
    return this.view(projectId);
  }

  deleteSuite(projectId: string, suiteId: string): ProjectView {
    this.store.deleteSuite(projectId, suiteId);
    return this.view(projectId);
  }

  runSuite(projectId: string, suiteId: string, envId?: string): SuiteExecution {
    const p = this.store.require(projectId);
    const suite = p.suites.find((s) => s.id === suiteId);
    if (!suite) throw new InputError('suite not found');
    if (!suite.scripts.length) throw new InputError('the suite has no scripts');
    if ([...this.suites.values()].some((s) => s.run.projectId === projectId)) throw new InputError('a suite is already running in this project');
    const env = this.envFor(p, envId || suite.envId);
    if (!env) throw new InputError('add an environment first (프로젝트 설정 → 환경)');
    const exec = startSuite(projectId, suite, env, {
      dir: projectDirs(this.store.dir(projectId)).suiteRuns,
      ...(this.o.now ? { now: this.o.now } : {}),
      start: (script, suiteRunId) => this.startRun({ projectId, script, envId: env.id, vars: '', env: '' }, 'suite', { suiteRunId, suiteName: suite.name }),
      onUpdate: (r) => this.ev.suiteUpdate?.(r),
    });
    this.suites.set(exec.run.id, exec);
    this.log(projectId, 'suite.started', 'user', `테스트 세트 시작: ${suite.name} @ ${env.name} (${suite.scripts.length}개${suite.stopOnFailure ? ', 실패 시 중단' : ''}${suite.alwaysRun?.length ? `, 항상 실행 ${suite.alwaysRun.length}개` : ''})`, { suiteRunId: exec.run.id, envId: env.id });
    const done = exec.done.then(async (r) => {
      this.suites.delete(exec.run.id);
      const counts = r.items.reduce<Record<string, number>>((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {});
      this.log(projectId, 'suite.finished', 'suite', `테스트 세트 종료: ${r.suiteName} @ ${r.envName} → ${r.status}${r.cancelled ? ' (취소)' : ''} — ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`, { suiteRunId: r.id, envId: r.envId });
      // The set report (ADR-032): written after the final status went out, then announced once more.
      if (await this.writeSuiteReport(projectId, r)) {
        r.hasReport = true;
        this.ev.suiteUpdate?.(structuredClone(r));
      }
      return r;
    });
    done.catch(() => this.suites.delete(exec.run.id));
    return { ...exec, done };
  }

  cancelSuite(suiteRunId: string): boolean {
    const s = this.suites.get(suiteRunId);
    if (!s) return false;
    s.cancel();
    return true;
  }

  suiteRuns(projectId: string): SuiteRun[] {
    const dir = projectDirs(this.store.dir(projectId)).suiteRuns;
    return listSuiteRuns(dir).map((r) => {
      const v = reviveSuiteRun(r, this.suites.has(r.id));
      return existsSync(suiteReportPath(dir, r.id)) ? { ...v, hasReport: true } : v;
    });
  }

  /** Write `suite-runs/<id>/report.html` (ADR-032). False when it could not be written. */
  async writeSuiteReport(projectId: string, run: SuiteRun): Promise<boolean> {
    try {
      const p = this.store.require(projectId);
      const d = projectDirs(this.store.dir(projectId));
      const check = this.o.selectorCheck === false ? undefined : (this.o.selectorCheck ?? ((source: string, runDir: string) => checkTargets(source, runDir)));
      const redactor = this.redactor(projectId);
      await buildSuiteReport({
        run,
        projectName: p.name,
        history: listSuiteRuns(d.suiteRuns),
        runDir: (runId) => findRunDir(d.runs, runId)?.dir,
        names: new Map(this.library(projectId).list().map((s) => [s.path, s.name])),
        suiteRunsDir: d.suiteRuns,
        redact: (t) => redactor.redactString(t),
        ...(check ? { check } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The set report file for [리포트]. A finished run without one (older runs, or a click just before
   * it was written) gets it written now. Undefined while the run is still going or when it is unknown.
   */
  async suiteReport(projectId: string, suiteRunId: string): Promise<string | undefined> {
    if (!isId(suiteRunId)) return undefined;
    const dir = projectDirs(this.store.dir(projectId)).suiteRuns;
    const file = suiteReportPath(dir, suiteRunId);
    if (existsSync(file)) return file;
    const run = this.suiteRuns(projectId).find((r) => r.id === suiteRunId);
    if (!run || run.status === 'running') return undefined;
    return (await this.writeSuiteReport(projectId, run)) ? file : undefined;
  }

  // ---- app settings ------------------------------------------------------------

  appSettings(): AppSettings {
    return this.appState.settings();
  }

  updateAppSettings(patch: unknown): AppSettings {
    const { settings, changed } = this.appState.updateSettings(patch);
    const cur = this.current();
    if (changed.length && cur) this.log(cur, 'settings.changed', 'user', `앱 설정 변경: ${changed.map((k) => (k === 'aiModel' ? `AI 모델=${settings.aiModel || '기본'}` : k === 'theme' ? `화면 테마=${THEME_LABEL[settings.theme]}` : k)).join(', ')}`);
    return settings;
  }

  // ---- AI chats ----------------------------------------------------------------

  chatEngine(projectId: string): ChatEngine {
    const p = this.store.require(projectId);
    let e = this.chats.get(p.id);
    if (e) return e;
    const chatOpts = this.o.chat;
    if (!chatOpts) throw new InputError('AI chat is not available');
    const dir = this.store.dir(p.id);
    e = new ChatEngine({
      store: new ChatStore(projectDirs(dir).chats),
      live: this.live,
      loadSdk: chatOpts.loadSdk,
      ...(chatOpts.queryFn ? { queryFn: chatOpts.queryFn } : {}),
      ...(chatOpts.claudeExecutable ? { claudeExecutable: chatOpts.claudeExecutable } : {}),
      ...(chatOpts.throttleMs !== undefined ? { throttleMs: chatOpts.throttleMs } : {}),
      defaults: () => {
        const cur = this.store.require(p.id);
        return { workDir: projectDirs(dir).scripts, model: this.appState.settings().aiModel, projectId: p.id, ...(cur.defaultEnvId ? { envId: cur.defaultEnvId } : {}) };
      },
      context: (chat) => this.chatContext(p.id, chat),
      onUpdate: (c) => this.ev.chatUpdate?.(p.id, c),
      onTurnStart: (chat, t) => {
        if (t.first) this.log(p.id, 'chat.started', 'ai', `AI 대화 시작: ${chat.title}`, { chatId: chat.id, ...(chat.envId ? { envId: chat.envId } : {}) });
      },
      onTurnEnd: (chat, t) => {
        const tools = [...new Set(t.tools)];
        this.tcDocs.chatTurnEnded(p.id, chat.id);
        this.log(p.id, 'chat.turn', 'ai', `${t.prompt.replace(/\s+/g, ' ').slice(0, 120)}${tools.length ? ` · 도구: ${tools.join(', ')}` : ''}`, { chatId: chat.id, ...(chat.envId ? { envId: chat.envId } : {}) });
      },
    });
    this.chats.set(p.id, e);
    return e;
  }

  /** Tool configuration for a chat: its environment (or the project default). */
  chatContext(projectId: string, chat: ChatView): ChatContext {
    const p = this.store.require(projectId);
    const env = chat.envId ? p.environments.find((x) => x.id === chat.envId) : this.envFor(p, undefined);
    const ctx = this.runContext(projectId, env?.id);
    const config = aiServerConfig(ctx);
    const workDir = projectDirs(this.store.dir(projectId)).scripts;
    const key = createHash('sha256')
      .update(JSON.stringify({ config, workDir, secretsFile: env?.secretsFile ?? '' }))
      .digest('hex');
    return {
      key,
      config,
      workDir,
      projectId,
      ...(env?.secretsFile ? { secretsFile: env.secretsFile } : {}),
      project: { name: p.name, environments: p.environments.map((e) => ({ name: e.name, baseUrl: e.baseUrl })), ...(env ? { envName: env.name } : {}) },
      onRunStarted: (runId) => this.runInfo.set(runId, { projectId, actor: 'ai', ...(env ? { envId: env.id, envName: env.name } : {}), chatId: chat.id }),
      onRead: (abs) => {
        if (!this.store.isCloud(projectId)) return;
        const rel = relative(realOr(workDir), join(realOr(dirname(abs)), basename(abs))).split(sep).join('/');
        let m = this.aiReads.get(chat.id);
        if (!m) this.aiReads.set(chat.id, (m = new Map()));
        m.set(rel, this.cloud?.scriptBase(projectId, rel)?.version);
      },
      writeScript: async (abs, content) => {
        const rel = relative(realOr(workDir), join(realOr(dirname(abs)), basename(abs))).split(sep).join('/');
        // Cloud: the AI's base is the version it read — if someone else's save arrived since, it is a conflict.
        const reads = this.aiReads.get(chat.id);
        if (this.store.isCloud(projectId) && this.cloud && reads?.has(rel)) {
          const stale = this.cloud.aiStale(projectId, rel, reads.get(rel));
          if (stale) {
            reads.delete(rel);
            throw new Error(stale);
          }
        }
        const r = this.writeScript(projectId, rel, content, 'ai');
        // Cloud project: the AI waits for the server answer; a conflict comes back as a tool error.
        if (!r.conflict && r.cloud) {
          const out = await r.cloud.outcome;
          if (out.kind === 'conflict') throw new Error(await this.cloud!.aiConflict(projectId, r.cloud.ticket, rel));
          if (out.kind === 'rejected') throw new Error(`클라우드 저장 거절: ${out.error}`);
        }
      },
      recordings: {
        get: (id) => this.recordingStore(projectId).get(id),
        list: () => this.recordingStore(projectId).list(),
        file: (id, rel) => this.recordingStore(projectId).file(id, rel),
        secretNames: () => Object.keys(ctx.secrets),
      },
      tcDocs: this.tcDocs.access(projectId, chat.id),
    };
  }

  // ---- demonstration recordings (SPEC 스크립트-작성-시연녹화) ---------------------

  recordingStore(projectId: string): RecordingStore {
    return new RecordingStore(projectDirs(this.store.dir(projectId)).recordings);
  }

  recordings(projectId: string): RecordingSummary[] {
    this.store.require(projectId);
    return this.recordingStore(projectId).list();
  }

  /** The live (or last) recording, if any. */
  recordingView(): RecordingView | undefined {
    return this.rec ? structuredClone(this.rec.view) : undefined;
  }

  /** TEST/host: the recorder's Playwright page while a recording runs. */
  activeRecorderPage(): Page | undefined {
    return this.rec && !this.rec.recorder.isStopped ? this.rec.recorder.page : undefined;
  }

  private toView(projectId: string, envId: string | undefined, v: RecorderView): RecordingView {
    return { projectId, ...(envId ? { envId } : {}), ...v } as RecordingView;
  }

  async startRecording(projectId: string, req: RecordingStartRequest = {}): Promise<RecordingView> {
    const p = this.store.require(projectId);
    if (this.rec && !this.rec.recorder.isStopped) throw new InputError('시연 녹화가 이미 진행 중입니다. 먼저 종료하세요.');
    const env = this.envFor(p, req.envId || undefined);
    const startPath = String(req.startPath ?? '').trim() || '/';
    if (!env?.baseUrl && !/^https?:\/\//i.test(startPath)) throw new InputError('환경 주소가 없습니다 — 프로젝트 설정에서 환경을 추가하거나 시작 주소를 전체 URL 로 입력하세요.');
    // "시연으로 변환" (SPEC TC-문서-변환): the recording demonstrates one TC of a TC document.
    const tcRef = req.tc && typeof req.tc.docId === 'string' && typeof req.tc.tcId === 'string' ? { docId: req.tc.docId, tcId: req.tc.tcId } : undefined;
    const tc = tcRef ? this.tcDocs.store(projectId).require(tcRef.docId).tcs.find((t) => t.id === tcRef.tcId) : undefined;
    if (tcRef && !tc) throw new InputError('TC 를 찾을 수 없습니다');
    const name = String(req.name ?? '').trim().slice(0, 80) || (tc ? `${tc.id} ${tc.title}`.slice(0, 80) : `시연 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
    const store = this.recordingStore(projectId);
    const { id, dir } = store.allocate();
    let recorder: Recorder;
    try {
      recorder = await openRecorder({
        dir,
        id,
        name,
        ...(env?.baseUrl ? { baseUrl: env.baseUrl } : {}),
        startPath,
        ...(env ? { envId: env.id } : {}),
        browser: { engine: p.browser.engine, ...(p.browser.device ? { device: p.browser.device } : {}) },
        headless: this.o.recorderHeadless ?? false,
        ...(tcRef ? { tcRef } : {}),
        onUpdate: (v) => {
          if (!this.rec || this.rec.id !== id) return;
          this.rec.view = this.toView(projectId, env?.id, v);
          this.ev.recordingUpdate?.(structuredClone(this.rec.view));
        },
        onFinished: (r) => this.onRecordingFinished(projectId, r),
      });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw new InputError(`녹화 브라우저를 열지 못했습니다: ${(e as Error).message.split('\n')[0]}`);
    }
    this.rec = { projectId, id, ...(env ? { envId: env.id } : {}), recorder, view: this.toView(projectId, env?.id, recorder.view()) };
    this.log(projectId, 'recording.started', 'user', `시연 녹화 시작: ${name}${env ? ` @ ${env.name}` : ''} (${recorder.startUrl})`, { recordingId: id, ...(env ? { envId: env.id } : {}) });
    this.ev.recordingUpdate?.(structuredClone(this.rec.view));
    return structuredClone(this.rec.view);
  }

  private onRecordingFinished(projectId: string, r: Recording): void {
    const s = summarize(r);
    this.log(projectId, 'recording.finished', 'user', `시연 녹화 종료: ${r.name} — 동작 ${s.events}개, 체크포인트 ${s.checkpoints}개, 메모 ${s.notes}개${s.sensitive ? `, 민감 입력 ${s.sensitive}개(값 저장 안 함)` : ''}`, { recordingId: r.id, ...(r.envId ? { envId: r.envId } : {}) });
  }

  /** Panel controls on the live recording (sensitive/annotate also work on a saved one). */
  async recordingControl(projectId: string, recordingId: string, action: RecordingAction, arg?: unknown): Promise<RecordingView | RecordingSummary> {
    this.store.require(projectId);
    const live = this.rec && this.rec.projectId === projectId && this.rec.id === recordingId && !this.rec.recorder.isStopped ? this.rec.recorder : undefined;
    const a = (arg ?? {}) as { seq?: unknown; text?: unknown; value?: unknown; kind?: unknown };
    const seq = Number(a.seq);
    if (!live) {
      if (action === 'sensitive') return summarize(this.recordingStore(projectId).markSensitive(recordingId, seq));
      if (action === 'stop') {
        if (this.rec?.id === recordingId) await this.rec.recorder.stop();
        return this.rec?.id === recordingId ? structuredClone(this.rec.view) : summarize(this.recordingStore(projectId).require(recordingId));
      }
      throw new InputError('녹화가 진행 중이 아닙니다');
    }
    switch (action) {
      case 'pause':
        live.pause();
        break;
      case 'resume':
        live.resume();
        break;
      case 'checkpoint': {
        const k = typeof a.kind === 'string' && a.kind ? (a.kind as CheckpointKind) : null;
        live.setCheckpointMode(k);
        break;
      }
      case 'undo':
        live.undoLast();
        break;
      case 'delete':
        live.deleteEvent(seq);
        break;
      case 'sensitive':
        live.markSensitive(seq);
        break;
      case 'annotate':
        live.annotate(seq, String(a.text ?? ''));
        break;
      case 'expected':
        live.setExpected(seq, typeof a.value === 'number' ? a.value : String(a.value ?? ''));
        break;
      case 'note':
        live.addNote(String(a.text ?? ''));
        break;
      case 'markStep':
        if (!live.markStep(Number((arg as { no?: unknown })?.no))) throw new InputError('이 단계는 이미 끝냈습니다');
        break;
      case 'stop':
        this.closeOpenTcStep(projectId, live);
        await live.stop();
        break;
      default:
        throw new InputError(`unknown recording action: ${String(action)}`);
    }
    return structuredClone(this.rec!.view);
  }

  /** Stopping a TC recording: actions after the last [다음 단계] belong to the current TC step. */
  private closeOpenTcStep(projectId: string, live: Recorder): void {
    const v = live.view();
    if (!v.tcRef) return;
    const marks = v.stepMarks ?? [];
    const lastTo = marks.at(-1)?.toSeq ?? 0;
    if (!v.events.some((e) => e.seq > lastTo)) return;
    const tc = this.tcDocs.store(projectId).get(v.tcRef.docId)?.tcs.find((t) => t.id === v.tcRef!.tcId);
    const next = tc?.steps.find((s) => !marks.some((m) => m.no === s.no));
    if (next) live.markStep(next.no);
  }

  /** The TC a recording demonstrates (when its document and TC still exist). */
  private recordingTc(projectId: string, r: Recording): { doc: { id: string; name: string }; tc: TcDocTc } | undefined {
    if (!r.tcRef) return undefined;
    const d = this.tcDocs.store(projectId).get(r.tcRef.docId);
    const tc = d?.tcs.find((t) => t.id === r.tcRef!.tcId);
    return d && tc ? { doc: { id: d.id, name: d.name }, tc } : undefined;
  }

  renameRecording(projectId: string, recordingId: string, name: string): RecordingSummary {
    this.store.require(projectId);
    if (this.rec?.id === recordingId && !this.rec.recorder.isStopped) throw new InputError('녹화 중에는 이름을 바꿀 수 없습니다');
    const r = this.recordingStore(projectId).rename(recordingId, name);
    if (this.rec?.id === recordingId) this.rec.view.name = r.name;
    return summarize(r);
  }

  deleteRecording(projectId: string, recordingId: string): void {
    this.store.require(projectId);
    if (this.rec?.id === recordingId) {
      if (!this.rec.recorder.isStopped) throw new InputError('녹화 중에는 삭제할 수 없습니다');
      this.rec = undefined;
    }
    this.recordingStore(projectId).delete(recordingId);
  }

  /** Mechanical draft of a recording for an environment (its secret names decide the missing list). */
  recordingDraft(projectId: string, recordingId: string, envId?: string): DraftView {
    const r = this.recordingStore(projectId).require(recordingId);
    const p = this.store.require(projectId);
    const env = this.envFor(p, envId || r.envId || undefined);
    const names = env ? this.envView(projectId, env).secretNames : [];
    const t = this.recordingTc(projectId, r);
    // A TC recording: one group per TC step by the step marks; unchecked expected results → manual.
    const d = recordingToScript(r, { secretNames: names, ...(t ? { name: t.tc.title, description: `TC ID: ${t.tc.id} — ${t.doc.name} (시연 녹화 ${r.id})`, tcSteps: t.tc.steps } : {}) });
    return { yaml: d.yaml, secrets: d.secrets, missingSecrets: d.missingSecrets };
  }

  /** "AI 없이 저장": write the draft into the script library. */
  saveRecordingDraft(projectId: string, recordingId: string, envId?: string): DraftView {
    const r = this.recordingStore(projectId).require(recordingId);
    const d = this.recordingDraft(projectId, recordingId, envId);
    const t = this.recordingTc(projectId, r);
    const got = this.library(projectId).freePath(t ? tcFileName(t.tc) : `${slugify(r.name, 'recording')}.yaml`);
    const yaml = d.yaml.endsWith('\n') ? d.yaml : `${d.yaml}\n`;
    this.writeScript(projectId, got, yaml, 'recording', { exclusive: true, kind: 'create' });
    this.log(projectId, 'recording.converted', 'user', `녹화 초안 저장 (AI 없이): ${r.name} → ${got}${d.missingSecrets.length ? ` — 등록 필요 secret: ${d.missingSecrets.join(', ')}` : ''}`, { recordingId, script: got });
    if (t) {
      const manual = countManualSteps(yaml);
      this.tcDocs.store(projectId).setConversion(t.doc.id, t.tc.id, { status: 'done', script: got, manualSteps: manual, by: 'recording' });
      this.log(projectId, 'tcdoc.converted', 'user', `TC 변환 완료 (시연): ${t.doc.name} / ${t.tc.id} ${t.tc.title} → ${got}${manual ? ` · 수동 ${manual}` : ''}`, { tcDocId: t.doc.id, tcId: t.tc.id, recordingId, script: got });
      this.ev.tcDocChanged?.(projectId, t.doc.id);
    }
    return { ...d, path: got };
  }

  /** "AI로 정리": a new project chat with the recording attached; the turn runs in the background. */
  tidyRecording(projectId: string, recordingId: string, envId?: string, message?: string): ChatView {
    const r = this.recordingStore(projectId).require(recordingId);
    const engine = this.chatEngine(projectId);
    const chat = engine.create(envId || r.envId || undefined);
    const extra = String(message ?? '').trim().slice(0, 4000);
    const t = this.recordingTc(projectId, r);
    const prompt = [
      `시연 녹화 "${r.name}" 를 튼튼한 테스트 스크립트로 정리해 주세요.`,
      `recordingId: ${r.id}`,
      ...(t
        ? [
            `tcRef: ${t.doc.id} ${t.tc.id}`,
            `TC 문서 "${t.doc.name}" 의 ${t.tc.id} 를 시연한 녹화입니다. get_recording 과 get_tc 를 함께 보고 TC 단계 묶음을 지키며 변환 규칙대로 다듬어, 파일 ${tcFileName(t.tc)} 로 저장 → 검증 → 실행한 뒤 set_tc_conversion 으로 결과를 남기세요.`,
          ]
        : ['get_recording 으로 동작·메모·체크포인트·초안을 보고, 다듬은 스크립트를 라이브러리에 저장한 뒤 이 환경에서 실행해 확인하고 결과를 알려 주세요.']),
      ...(extra ? ['', extra] : []),
    ].join('\n');
    this.log(projectId, 'recording.converted', 'user', `녹화 AI 정리 요청: ${r.name}`, { recordingId, chatId: chat.id });
    void engine.send(chat.id, prompt).catch(() => undefined);
    return engine.get(chat.id) ?? chat;
  }

  /**
   * "AI에게 수정 요청": a new project chat in the selected environment with the script path,
   * (for a step request) its number and sentence, and the request; the turn runs in the background.
   */
  requestScriptEdit(projectId: string, rel: string, text: string, step?: { id: string; sentence: string }, envId?: string): ChatView {
    const p = this.store.require(projectId);
    const lib = this.library(projectId);
    const abs = this.scriptAbsPath(projectId, rel);
    const clean = lib.rel(abs) ?? rel;
    const ask = String(text ?? '').trim().slice(0, 4000);
    if (!ask) throw new InputError('요청 내용을 입력하세요');
    const env = this.envFor(p, envId || undefined);
    const name = scriptName(readFileSync(abs, 'utf8')) ?? clean;
    const engine = this.chatEngine(projectId);
    const chat = engine.create(env?.id);
    const prompt = [
      `스크립트 "${name}" 를 고쳐 주세요.`,
      `scriptEdit: ${clean}`,
      ...(step ? [`대상 단계: ${String(step.id).slice(0, 20)}번 — ${String(step.sentence).slice(0, 300)}`] : []),
      ...(env ? [`환경: ${env.name}`] : []),
      '',
      `요청: ${ask}`,
      '',
      'read_file 로 현재 내용을 읽고, 요청한 부분만 고친 전체 YAML 을 save_script (같은 경로, overwrite: true) 로 저장한 뒤 validate_script, 필요하면 run_script 로 확인하고, 바꾼 점을 단계 문장으로 알려 주세요.',
    ].join('\n');
    void engine.send(chat.id, prompt).catch(() => undefined);
    return engine.get(chat.id) ?? chat;
  }

  /** Close watchers, abort chat turns, close AI sessions (app quit). */
  dispose(): Promise<unknown> {
    const recording = this.rec && !this.rec.recorder.isStopped ? this.rec.recorder.stop().catch(() => undefined) : undefined;
    for (const close of this.watchers.values()) close();
    this.watchers.clear();
    this.disposeLive();
    for (const s of this.suites.values()) s.cancel();
    return Promise.allSettled([...this.chats.values()].map((c) => c.dispose()).concat(recording ? [recording] : []));
  }
}
