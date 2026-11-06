import type {
  ActivityEvent,
  ActivityQuery,
  AiInfo,
  AppInfo,
  AppSettings,
  AuthState,
  ChatSummary,
  ChatView,
  CloudActivityView,
  CloudConflictChoice,
  CloudHistoryView,
  CloudNotificationView,
  CloudPrecheckView,
  CloudRunItem,
  CloudRunRequest,
  CloudScheduleForm,
  CloudScheduleView,
  CloudUploadResult,
  CloudMemberView,
  CloudNotice,
  CloudAccessRequestView,
  CloudConvertPreview,
  CloudConvertResult,
  CloudMergeChoices,
  CloudMergePlan,
  CloudReceiveList,
  CloudRole,
  CloudStatusView,
  DraftView,
  HistoryItem,
  HookSessionView,
  ProjectRunRequest,
  ProjectSummary,
  ProjectView,
  PtyKind,
  RecordingAction,
  RecordingStartRequest,
  TcDoc,
  TcDocSummary,
  TcDocView,
  TcConvertProgress,
  TcExportFormat,
  TcExportSource,
  TcImportConfirm,
  TcImportView,
  TcMappingView,
  TcSetGrouping,
  TcSetPlan,
  RecordingSummary,
  RecordingView,
  RunListItem,
  RunView,
  DeletedScript,
  ScriptCheck,
  ScriptCompareView,
  ScriptDetailView,
  ScriptDraftCheck,
  ScriptEditPayload,
  ScriptEntry,
  ScriptHistoryView,
  ScriptSaveResult,
  SuiteRun,
  TerminalInfo,
  VaultStatus,
} from '../shared/types';

export interface EnvForm {
  name?: string;
  baseUrl?: string;
  vars?: Record<string, string>;
  /** Hosts where secret fill/type steps may run (cloud: the server's list; local: null = back to the address-host default). */
  allowedDomains?: string[] | null;
  /** Absolute path, or '' for the vault. */
  secretsFile?: string;
}

export interface SuiteForm {
  name?: string;
  scripts?: string[];
  envId?: string;
  stopOnFailure?: boolean;
  /** "항상 실행" script paths (a subset of `scripts`). */
  alwaysRun?: string[];
}

