import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cloud, Download, Folder, Lock, Plus, RefreshCw, Settings } from 'lucide-react';
import logo from '../../../build/icon.svg';
import type { CloudConflictView, CloudConvertResult, CloudNotice, ProjectSummary, ProjectView, RecordingView, RunListItem, RunView, SuiteRun } from '../../shared/types';
import { CloudChip, ConflictDialog, ROLE_LABEL, useCloudStatus } from './tabs/Cloud';
import { AccessLostPanel, CloudReceive, MergeBanner, RoleBadges } from './tabs/CloudAccess';
import { ScriptsTab } from './tabs/ScriptsTab';
import { RunTab, type RunWhere } from './tabs/RunTab';
import { SchedulesTab } from './tabs/SchedulesTab';
import { LiveTab } from './tabs/LiveTab';
import { HistoryTab } from './tabs/HistoryTab';
import { AiTab } from './tabs/AiTab';
import { ActivityTab } from './tabs/ActivityTab';
import { ProjectSettingsTab } from './tabs/ProjectSettingsTab';
import { AppSettingsTab } from './tabs/SettingsTab';
import { RecordingPanel, RecordStartDialog } from './tabs/RecordingPanel';
import { UpdateBanner, useUpdateActions } from './tabs/Update';
import { confirmLeave } from './unsaved';
import { Badge, Button, cx, PageHeader, Tabs } from './ui';

export type Tab = 'scripts' | 'run' | 'live' | 'history' | 'schedules' | 'ai' | 'activity' | 'project';
const TABS: { id: Tab; label: string; cloudOnly?: boolean }[] = [
  { id: 'scripts', label: '스크립트' },
  { id: 'run', label: '실행' },
  { id: 'live', label: '실시간' },
  { id: 'history', label: '실행 이력' },
  { id: 'schedules', label: '예약', cloudOnly: true },
  { id: 'ai', label: 'AI' },
  { id: 'activity', label: '작업 로그' },
  { id: 'project', label: '프로젝트 설정' },
];

/** Tabs left on a working copy locked as "접근 권한 없음". */
const LOCKED_TABS: Tab[] = ['history', 'live'];

/** Cross-tab navigation requests (activity → run/chat/script, scripts → run). */
export interface Nav {
  openRun(runId: string): void;
  openHistoryRun(runId: string): void;
  openChat(chatId: string): void;
  openScript(path: string): void;
  runScript(path: string, where?: RunWhere): void;
  /** "시연으로 만들기": environment / start path / name dialog, then the recorder. With a TC: "시연으로 변환". */
  startRecording(tc?: { docId: string; tcId: string }): void;
  /** A recording was deleted from the library — close its panel if it is the one shown. */
  recordingDeleted(recordingId: string): void;
  /** Cloud project: show the conflict screen (3 choices). */
  openConflict(v: CloudConflictView): void;
}

