// euta desktop app — main process (ESM).
// Wires: project service (projects, environments, vault, scripts, suites, activity, chats —
// ADR-016), local server (events + hooks), live store, history, terminal (node-pty), and the
// sandboxed renderer via a narrow IPC API.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC } from '../shared/ipc.js';
import type { ActivityQuery, AiInfo, AppInfo, CloudConflictChoice, CloudRole, CloudNotificationView, CloudRunRequest, CloudScheduleForm, ProjectRunRequest, PtyKind, RecordingAction, RecordingStartRequest, ScriptEditPayload, TcExportFormat, TcImportConfirm, TcSetGrouping } from '../shared/types.js';
import { CloudService } from './cloud/cloud-service.js';
import { readArtifactImage } from './artifacts.js';
import { HookStore } from './hook-store.js';
import { LiveStore } from './live-store.js';
import { startLocalServer, type LocalServer } from './local-server.js';
import { PtyManager } from './pty-manager.js';
import { fixProcessPath } from './terminal-env.js';
import { ClaudeAuth, claudeExecutableForAgent } from './ai/claude-auth.js';
import type { SdkModule } from './ai/chat-engine.js';
import { fakeQuery } from './ai/fake-agent.js';
import { ProjectService } from './project/service.js';
import { applyTheme } from './project/app-state.js';
import { channelOf, updateMode, type UpdateMode } from '../shared/app-version.js';
import { AppUpdater, type UpdaterBackend } from './updater.js';
import { electronUpdaterBackend } from './update-backend.js';
import { resolveUpdateSource } from './update-source.js';

const here = dirname(fileURLToPath(import.meta.url));

// Test/portable override of the profile dir (must happen before `ready`).
if (process.env.EUTA_USER_DATA_DIR) app.setPath('userData', resolve(process.env.EUTA_USER_DATA_DIR));

let mainWindow: BrowserWindow | undefined;
let server: LocalServer | undefined;
let projects: ProjectService | undefined;
let cloud: CloudService | undefined;
let updater: AppUpdater | undefined;
/** E2E: [다시 시작해서 업데이트] requests (the real install quits the app). */
let installRequests = 0;
/** E2E: the device-approval URL the app would have opened in the browser. */
let lastExternalUrl: string | undefined;
/** App notifications shown (E2E reads them — OS notifications are not observable from Playwright). */
const notifications: CloudNotificationView[] = [];
/** Shown OS notifications are kept referenced until clicked/closed (otherwise GC drops the click handler). */
const liveNotifications = new Set<Notification>();
const live = new LiveStore({ projectOf: (dir) => projects?.projectOfRunDir(dir) });
const hooks = new HookStore();
let ptys: PtyManager;
let pathFixed: Promise<boolean> = Promise.resolve(false);
const auth = new ClaudeAuth();
// Test-only scripted agent: never active unless both E2E flags are set.
const FAKE_AGENT = process.env.EUTA_E2E === '1' && process.env.EUTA_E2E_FAKE_AGENT === '1';

