// Script detail screen (SPEC 스크립트-보기-편집): readable Korean step sentences with the latest
// run overlaid (only when the run executed exactly this content), step-level form editing with
// live validation and a save button, version history with step-sentence comparison and restore,
// and "AI에게 수정 요청" (whole script or one step) that opens a project AI chat.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Bot, Check, ChevronDown, ChevronRight, Clock, Copy, FileCode, GripVertical, Image, ListIndentDecrease, ListIndentIncrease, Minus, Pencil, Play, RotateCcw, Save, Send, ShieldCheck, Sparkles, Trash, TriangleAlert, X } from 'lucide-react';
import { describeStep } from '@euta/core/describe';
import type { ProjectView, ScriptCompareView, ScriptDetailView, ScriptDraftCheck, ScriptHistoryView, ScriptVersionView } from '../../../shared/types';
import {
  addStep,
  deleteStep,
  duplicateStep,
  flatten,
  getStep,
  groupIn,
  groupOut,
  issueStepPath,
  moveDown,
  moveStep,
  moveUp,
  NEW_STEP_KINDS,
  plainStep,
  setHeader,
  setStep,
  stepIdOf,
  toModel,
  toPayload,
  type EModel,
  type StepPath,
} from '../../../shared/script-model';
import type { Nav } from '../App';
import { confirmLeave, setUnsaved } from '../unsaved';
import { manualCount, StatusBadge, StepStatusBadge } from './LiveTab';
import { HeaderForm, StepForm, type FormContext } from './StepForm';
import { Badge, Button, Dialog, IconButton, statusLabel, StepIcon } from '../ui';

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '');
const fmtMs = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const STATUS_ICON: Record<string, typeof Check> = { passed: Check, failed: X, error: X, skipped: Minus };
export const ACTOR_LABEL: Record<string, string> = { user: '사용자', ai: 'AI', recording: '녹화', external: '바깥 변경', restore: '되돌리기' };
const KIND_LABEL: Record<string, string> = { baseline: '처음 기록', create: '생성', save: '저장', external: '바깥에서 바뀜', restore: '되돌리기', rename: '이름 변경', delete: '삭제', undelete: '삭제 복원' };
const samePath = (a: StepPath | undefined, b: StepPath) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
const sameParent = (a: StepPath, b: StepPath) => a.length === b.length && a.slice(0, -1).every((x, i) => x === b[i]);

type Mode = 'view' | 'edit' | 'history';