function NewProject({ onCreated, first }: { onCreated: (p: ProjectView) => void; first: boolean }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState<string | undefined>();
  const create = async () => {
    setError(undefined);
    try {
      onCreated(await window.euta.projects.create({ name, baseUrl }));
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Input)?Error: /, ''));
    }
  };
  return (
    <div className="welcome" data-testid="new-project">
      {first && (
        <>
          <PageHeader title="euta 에 오신 것을 환영합니다" />
          <p className="muted">테스트할 사이트(서비스)마다 프로젝트를 만듭니다. 프로젝트에는 환경(dev·staging·prod 주소·변수·비밀값), 스크립트, 실행 이력, AI 대화, 작업 로그가 함께 저장됩니다.</p>
        </>
      )}
      <div className="card">
      <h3>새 프로젝트 만들기</h3>
      <div className="form-row">
        <label htmlFor="np-name">프로젝트 이름</label>
        <input id="np-name" data-testid="new-project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 고객 포털" />
      </div>
      <div className="form-row">
        <label htmlFor="np-url">첫 환경 주소 (선택 — 나중에 프로젝트 설정에서 추가 가능)</label>
        <input id="np-url" data-testid="new-project-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://dev.example.com" />
      </div>
      <Button variant="primary" icon={Plus} disabled={!name.trim()} onClick={() => void create()} data-testid="new-project-create">
        만들기
      </Button>
      {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

/** Cloud project locked by 426 APP_TOO_OLD (SPEC 앱-배포-업데이트 "최소 앱 버전"). */
function UpdateNeededPanel({ pending, minVersion }: { pending: number; minVersion: string | null }) {
  const a = useUpdateActions();
  return (
    <section className="panel" data-testid="cloud-update-needed">
      <div className="card">
        <h3>앱을 업데이트해야 이 클라우드 프로젝트를 열 수 있습니다</h3>
        <p className="muted">
          euta cloud 가 이 앱 버전을 더 받지 않습니다{minVersion ? ` (최소 ${minVersion})` : ''}. 작업 사본은 이 PC 에 남아 있고
          {pending ? ` 보내기 대기 ${pending}건도 그대로 보관합니다 — 업데이트한 뒤 보냅니다` : ' 지워지지 않습니다'}. 로컬 프로젝트와 이 PC 실행은 그대로 쓸 수 있습니다.
        </p>
        <Button variant="primary" icon={RefreshCw} onClick={() => void a.updateNow()} data-testid="cloud-update-button">
          업데이트
        </Button>
        {a.error && <div className="error">{a.error}</div>}
      </div>
      {a.dialogs}
    </section>
  );
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[] | undefined>();
  const [currentId, setCurrentId] = useState<string | undefined>();
  const [project, setProject] = useState<ProjectView | undefined>();
  const [view, setView] = useState<'project' | 'new' | 'app-settings' | 'cloud-find'>('project');
  const cloudStatus = useCloudStatus();
  const [conflict, setConflict] = useState<CloudConflictView | undefined>();
  /** "클라우드로 올리기" just converted this project (the result banner on the cloud project). */
  const [converted, setConverted] = useState<CloudConvertResult | undefined>();
  const [notices, setNotices] = useState<(CloudNotice & { n: number })[]>([]);
  const dismissedTicket = useRef<string | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('scripts');
  const [runs, setRuns] = useState<Map<string, RunView>>(new Map());
  const [selected, setSelected] = useState<string | undefined>();
  const [follow, setFollow] = useState(true);
  const [chatToOpen, setChatToOpen] = useState<{ id: string; n: number } | undefined>();
  const [scriptFocus, setScriptFocus] = useState<{ path: string; n: number } | undefined>();
  const [runScriptReq, setRunScriptReq] = useState<{ path: string; n: number; where?: RunWhere } | undefined>();
  /** Run tab's 실행 위치 — test sets in the Scripts tab run there too (SPEC 테스트 세트). */
  const [runWhere, setRunWhere] = useState<RunWhere>('pc');
  const [recView, setRecView] = useState<RecordingView | undefined>();
  const [recDismissed, setRecDismissed] = useState(false);
  const [recDialog, setRecDialog] = useState<false | { tc?: { docId: string; tcId: string } }>(false);
  const followRef = useRef(true);
  const currentRef = useRef<string | undefined>(undefined);
  const known = useRef(new Set<string>());

  const refreshProjects = useCallback(async () => setProjects(await window.euta.projects.list()), []);
  const refreshProject = useCallback(async (id = currentRef.current) => {
    if (!id) return setProject(undefined);
    try {
      setProject(await window.euta.projects.get(id));
    } catch {
      setProject(undefined);
    }
  }, []);

  const openProject = useCallback(async (id: string) => {
    if (id !== currentRef.current && !confirmLeave()) return;
    currentRef.current = id;
    setCurrentId(id);
    setView('project');
    setSelected(undefined);
    setProject(await window.euta.projects.open(id));
    await refreshProjects();
  }, [refreshProjects]);

  // Initial load: projects, last project.
  useEffect(() => {
    void (async () => {
      const [list, info] = await Promise.all([window.euta.projects.list(), window.euta.appInfo()]);
      setProjects(list);
      const last = list.find((p) => p.id === info.lastProjectId) ?? list[0];
      if (last) await openProject(last.id);
    })();
    const offChanged = window.euta.projects.onChanged(() => {
      void refreshProjects();
      void refreshProject();
    });
    return offChanged;
  }, [openProject, refreshProject, refreshProjects]);

  // Live runs (all projects; the project's Live tab filters).
  useEffect(() => {
    void window.euta.live.list().then(async (items: RunListItem[]) => {
      const views = await Promise.all(items.map((i) => window.euta.live.get(i.runId)));
      const list = views.filter((v): v is RunView => !!v);
      for (const v of list) known.current.add(v.runId);
      setRuns((prev) => new Map([...list.map((v) => [v.runId, v] as const), ...prev]));
    });
    return window.euta.live.onUpdate((v) => {
      if (!known.current.has(v.runId)) {
        known.current.add(v.runId);
        // Follow newly started runs of the open project; history opens select explicitly.
        // Cloud runs that are already over (feed catch-up after a restart) do not steal the selection.
        const finishedCloud = v.source === 'cloud' && v.status !== 'running';
        if (v.source !== 'history' && !finishedCloud && followRef.current && (!v.projectId || v.projectId === currentRef.current)) setSelected(v.runId);
        void refreshProjects();
      }
      setRuns((prev) => {
        const old = prev.get(v.runId);
        if (old && old.status !== v.status) void refreshProjects();
        return new Map(prev).set(v.runId, v);
      });
    });
  }, [refreshProjects]);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  // The demonstration recording (one at a time) and its panel.
  useEffect(() => {
    void window.euta.recordings.current().then((v) => v && setRecView(v));
    return window.euta.recordings.onUpdate((v) => {
      setRecView((cur) => {
        if (!cur || cur.id !== v.id) setRecDismissed(false);
        return v;
      });
    });
  }, []);

  const projectRuns = useMemo(() => new Map([...runs].filter(([, v]) => !v.projectId || v.projectId === currentId)), [runs, currentId]);

  // This PC's test set runs of the open project — Live groups their runs under the set (ADR-032).
  const [suiteRuns, setSuiteRuns] = useState<SuiteRun[]>([]);
  useEffect(() => {
    setSuiteRuns([]);
    if (!currentId) return;
    let alive = true;
    void window.euta.history
      .list(currentId)
      .then((h) => alive && setSuiteRuns((cur) => [...cur, ...h.suiteRuns.filter((r) => !cur.some((c) => c.id === r.id))]))
      .catch(() => undefined);
    const off = window.euta.suites.onUpdate((r) => {
      if (r.projectId !== currentId) return;
      setSuiteRuns((cur) => [r, ...cur.filter((c) => c.id !== r.id)]);
    });
    return () => {
      alive = false;
      off();
    };
  }, [currentId]);

  const nav: Nav = useMemo(
    () => ({
      openRun: (runId) => {
        setSelected(runId);
        setTab('live');
      },
      openHistoryRun: async (runId) => {
        if (!currentRef.current) return;
        const id = await window.euta.history.open(currentRef.current, runId);
        if (id) {
          setSelected(id);
          setTab('live');
        }
      },
      openChat: (chatId) => {
        setChatToOpen({ id: chatId, n: Date.now() });
        setTab('ai');
      },
      openScript: (path) => {
        setScriptFocus({ path, n: Date.now() });
        setTab('scripts');
      },
      runScript: (path, where) => {
        setRunScriptReq({ path, n: Date.now(), ...(where ? { where } : {}) });
        setTab('run');
      },
      startRecording: (tc) => setRecDialog(tc ? { tc } : {}),
      recordingDeleted: (recordingId) => setRecView((cur) => (cur && cur.id === recordingId ? undefined : cur)),
      openConflict: (v) => setConflict(v),
    }),
    [],
  );

  // An app notification was clicked (SPEC 앱 알림 "클릭 → 그 실행"): open its project, then the run.
  useEffect(
    () =>
      window.euta.cloud.onOpenRun((v) => {
        void (async () => {
          const list = await window.euta.projects.list();
          if (!list.some((p) => p.id === v.projectId)) return;
          if (currentRef.current !== v.projectId) await openProject(v.projectId);
          // 권한 요청 알림 → 프로젝트 설정 > 구성원 (승인·거절) / 내 요청의 결과 → the project.
          if (v.kind.startsWith('access.')) return setTab(v.kind === 'access.requested' ? 'project' : 'scripts');
          if (!v.runId) return setTab('history');
          try {
            const r = await window.euta.cloud.openRun(v.projectId, v.runId);
            setSelected(r.liveId);
            setTab('live');
          } catch {
            setTab('history');
          }
        })();
      }),
    [openProject],
  );

  // Cloud notices (다른 사람이 저장함 · 충돌 · AI 저장 충돌 · 보냄) for the open project.
  useEffect(
    () =>
      window.euta.cloud.onNotice((n) => {
        if (n.projectId !== currentRef.current) return;
        const item = { ...n, n: Date.now() + Math.random() };
        setNotices((list) => [...list.slice(-3), item]);
        setTimeout(() => setNotices((list) => list.filter((x) => x.n !== item.n)), n.kind === 'ai-conflict' || n.kind === 'conflict' ? 30_000 : 12_000);
      }),
    [],
  );
  useEffect(() => setNotices([]), [currentId]);

  // A save of the open project stopped at a conflict → the conflict screen (once per conflict).
  // Locked "접근 권한 없음": only 실행 이력 / 실시간.
  const locked = !!project?.cloudView?.accessLost;
  useEffect(() => {
    if (locked) setTab((t) => (LOCKED_TABS.includes(t) ? t : 'history'));
  }, [locked]);
  const blocked = project?.cloudView?.blocked;
  useEffect(() => {
    if (!blocked) return setConflict((c) => (c && c.projectId === currentId ? undefined : c));
    const key = `${blocked.projectId}:${blocked.ticket}`;
    setConflict((c) => (c && c.ticket === blocked.ticket ? blocked : dismissedTicket.current === key ? c : blocked));
  }, [blocked, currentId]);

  const pinned = projects?.filter((p) => p.pinned) ?? [];
  const recent = projects?.filter((p) => !p.pinned) ?? [];
  const Item = ({ p }: { p: ProjectSummary }) => (
    <li className={cx('nav-item', p.id === currentId && view === 'project' && 'is-active')} onClick={() => void openProject(p.id)} data-testid="project-item" data-project-id={p.id} data-cloud={p.cloud ? '1' : '0'} title={p.name}>
      {p.cloud?.accessLost ? (
        <span className="nav-icon" title="접근 권한 없음 — 이 PC 실행 기록만 볼 수 있습니다" data-testid="project-locked">
          <Lock size={16} aria-hidden="true" />
        </span>
      ) : p.cloud ? (
        <span className="nav-icon" title={`클라우드 프로젝트 (${ROLE_LABEL[p.cloud.role]})`}>
          <Cloud size={16} aria-hidden="true" />
        </span>
      ) : (
        <Folder className="nav-icon" size={16} aria-hidden="true" />
      )}
      <span className="name">{p.name}</span>
      {p.cloud?.appTooOld && (
        <Badge tone="warn" data-testid="project-update-needed" title="euta cloud 가 이 앱 버전을 더 받지 않습니다 — 앱을 업데이트하세요">
          업데이트 필요
        </Badge>
      )}
      {p.cloud && p.cloud.pending > 0 && (
        <Badge tone={p.cloud.blocked ? 'bad' : 'warn'} data-testid="project-pending" title={p.cloud.blocked ? '충돌 — 해결이 필요합니다' : '보내기 대기'}>
          {p.cloud.blocked ? '충돌' : `대기 ${p.cloud.pending}`}
        </Badge>
      )}
      {p.running > 0 && (
        <Badge tone="run" data-testid="project-running" title="지금 실행 중">
          {p.running} 실행 중
        </Badge>
      )}
    </li>
  );

  return (
    <div className="app">
      <aside className="sidebar" data-testid="sidebar">
        <div className="brand">
          <img src={logo} alt="" width={24} height={24} />
          euta
        </div>
        <Button icon={Plus} className="side-new" onClick={() => confirmLeave() && setView('new')} data-testid="project-new">
          새 프로젝트
        </Button>
        {cloudStatus && cloudStatus.state !== 'none' && (
          <button className={cx('nav-item', view === 'cloud-find' && 'is-active')} onClick={() => confirmLeave() && setView('cloud-find')} data-testid="cloud-find">
            <Download className="nav-icon" size={16} aria-hidden="true" />
            클라우드에서 받기
          </button>
        )}
        {pinned.length > 0 && (
          <>
            <div className="side-h">고정</div>
            <ul className="side-list">
              {pinned.map((p) => (
                <Item key={p.id} p={p} />
              ))}
            </ul>
          </>
        )}
        <div className="side-h">{pinned.length ? '최근' : '프로젝트'}</div>
        <ul className="side-list" data-testid="project-list">
          {recent.map((p) => (
            <Item key={p.id} p={p} />
          ))}
        </ul>
        {projects && projects.length === 0 && <p className="muted small side-empty">아직 프로젝트가 없습니다.</p>}
        <div className="side-foot">
          <CloudChip status={cloudStatus} onClick={() => confirmLeave() && setView('app-settings')} />
          <button className={cx('nav-item', view === 'app-settings' && 'is-active')} onClick={() => confirmLeave() && setView('app-settings')} data-testid="app-settings">
            <Settings className="nav-icon" size={16} aria-hidden="true" />
            앱 설정
          </button>
        </div>
      </aside>
      <div className="main">
        <UpdateBanner />
        {view === 'app-settings' ? (
          <section className="panel">
            <AppSettingsTab />
          </section>
        ) : view === 'cloud-find' ? (
          <section className="panel">
            <CloudReceive status={cloudStatus} onOpen={(id) => void openProject(id)} onSettings={() => setView('app-settings')} />
          </section>
        ) : view === 'new' || !project || !currentId ? (
          projects === undefined ? null : (
            <section className="panel">
              <NewProject first={projects.length === 0} onCreated={(p) => void openProject(p.id)} />
            </section>
          )
        ) : (
          <div className="project" key={currentId} data-testid="project" data-project-id={currentId}>
            <header className="project-head">
              <span className="project-name" data-testid="project-name">
                {project.cloud && '☁ '}
                {project.name}
              </span>
              <RoleBadges project={project} onChanged={setProject} />
              {project.cloudView?.appTooOld && (
                <Badge tone="warn" data-testid="update-needed-badge" title="euta cloud 가 이 앱 버전을 더 받지 않습니다 — 앱을 업데이트하세요">
                  업데이트 필요
                </Badge>
              )}
              {project.cloudView && !project.cloudView.online && !project.cloudView.needsLogin && !project.cloudView.appTooOld && (
                <Badge tone="warn" data-testid="offline-badge" title="환경·테스트 계정·테스트 세트·구성원은 읽기만 · 스크립트 저장은 보내기 대기">
                  오프라인
                </Badge>
              )}
              {project.cloudView && project.cloudView.pending > 0 && (
                <Badge tone="neutral" data-testid="pending-badge">
                  보내기 대기 {project.cloudView.pending}
                </Badge>
              )}
              <Tabs
                asTablist
                label="프로젝트 화면"
                items={TABS.filter((t) => (!t.cloudOnly || project.cloud) && (!project.cloudView?.accessLost || LOCKED_TABS.includes(t.id))).map((t) => ({ key: t.id, label: t.label, testId: `tab-${t.id}` }))}
                active={tab}
                onSelect={(k) => setTab(k as Tab)}
              />
            </header>
            {project.cloudView?.appTooOld ? (
              <UpdateNeededPanel pending={project.cloudView.pending} minVersion={project.cloudView.appTooOld.minVersion} />
            ) : project.cloudView?.needsLogin ? (
              <section className="panel" data-testid="cloud-needs-login">
                <div className="card">
                <h3>클라우드에 로그인해야 이 프로젝트를 열 수 있습니다</h3>
                <p className="muted">작업 사본은 이 PC 에 남아 있습니다{project.cloudView.pending ? ` (보내기 대기 ${project.cloudView.pending}건 포함)` : ''}. 서버: <code>{project.cloudView.serverUrl}</code></p>
                <Button variant="primary" icon={Settings} onClick={() => setView('app-settings')}>
                  앱 설정 → 클라우드
                </Button>
                </div>
              </section>
            ) : project.cloudView?.accessLost ? (
              <AccessLostPanel
                project={project}
                onChanged={setProject}
                onDeleted={async () => {
                  currentRef.current = undefined;
                  setCurrentId(undefined);
                  setProject(undefined);
                  const list = await window.euta.projects.list();
                  setProjects(list);
                  if (list[0]) await openProject(list[0].id);
                }}
              >
                {/* Only this PC's runs stay readable: 실행 이력 (local only) and 실시간 (replay). */}
                <section hidden={tab !== 'history'} className="panel">
                  <HistoryTab projectId={currentId} active={tab === 'history'} onOpen={nav.openRun} cloud={false} />
                </section>
                <section hidden={tab !== 'live'} className="panel">
                  <LiveTab runs={projectRuns} selected={selected} onSelect={setSelected} follow={follow} onFollow={setFollow} suiteRuns={suiteRuns} projectId={currentId} />
                </section>
              </AccessLostPanel>
            ) : (
            <>
            {!project.cloud && project.uploadedTo && <MergeBanner project={project} online={cloudStatus?.state === 'online'} onMerged={(id) => void openProject(id)} />}
            {converted && converted.localId === currentId && (
              <div className="banner" data-testid="upload-result">
                <Cloud size={16} aria-hidden="true" /> 클라우드 프로젝트로 올렸습니다{converted.resumed ? ' (전에 만들다 만 서버 프로젝트를 이어서 썼습니다)' : ''} — 이 PC 실행 기록 {converted.movedRuns}건을 함께 옮겼습니다.
                {converted.credentialNames.length > 0 && ` 클라우드 실행에 쓸 테스트 계정 값을 프로젝트 설정에서 입력하세요: ${converted.credentialNames.join(', ')}.`}
                {converted.skippedEnvs.length > 0 && ` 주소가 없어 올리지 않은 환경: ${converted.skippedEnvs.join(', ')}.`}
                {converted.flaggedScripts.length > 0 && ` 검증 오류가 있는 스크립트(“앱 바깥 변경”으로 보관): ${converted.flaggedScripts.join(', ')}.`}{' '}
                <Button size="sm" variant="ghost" onClick={() => setConverted(undefined)} data-testid="upload-result-close">
                  닫기
                </Button>
              </div>
            )}
            {project.cloudView?.blocked && !conflict && (
              <div className="banner conflict" data-testid="conflict-banner">
                {project.cloudView.blocked.status === 'conflict' ? '충돌' : '저장 거절'}: <code>{project.cloudView.blocked.path}</code> — 해결할 때까지 보내기가 멈춰 있습니다.{' '}
                <Button size="sm" onClick={() => setConflict(project.cloudView!.blocked)} data-testid="conflict-banner-open">
                  해결하기
                </Button>
              </div>
            )}
            {notices.map((n) => (
              <div key={n.n} className={`banner cloud-notice ${n.kind}`} data-testid="cloud-notice" data-kind={n.kind} data-path={n.path ?? ''}>
                <Cloud size={16} aria-hidden="true" /> {n.message}
              </div>
            ))}
            <div className="project-body">
            <main className="content">
              {/* Tabs stay mounted inside a project so forms, chat and terminal survive tab switches. */}
              <section hidden={tab !== 'scripts'} className="panel">
                <ScriptsTab project={project} active={tab === 'scripts'} focus={scriptFocus} nav={nav} runWhere={runWhere} onProjectChanged={setProject} />
              </section>
              <section hidden={tab !== 'run'} className="panel">
                <RunTab project={project} active={tab === 'run'} request={runScriptReq} onStarted={nav.openRun} where={runWhere} onWhere={setRunWhere} />
              </section>
              <section hidden={tab !== 'live'} className="panel">
                <LiveTab runs={projectRuns} selected={selected} onSelect={setSelected} follow={follow} onFollow={setFollow} suiteRuns={suiteRuns} projectId={currentId} />
              </section>
              <section hidden={tab !== 'history'} className="panel">
                <HistoryTab projectId={currentId} active={tab === 'history'} onOpen={nav.openRun} cloud={!!project.cloud} />
              </section>
              {project.cloud && (
                <section hidden={tab !== 'schedules'} className="panel">
                  <SchedulesTab project={project} active={tab === 'schedules'} />
                </section>
              )}
              <section hidden={tab !== 'ai'} className="panel">
                <AiTab project={project} active={tab === 'ai'} onOpenRun={nav.openRun} openChat={chatToOpen} onRecord={() => nav.startRecording()} />
              </section>
              <section hidden={tab !== 'activity'} className="panel">
                <ActivityTab projectId={currentId} active={tab === 'activity'} nav={nav} cloud={!!project.cloud} />
              </section>
              <section hidden={tab !== 'project'} className="panel">
                <ProjectSettingsTab
                  project={project}
                  onChanged={setProject}
                  onConverted={(r) => {
                    setConverted(r);
                    void openProject(r.localId);
                  }}
                  onDeleted={async () => {
                    currentRef.current = undefined;
                    setCurrentId(undefined);
                    setProject(undefined);
                    setTab('scripts');
                    const list = await window.euta.projects.list();
                    setProjects(list);
                    if (list[0]) await openProject(list[0].id);
                  }}
                />
              </section>
            </main>
            {recView && recView.projectId === currentId && !recDismissed && (
              <RecordingPanel
                project={project}
                view={recView}
                onClose={() => setRecDismissed(true)}
                onOpenChat={nav.openChat}
                onOpenScript={nav.openScript}
              />
            )}
            </div>
            </>
            )}
            {conflict && conflict.projectId === currentId && (
              <ConflictDialog
                view={conflict}
                online={!!project.cloudView?.online}
                onClose={() => {
                  dismissedTicket.current = `${conflict.projectId}:${conflict.ticket}`;
                  setConflict(undefined);
                }}
                onResolved={(p) => {
                  setConflict(undefined);
                  setProject(p);
                  void refreshProjects();
                }}
              />
            )}
            {recDialog && (
              <RecordStartDialog
                project={project}
                {...(recDialog.tc ? { tc: recDialog.tc } : {})}
                onCancel={() => setRecDialog(false)}
                onStarted={(v) => {
                  setRecDialog(false);
                  setRecView(v);
                  setRecDismissed(false);
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