function sdkAvailable(): boolean {
  try {
    import.meta.resolve('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

function svc(): ProjectService {
  if (!projects) throw new Error('not ready');
  return projects;
}

function cl(): CloudService {
  if (!cloud) throw new Error('not ready');
  return cloud;
}

/** Cloud projects route these calls to the cloud service (server is the source of truth). */
const isCloud = (id: unknown): boolean => !!projects?.isCloud(str(id));

function aiInfo(projectId: string): AiInfo {
  const v = svc().view(projectId);
  return { workDir: v.dirs.scripts, model: svc().appSettings().aiModel, sdkAvailable: sdkAvailable(), fakeAgent: FAKE_AGENT };
}

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function rendererUrl(): string | undefined {
  return !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
}

/** Only our own renderer may call the IPC API. */
function trusted(e: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  const dev = rendererUrl();
  return e.sender === mainWindow?.webContents && (url.startsWith('file://') || (!!dev && url.startsWith(dev)));
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('untrusted sender');
    return fn(...args);
  });
}

function on(channel: string, fn: (...args: unknown[]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (trusted(e)) fn(...args);
  });
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Edited script from the renderer: { header: object, steps: [...] } (engine ScriptEdit). */
function editPayload(v: unknown): ScriptEditPayload {
  const e = obj(v);
  if (!e.header || typeof e.header !== 'object' || Array.isArray(e.header) || !Array.isArray(e.steps)) throw new Error('invalid script edit');
  return e as unknown as ScriptEditPayload;
}

function locateMcpServer(): string | undefined {
  try {
    const coreEntry = realpathSync(fileURLToPath(import.meta.resolve('@euta/core')));
    const p = resolve(dirname(coreEntry), '../../mcp-server/dist/index.js');
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

function locatePlugin(mcpServerPath: string | undefined): string | undefined {
  if (!mcpServerPath) return undefined;
  const p = resolve(dirname(mcpServerPath), '../../../../euta-claude-plugin');
  return existsSync(join(p, 'plugins')) ? p : undefined;
}

/** A report.html in its own sandboxed window (no preload) — or in the system browser. */
async function showReport(file: string, title: string, where: unknown): Promise<BrowserWindow | boolean> {
  if (where === 'browser') return (await shell.openPath(file)) === '';
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    title,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(file);
  return win;
}

async function openReport(projectId: string, runId: string, where: unknown): Promise<boolean> {
  // Local runs (index.sqlite), then a downloaded cloud run of a cloud project (`cloud-runs/<runId>/`).
  const local = svc().findRun(projectId, runId);
  const dir = local?.dir ?? (isCloud(projectId) ? cl().runs.dirOfEngineRun(projectId, runId) : undefined);
  const r = dir ? { id: local?.id ?? runId, dir } : undefined;
  const report = r && join(r.dir, 'report.html');
  if (!r || !report || !existsSync(report)) return false;
  return !!(await showReport(report, `Report — ${r.id}`, where));
}

/**
 * Test set report (ADR-032). Navigation stays blocked in report windows (hardenContents); a click on a
 * script's own report link (`…/runs/<runId>/report.html`) opens that run's report in its own window.
 */
async function openSuiteReport(projectId: string, suiteRunId: string, where: unknown): Promise<boolean> {
  const file = await svc().suiteReport(projectId, suiteRunId);
  if (!file) return false;
  const win = await showReport(file, `테스트 세트 리포트 — ${suiteRunId}`, where);
  if (win instanceof BrowserWindow) {
    win.webContents.on('will-navigate', (_e, url) => {
      let path: string;
      try {
        path = fileURLToPath(url);
      } catch {
        return;
      }
      const m = /[\\/]runs[\\/]([^\\/]+)[\\/]report\.html$/.exec(path);
      if (m?.[1]) void openReport(projectId, m[1], 'window');
    });
  }
  return !!win;
}

function registerIpc(): void {
  handle(IPC.appInfo, (): AppInfo => ({
    serverUrl: server?.url ?? '',
    runsDir: svc().currentRunsDir() ?? '',
    userData: app.getPath('userData'),
    ...(svc().appState.get().lastProjectId ? { lastProjectId: svc().appState.get().lastProjectId } : {}),
    mcpServerPath: locateMcpServer(),
    pluginDir: locatePlugin(locateMcpServer()),
    platform: process.platform,
    versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
  }));
  handle(IPC.appSettingsGet, () => svc().appSettings());
  handle(IPC.updateState, () => updater?.state());
  handle(IPC.updateCheck, () => updater?.check());
  handle(IPC.updateRestart, (force) => updater?.restart(force === true));
  handle(IPC.updateWhenIdle, () => updater?.restartWhenIdle());
  handle(IPC.updateCancelWait, () => updater?.stopWaiting());
  handle(IPC.updateDownload, () => updater?.openDownload() ?? false);
  handle(IPC.appSettingsSet, (patch) => {
    const before = svc().appSettings().cloudNotify;
    const next = svc().updateAppSettings(patch);
    if (next.cloudNotify !== before) cl().notifyChanged(next.cloudNotify);
    applyTheme(nativeTheme, next.theme);
    return next;
  });
  handle(IPC.vaultStatus, () => svc().vaultStatus());

  handle(IPC.pickFile, async (kind) => {
    const filters = kind === 'secrets' ? [{ name: 'Secrets', extensions: ['json', 'env'] }, { name: 'All', extensions: ['*'] }] : [{ name: 'euta script', extensions: ['yaml', 'yml'] }];
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters });
    return r.canceled ? undefined : r.filePaths[0];
  });
  handle(IPC.pickDir, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? undefined : r.filePaths[0];
  });

  // ---- projects
  handle(IPC.projectsList, () => svc().list());
  handle(IPC.projectCreate, (input) => svc().create(obj(input)));
  handle(IPC.projectGet, (id) => svc().view(str(id)));
  handle(IPC.projectOpen, (id) => svc().open(str(id)));
  handle(IPC.projectUpdate, (id, patch) => (isCloud(id) ? cl().updateProject(str(id), obj(patch)) : svc().update(str(id), obj(patch))));
  handle(IPC.projectDeleteCheck, (id) => {
    const pending = isCloud(id) ? (svc().view(str(id)).cloudView?.pending ?? 0) : 0;
    if (pending) return `보내기 대기 중인 저장이 ${pending}건 있습니다. 다시 연결해 보낸 뒤(또는 충돌을 해결한 뒤) 지우세요.`;
    return svc().deleteBlocker(str(id)) ?? null;
  });
  handle(IPC.projectDelete, (id) => svc().delete(str(id)));
  handle(IPC.envUpsert, (id, envId, input) => (isCloud(id) ? cl().upsertEnv(str(id), str(envId) || undefined, obj(input)) : svc().upsertEnv(str(id), str(envId) || undefined, obj(input))));
  handle(IPC.envDelete, (id, envId) => (isCloud(id) ? cl().deleteEnv(str(id), str(envId)) : svc().deleteEnv(str(id), str(envId))));
  // Write-only: returns the secret NAMES of the environment, never values.
  handle(IPC.secretSet, (id, envId, name, value) => svc().setSecret(str(id), str(envId), str(name), str(value)));
  handle(IPC.secretRemove, (id, envId, name) => svc().removeSecret(str(id), str(envId), str(name)));

  // ---- script library
  handle(IPC.scriptsList, (id) => svc().scripts(str(id)));
  handle(IPC.scriptCreate, (id, path, name) => svc().createScript(str(id), str(path) || undefined, str(name) || undefined));
  handle(IPC.scriptImport, async (id) => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'euta script', extensions: ['yaml', 'yml'] }] });
    if (r.canceled) return [];
    return r.filePaths.map((f) => svc().importScript(str(id), f));
  });
  handle(IPC.scriptRename, (id, from, to) => (isCloud(id) ? cl().renameScript(str(id), str(from), str(to)) : svc().renameScript(str(id), str(from), str(to))));
  handle(IPC.scriptDelete, (id, rel) => (isCloud(id) ? cl().deleteScript(str(id), str(rel)) : svc().deleteScript(str(id), str(rel))));
  handle(IPC.scriptExport, async (id, rel) => {
    const r = await dialog.showSaveDialog(mainWindow!, { defaultPath: basename(str(rel)), filters: [{ name: 'euta script', extensions: ['yaml', 'yml'] }] });
    if (r.canceled || !r.filePath) return false;
    svc().exportScript(str(id), str(rel), r.filePath);
    return true;
  });
  handle(IPC.scriptOpen, async (id, rel) => (await shell.openPath(svc().scriptAbsPath(str(id), str(rel)))) === '');
  handle(IPC.scriptCheck, (id, rel, envId, vars, env) => svc().checkScript(str(id), str(rel), str(envId) || undefined, str(vars), str(env)));
  // ---- script view · edit · history (SPEC 스크립트-보기-편집)
  handle(IPC.scriptDetail, (id, rel, envId) => svc().scriptDetail(str(id), str(rel), str(envId) || undefined));
  handle(IPC.scriptDraftCheck, (id, base, edit, envId) => svc().checkDraft(str(id), str(base), editPayload(edit), str(envId) || undefined));
  handle(IPC.scriptSave, (id, rel, base, edit, envId, force) =>
    isCloud(id)
      ? cl().saveScript(str(id), str(rel), str(base), editPayload(edit), str(envId) || undefined)
      : svc().saveScript(str(id), str(rel), str(base), editPayload(edit), { ...(str(envId) ? { envId: str(envId) } : {}), force: force === true }),
  );
  handle(IPC.scriptVersions, (id, rel) => (isCloud(id) ? cl().scriptVersions(str(id), str(rel)) : svc().scriptVersions(str(id), str(rel))));
  handle(IPC.scriptCompare, (id, key, to, from) => {
    const f = typeof from === 'number' ? from : undefined;
    return isCloud(id) ? cl().compareVersions(str(id), str(key), Number(to), f) : svc().compareVersions(str(id), str(key), Number(to), f);
  });
  handle(IPC.scriptRestore, (id, key, version) => {
    if (isCloud(id)) return cl().restoreVersion(str(id), str(key), Number(version));
    const r = svc().restoreVersion(str(id), str(key), Number(version));
    return r.conflict ? { conflict: true } : { path: r.path };
  });
  handle(IPC.scriptsDeleted, (id) => (isCloud(id) ? cl().deletedScripts(str(id)) : svc().deletedScripts(str(id))));
  handle(IPC.scriptUndelete, (id, key) => (isCloud(id) ? cl().undeleteScript(str(id), str(key)) : svc().undeleteScript(str(id), str(key))));
  handle(IPC.scriptRunShot, (id, runId, rel) => {
    const r = svc().findRun(str(id), str(runId));
    return r ? readArtifactImage(r.dir, str(rel)) : undefined;
  });
  handle(IPC.scriptAiRequest, (id, rel, text, step, envId) => {
    const s = obj(step);
    const stepCtx = typeof s.id === 'string' && typeof s.sentence === 'string' ? { id: s.id, sentence: s.sentence } : undefined;
    return svc().requestScriptEdit(str(id), str(rel), str(text), stepCtx, str(envId) || undefined).id;
  });

  // ---- runs
  handle(IPC.runStart, (raw) => {
    const h = svc().startRun(obj(raw) as unknown as ProjectRunRequest);
    return { runId: h.runId, runDir: h.runDir };
  });
  handle(IPC.liveList, () => live.list());
  handle(IPC.liveGet, (id) => live.get(str(id)));
  handle(IPC.artifactImage, (id, rel) => {
    const dir = live.runDirOf(str(id));
    return dir ? readArtifactImage(dir, str(rel)) : undefined;
  });
  handle(IPC.historyList, (id) => svc().history(str(id)));
  handle(IPC.historyOpen, (id, runId) => {
    const r = svc().findRun(str(id), str(runId));
    if (!r) return undefined;
    if (!live.get(r.id)) live.loadFromRunDir(r.id, r.dir, 'history');
    return r.id;
  });
  handle(IPC.reportOpen, (id, runId, where) => openReport(str(id), str(runId), where));
  handle(IPC.suiteReportOpen, (id, suiteRunId, where) => openSuiteReport(str(id), str(suiteRunId), where));

  // ---- suites
  handle(IPC.suiteUpsert, (id, suiteId, input) => (isCloud(id) ? cl().upsertSuite(str(id), str(suiteId) || undefined, obj(input)) : svc().upsertSuite(str(id), str(suiteId) || undefined, obj(input))));
  handle(IPC.suiteDelete, (id, suiteId) => (isCloud(id) ? cl().deleteSuite(str(id), str(suiteId)) : svc().deleteSuite(str(id), str(suiteId))));
  handle(IPC.suiteRun, (id, suiteId, envId) => svc().runSuite(str(id), str(suiteId), str(envId) || undefined).run);
  handle(IPC.suiteCancel, (suiteRunId) => svc().cancelSuite(str(suiteRunId)));

  // ---- activity
  handle(IPC.activityList, (id, q) => svc().activity(str(id), obj(q) as ActivityQuery));

  // ---- AI terminal (advanced) + hooks
  handle(IPC.hooksList, () => hooks.list());
  handle(IPC.termInfo, async () => {
    await pathFixed;
    return ptys.info();
  });
  handle(IPC.termSpawn, async (kind, cols, rows) => {
    await pathFixed;
    const k: PtyKind = kind === 'claude' || kind === 'codex' ? kind : 'shell';
    return ptys.spawn(k, Number(cols), Number(rows));
  });
  on(IPC.termWrite, (id, data) => ptys.write(Number(id), str(data)));
  on(IPC.termResize, (id, cols, rows) => ptys.resize(Number(id), Number(cols), Number(rows)));
  on(IPC.termKill, (id) => ptys.kill(Number(id)));

  // ---- AI chat (per project)
  handle(IPC.aiInfo, (id) => aiInfo(str(id)));
  handle(IPC.aiAuthStatus, async (force) => {
    await pathFixed;
    return auth.status(force === true);
  });
  handle(IPC.aiAuthLogin, async () => {
    await pathFixed;
    return auth.startLogin();
  });
  handle(IPC.aiAuthLogout, async () => {
    await pathFixed;
    return auth.logout();
  });
  handle(IPC.aiChats, (id) => svc().chatEngine(str(id)).list());
  handle(IPC.aiChatGet, (id, chatId) => svc().chatEngine(str(id)).get(str(chatId)));
  handle(IPC.aiChatNew, (id, envId) => svc().chatEngine(str(id)).create(str(envId) || undefined));
  handle(IPC.aiChatDelete, (id, chatId) => svc().chatEngine(str(id)).delete(str(chatId)));
  handle(IPC.aiChatSetEnv, (id, chatId, envId) => svc().chatEngine(str(id)).setEnv(str(chatId), str(envId) || undefined));
  handle(IPC.aiSend, (id, chatId, text) => {
    const engine = svc().chatEngine(str(id));
    const c = engine.get(str(chatId));
    if (!c) throw new Error('chat not found');
    if (c.busy) throw new Error('chat is busy');
    // The app sends the next TC item itself between messages; the person's message waits for [중지].
    if (svc().tcDocs.autoChat(str(id), c.id)) throw new Error('TC 자동 변환이 진행 중입니다 — [중지] 한 뒤 보내세요');
    // Runs in the background; progress arrives via ai:chat-update.
    void engine.send(c.id, str(text).slice(0, 20_000)).catch(() => undefined);
  });
  handle(IPC.aiStop, (id, chatId) => svc().chatEngine(str(id)).stop(str(chatId)));

  // ---- demonstration recordings
  handle(IPC.recList, (id) => svc().recordings(str(id)));
  handle(IPC.recCurrent, () => svc().recordingView() ?? null);
  handle(IPC.recStart, (id, req) => svc().startRecording(str(id), obj(req) as RecordingStartRequest));
  handle(IPC.recControl, (id, recId, action, arg) => svc().recordingControl(str(id), str(recId), str(action) as RecordingAction, obj(arg)));
  handle(IPC.recRename, (id, recId, name) => svc().renameRecording(str(id), str(recId), str(name)));
  handle(IPC.recDelete, (id, recId) => svc().deleteRecording(str(id), str(recId)));
  handle(IPC.recDraft, (id, recId, envId) => svc().recordingDraft(str(id), str(recId), str(envId) || undefined));
  handle(IPC.recSave, (id, recId, envId) => svc().saveRecordingDraft(str(id), str(recId), str(envId) || undefined));
  handle(IPC.recTidy, (id, recId, envId, message) => svc().tidyRecording(str(id), str(recId), str(envId) || undefined, str(message)).id);
  handle(IPC.recShot, (id, recId, rel) => {
    try {
      const p = svc().recordingStore(str(id)).file(str(recId), str(rel));
      return /\.png$/i.test(p) && existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : undefined;
    } catch {
      return undefined;
    }
  });

  // ---- TC documents (SPEC TC-문서-변환) — local only, also for cloud projects (never routed to the server)
  const tc = () => svc().tcDocs;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  handle(IPC.tcdocList, (id) => tc().list(str(id)));
  handle(IPC.tcdocGet, (id, docId) => tc().view(str(id), str(docId)));
  handle(IPC.tcdocImport, async (id) => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters: [{ name: 'TC 문서', extensions: ['xlsx', 'csv', 'docx', 'md'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return tc().importFile(str(id), r.filePaths[0]);
  });
  handle(IPC.tcdocImportGet, (importId) => tc().importView(str(importId)) ?? null);
  handle(IPC.tcdocImportExtract, (id, importId, envId) => tc().extractWithAi(str(id), str(importId), str(envId) || undefined).id);
  handle(IPC.tcdocImportCancel, (importId) => tc().cancelImport(str(importId)));
  handle(IPC.tcdocImportConfirm, (id, importId, c) => tc().confirmImport(str(id), str(importId), obj(c) as unknown as TcImportConfirm));
  handle(IPC.tcdocRename, (id, docId, name) => tc().rename(str(id), str(docId), str(name)));
  handle(IPC.tcdocDelete, (id, docId) => tc().delete(str(id), str(docId)));
  handle(IPC.tcdocSetQueue, (id, docId, tcIds) => tc().setQueue(str(id), str(docId), strs(tcIds)));
  handle(IPC.tcdocConvert, (id, docId, o) => {
    const x = obj(o);
    return tc().convert(str(id), str(docId), { ...(Array.isArray(x.tcIds) ? { tcIds: strs(x.tcIds) } : {}), redo: x.redo === true, envId: str(x.envId), message: str(x.message), ...(typeof x.limit === 'number' ? { limit: x.limit } : {}) }).id;
  });
  handle(IPC.tcdocStop, (id, docId) => tc().stopConvert(str(id), str(docId)));
  handle(IPC.tcdocProgress, (id) => tc().progress(str(id)));
  handle(IPC.tcdocExclude, (id, docId, tcId, excluded) => tc().exclude(str(id), str(docId), str(tcId), excluded === true));
  handle(IPC.tcdocMapping, (id, docId, tcId) => tc().mapping(str(id), str(docId), str(tcId)));
  handle(IPC.tcdocPlanSets, (id, docId, mode, tcIds) => tc().planSets(str(id), str(docId), (mode === 'category' || mode === 'checked' ? mode : 'all') as TcSetGrouping, strs(tcIds)));
  handle(IPC.tcdocExport, async (id, source, format) => {
    const pid = str(id);
    const fmt: TcExportFormat = format === 'md' ? 'md' : 'xlsx';
    const src = obj(source);
    let out: { name: string; bytes: Uint8Array; count?: number };
    let what: string;
    if (str(src.docId)) {
      out = tc().exportDoc(pid, str(src.docId), fmt);
      what = `TC 문서 “${out.name}”`;
    } else if (str(src.suiteId)) {
      const suite = svc().view(pid).suites.find((s) => s.id === str(src.suiteId));
      if (!suite) throw new Error('테스트 세트를 찾을 수 없습니다');
      out = tc().exportScripts(pid, suite.scripts, suite.name, fmt);
      what = `테스트 세트 “${suite.name}”`;
    } else {
      out = tc().exportScripts(pid, strs(src.scripts), str(src.name) || 'euta 스크립트', fmt);
      what = `스크립트 ${strs(src.scripts).length}개`;
    }
    const safe = out.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'tc-document';
    const r = await dialog.showSaveDialog(mainWindow!, { defaultPath: `${safe}.${fmt}`, filters: [{ name: fmt === 'xlsx' ? 'Excel' : 'Markdown', extensions: [fmt] }] });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, out.bytes);
    svc().log(pid, 'tcdoc.exported', 'user', `TC 문서로 내보내기: ${what} → ${basename(r.filePath)} (${fmt}${out.count ? `, TC ${out.count}개` : ''})`, str(src.docId) ? { tcDocId: str(src.docId) } : undefined);
    return r.filePath;
  });

  // ---- euta cloud (SPEC 클라우드-앱-연동)
  handle(IPC.cloudStatus, () => cl().status());
  handle(IPC.cloudSetServer, (url) => cl().setServer(str(url)));
  handle(IPC.cloudLogin, () => cl().login());
  handle(IPC.cloudLoginCancel, () => cl().cancelLogin());
  handle(IPC.cloudLogout, () => cl().logout());
  handle(IPC.cloudReconnect, async () => {
    await cl().probe();
    return cl().status();
  });
  handle(IPC.cloudProjects, () => cl().receiveList());
  handle(IPC.cloudOpenRemote, (cloudId) => cl().openRemote(str(cloudId)));
  handle(IPC.cloudUpload, (id) => cl().upload(str(id)));
  handle(IPC.cloudResolve, (id, ticket, choice) => {
    const c = str(choice);
    if (c !== 'mine' && c !== 'theirs' && c !== 'copy') throw new Error('invalid choice');
    return cl().resolveConflict(str(id), Number(ticket), c as CloudConflictChoice);
  });
  handle(IPC.cloudResync, (id) => cl().resync(str(id)));
  handle(IPC.cloudMembers, (id) => cl().members(str(id)));
  const roleOf = (r: unknown): CloudRole => (r === 'owner' || r === 'runner' || r === 'viewer' ? r : 'editor');
  handle(IPC.cloudMemberSet, (id, email, role) => cl().setMember(str(id), str(email), roleOf(role)));
  handle(IPC.cloudConvertPreview, (id) => cl().convertPreview(str(id)));
  handle(IPC.cloudAccessRequest, (project, role, memo) => cl().requestAccess(str(project), role === 'runner' ? 'runner' : 'editor', str(memo)));
  handle(IPC.cloudMyAccessRequest, (id) => cl().myOpenRequest(str(id)));
  handle(IPC.cloudAccessRequests, (id) => cl().accessRequests(str(id)));
  handle(IPC.cloudAccessDecide, (id, requestId, approve, role) => cl().decideAccess(str(id), str(requestId), approve === true, role ? roleOf(role) : undefined));
  handle(IPC.cloudMergeStatus, (id) => cl().mergeStatus(str(id)));
  handle(IPC.cloudMergePlan, (id) => cl().mergePlan(str(id)));
  handle(IPC.cloudMergeApply, (id, choices) => {
    const c = obj(choices);
    const pick = <T extends string>(v: unknown, ok: readonly T[]): Record<string, T> => Object.fromEntries(Object.entries(obj(v)).filter((e): e is [string, T] => ok.includes(e[1] as T)));
    return cl().mergeApply(str(id), { scripts: pick(c.scripts, ['local', 'server', 'both'] as const), suites: pick(c.suites, ['local', 'server'] as const) });
  });
  handle(IPC.cloudRefreshAccess, async (id) => {
    await cl().refreshAccess(str(id));
    return svc().view(str(id));
  });
  handle(IPC.cloudMemberRemove, (id, userId) => cl().removeMember(str(id), str(userId)));
  // Write-only: the value goes to the server once; it is never stored or returned.
  handle(IPC.cloudCredentialSet, (id, envId, name, value) => cl().setCredential(str(id), str(envId), str(name), str(value)));
  handle(IPC.cloudCredentialRemove, (id, envId, name) => cl().removeCredential(str(id), str(envId), str(name)));
  handle(IPC.cloudActivity, (id) => cl().activity(str(id)));
  handle(IPC.cloudUserSearch, async (q) => (await cl().searchUsers(str(q))) ?? null);
  // ---- cloud runs · History · upload · schedules (C3)
  const runReq = (v: unknown): CloudRunRequest => {
    const o = obj(v);
    return { ...(str(o.script) ? { script: str(o.script) } : {}), ...(str(o.suiteId) ? { suiteId: str(o.suiteId) } : {}), ...(str(o.envId) ? { envId: str(o.envId) } : {}), vars: str(o.vars) };
  };
  handle(IPC.cloudPrecheck, (id, req) => cl().runs.precheck(str(id), runReq(req)));
  handle(IPC.cloudRunStart, (id, req) => cl().runs.start(str(id), runReq(req)));
  handle(IPC.cloudRunCancel, (id, runId) => cl().runs.cancel(str(id), str(runId)));
  handle(IPC.cloudHistory, (id) => cl().runs.history(str(id)));
  handle(IPC.cloudRunChildren, (id, runId) => cl().runs.children(str(id), str(runId)));
  handle(IPC.cloudRunOpen, (id, runId) => cl().runs.open(str(id), str(runId)));
  handle(IPC.cloudRunReport, async (id, runId, where) => {
    const dir = cl().runs.cachedDir(str(id), str(runId));
    if (!dir) await cl().runs.open(str(id), str(runId));
    const d = cl().runs.cachedDir(str(id), str(runId));
    if (!d || !existsSync(join(d, 'report.html'))) return false;
    return !!(await showReport(join(d, 'report.html'), `Report — ${str(runId)}`, where));
  });
  // A cloud test set run's report is the web run detail (ADR-032): built in main, opened in the browser.
  handle(IPC.cloudRunWeb, (id, runId) => openExternalUrl(cl().runs.webRunUrl(str(id), str(runId))));
  handle(IPC.cloudRunUpload, (id, localRunId) => cl().runs.upload(str(id), str(localRunId)));
  handle(IPC.cloudSchedules, (id) => cl().schedules.list(str(id)));
  handle(IPC.cloudScheduleSave, (id, scheduleId, form) => cl().schedules.save(str(id), str(scheduleId) || undefined, obj(form) as CloudScheduleForm));
  handle(IPC.cloudScheduleDelete, (id, scheduleId) => cl().schedules.remove(str(id), str(scheduleId)));
}