export function ScriptDetail({ project, path, nav, onBack }: { project: ProjectView; path: string; nav: Nav; onBack: () => void }) {
  const pid = project.id;
  const [envId, setEnvId] = useState<string | undefined>(project.defaultEnvId);
  const [detail, setDetail] = useState<ScriptDetailView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [mode, setMode] = useState<Mode>('view');
  const [model, setModel] = useState<EModel | undefined>();
  const [base, setBase] = useState<{ text: string; hash: string } | undefined>();
  const [dirty, setDirty] = useState(false);
  const [rev, setRev] = useState(0);
  const [check, setCheck] = useState<{ rev: number; r: ScriptDraftCheck } | undefined>();
  const [openId, setOpenId] = useState<string | undefined>();
  const [headerOpen, setHeaderOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState(false);
  const [banner, setBanner] = useState<ScriptVersionView | undefined>();
  const [ask, setAsk] = useState<{ path?: StepPath; text: string } | undefined>();
  const [shot, setShot] = useState<string | undefined>();
  const [runId, setRunId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState<StepPath | undefined>();
  const [hist, setHist] = useState<ScriptHistoryView | undefined>();
  const [cmp, setCmp] = useState<ScriptCompareView | undefined>();
  /** Cloud project: someone else saved this script (change feed). */
  const [remote, setRemote] = useState<{ version?: number; by?: string; pending: boolean } | undefined>();
  const readOnly = !!project.cloudView?.readOnly;
  const canRun = !project.cloudView || project.cloudView.canRun;
  const ref = useRef({ detail, mode, dirty, runId });
  ref.current = { detail, mode, dirty, runId };

  const load = useCallback(async (): Promise<ScriptDetailView | undefined> => {
    try {
      const d = await window.euta.scripts.detail(pid, path, envId);
      setDetail(d);
      setError(undefined);
      return d;
    } catch (e) {
      setError(errMsg(e));
      return undefined;
    }
  }, [pid, path, envId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setUnsaved(mode === 'edit' && dirty), [mode, dirty]);
  useEffect(() => () => setUnsaved(false), []);

  const startEdit = useCallback((d: ScriptDetailView | undefined) => {
    if (!d?.script) {
      setError('YAML 을 읽을 수 없어 폼으로 고칠 수 없습니다 — “기본 편집기로 열기” 로 고치세요.');
      return;
    }
    setModel(toModel(d.script));
    setBase({ text: d.text, hash: d.hash });
    setDirty(false);
    setConflict(false);
    setOpenId(undefined);
    setCheck(undefined);
    setRev((r) => r + 1);
    setMode('edit');
  }, []);

  const loadHistory = useCallback(
    async (select?: number) => {
      const h = await window.euta.scripts.versions(pid, path);
      setHist(h);
      const v = select ?? h.versions.at(-1)?.version;
      setCmp(h.key && v !== undefined ? await window.euta.scripts.compare(pid, h.key, v) : undefined);
    },
    [pid, path],
  );

  // Outside changes (editor, AI chat, watcher): refresh; while editing → conflict notice.
  useEffect(
    () =>
      window.euta.scripts.onChanged((id) => {
        if (id !== pid) return;
        void (async () => {
          const prev = ref.current.detail;
          const d = await load();
          if (!d || !prev || d.hash === prev.hash) return;
          if (d.latest?.actor === 'ai' && d.latest.version !== prev.latest?.version) setBanner(d.latest);
          if (ref.current.mode === 'edit') {
            if (ref.current.dirty) setConflict(true);
            else startEdit(d);
          }
          if (ref.current.mode === 'history') void loadHistory();
        })();
      }),
    [pid, load, startEdit, loadHistory],
  );

  // Cloud: "다른 사람이 저장함" for this script.
  useEffect(
    () =>
      window.euta.cloud.onNotice((n) => {
        if (n.projectId !== pid || n.path !== path) return;
        if (n.kind === 'remote-saved') setRemote({ ...(n.version !== undefined ? { version: n.version } : {}), ...(n.by ? { by: n.by } : {}), pending: /보내기 대기/.test(n.message) });
      }),
    [pid, path],
  );

  // A run started here: refresh the overlay when it finishes.
  useEffect(
    () =>
      window.euta.live.onUpdate((v) => {
        if (v.runId === ref.current.runId && v.status !== 'running') {
          setRunId(undefined);
          setNote(`실행 끝: ${statusLabel(v.status)}`);
          void load();
        }
      }),
    [load],
  );

  // Live validation of the edit (debounced; the serialized result is what gets checked).
  useEffect(() => {
    if (mode !== 'edit' || !model || !base) return;
    const at = rev;
    const t = setTimeout(() => {
      void window.euta.scripts
        .draftCheck(pid, base.text, toPayload(model), envId)
        .then((r) => setCheck((c) => (c && c.rev > at ? c : { rev: at, r })))
        .catch((e) => setError(errMsg(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [mode, model, base, rev, pid, envId]);

  const update = (fn: (m: EModel) => EModel) => {
    setModel((m) => (m ? fn(m) : m));
    setDirty(true);
    setRev((r) => r + 1);
  };

  const viewModel = useMemo(() => (detail?.script ? toModel(detail.script) : undefined), [detail?.script]);
  const shown = mode === 'edit' ? model : viewModel;
  const ctx: FormContext = useMemo(() => {
    const vars = shown?.header.vars;
    return { secretNames: detail?.secretNames ?? [], varNames: vars && typeof vars === 'object' ? Object.keys(vars) : [] };
  }, [detail?.secretNames, shown?.header]);

  const back = () => {
    if (mode === 'edit' && dirty && !confirmLeave()) return;
    setUnsaved(false);
    onBack();
  };

  const save = async (force = false) => {
    if (!model || !base) return;
    setSaving(true);
    setError(undefined);
    try {
      const r = await window.euta.scripts.save(pid, path, base.text, toPayload(model), envId, force);
      if (r.ok) {
        setDirty(false);
        setUnsaved(false);
        setConflict(false);
        setRemote(undefined);
        setMode('view');
        setNote(r.pending ? '저장했습니다 — 보내기 대기 (클라우드에 다시 연결되면 순서대로 보냅니다)' : `저장했습니다${r.version ? ` — 버전 ${r.version.version}${r.version.summary ? `: ${r.version.summary}` : ''}` : ''}`);
        await load();
      } else if (r.conflict) setConflict(true);
      else if (r.cloudConflict) {
        // My text is kept in the conflict; the conflict screen decides (SPEC 충돌 3 choices).
        setDirty(false);
        setUnsaved(false);
        setConflict(false);
        setMode('view');
        setNote('충돌 — 클라우드에 더 새로운 버전이 있어 저장하지 않았습니다. 충돌 화면에서 고르세요.');
        nav.openConflict(r.cloudConflict);
        await load();
      } else setCheck({ rev, r: { issues: r.issues, missingSecrets: [], unstable: 0, ruleIssues: [] } });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const run = async () => {
    setError(undefined);
    try {
      const h = await window.euta.startRun({ projectId: pid, script: path, ...(envId ? { envId } : {}), vars: '', env: '' });
      setRunId(h.runId);
      setNote('실행 중… (실시간 탭에서 진행을 볼 수 있습니다)');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const sendAsk = async () => {
    if (!ask?.text.trim()) return;
    try {
      const st = ask.path && viewModel ? getStep(viewModel, ask.path) : undefined;
      const step = ask.path && st ? { id: stepIdOf(ask.path), sentence: describeStep(plainStep(st)).sentence } : undefined;
      const chatId = await window.euta.scripts.aiRequest(pid, path, ask.text, step, envId);
      setAsk(undefined);
      nav.openChat(chatId);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const openShot = async (rel: string) => {
    if (!detail?.lastRun) return;
    setShot((await window.euta.scripts.runShot(pid, detail.lastRun.runId, rel)) ?? undefined);
  };

  const issues = mode === 'edit' ? (check?.r.issues ?? []) : (detail?.issues ?? []);
  const missing = mode === 'edit' ? (check?.r.missingSecrets ?? []) : (detail?.missingSecrets ?? []);
  const unstable = mode === 'edit' ? (check?.r.unstable ?? 0) : (detail?.unstable ?? 0);
  const ruleIssues = mode === 'edit' ? (check?.r.ruleIssues ?? []) : (detail?.ruleIssues ?? []);
  const checking = mode === 'edit' && (!check || check.rev !== rev);
  const canSave = mode === 'edit' && dirty && !checking && issues.length === 0 && !saving;
  const lastRun = detail?.lastRun;
  const stale = !!lastRun && !lastRun.hashMatch;

  const flat = useMemo(() => {
    if (!shown) return [];
    const all = flatten(shown);
    return all.filter((f) => !f.path.slice(0, -1).some((_x, i) => collapsed.has(stepIdOf(f.path.slice(0, i + 1)))));
  }, [shown, collapsed]);

  const addMenu = (testId: string, at: StepPath, label = '+ 아래에 단계 추가') => (
    <select
      className="add-step"
      value=""
      onChange={(e) => {
        const k = NEW_STEP_KINDS.find((x) => x.kind === e.target.value);
        if (!k || !model) return;
        const next = addStep(model, at, k.make());
        update(() => next);
        setOpenId(getStep(next, at)?.id);
      }}
      data-testid={testId}
    >
      <option value="">{label}</option>
      {NEW_STEP_KINDS.map((k) => (
        <option key={k.kind} value={k.kind}>
          {k.label}
        </option>
      ))}
    </select>
  );

  const onDrop = (e: DragEvent, to: StepPath) => {
    e.preventDefault();
    if (drag && sameParent(drag, to)) update((m) => moveStep(m, drag, to[to.length - 1]!));
    setDrag(undefined);
  };

  if (!detail) {
    return (
      <div className="script-detail" data-testid="script-detail" data-path={path}>
        <Button variant="ghost" icon={ArrowLeft} onClick={back} data-testid="detail-back">
          목록
        </Button>
        {error ? <div className="error">{error}</div> : <p className="muted">불러오는 중…</p>}
      </div>
    );
  }

  return (
    <div className="script-detail" data-testid="script-detail" data-path={path} data-mode={mode}>
      <div className="inline between">
        <Button variant="ghost" icon={ArrowLeft} onClick={back} data-testid="detail-back">
          목록
        </Button>
        <code className="muted file">scripts/{detail.path}</code>
      </div>
      <h2 data-testid="detail-name">{(mode === 'edit' ? String(model?.header.name ?? '') : detail.name) || detail.path}</h2>
      {typeof shown?.header.description === 'string' && shown.header.description && <p className="muted">{shown.header.description}</p>}

      <div className="inline small detail-last" data-testid="detail-last-run">
        {lastRun ? (
          <>
            최근 실행: <StatusBadge status={lastRun.status} /> {lastRun.envName ? `· ${lastRun.envName} ` : ''}· {new Date(lastRun.startedAt).toLocaleString()}
            {manualCount(Object.values(lastRun.steps)) > 0 && (
              <>
                {' '}
                <Badge tone="manual" data-testid="detail-manual-count">
                  수동 확인 필요 {manualCount(Object.values(lastRun.steps))}
                </Badge>
              </>
            )}
            {stale && (
              <span className="warn" data-testid="overlay-stale">
                {' '}
                · 수정 이후 아직 실행하지 않음
              </span>
            )}
            <button className="link" onClick={() => void nav.openHistoryRun(lastRun.runId)} data-testid="detail-live-link">
              실시간 탭에서 보기 <ChevronRight size={14} aria-hidden="true" />
            </button>
          </>
        ) : (
          <span className="muted">아직 실행 기록이 없습니다.</span>
        )}
        {runId && <Badge tone="run">실행 중</Badge>}
      </div>

      {mode !== 'edit' ? (
        <div className="inline detail-toolbar">
          <select value={envId ?? ''} onChange={(e) => setEnvId(e.target.value || undefined)} data-testid="detail-env" title="환경">
            {project.environments.length === 0 && <option value="">(환경 없음)</option>}
            {project.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          {canRun && (
            <Button variant="primary" icon={Play} onClick={() => void run()} disabled={!!runId} data-testid="detail-run">
              실행
            </Button>
          )}
          <Button
            icon={ShieldCheck}
            onClick={() =>
              void load().then((d) => d && setNote(d.issues.length ? `검증 오류 ${d.issues.length}개` : `✓ 검증 통과${d.missingSecrets.length ? ' (비밀값 등록 필요)' : ''}`))
            }
            data-testid="detail-validate"
          >
            검증
          </Button>
          {!readOnly && (
            <>
              <Button icon={Pencil} onClick={() => startEdit(detail)} data-testid="detail-edit">
                편집
              </Button>
              <Button icon={Sparkles} onClick={() => setAsk({ text: '' })} data-testid="detail-ai">
                AI에게 수정 요청
              </Button>
            </>
          )}
          <Button
            icon={Clock}
            active={mode === 'history'}
            onClick={() => {
              if (mode === 'history') setMode('view');
              else {
                setMode('history');
                void loadHistory();
              }
            }}
            data-testid="detail-history"
          >
            이력
          </Button>
          <Button variant="ghost" icon={FileCode} onClick={() => void window.euta.scripts.open(pid, path)} data-testid="detail-open-editor" title="YAML 을 직접 고칠 때">
            기본 편집기로 열기
          </Button>
        </div>
      ) : (
        <div className="inline detail-toolbar">
          <Button variant="primary" icon={Save} disabled={!canSave} onClick={() => void save()} data-testid="edit-save">
            저장
          </Button>
          <Button
            icon={X}
            onClick={() => {
              if (dirty && !window.confirm('편집한 내용을 버릴까요?')) return;
              setDirty(false);
              setMode('view');
            }}
            data-testid="edit-cancel"
          >
            취소
          </Button>
          <span className="small" data-testid="edit-status">
            {!dirty ? <span className="muted">바뀐 것 없음</span> : checking ? <span className="muted">검증 중…</span> : issues.length ? <span className="error-text">오류 {issues.length}개 — 고쳐야 저장할 수 있습니다</span> : <span className="ok-text">✓ 저장할 수 있습니다</span>}
          </span>
          <Button variant="ghost" icon={headerOpen ? ChevronDown : ChevronRight} active={headerOpen} onClick={() => setHeaderOpen((o) => !o)} data-testid="edit-header-toggle">
            스크립트 정보 (이름·설명·기본값·녹화·브라우저·변수)
          </Button>
        </div>
      )}

      {banner && (
        <div className="banner ai-banner" data-testid="ai-banner">
          <Bot size={16} aria-hidden="true" /> AI 가 수정함 (버전 {banner.version}: {banner.summary}) —{' '}
          <button
            className="link"
            onClick={() => {
              setMode('history');
              void loadHistory(banner.version);
              setBanner(undefined);
            }}
            data-testid="ai-banner-view"
          >
            변경 보기
          </button>{' '}
          <Button size="sm" variant="ghost" icon={X} onClick={() => setBanner(undefined)}>
            닫기
          </Button>
        </div>
      )}

      {remote && (
        <div className="banner conflict" data-testid="cloud-remote-saved">
          ☁ 다른 사람이 저장함{remote.version !== undefined ? ` (버전 ${remote.version}${remote.by ? ` · ${remote.by}` : ''})` : ''}
          {mode === 'edit' ? ' — 편집 중인 내 내용을 저장하면 충돌 화면이 열립니다.' : remote.pending ? ' — 보내기 대기 중인 내 저장과 충돌할 수 있습니다.' : ' — 최신 내용으로 바꿨습니다.'}{' '}
          <Button size="sm" variant="ghost" icon={X} onClick={() => setRemote(undefined)}>
            닫기
          </Button>
        </div>
      )}

      {conflict && (
        <div className="banner conflict" data-testid="conflict-notice">
          편집하는 동안 이 파일이 바깥(다른 편집기·AI)에서 바뀌었습니다.{' '}
          <Button
            size="sm"
            icon={RotateCcw}
            onClick={() => {
              setConflict(false);
              void load().then((d) => startEdit(d));
            }}
            data-testid="conflict-reload"
          >
            다시 불러오기 (내 변경 버림)
          </Button>{' '}
          <Button size="sm" icon={Save} disabled={issues.length > 0 || checking} onClick={() => void save(true)} data-testid="conflict-mine">
            내 것으로 저장 (바깥 변경은 이력에 남음)
          </Button>
        </div>
      )}

      {ask && (
        <div className="card ai-ask" data-testid="ai-ask">
          <div className="small muted">
            {ask.path ? `${stepIdOf(ask.path)}번 단계에 대해 AI 에게 요청` : '이 스크립트에 대해 AI 에게 요청'} — 새 AI 대화가 열리고, AI 가 고쳐 저장하면 이력에 남습니다.
          </div>
          <textarea
            rows={3}
            value={ask.text}
            onChange={(e) => setAsk({ ...ask, text: e.target.value })}
            placeholder="예: 이 단계 다음에 합계 1,200원 확인 추가해줘"
            data-testid="ai-ask-input"
            autoFocus
          />
          <div className="inline">
            <Button variant="primary" size="sm" icon={Send} disabled={!ask.text.trim()} onClick={() => void sendAsk()} data-testid="ai-ask-send">
              보내기
            </Button>
            <Button size="sm" icon={X} onClick={() => setAsk(undefined)}>
              취소
            </Button>
          </div>
        </div>
      )}

      {(issues.length > 0 || missing.length > 0 || unstable > 0 || ruleIssues.length > 0) && (
        <div className="detail-warnings" data-testid="detail-warnings">
          {issues.length > 0 && (
            <div className="issues bad" data-testid="warn-issues">
              검증 오류 {issues.length}개
              <ul>
                {issues.slice(0, 20).map((i, n) => {
                  const sp = issueStepPath(i.path);
                  return (
                    <li key={n}>
                      {sp ? `${stepIdOf(sp)}번 단계` : i.path || '(스크립트)'}: {i.message}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {missing.length > 0 && (
            <div className="issues warn-box" data-testid="warn-missing-secrets">
              환경 {project.environments.find((e) => e.id === (envId ?? detail.envId))?.name ?? '(없음)'} 에 없는 비밀값: {missing.map((m) => `🔒${m}`).join(', ')} — 프로젝트 설정 → 환경에서 등록하세요 (이름만 표시).
            </div>
          )}
          {ruleIssues.length > 0 && (
            <div className="issues bad" data-testid="warn-secret-rule">
              비밀값 규칙 위반 {ruleIssues.length}개 — 저장은 되지만 실행하면 검증 오류로 멈춥니다
              <ul>
                {ruleIssues.slice(0, 20).map((i, n) => {
                  const sp = issueStepPath(i.path);
                  return (
                    <li key={n}>
                      {sp ? `${stepIdOf(sp)}번 단계` : i.path || '(스크립트)'}: {i.message}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {unstable > 0 && (
            <div className="issues warn-box" data-testid="warn-unstable">
              <TriangleAlert className="lead-icon" size={14} aria-hidden="true" /> CSS 로 고른 대상 {unstable}개 — 화면이 바뀌면 깨지기 쉽습니다. 역할·라벨·글자로 바꾸는 것을 권합니다.
            </div>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {note && (
        <div className="note" data-testid="detail-note">
          {note}
        </div>
      )}

      {mode === 'edit' && headerOpen && model && (
        <div className="card">
          <HeaderForm header={model.header} onChange={(h) => update((m) => setHeader(m, h))} />
        </div>
      )}

      {mode === 'history' ? (
        <HistoryView readOnly={readOnly} hist={hist} cmp={cmp} onSelect={(v) => hist?.key && void window.euta.scripts.compare(pid, hist.key, v).then(setCmp)} onRestore={async (v) => {
          if (!hist?.key || !window.confirm(`버전 ${v} 로 되돌릴까요? 지금 내용도 이력에 남습니다.`)) return;
          try {
            const r = await window.euta.scripts.restore(pid, hist.key, v);
            if (r.conflict) setError('파일이 바뀌어 되돌리지 못했습니다. 다시 시도하세요.');
            else setNote(`버전 ${v} 로 되돌렸습니다`);
            await load();
            await loadHistory();
          } catch (e) {
            setError(errMsg(e));
          }
        }} />
      ) : !shown ? (
        <div className="error">YAML 을 읽을 수 없습니다 — 기본 편집기로 열어 고치세요.</div>
      ) : (
        <div className={`step-list${stale && mode === 'view' ? ' stale' : ''}`} data-testid="step-list">
          {flat.map(({ path: sp, depth, step }) => {
            const d = describeStep(plainStep(step));
            const sid = stepIdOf(sp);
            const ov = mode === 'view' ? lastRun?.steps[sid] : undefined;
            const cardIssues = mode === 'edit' ? issues.filter((i) => samePath(issueStepPath(i.path), sp)) : [];
            const isGroup = !!step.children;
            const isOpen = mode === 'edit' && openId === step.id;
            return (
              <div key={step.id} className="step-wrap" style={{ marginLeft: depth * 24 }}>
                <div
                  className={`step-card${ov ? ` ${ov.status}` : ''}${cardIssues.length ? ' has-issue' : ''}${isOpen ? ' open' : ''}`}
                  data-testid="detail-step"
                  data-step-id={sid}
                  data-status={ov?.status ?? ''}
                  draggable={mode === 'edit'}
                  onDragStart={() => setDrag(sp)}
                  onDragOver={(e) => drag && sameParent(drag, sp) && e.preventDefault()}
                  onDrop={(e) => onDrop(e, sp)}
                >
                  <span className="step-no">{sid}</span>
                  {mode === 'edit' && (
                    <span className="handle" title="끌어서 순서 변경">
                      <GripVertical size={16} aria-hidden="true" />
                    </span>
                  )}
                  <StepIcon action={d.action} />
                  <div className="step-main" onClick={() => mode === 'edit' && setOpenId(isOpen ? undefined : step.id)}>
                    {d.title && (
                      <div className="step-title" data-testid="step-title">
                        {d.title}
                      </div>
                    )}
                    <div className="step-sentence" data-testid="step-sentence">
                      {d.sentence}
                      {isGroup && mode === 'view' && (
                        <button
                          className="link small"
                          onClick={() =>
                            setCollapsed((c) => {
                              const n = new Set(c);
                              if (n.has(sid)) n.delete(sid);
                              else n.add(sid);
                              return n;
                            })
                          }
                          data-testid="group-toggle"
                        >
                          {collapsed.has(sid) ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                          {collapsed.has(sid) ? '펼치기' : '접기'}
                        </button>
                      )}
                    </div>
                    {d.details.map((l, i) => (
                      <div key={i} className="step-detail">
                        └ {l}
                      </div>
                    ))}
                    {d.badges.length > 0 && (
                      <div className="step-badges">
                        {d.badges.map((b) => (
                          <Badge key={b}>{b}</Badge>
                        ))}
                      </div>
                    )}
                    {ov?.error && (
                      <div className="step-error" data-testid="step-error">
                        {ov.error}
                      </div>
                    )}
                    {cardIssues.map((i, n) => (
                      <div key={n} className="step-error" data-testid="step-issue">
                        {i.path.replace(/^(steps\[\d+\]\.?(group\.)?)+/, '')}: {i.message}
                      </div>
                    ))}
                  </div>
                  {ov && (
                    <div className="step-ov" data-testid="step-overlay" data-status={ov.status}>
                      {ov.manual ? (
                        <StepStatusBadge step={ov} />
                      ) : (
                        (() => {
                          const Icon = STATUS_ICON[ov.status];
                          return <span className={`ov-icon ${ov.status}`}>{Icon ? <Icon size={14} aria-label={ov.status} /> : '·'}</span>;
                        })()
                      )}{' '}
                      {!ov.manual && fmtMs(ov.durationMs)}
                      {ov.screenshot && <IconButton icon={Image} label="스크린샷 크게 보기" variant="ghost" onClick={() => void openShot(ov.screenshot!)} data-testid="step-shot" />}
                    </div>
                  )}
                  {mode === 'view' && !readOnly && (
                    <Button size="sm" variant="ghost" icon={Sparkles} className="step-ai" onClick={() => setAsk({ path: sp, text: '' })} data-testid="step-ai" title="이 단계에 대해 AI에게">
                      AI에게
                    </Button>
                  )}
                  {mode === 'edit' && (
                    <span className="step-tools">
                      <IconButton icon={ArrowUp} label="위로" onClick={() => update((m) => moveUp(m, sp))} disabled={sp[sp.length - 1] === 0} data-testid="step-up" />
                      <IconButton icon={ArrowDown} label="아래로" onClick={() => update((m) => moveDown(m, sp))} data-testid="step-down" />
                      <Button size="sm" icon={Copy} onClick={() => update((m) => duplicateStep(m, sp))} title="복제" data-testid="step-dup">
                        복제
                      </Button>
                      <Button size="sm" icon={ListIndentIncrease} onClick={() => update((m) => groupIn(m, sp))} title="위 묶음으로 넣기 (위가 묶음이 아니면 새 묶음)" data-testid="step-group-in">
                        묶음 넣기
                      </Button>
                      {sp.length > 1 && (
                        <Button size="sm" icon={ListIndentDecrease} onClick={() => update((m) => groupOut(m, sp))} title="묶음에서 빼기" data-testid="step-group-out">
                          묶음 빼기
                        </Button>
                      )}
                      <Button size="sm" variant="danger" icon={Trash} onClick={() => update((m) => deleteStep(m, sp))} title="삭제" data-testid="step-del">
                        삭제
                      </Button>
                    </span>
                  )}
                </div>
                {isOpen && model && (
                  <div className="card step-form-card">
                    <StepForm step={step.step} onChange={(s) => update((m) => setStep(m, sp, s))} ctx={ctx} />
                  </div>
                )}
                {mode === 'edit' && isGroup && addMenu('step-add-inside', [...sp, step.children!.length], '+ 묶음 안에 추가')}
                {mode === 'edit' && isOpen && addMenu('step-add-below', [...sp.slice(0, -1), sp[sp.length - 1]! + 1])}
              </div>
            );
          })}
          {mode === 'edit' && model && <div className="step-add-end">{addMenu('step-add-end', [model.steps.length], '+ 단계 추가')}</div>}
          {flat.length === 0 && <p className="muted">단계가 없습니다.</p>}
          {mode === 'edit' && model && (
            <p className="muted small">
              단계를 누르면 폼이 열립니다. ⠿ 를 끌거나 ↑↓ 로 순서를 바꿉니다. 저장하면 바뀐 단계만 다시 쓰고, 나머지 주석·순서는 그대로 둡니다.
            </p>
          )}
        </div>
      )}

      {shot && (
        <Dialog label="스크린샷" className="shot-modal" onBackdropClick={() => setShot(undefined)} data-testid="shot-modal">
          <img src={shot} alt="단계 스크린샷" />
        </Dialog>
      )}
    </div>
  );
}

function HistoryView({ hist, cmp, onSelect, onRestore, readOnly }: { hist?: ScriptHistoryView; cmp?: ScriptCompareView; onSelect: (v: number) => void; onRestore: (v: number) => void; readOnly?: boolean }) {
  if (!hist) return <p className="muted">불러오는 중…</p>;
  if (!hist.versions.length) return <p className="muted">아직 이력이 없습니다.</p>;
  const latest = hist.versions.at(-1)!.version;
  return (
    <div className="history-view" data-testid="history-view">
      <ul className="timeline-list version-list card">
        {[...hist.versions].reverse().map((v) => (
          <li key={v.version} className={`link-row${cmp?.to.version === v.version ? ' sel' : ''}`} onClick={() => onSelect(v.version)} data-testid="version-row" data-version={v.version} data-actor={v.actor} data-kind={v.kind}>
            <b>v{v.version}</b>
            <span className={`tag actor-${v.actor === 'ai' ? 'ai' : 'user'}`}>{v.origin ?? ACTOR_LABEL[v.actor] ?? v.actor}</span>
            {v.author && (
              <span className="small" data-testid="version-author">
                {v.author}
              </span>
            )}
            <span className="muted small">{new Date(v.at).toLocaleString()}</span>
            <span className="muted small">{KIND_LABEL[v.kind] ?? v.kind}</span>
            <span className="summary">{v.summary}</span>
          </li>
        ))}
      </ul>
      {cmp && (
        <div className="card compare-view" data-testid="compare-view" data-version={cmp.to.version}>
          <div className="inline between">
            <b>
              {cmp.from ? `v${cmp.from.version} → v${cmp.to.version}` : `v${cmp.to.version} (처음)`} · {cmp.summary}
            </b>
            {!readOnly && (
              <Button icon={RotateCcw} onClick={() => onRestore(cmp.to.version)} disabled={cmp.to.version === latest && cmp.to.kind !== 'delete'} data-testid="version-restore">
                이 버전으로 되돌리기
              </Button>
            )}
          </div>
          {cmp.header.length > 0 && <div className="small muted">머리 정보 변경: {cmp.header.join(', ')}</div>}
          <div className="diff">
            {cmp.rows.map((r, i) => (
              <div key={i} className={`diff-row ${r.kind}`} style={{ paddingLeft: 8 + r.depth * 20 }} data-testid="diff-row" data-kind={r.kind}>
                {r.kind === 'changed' ? (
                  <>
                    <span className="diff-before">− {r.before}</span>
                    <span className="diff-after">+ {r.after}</span>
                  </>
                ) : r.kind === 'removed' ? (
                  <span>− {r.before}</span>
                ) : r.kind === 'added' ? (
                  <span>+ {r.after}</span>
                ) : (
                  <span className="muted">  {r.after}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