/** API exposed to the renderer as `window.euta` (contextBridge). */
export interface EutaApi {
  appInfo(): Promise<AppInfo>;
  appSettings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  vaultStatus(): Promise<VaultStatus>;
  pickFile(kind: 'script' | 'secrets'): Promise<string | undefined>;
  pickDir(): Promise<string | undefined>;
  projects: {
    list(): Promise<ProjectSummary[]>;
    create(input: { name: string; description?: string; baseUrl?: string }): Promise<ProjectView>;
    get(id: string): Promise<ProjectView>;
    open(id: string): Promise<ProjectView>;
    update(id: string, patch: Record<string, unknown>): Promise<ProjectView>;
    /** Reason the project cannot be deleted now, or null. */
    deleteCheck(id: string): Promise<string | null>;
    delete(id: string): Promise<void>;
    onChanged(fn: () => void): () => void;
    upsertEnv(id: string, envId: string | undefined, input: EnvForm): Promise<ProjectView>;
    deleteEnv(id: string, envId: string): Promise<ProjectView>;
    /** Write-only: resolves with the secret names of the environment. */
    setSecret(id: string, envId: string, name: string, value: string): Promise<string[]>;
    removeSecret(id: string, envId: string, name: string): Promise<string[]>;
  };
  scripts: {
    list(projectId: string): Promise<ScriptEntry[]>;
    create(projectId: string, path?: string, name?: string): Promise<string>;
    /** Opens a file dialog in main; returns the imported library paths. */
    import(projectId: string): Promise<string[]>;
    rename(projectId: string, from: string, to: string): Promise<string>;
    delete(projectId: string, path: string): Promise<void>;
    export(projectId: string, path: string): Promise<boolean>;
    open(projectId: string, path: string): Promise<boolean>;
    check(projectId: string, path: string, envId: string | undefined, vars: string, env: string): Promise<ScriptCheck>;
    onChanged(fn: (projectId: string) => void): () => void;
    /** Detail screen (SPEC 스크립트-보기-편집): text, parsed script, warnings, latest-run overlay. */
    detail(projectId: string, path: string, envId?: string): Promise<ScriptDetailView>;
    draftCheck(projectId: string, baseText: string, edit: ScriptEditPayload, envId?: string): Promise<ScriptDraftCheck>;
    save(projectId: string, path: string, baseText: string, edit: ScriptEditPayload, envId?: string, force?: boolean): Promise<ScriptSaveResult>;
    versions(projectId: string, path: string): Promise<ScriptHistoryView>;
    compare(projectId: string, key: string, to: number, from?: number): Promise<ScriptCompareView>;
    restore(projectId: string, key: string, version: number): Promise<{ path?: string; conflict?: boolean }>;
    deleted(projectId: string): Promise<DeletedScript[]>;
    undelete(projectId: string, key: string): Promise<string>;
    /** Screenshot of a run step as a data URL. */
    runShot(projectId: string, runId: string, rel: string): Promise<string | undefined>;
    /** "AI에게 수정 요청": opens a new project chat; returns its id. */
    aiRequest(projectId: string, path: string, text: string, step?: { id: string; sentence: string }, envId?: string): Promise<string>;
  };
  startRun(req: ProjectRunRequest): Promise<{ runId: string; runDir: string }>;
  live: {
    list(): Promise<RunListItem[]>;
    get(runId: string): Promise<RunView | undefined>;
    onUpdate(fn: (v: RunView) => void): () => void;
  };
  artifactImage(runId: string, relPath: string): Promise<string | undefined>;
  history: {
    list(projectId: string): Promise<{ runs: HistoryItem[]; suiteRuns: SuiteRun[] }>;
    open(projectId: string, runId: string): Promise<string | undefined>;
    openReport(projectId: string, runId: string, where: 'window' | 'browser'): Promise<boolean>;
  };
  suites: {
    upsert(projectId: string, suiteId: string | undefined, input: SuiteForm): Promise<ProjectView>;
    delete(projectId: string, suiteId: string): Promise<ProjectView>;
    run(projectId: string, suiteId: string, envId?: string): Promise<SuiteRun>;
    cancel(suiteRunId: string): Promise<boolean>;
    /** Test set report (`suite-runs/<id>/report.html`, written now when missing). False while running / unknown. */
    openReport(projectId: string, suiteRunId: string, where?: 'window' | 'browser'): Promise<boolean>;
    onUpdate(fn: (r: SuiteRun) => void): () => void;
  };
  activity: {
    list(projectId: string, q?: ActivityQuery): Promise<ActivityEvent[]>;
    onAppended(fn: (projectId: string, e: ActivityEvent) => void): () => void;
  };
  hooks: {
    list(): Promise<HookSessionView[]>;
    onUpdate(fn: (s: HookSessionView) => void): () => void;
  };
  term: {
    info(): Promise<TerminalInfo>;
    spawn(kind: PtyKind, cols: number, rows: number): Promise<number>;
    write(id: number, data: string): void;
    resize(id: number, cols: number, rows: number): void;
    kill(id: number): void;
    onData(fn: (id: number, data: string) => void): () => void;
    onExit(fn: (id: number, code: number) => void): () => void;
  };
  ai: {
    info(projectId: string): Promise<AiInfo>;
    authStatus(force?: boolean): Promise<AuthState>;
    login(): Promise<{ ok: boolean; command: string; error?: string }>;
    logout(): Promise<{ ok: boolean; error?: string }>;
    chats(projectId: string): Promise<ChatSummary[]>;
    chat(projectId: string, id: string): Promise<ChatView | undefined>;
    newChat(projectId: string, envId?: string): Promise<ChatView>;
    deleteChat(projectId: string, id: string): Promise<void>;
    setChatEnv(projectId: string, id: string, envId: string | undefined): Promise<ChatView>;
    send(projectId: string, id: string, text: string): Promise<void>;
    stop(projectId: string, id: string): Promise<boolean>;
    onChatUpdate(fn: (projectId: string, c: ChatView) => void): () => void;
  };
  /** Demonstration recordings (SPEC 스크립트-작성-시연녹화). */
  /** TC documents (SPEC TC-문서-변환). */
  tcDocs: {
    list(projectId: string): Promise<TcDocSummary[]>;
    get(projectId: string, docId: string): Promise<TcDocView>;
    onChanged(fn: (projectId: string, docId: string) => void): () => void;
    /** File picker (xlsx · csv · docx · md) → preview; null when cancelled. */
    import(projectId: string): Promise<TcImportView | null>;
    importView(importId: string): Promise<TcImportView | null>;
    /** Unrecognized layout: a new AI chat reads the grid; resolves with the chat id. */
    extract(projectId: string, importId: string, envId?: string): Promise<string>;
    cancelImport(importId: string): Promise<void>;
    confirm(projectId: string, importId: string, c: TcImportConfirm): Promise<TcDoc>;
    onImportUpdate(fn: (v: TcImportView) => void): () => void;
    rename(projectId: string, docId: string, name: string): Promise<TcDoc>;
    delete(projectId: string, docId: string): Promise<void>;
    setQueue(projectId: string, docId: string, tcIds: string[]): Promise<TcDoc>;
    /** [AI로 변환] / [다시 변환] / [이어서 변환]: resolves with the new chat id; the app then sends one message per item (`limit` TCs at most). */
    convert(projectId: string, docId: string, o: { tcIds?: string[]; redo?: boolean; envId?: string; message?: string; limit?: number }): Promise<string>;
    /** [중지]: stop the document's auto conversion (the queue stays). */
    stop(projectId: string, docId: string): Promise<void>;
    /** Auto conversions running in the project (chat screen progress). */
    progress(projectId: string): Promise<TcConvertProgress[]>;
    exclude(projectId: string, docId: string, tcId: string, excluded: boolean): Promise<TcDoc>;
    mapping(projectId: string, docId: string, tcId: string): Promise<TcMappingView>;
    planSets(projectId: string, docId: string, mode: TcSetGrouping, tcIds?: string[]): Promise<TcSetPlan>;
    /** Save dialog → the written file path, or null when cancelled. */
    export(projectId: string, source: TcExportSource, format: TcExportFormat): Promise<string | null>;
  };
  recordings: {
    list(projectId: string): Promise<RecordingSummary[]>;
    /** The live (or last) recording, or null. */
    current(): Promise<RecordingView | null>;
    /** Opens the recorder browser on the environment's start path. */
    start(projectId: string, req: RecordingStartRequest): Promise<RecordingView>;
    control(projectId: string, id: string, action: RecordingAction, arg?: Record<string, unknown>): Promise<RecordingView | RecordingSummary>;
    rename(projectId: string, id: string, name: string): Promise<RecordingSummary>;
    delete(projectId: string, id: string): Promise<void>;
    draft(projectId: string, id: string, envId?: string): Promise<DraftView>;
    /** "AI 없이 저장": the draft goes into the script library. */
    save(projectId: string, id: string, envId?: string): Promise<DraftView>;
    /** "AI로 정리": resolves with the new chat id. */
    tidy(projectId: string, id: string, envId?: string, message?: string): Promise<string>;
    /** Masked step screenshot as a data URL. */
    shot(projectId: string, id: string, rel: string): Promise<string | undefined>;
    onUpdate(fn: (v: RecordingView) => void): () => void;
  };
  /** euta cloud (SPEC 클라우드-앱-연동). The device token stays in main; values are write-only. */
  cloud: {
    status(): Promise<CloudStatusView>;
    onStatus(fn: (v: CloudStatusView) => void): () => void;
    onNotice(fn: (n: CloudNotice) => void): () => void;
    setServer(url: string): Promise<CloudStatusView>;
    /** Device login: opens the browser, resolves with the code to confirm there. */
    login(): Promise<CloudStatusView>;
    cancelLogin(): Promise<CloudStatusView>;
    logout(): Promise<CloudStatusView>;
    reconnect(): Promise<CloudStatusView>;
    /** [클라우드에서 받기]: 내 프로젝트 / 조직 공개. */
    projects(): Promise<CloudReceiveList>;
    /** Working copy of a cloud project; resolves with its app project id. */
    openRemote(cloudProjectId: string): Promise<string>;
    /** "클라우드로 올리기" = conversion: the local project becomes the cloud project (`localId` = its new app id). */
    upload(projectId: string): Promise<CloudConvertResult>;
    convertPreview(projectId: string): Promise<CloudConvertPreview>;
    /** [권한 요청] (`project` = app id of a working copy, or a cloud project UUID from the receive list). */
    requestAccess(project: string, role: 'editor' | 'runner', memo: string): Promise<{ role: 'editor' | 'runner'; createdAt: string }>;
    myAccessRequest(projectId: string): Promise<{ role: 'editor' | 'runner'; createdAt: string } | null>;
    accessRequests(projectId: string): Promise<CloudAccessRequestView[]>;
    decideAccess(projectId: string, requestId: string, approve: boolean, role?: CloudRole): Promise<CloudAccessRequestView[]>;
    /** 합치기: may this local project be merged into its (fixed) cloud project, and why not. */
    mergeStatus(projectId: string): Promise<{ ok: boolean; message?: string; targetName?: string }>;
    mergePlan(projectId: string): Promise<CloudMergePlan>;
    mergeApply(projectId: string, choices: CloudMergeChoices): Promise<{ localId: string; movedRuns: number }>;
    /** Read the project's role / access again (header [새로고침]). */
    refreshAccess(projectId: string): Promise<ProjectView>;
    resolve(projectId: string, ticket: number, choice: CloudConflictChoice): Promise<ProjectView>;
    resync(projectId: string): Promise<void>;
    members(projectId: string): Promise<CloudMemberView[]>;
    setMember(projectId: string, email: string, role: CloudRole): Promise<CloudMemberView[]>;
    removeMember(projectId: string, userId: string): Promise<CloudMemberView[]>;
    /** Write-only: the value goes to the server once (never stored on this PC). */
    setCredential(projectId: string, envId: string, name: string, value: string): Promise<ProjectView>;
    removeCredential(projectId: string, envId: string, name: string): Promise<ProjectView>;
    activity(projectId: string): Promise<CloudActivityView[]>;
    /** Invite box suggestions (`GET /api/users?q=`); null = the server has no user search. */
    searchUsers(q: string): Promise<{ id: string; email: string; name: string }[] | null>;
    /** Run location "클라우드": reasons next to the button (SPEC 실행 위치 선택). */
    precheck(projectId: string, req: CloudRunRequest): Promise<CloudPrecheckView>;
    /** Request a cloud run; it shows up in Live at once (`runId` = cloud run id = Live id). */
    startRun(projectId: string, req: CloudRunRequest): Promise<{ runId: string }>;
    cancelRun(projectId: string, runId: string): Promise<void>;
    /** History: cloud runs (merged with local runs in the renderer) and this PC's uploads. */
    history(projectId: string): Promise<CloudHistoryView>;
    runChildren(projectId: string, runId: string): Promise<CloudRunItem[]>;
    /** Download the result files (once, cache) and replay; `liveId` is the run to select in Live. */
    openRun(projectId: string, runId: string): Promise<{ liveId: string; expired?: boolean; files: boolean }>;
    openReport(projectId: string, runId: string, where: 'window' | 'browser'): Promise<boolean>;
    /** Open the web run detail (a test set run: its report screen) in the system browser. */
    openWebRun(projectId: string, runId: string): Promise<void>;
    /** "클라우드에 올리기" of a local run. */
    uploadRun(projectId: string, localRunId: string): Promise<CloudUploadResult>;
    onRunsChanged(fn: (projectId: string) => void): () => void;
    schedules(projectId: string): Promise<CloudScheduleView[]>;
    saveSchedule(projectId: string, scheduleId: string | undefined, form: CloudScheduleForm): Promise<CloudScheduleView[]>;
    deleteSchedule(projectId: string, scheduleId: string): Promise<CloudScheduleView[]>;
    /** An app notification was clicked. */
    onOpenRun(fn: (v: CloudNotificationView) => void): () => void;
  };
}

declare global {
  interface Window {
    euta: EutaApi;
  }
}