/** An app notification (SPEC 클라우드-앱-연동 "앱 알림") → OS notification; click opens the run. */
function showNotification(v: CloudNotificationView): void {
  notifications.push(v);
  if (notifications.length > 100) notifications.shift();
  if (process.env.EUTA_E2E === '1' || !Notification.isSupported()) return;
  const n = new Notification({ title: v.title, body: v.body });
  liveNotifications.add(n);
  n.on('click', () => {
    liveNotifications.delete(n);
    openNotification(v);
  });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

function openNotification(v: CloudNotificationView): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  send(IPC.cloudOpenRun, v);
}

/** How this build was signed (`eutaBuild` in the packaged package.json — scripts/package.mjs). */
function buildInfo(): { macSignature?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { eutaBuild?: { macSignature?: string } };
    return pkg.eutaBuild ?? {};
  } catch {
    return {};
  }
}

/**
 * App updates (SPEC 앱-배포-업데이트, ADR-042). E2E (EUTA_E2E=1 + EUTA_E2E_UPDATE_MODE=auto|manual) forces the
 * path on the unpackaged app: `auto` checks the fake feed with electron-updater for real, the download and
 * the install are stubbed (an unsigned development app cannot install).
 */
function createUpdater(): AppUpdater {
  const version = app.getVersion();
  const channel = channelOf(version);
  const forced = process.env.EUTA_E2E === '1' && ['auto', 'manual'].includes(process.env.EUTA_E2E_UPDATE_MODE ?? '') ? (process.env.EUTA_E2E_UPDATE_MODE as UpdateMode) : undefined;
  const mode = forced ?? updateMode({ platform: process.platform, packaged: app.isPackaged, macSignature: buildInfo().macSignature, appImage: !!process.env.APPIMAGE });
  // The connected cloud server, if any (EUTA_UPDATE_SERVER overrides it — development / E2E only).
  const serverUrl = (): string | undefined => process.env.EUTA_UPDATE_SERVER || cloud?.status().serverUrl || undefined;
  let backend: UpdaterBackend | undefined;
  if (mode === 'auto') {
    const real = electronUpdaterBackend({ dev: !!forced });
    backend = forced ? { setFeed: (u) => real.setFeed(u), check: () => real.check(), download: async () => undefined, install: () => void installRequests++ } : real;
  }
  return new AppUpdater({
    version,
    channel,
    mode,
    platform: process.platform,
    arch: process.arch,
    source: () => resolveUpdateSource({ serverUrl: serverUrl(), channel, version, fetch: (u, init) => fetch(u, init) }),
    ...(backend ? { backend } : {}),
    busy: () => projects?.busyWork() ?? { runs: 0, recording: false, chats: 0 },
    emit: (v) => send(IPC.updateChanged, v),
    openExternal: openExternalUrl,
  });
}

/** System browser for the device-approval page (http(s) only). E2E records it instead. */
function openExternalUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  lastExternalUrl = url;
  if (process.env.EUTA_E2E === '1') return;
  void shell.openExternal(url);
}

function hardenContents(contents: WebContents): void {
  // No popups, no navigation away from the loaded page.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => {
    if (url !== contents.getURL()) e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'euta',
    show: false,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  const dev = rendererUrl();
  if (dev) void mainWindow.loadURL(dev);
  else void mainWindow.loadFile(join(here, '../renderer/index.html'));
  mainWindow.on('closed', () => (mainWindow = undefined));
}

app.on('web-contents-created', (_e, contents) => hardenContents(contents));

// E2E: Chromium's mock keychain keeps safeStorage off the user's real Keychain (no prompts,
// no stray items). Real encryption code path, test-only key. Never set in normal runs.
if (process.env.EUTA_E2E === '1') app.commandLine.appendSwitch('use-mock-keychain');

app.whenReady().then(async () => {
  // Dev mode runs the stock Electron bundle; the packaged app gets the icon from its icns (ADR-027).
  if (!app.isPackaged) app.dock?.setIcon(join(here, '../../build/icon.png'));
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  pathFixed = fixProcessPath().catch(() => false);

  projects = new ProjectService({
    userData: app.getPath('userData'),
    safeStorage,
    live,
    events: {
      projectsChanged: () => send(IPC.projectsChanged),
      scriptsChanged: (id) => send(IPC.scriptsChanged, id),
      suiteUpdate: (r) => send(IPC.suiteUpdate, r),
      activity: (id, e) => send(IPC.activityAppended, id, e),
      chatUpdate: (id, c) => send(IPC.aiChatUpdate, id, c),
      recordingUpdate: (v) => send(IPC.recUpdate, v),
      tcDocChanged: (id, docId) => send(IPC.tcdocChanged, id, docId),
      tcImportUpdate: (v) => send(IPC.tcdocImportUpdate, v),
    },
    chat: {
      loadSdk: async () => (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SdkModule,
      ...(FAKE_AGENT ? { queryFn: fakeQuery } : {}),
      claudeExecutable: claudeExecutableForAgent,
    },
  });

  cloud = new CloudService({
    userData: app.getPath('userData'),
    safeStorage,
    projects,
    live,
    openExternal: openExternalUrl,
    notifyEnabled: () => projects?.appSettings().cloudNotify ?? true,
    appVersion: app.getVersion(),
    events: {
      status: (v) => send(IPC.cloudStatusChanged, v),
      notice: (n) => send(IPC.cloudNotice, n),
      projectsChanged: () => send(IPC.projectsChanged),
      scriptsChanged: (id) => send(IPC.scriptsChanged, id),
      runsChanged: (id) => send(IPC.cloudRunsChanged, id),
      notification: (v) => showNotification(v),
    },
  });
  cloud.start();
  // 앱 설정 "화면 테마" before the first window: Electron drives prefers-color-scheme from it.
  applyTheme(nativeTheme, projects.appSettings().theme);

  server = await startLocalServer({
    onEvents: (env) => live.ingest(env.events, 'mcp'),
    onHook: (payload) => hooks.ingest(payload),
  });
  ptys = new PtyManager(
    () => {
      const runsDir = svc().currentRunsDir();
      const cur = svc().current();
      if (!runsDir || !cur) throw new Error('open a project first');
      return { url: server!.url, token: server!.token, runsDir, allowedDomains: svc().terminalDomains(cur) };
    },
    {
      onData: (id, data) => send(IPC.termData, id, data),
      onExit: (id, code) => send(IPC.termExit, id, code),
    },
  );
  live.onUpdate((v) => send(IPC.liveUpdate, v));
  hooks.onUpdate((s) => send(IPC.hooksUpdate, s));
  updater = createUpdater();
  registerIpc();

  if (process.env.EUTA_E2E === '1') {
    // Test-only handle for Playwright's electronApp.evaluate (never set in normal runs).
    // recorderPage(): the demonstration recorder's Playwright page, so the E2E can act as
    // the person in the recording browser (ADR-017) — no debug port, no CDP.
    (globalThis as Record<string, unknown>).__eutaTest = {
      serverUrl: server.url,
      token: server.token,
      live,
      hooks,
      projects,
      claudeExecutable: claudeExecutableForAgent(),
      recorderPage: () => projects?.activeRecorderPage(),
      cloud,
      updater,
      installRequests: () => installRequests,
      lastExternalUrl: () => lastExternalUrl,
      notifications: () => notifications.slice(),
      /** What a click on notification `i` does (open the project and the run). */
      clickNotification: (i: number) => {
        const v = notifications[i];
        if (v) openNotification(v);
      },
    };
  }

  createWindow();
  updater.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Synchronous cleanup: kill pty children, stop timers, drop server sockets. (Deferring
// quit with preventDefault + a second app.quit() stalls on macOS, so nothing is awaited.)
app.on('will-quit', () => {
  ptys?.killAll();
  auth.dispose();
  cloud?.dispose();
  updater?.dispose();
  void projects?.dispose(); // watchers; aborts chat turns; AI-opened browser sessions are closed best-effort
  live.dispose();
  if (server) {
    server.server.closeAllConnections();
    server.server.close();
  }
});

// Terminal/CI signals: quit through the normal path so ptys and the server are closed.
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || process.env.EUTA_E2E === '1') app.quit();
});
