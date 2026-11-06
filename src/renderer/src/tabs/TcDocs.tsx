// TC 문서 (SPEC TC-문서-변환) — Scripts tab view: the documents of the project, the import preview
// (TC list + editable step table + precondition groups → 확정), and a document's detail screen: search +
// check (checked TCs rise to the top in check order with numbers = the conversion queue), per-TC state,
// [AI로 변환] [이어서 변환] [시연으로 변환] [다시 변환] [테스트 세트 만들기] [내보내기].
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FileDown,
  FileSpreadsheet,
  Info,
  ListChecks,
  ListPlus,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Trash,
  Undo2,
  Video,
  X,
} from 'lucide-react';
import type { ProjectView, TcConversionStatus, TcConvertEnd, TcConvertProgress, TcDocSummary, TcDocTc, TcDocView, TcExportSource, TcImportView, TcInput, TcMappingView, TcSetGrouping, TcSetPlan, TcStepItem } from '../../../shared/types';
import type { Nav } from '../App';
import { StatusBadge } from './LiveTab';
import { errText } from './ScriptsTab';
import { ScriptLabel } from './ScriptLabel';
import { Badge, Button, cx, Dialog, DialogActions, EmptyState, IconButton, PageHeader, type BadgeTone } from '../ui';

const STATUS: Record<TcConversionStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: '대기', tone: 'idle' },
  converting: { label: '변환 중', tone: 'run' },
  done: { label: '완료', tone: 'ok' },
  failed: { label: '실패', tone: 'bad' },
  excluded: { label: '제외', tone: 'neutral' },
};

export function TcStatusBadge({ status }: { status: TcConversionStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} data-testid="tc-status" data-status={status}>
      {s.label}
    </Badge>
  );
}

const LAYOUT_LABEL: Record<string, string> = { block: '블록형 (TC 하나 = 한 블록)', table: '행형 (한 행 = TC 또는 단계)', unknown: '알아보지 못함' };
const CREDENTIAL = /(비밀\s*번호|패스워드|password|passwd|pwd|\bpw\b|암호)\s*[:=：]\s*\S+/i;

/** Warnings of the TCs as they are now (preview edits re-check them). */
function liveWarnings(tcs: TcInput[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, m: string) => out.set(id, [...(out.get(id) ?? []), m]);
  const seen = new Map<string, number>();
  for (const t of tcs) seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
  for (const t of tcs) {
    if (!t.steps.length) add(t.id, '단계가 없습니다 — 단계를 추가하거나 이 TC 를 빼세요');
    if ((seen.get(t.id) ?? 0) > 1) add(t.id, `같은 TC ID (${t.id}) 가 여러 개입니다 — ID 를 고치세요`);
    const text = [t.precondition, t.description, ...t.steps.flatMap((s) => [s.action, s.expected])].filter(Boolean).join('\n');
    if (CREDENTIAL.test(text)) add(t.id, '비밀번호처럼 보이는 값이 있습니다 — 저장 전에 지우세요 (실행에는 프로젝트 설정의 비밀값을 씁니다)');
    if (!t.title.trim()) add(t.id, '제목이 비어 있습니다');
    if (t.steps.some((s) => !s.action.trim())) add(t.id, '절차가 빈 단계가 있습니다');
  }
  return out;
}

const normPre = (s: string | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');

/** Automatic precondition groups: same sentence → same group (in order of first appearance). */
function autoGroups(tcs: TcInput[]): Record<string, number> {
  const keys: string[] = [];
  const out: Record<string, number> = {};
  for (const t of tcs) {
    const k = normPre(t.precondition);
    if (!k) continue;
    let i = keys.indexOf(k);
    if (i < 0) i = keys.push(k) - 1;
    out[t.id] = i;
  }
  return out;
}

// ---- import preview ------------------------------------------------------------------------------------

function StepEditor({ steps, onChange }: { steps: TcStepItem[]; onChange: (s: TcStepItem[]) => void }) {
  const set = (i: number, patch: Partial<TcStepItem>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => {
    const next = [...steps];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    onChange(next);
  };
  return (
    <div className="tc-steps">
      <div className="table-card">
        <table data-testid="tc-step-table">
          <thead>
            <tr>
              <th>No.</th>
              <th>절차</th>
              <th>기대 결과</th>
              <th>순서 · 삭제</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={i} data-testid="tc-step-row">
                <td className="num">{i + 1}</td>
                <td>
                  <textarea rows={2} value={s.action} onChange={(e) => set(i, { action: e.target.value })} aria-label={`${i + 1}번 절차`} data-testid="tc-step-action" />
                </td>
                <td>
                  <textarea rows={2} value={s.expected ?? ''} onChange={(e) => set(i, { expected: e.target.value })} aria-label={`${i + 1}번 기대 결과`} placeholder="(없음)" data-testid="tc-step-expected" />
                </td>
                <td className="nowrap">
                  <div className="row-actions">
                    <IconButton icon={ArrowUp} label="한 칸 위로" disabled={i === 0} onClick={() => move(i, -1)} data-testid="tc-step-up" />
                    <IconButton icon={ArrowDown} label="한 칸 아래로" disabled={i === steps.length - 1} onClick={() => move(i, 1)} data-testid="tc-step-down" />
                    <Button size="sm" variant="danger" icon={Trash} onClick={() => onChange(steps.filter((_x, j) => j !== i))} title="이 단계 삭제" data-testid="tc-step-delete">
                      삭제
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button icon={Plus} onClick={() => onChange([...steps, { no: steps.length + 1, action: '' }])} data-testid="tc-step-add">
        단계 추가
      </Button>
    </div>
  );
}

export function TcImportPreview({ project, view, nav, onConfirmed, onCancel }: { project: ProjectView; view: TcImportView; nav: Nav; onConfirmed: (docId: string) => void; onCancel: () => void }) {
  const pid = project.id;
  const [name, setName] = useState(view.fileName.replace(/\.[^.]+$/, ''));
  const [tcs, setTcs] = useState<TcInput[]>(view.tcs);
  const [sel, setSel] = useState(view.tcs[0]?.id);
  const [groups, setGroups] = useState<Record<string, number>>(() => autoGroups(view.tcs));
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [envId, setEnvId] = useState(project.defaultEnvId ?? project.environments[0]?.id ?? '');
  // AI extraction delivered TCs while this screen was open.
  useEffect(() => {
    setTcs(view.tcs);
    setGroups(autoGroups(view.tcs));
    setSel((s) => (s && view.tcs.some((t) => t.id === s) ? s : view.tcs[0]?.id));
  }, [view.tcs]);

  const warn = useMemo(() => liveWarnings(tcs), [tcs]);
  const origWarn = (id: string) => view.warnings.filter((w) => w.tcId === id && w.code.startsWith('step-number'));
  const cur = tcs.find((t) => t.id === sel);
  const curIndex = tcs.findIndex((t) => t.id === sel);
  const update = (patch: Partial<TcInput>) => {
    if (curIndex < 0) return;
    const before = tcs[curIndex]!;
    const next = tcs.map((t, i) => (i === curIndex ? { ...t, ...patch } : t));
    setTcs(next);
    if (patch.id !== undefined && patch.id !== before.id) {
      setSel(patch.id);
      setGroups((g) => {
        const { [before.id]: v, ...rest } = g;
        return v === undefined ? rest : { ...rest, [patch.id!]: v };
      });
    }
    // Editing a precondition sentence regroups by sentence (manual moves are recomputed).
    if (patch.precondition !== undefined) setGroups(autoGroups(next));
  };
  const remove = (id: string) => {
    const next = tcs.filter((t) => t.id !== id);
    setTcs(next);
    setGroups((g) => {
      const { [id]: _x, ...rest } = g;
      return rest;
    });
    setSel(next[Math.max(0, curIndex - 1)]?.id ?? next[0]?.id);
  };

  // Precondition groups as people see them: number → TCs (first member's sentence is the group's).
  const groupList = useMemo(() => {
    const nums = [...new Set(tcs.flatMap((t) => (groups[t.id] !== undefined ? [groups[t.id]!] : [])))].sort((a, b) => a - b);
    return nums.map((n) => {
      const members = tcs.filter((t) => groups[t.id] === n);
      return { n, text: members[0]?.precondition ?? '', members };
    });
  }, [tcs, groups]);
  const moveTo = (tcId: string, to: string) =>
    setGroups((g) => {
      if (to === 'own') return { ...g, [tcId]: Math.max(-1, ...Object.values(g)) + 1 };
      return { ...g, [tcId]: Number(to) };
    });

  const blocking = [...warn.values()].flat().filter((m) => !m.startsWith('비밀번호')).length;
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const doc = await window.euta.tcDocs.confirm(pid, view.importId, {
        name,
        tcs: tcs.map((t) => ({ ...t, steps: t.steps.map((s, i) => ({ no: i + 1, action: s.action, ...(s.expected?.trim() ? { expected: s.expected } : {}) })) })),
        preconditions: groupList.map((g, i) => ({ text: g.text || `사전 조건 ${i + 1}`, tcIds: g.members.map((m) => m.id) })),
      });
      onConfirmed(doc.id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const extract = async () => {
    setError(undefined);
    try {
      nav.openChat(await window.euta.tcDocs.extract(pid, view.importId, envId));
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className="tc-preview" data-testid="tc-preview" data-status={view.status}>
      <PageHeader
        title="TC 문서 미리보기"
        meta={
          <Badge tone="neutral" data-testid="tc-preview-layout" data-layout={view.layout}>
            {view.format.toUpperCase()} · {view.extractedByAi ? 'AI 가 읽음' : LAYOUT_LABEL[view.layout]}
          </Badge>
        }
        actions={
          <>
            <Button icon={X} onClick={onCancel} data-testid="tc-preview-cancel">
              취소
            </Button>
            <Button variant="primary" icon={Check} disabled={busy || !tcs.length || !name.trim() || blocking > 0} onClick={() => void confirm()} data-testid="tc-preview-confirm" title={blocking ? '경고(단계 없음 · 같은 ID · 빈 절차)를 먼저 고치세요' : '이대로 저장합니다 (원본 파일은 저장하지 않음)'}>
              확정 (TC {tcs.length}개)
            </Button>
          </>
        }
      />
      <div className="form-row tc-docname">
        <label htmlFor="tc-doc-name">문서 이름</label>
        <input id="tc-doc-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="tc-preview-name" />
        <span className="muted small">가져온 파일: {view.fileName} — 원본 파일은 저장하지 않고 정리된 TC 만 프로젝트에 남깁니다.</span>
      </div>
      {error && <div className="error">{error}</div>}
      {blocking > 0 && tcs.length > 0 && (
        <div className="warn small" data-testid="tc-preview-blocking">
          <AlertTriangle className="lead-icon" size={14} aria-hidden="true" /> 경고가 있는 TC 가 있습니다(단계 없음 · 같은 ID · 빈 절차) — 고치거나 그 TC 를 빼면 확정할 수 있습니다.
        </div>
      )}

      {view.status !== 'ready' && (
        <div className="card" data-testid="tc-preview-ai">
          {view.status === 'extracting' ? (
            <p>
              <Sparkles className="lead-icon" size={14} aria-hidden="true" /> AI 가 문서의 표를 읽고 있습니다. 끝나면 이 화면에 TC 가 나타납니다.{' '}
              {view.chatId && (
                <Button size="sm" icon={Eye} onClick={() => nav.openChat(view.chatId!)}>
                  AI 대화 보기
                </Button>
              )}
            </p>
          ) : (
            <>
              <p>
                <AlertTriangle className="lead-icon" size={14} aria-hidden="true" /> 이 문서의 양식을 알아보지 못했습니다. AI 가 표에서 TC 를 읽어 정리할 수 있습니다(새 AI 대화가 열립니다).
              </p>
              <div className="inline">
                <label className="small">
                  환경{' '}
                  <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                    {project.environments.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button variant="primary" icon={Sparkles} onClick={() => void extract()} data-testid="tc-preview-extract">
                  AI로 읽기
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {tcs.length > 0 && (
        <div className="tc-split">
          <div className="tc-list card" data-testid="tc-preview-list">
            <div className="small muted">TC {tcs.length}개</div>
            <ul>
              {tcs.map((t) => {
                const w = (warn.get(t.id)?.length ?? 0) + origWarn(t.id).length;
                return (
                  <li key={t.id}>
                    <button className={cx('tc-pick', t.id === sel && 'is-active')} onClick={() => setSel(t.id)} data-testid="tc-preview-item" data-id={t.id} data-warn={w}>
                      <span className="tc-pick-title">
                        <b>{t.title || '(제목 없음)'}</b> <span className="muted small">{t.id}</span>
                      </span>
                      <span className="tc-pick-meta small muted">
                        {t.category ?? '분류 없음'} · 단계 {t.steps.length}
                        {w > 0 && (
                          <Badge tone="warn" title="경고가 있습니다">
                            경고 {w}
                          </Badge>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {cur && (
            <div className="tc-edit card" data-testid="tc-preview-edit" data-id={cur.id}>
              <div className="inline between">
                <h3>{cur.title || '(제목 없음)'}</h3>
                <Button size="sm" variant="danger" icon={Trash} onClick={() => remove(cur.id)} data-testid="tc-preview-remove" title="이 TC 를 문서에서 뺍니다">
                  이 TC 빼기
                </Button>
              </div>
              {[...(warn.get(cur.id) ?? []), ...origWarn(cur.id).map((w) => `${w.message} — 확정할 때 순서대로 1부터 다시 매깁니다`)].map((m, i) => (
                <div key={i} className="warn small" data-testid="tc-preview-warning">
                  <AlertTriangle className="lead-icon" size={14} aria-hidden="true" /> {m}
                </div>
              ))}
              <div className="tc-fields">
                <label>
                  TC ID <input value={cur.id} onChange={(e) => update({ id: e.target.value })} data-testid="tc-field-id" />
                </label>
                <label className="grow">
                  제목 <input value={cur.title} onChange={(e) => update({ title: e.target.value })} data-testid="tc-field-title" />
                </label>
                <label>
                  분류 <input value={cur.category ?? ''} onChange={(e) => update({ category: e.target.value })} data-testid="tc-field-category" />
                </label>
              </div>
              <label className="tc-field-block">
                사전 조건
                <textarea rows={2} value={cur.precondition ?? ''} onChange={(e) => update({ precondition: e.target.value })} data-testid="tc-field-precondition" />
              </label>
              {cur.description && <p className="muted small">설명: {cur.description}</p>}
              <StepEditor steps={cur.steps} onChange={(steps) => update({ steps })} />
            </div>
          )}
        </div>
      )}

      {groupList.length > 0 && (
        <div className="card" data-testid="tc-pre-groups">
          <h3>사전 조건 묶음</h3>
          <p className="muted small">같은 문장은 자동으로 묶었습니다. 묶음 하나가 사전 조건 스크립트 하나가 되고, 테스트 세트에서 그 TC 들보다 먼저 실행됩니다. TC 를 다른 묶음으로 옮기거나 따로 떼어 낼 수 있습니다.</p>
          <ol className="tc-groups">
            {groupList.map((g, i) => (
              <li key={g.n} data-testid="tc-pre-group" data-members={g.members.map((m) => m.id).join(',')}>
                <div>
                  <span className="order">{i + 1}</span> <b>{g.text.split('\n')[0]}</b>
                </div>
                <ul className="tc-group-members">
                  {g.members.map((m) => (
                    <li key={m.id} className="inline">
                      <span>
                        {m.title} <span className="muted small">{m.id}</span>
                      </span>
                      <label className="small muted">
                        옮기기{' '}
                        <select value={String(g.n)} onChange={(e) => moveTo(m.id, e.target.value)} data-testid="tc-pre-move" aria-label={`${m.id} 사전 조건 묶음`}>
                          {groupList.map((x, j) => (
                            <option key={x.n} value={String(x.n)}>
                              묶음 {j + 1}
                            </option>
                          ))}
                          <option value="own">따로 (새 묶음)</option>
                        </select>
                      </label>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ---- dialogs ------------------------------------------------------------------------------------------

/** [내보내기]: xlsx (블록형, 다시 가져오기 가능) or md (읽기용) → save dialog. */
export function TcExportDialog({ project, source, title, onClose }: { project: ProjectView; source: TcExportSource; title: string; onClose: () => void }) {
  const [format, setFormat] = useState<'xlsx' | 'md'>('xlsx');
  const [saved, setSaved] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const save = async () => {
    setError(undefined);
    try {
      const p = await window.euta.tcDocs.export(project.id, source, format);
      if (p) setSaved(p);
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Dialog label="TC 문서로 내보내기" className="tc-dialog" data-testid="tc-export">
      <h3>TC 문서로 내보내기 — {title}</h3>
      <p className="muted small">TC 문서에서 만든 스크립트는 원래 TC 문장으로, 그 밖의 스크립트는 단계 문장(묶음 하나 = TC 단계 하나)으로 씁니다. 결과(Result) 칸은 비워 둡니다.</p>
      <div className="choice-list">
        <label className={cx('choice', format === 'xlsx' && 'is-active')}>
          <input type="radio" name="tc-fmt" checked={format === 'xlsx'} onChange={() => setFormat('xlsx')} data-testid="tc-export-xlsx" />
          <span>
            <b>Excel (xlsx, 블록형)</b>
            <span className="muted small"> — TC 목록 시트 + 분류별 시트. 다시 가져올 수 있습니다.</span>
          </span>
        </label>
        <label className={cx('choice', format === 'md' && 'is-active')}>
          <input type="radio" name="tc-fmt" checked={format === 'md'} onChange={() => setFormat('md')} data-testid="tc-export-md" />
          <span>
            <b>Markdown (md)</b>
            <span className="muted small"> — 읽기용 문서.</span>
          </span>
        </label>
      </div>
      {saved && (
        <div className="ok-text small" data-testid="tc-export-saved" data-path={saved}>
          <Check className="lead-icon" size={14} aria-hidden="true" /> 저장했습니다: <code>{saved}</code>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <DialogActions>
        <Button icon={X} onClick={onClose} data-testid="tc-export-close">
          {saved ? '닫기' : '취소'}
        </Button>
        <Button variant="primary" icon={FileDown} onClick={() => void save()} data-testid="tc-export-save">
          저장할 곳 고르기…
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** "n / N 진행 중 · 지금 <TC>" of an auto conversion (TC 문서 화면 · 채팅 위). */
export function TcProgressText({ p }: { p: TcConvertProgress }) {
  const c = p.current;
  return (
    <span data-testid="tc-progress-text" data-done={p.done} data-total={p.total} data-current={c?.tcId ?? ''}>
      <b>
        {Math.min(p.done + 1, p.total)} / {p.total}
      </b>{' '}
      진행 중
      {c && (
        <>
          {' '}
          · 지금 <b>{c.title}</b> <span className="muted small">{c.tcId}</span>
          {c.precondition && <span className="muted small"> · 사전 조건 스크립트 먼저: “{c.preconditionText ?? c.precondition}”</span>}
          {c.attempt > 1 && <span className="muted small"> · 한 번 더 (한도에 닿음)</span>}
        </>
      )}
      {p.stopping && <span className="muted small"> · 멈추는 중…</span>}
    </span>
  );
}

const END_LABEL: Record<TcConvertEnd['reason'], string> = { empty: '대기열을 모두 마쳤습니다', stopped: '중지했습니다', limit: '정한 개수만큼 진행했습니다', error: '오류로 멈췄습니다' };

/** [AI로 변환] · [이어서 변환] · [다시 변환]: the queue in order, the chat's environment, an optional note. */
function ConvertDialog({
  project,
  doc,
  tcIds,
  mode,
  onClose,
  onStarting,
  onStarted,
}: {
  project: ProjectView;
  doc: TcDocView;
  tcIds: string[];
  mode: 'new' | 'resume' | 'redo';
  onClose: () => void;
  onStarting: (on: boolean) => void;
  onStarted: (chatId: string) => void;
}) {
  const [envId, setEnvId] = useState(project.defaultEnvId ?? project.environments[0]?.id ?? '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const list = tcIds.map((id) => doc.tcs.find((t) => t.id === id)).filter((t): t is TcDocTc => !!t);
  // 자동으로 진행할 개수: the whole queue by default, can be lowered.
  const [limit, setLimit] = useState(String(list.length));
  const count = Math.min(list.length, Math.max(1, Math.floor(Number(limit)) || list.length));
  const start = async () => {
    if (busy) return;
    setBusy(true);
    onStarting(true);
    setError(undefined);
    try {
      onStarted(await window.euta.tcDocs.convert(project.id, doc.id, { ...(mode === 'resume' ? {} : { tcIds }), redo: mode === 'redo', envId, message, limit: count }));
    } catch (e) {
      setError(errText(e));
      onStarting(false);
    } finally {
      setBusy(false);
    }
  };
  const title = mode === 'resume' ? '이어서 변환' : mode === 'redo' ? '다시 변환' : 'AI로 변환';
  return (
    <Dialog label={title} className="tc-dialog" data-testid="tc-convert">
      <h3>{title}</h3>
      <p className="muted small">
        새 AI 대화 하나에서 아래 순서대로 TC 를 하나씩 변환합니다. 앱이 TC 하나(필요하면 그 사전 조건 먼저)를 메시지 하나로 보내고, 끝나면 다음 TC 를 자동으로 보냅니다. AI 는 실제 화면을 열어 대상을 확인하고 저장 → 검증 → 실행(실패하면 최대 3번 고침)한 뒤 결과를 알려 줍니다. 멈춰도 남은 대기열은 [이어서 변환] 으로 다시 시작할 수 있습니다.
      </p>
      <ol className="tc-queue" data-testid="tc-convert-queue">
        {list.map((t, i) => (
          <li key={t.id} data-id={t.id} className={i >= count ? 'muted' : undefined}>
            <span className="order">{i + 1}</span> {t.title} <span className="muted small">{t.id}</span>
            {i >= count && <span className="muted small"> · 대기열에 남음</span>}
          </li>
        ))}
      </ol>
      <div className="form-row">
        <label htmlFor="tc-conv-limit">자동으로 진행할 개수</label>
        <div className="inline">
          <input id="tc-conv-limit" type="number" min={1} max={list.length} value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 80 }} data-testid="tc-convert-limit" />
          <span className="muted small">/ {list.length}개 — 남은 TC 는 대기열에 남아 [이어서 변환] 으로 계속합니다</span>
        </div>
      </div>
      <p className="small" data-testid="tc-convert-usage">
        <Info className="lead-icon" size={14} aria-hidden="true" /> 항목마다 AI 메시지 1개를 씁니다(사전 조건이 필요하면 1개 더) — 본인 Claude 구독 사용량에서 나갑니다. 지금 설정이면 TC {count}개 = 메시지 {count}개 이상.
      </p>
      <div className="form-row">
        <label htmlFor="tc-conv-env">실행 환경</label>
        <select id="tc-conv-env" value={envId} onChange={(e) => setEnvId(e.target.value)} data-testid="tc-convert-env">
          {project.environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.baseUrl ? ` — ${e.baseUrl}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label htmlFor="tc-conv-msg">AI 에게 덧붙일 말 (선택)</label>
        <textarea id="tc-conv-msg" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="예) 로그인은 USER_EMAIL / USER_PASSWORD 비밀값을 쓰세요" data-testid="tc-convert-message" />
      </div>
      {error && <div className="error">{error}</div>}
      <DialogActions>
        <Button icon={X} onClick={onClose}>
          취소
        </Button>
        <Button variant="primary" icon={Sparkles} disabled={busy || !!doc.activeChatId || !list.length || !project.environments.length} onClick={() => void start()} data-testid="tc-convert-start">
          변환 시작 ({count}개)
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const GROUPING: { key: TcSetGrouping; label: string; hint: string }[] = [
  { key: 'all', label: '문서 전체', hint: '세트 1개' },
  { key: 'category', label: '분류별', hint: '분류마다 세트 1개' },
  { key: 'checked', label: '체크한 TC', hint: '세트 1개' },
];

/** [테스트 세트 만들기]: grouping → planned sets (precondition scripts first) → new set or append to an existing one. */
function TestSetDialog({ project, doc, checked, onClose, onDone }: { project: ProjectView; doc: TcDocView; checked: string[]; onClose: () => void; onDone: (p: ProjectView, note: string) => void }) {
  const pid = project.id;
  const [mode, setMode] = useState<TcSetGrouping>(checked.length ? 'checked' : 'category');
  const [plan, setPlan] = useState<TcSetPlan | undefined>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const editable = !project.cloudView || (project.cloudView.online && !project.cloudView.readOnly);
  useEffect(() => {
    let alive = true;
    setError(undefined);
    void window.euta.tcDocs.planSets(pid, doc.id, mode, checked).then(
      (p) => {
        if (!alive) return;
        setPlan(p);
        setNames(Object.fromEntries(p.sets.map((s) => [s.key, s.name])));
        setTargets(Object.fromEntries(p.sets.map((s) => [s.key, project.suites.find((x) => x.name === s.name)?.id ?? ''])));
      },
      (e) => alive && setError(errText(e)),
    );
    return () => {
      alive = false;
    };
  }, [pid, doc.id, mode, checked, project.suites]);
  const scriptName = (p: string) => doc.scripts[p]?.name;
  const create = async () => {
    if (!plan) return;
    setBusy(true);
    setError(undefined);
    try {
      let v: ProjectView = project;
      const made: string[] = [];
      for (const s of plan.sets) {
        const target = targets[s.key];
        const existing = target ? v.suites.find((x) => x.id === target) : undefined;
        if (existing) {
          v = await window.euta.suites.upsert(pid, existing.id, { scripts: [...existing.scripts, ...s.scripts.filter((p) => !existing.scripts.includes(p))] });
          made.push(`“${existing.name}” 에 덧붙임`);
        } else {
          v = await window.euta.suites.upsert(pid, undefined, { name: names[s.key]?.trim() || s.name, scripts: s.scripts });
          made.push(`“${names[s.key]?.trim() || s.name}”`);
        }
      }
      onDone(v, `테스트 세트 ${made.join(', ')}${plan.skipped.length ? ` — 변환이 안 끝난 TC ${plan.skipped.length}개는 뺐습니다` : ''}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog label="테스트 세트 만들기" className="tc-dialog" data-testid="tc-sets">
      <h3>테스트 세트 만들기 — {doc.name}</h3>
      <div className="choice-list horizontal" role="radiogroup" aria-label="묶는 기준">
        {GROUPING.map((g) => (
          <label key={g.key} className={cx('choice', mode === g.key && 'is-active')}>
            <input type="radio" name="tc-grouping" checked={mode === g.key} disabled={g.key === 'checked' && !checked.length} onChange={() => setMode(g.key)} data-testid={`tc-sets-${g.key}`} />
            <span>
              <b>{g.label}</b>
              <span className="muted small"> — {g.key === 'checked' ? (checked.length ? `${checked.length}개 체크함` : '체크한 TC 없음') : g.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="muted small">세트마다 그 TC 들이 쓰는 사전 조건 스크립트를 맨 앞에 두고, 이어서 문서 순서로 TC 스크립트를 넣습니다.</p>
      {plan && plan.skipped.length > 0 && (
        <div className="warn small" data-testid="tc-sets-skipped" data-count={plan.skipped.length}>
          <AlertTriangle className="lead-icon" size={14} aria-hidden="true" /> 변환이 안 끝난 TC {plan.skipped.length}개는 빼고 만듭니다: {plan.skipped.map((s) => `${s.title} (${s.tcId} · ${s.reason})`).join(', ')}
        </div>
      )}
      {plan && !plan.sets.length && <p className="muted">만들 세트가 없습니다 — 먼저 TC 를 변환하세요.</p>}
      {plan?.sets.map((s) => (
        <div key={s.key} className="card tc-set-plan" data-testid="tc-sets-plan" data-name={s.name} data-count={s.scripts.length}>
          <div className="tc-fields">
            <label className="grow">
              이름{' '}
              <input value={names[s.key] ?? ''} disabled={!!targets[s.key]} onChange={(e) => setNames((m) => ({ ...m, [s.key]: e.target.value }))} data-testid="tc-sets-name" />
            </label>
            <label>
              어디에{' '}
              <select value={targets[s.key] ?? ''} onChange={(e) => setTargets((m) => ({ ...m, [s.key]: e.target.value }))} data-testid="tc-sets-target">
                <option value="">새 테스트 세트로 만들기</option>
                {project.suites.map((x) => (
                  <option key={x.id} value={x.id}>
                    “{x.name}” 에 덧붙이기
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ol className="compact-list small">
            {s.scripts.map((p) => (
              <li key={p}>
                <ScriptLabel path={p} name={scriptName(p)} /> {s.preconditionScripts.includes(p) && <span className="tag">사전 조건</span>}
              </li>
            ))}
          </ol>
        </div>
      ))}
      {!editable && <div className="warn small">클라우드 프로젝트의 테스트 세트는 온라인 · 편집 권한일 때만 만들 수 있습니다.</div>}
      {error && <div className="error">{error}</div>}
      <DialogActions>
        <Button icon={X} onClick={onClose}>
          취소
        </Button>
        <Button variant="primary" icon={ListPlus} disabled={busy || !editable || !plan?.sets.length} onClick={() => void create()} data-testid="tc-sets-create">
          {plan?.sets.length ? `테스트 세트 ${plan.sets.length}개 만들기` : '만들기'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---- detail ---------------------------------------------------------------------------------------------

const KIND: Record<string, { label: string; tone: BadgeTone }> = {
  auto: { label: '자동', tone: 'ok' },
  manual: { label: '수동', tone: 'manual' },
  partial: { label: '자동 + 수동', tone: 'manual' },
  missing: { label: '대응 없음', tone: 'warn' },
};

function TcRowDetail({ project, doc, tc, nav, onChanged }: { project: ProjectView; doc: TcDocView; tc: TcDocTc; nav: Nav; onChanged: () => void }) {
  const [m, setM] = useState<TcMappingView | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    void window.euta.tcDocs.mapping(project.id, doc.id, tc.id).then(setM, (e) => setError(errText(e)));
  }, [project.id, doc.id, tc.id, tc.conversion.updatedAt]);
  const pre = doc.preconditions.find((p) => p.id === tc.preconditionId);
  return (
    <div className="tc-row-detail" data-testid="tc-row-detail">
      {pre && (
        <p className="small">
          <span className="muted">사전 조건:</span> {pre.text.split('\n')[0]} <TcStatusBadge status={pre.status} />{' '}
          {pre.script && <ScriptLabel path={pre.script} name={doc.scripts[pre.script]?.name} />}
        </p>
      )}
      {tc.conversion.note && (
        <p className="small warn" data-testid="tc-note">
          {tc.conversion.status === 'failed' ? '실패 원인: ' : ''}
          {tc.conversion.note}
        </p>
      )}
      {tc.conversion.missingInfo.length > 0 && (
        <div className="small" data-testid="tc-missing">
          <b>정보 부족</b>
          <ul>
            {tc.conversion.missingInfo.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      <table className="tc-map" data-testid="tc-mapping">
        <thead>
          <tr>
            <th>No.</th>
            <th>절차 → 기대 결과</th>
            <th>스크립트 묶음</th>
            <th>대응</th>
          </tr>
        </thead>
        <tbody>
          {(m?.steps ?? tc.steps.map((s) => ({ ...s, kind: 'missing' as const, manual: [] as string[], group: undefined }))).map((s) => (
            <tr key={s.no} data-testid="tc-map-row" data-kind={tc.conversion.script ? s.kind : 'none'}>
              <td className="num">{s.no}</td>
              <td>
                {s.action}
                {s.expected && <div className="muted small">→ {s.expected}</div>}
              </td>
              <td className="small">{s.group ?? <span className="muted">—</span>}</td>
              <td>
                {tc.conversion.script ? (
                  <>
                    <Badge tone={KIND[s.kind]!.tone}>{KIND[s.kind]!.label}</Badge>
                    {s.manual.map((x, i) => (
                      <div key={i} className="manual-note small">
                        수동 확인: {x}
                      </div>
                    ))}
                  </>
                ) : (
                  <span className="muted small">변환 전</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {m && m.script && !m.exists && <div className="warn small">스크립트 파일이 없습니다 ({m.script}) — [다시 변환] 하세요.</div>}
      <div className="row-actions">
        {tc.conversion.script && m?.exists && (
          <Button size="sm" icon={Eye} onClick={() => nav.openScript(tc.conversion.script!)} data-testid="tc-open-script">
            스크립트 보기
          </Button>
        )}
        {tc.conversion.status === 'excluded' ? (
          <Button size="sm" icon={Undo2} onClick={() => void window.euta.tcDocs.exclude(project.id, doc.id, tc.id, false).then(onChanged, (e) => setError(errText(e)))} data-testid="tc-include">
            다시 포함
          </Button>
        ) : (
          <Button size="sm" icon={Ban} onClick={() => void window.euta.tcDocs.exclude(project.id, doc.id, tc.id, true).then(onChanged, (e) => setError(errText(e)))} title="자동화하지 않을 TC — 변환 대기열과 테스트 세트에서 뺍니다" data-testid="tc-exclude">
            변환에서 빼기
          </Button>
        )}
      </div>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

export function TcDocDetail({
  project,
  docId,
  nav,
  onBack,
  onProjectChanged,
  onShowSets,
}: {
  project: ProjectView;
  docId: string;
  nav: Nav;
  onBack: () => void;
  onProjectChanged: (p: ProjectView) => void;
  onShowSets: () => void;
}) {
  const pid = project.id;
  const [doc, setDoc] = useState<TcDocView | undefined>();
  const [picked, setPicked] = useState<string[] | undefined>();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ kind: 'convert'; mode: 'new' | 'resume' | 'redo'; tcIds: string[] } | { kind: 'sets' } | { kind: 'export' } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const d = await window.euta.tcDocs.get(pid, docId);
      setDoc(d);
      // The persisted queue comes back checked, in order (이어서 변환 after a restart).
      setPicked((p) => p ?? [...d.queue]);
    } catch (e) {
      setError(errText(e));
    }
  }, [pid, docId]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => window.euta.tcDocs.onChanged((p, d) => p === pid && d === docId && void refresh()), [pid, docId, refresh]);
  useEffect(() => window.euta.scripts.onChanged((p) => p === pid && void refresh()), [pid, refresh]);
  const checked = picked ?? [];

  const rows = useMemo(() => {
    if (!doc) return [];
    const q = query.trim().toLowerCase();
    const match = (t: TcDocTc) => !q || `${t.id}\n${t.title}\n${t.category ?? ''}`.toLowerCase().includes(q);
    return [...checked.map((id) => doc.tcs.find((t) => t.id === id)).filter((t): t is TcDocTc => !!t), ...doc.tcs.filter((t) => !checked.includes(t.id) && match(t))];
  }, [doc, checked, query]);

  if (!doc)
    return (
      <div>
        {error ? <div className="error">{error}</div> : <p className="muted">불러오는 중…</p>}
        <Button icon={ChevronRight} onClick={onBack}>
          목록으로
        </Button>
      </div>
    );

  const toggle = (id: string, on: boolean) => setPicked(on ? [...checked, id] : checked.filter((x) => x !== id));
  const stopAuto = async () => {
    try {
      await window.euta.tcDocs.stop(pid, doc.id);
    } catch (e) {
      setError(errText(e));
    }
  };
  const done = doc.tcs.filter((t) => t.conversion.status === 'done').length;
  const queueLeft = doc.queue.filter((id) => doc.tcs.some((t) => t.id === id));
  // Disabled at once from the click (starting) until the chat's turn ends (activeChatId from main).
  const converting = starting || !!doc.activeChatId || doc.tcs.some((t) => t.conversion.status === 'converting');
  const redoable = checked.filter((id) => ['done', 'failed'].includes(doc.tcs.find((t) => t.id === id)?.conversion.status ?? ''));
  const newOnes = checked.filter((id) => !['done', 'excluded'].includes(doc.tcs.find((t) => t.id === id)?.conversion.status ?? ''));
  const one = checked.length === 1 ? doc.tcs.find((t) => t.id === checked[0]) : undefined;
  const scriptLast = (t: TcDocTc) => (t.conversion.script ? doc.scripts[t.conversion.script] : undefined);
  const editable = !project.cloudView?.readOnly;

  return (
    <div className="tc-detail" data-testid="tc-detail" data-doc-id={doc.id}>
      <button className="link small" onClick={onBack} data-testid="tc-back">
        ← TC 문서 목록
      </button>
      <PageHeader
        title={doc.name}
        titleTestId="tc-detail-name"
        meta={
          <>
            <Badge tone="neutral">TC {doc.tcs.length}</Badge>
            <Badge tone={done === doc.tcs.length ? 'ok' : 'idle'} data-testid="tc-detail-done">
              완료 {done}
            </Badge>
          </>
        }
        actions={
          <>
            <Button icon={ListChecks} onClick={() => setDialog({ kind: 'sets' })} data-testid="tc-make-sets" title="변환한 TC 로 테스트 세트를 만듭니다">
              테스트 세트 만들기
            </Button>
            <Button icon={FileDown} onClick={() => setDialog({ kind: 'export' })} data-testid="tc-export-open" title="TC 문서(xlsx · md)로 내보냅니다">
              내보내기
            </Button>
          </>
        }
      />
      <p className="muted small">
        가져온 파일 {doc.source.fileName} · {doc.source.extractedByAi ? 'AI 가 읽음' : LAYOUT_LABEL[doc.source.layout]} · {new Date(doc.source.importedAt).toLocaleString()}
      </p>
      {editable && (
        <div className="tc-actions card" data-testid="tc-actions">
          <div className="small muted">
            TC 를 체크한 순서가 변환 순서(대기열)입니다. {checked.length ? `${checked.length}개 체크함.` : '변환할 TC 를 체크하세요.'}
          </div>
          <div className="row-actions">
            <Button variant={queueLeft.length ? 'secondary' : 'primary'} icon={Sparkles} disabled={!newOnes.length || converting} onClick={() => setDialog({ kind: 'convert', mode: 'new', tcIds: newOnes })} data-testid="tc-convert-ai" title="체크한 TC 를 새 AI 대화에서 하나씩 변환합니다">
              AI로 변환{newOnes.length ? ` (${newOnes.length})` : ''}
            </Button>
            {queueLeft.length > 0 && (
              <Button variant="primary" icon={Play} disabled={converting} onClick={() => setDialog({ kind: 'convert', mode: 'resume', tcIds: queueLeft })} data-testid="tc-convert-resume" title={converting ? '변환이 진행 중입니다' : '대기열에 남은 TC 를 새 AI 대화에서 이어서 변환합니다'}>
                이어서 변환 ({queueLeft.length})
              </Button>
            )}
            <Button icon={Video} disabled={!one} onClick={() => one && nav.startRecording({ docId: doc.id, tcId: one.id })} data-testid="tc-convert-record" title={one ? 'TC 단계를 띄운 녹화 패널로 직접 시연합니다' : 'TC 를 하나만 체크하세요'}>
              시연으로 변환
            </Button>
            <Button icon={RotateCcw} disabled={!redoable.length || converting} onClick={() => setDialog({ kind: 'convert', mode: 'redo', tcIds: redoable })} data-testid="tc-convert-redo" title="완료 · 실패한 TC 를 다시 변환합니다 (덧붙일 말을 쓸 수 있음)">
              다시 변환{redoable.length ? ` (${redoable.length})` : ''}
            </Button>
            {checked.length > 0 && (
              <Button icon={X} onClick={() => setPicked([])} data-testid="tc-uncheck">
                체크 해제
              </Button>
            )}
          </div>
          {converting && (
            <div className="small tc-progress" data-testid="tc-converting">
              <Sparkles className="lead-icon" size={14} aria-hidden="true" />{' '}
              {doc.progress ? <TcProgressText p={doc.progress} /> : <>변환 채팅이 진행 중입니다 — 끝나거나 멈춘 뒤 다시 시작할 수 있습니다.</>}{' '}
              {doc.activeChatId && (
                <Button size="sm" icon={Eye} onClick={() => nav.openChat(doc.activeChatId!)} data-testid="tc-open-chat">
                  AI 대화 보기
                </Button>
              )}{' '}
              {doc.progress && (
                <Button size="sm" variant="danger" icon={Square} disabled={doc.progress.stopping} onClick={() => void stopAuto()} data-testid="tc-auto-stop" title="지금 메시지를 멈추고 자동 진행을 끝냅니다 (남은 대기열은 그대로)">
                  중지
                </Button>
              )}
            </div>
          )}
          {!converting && doc.lastRun && (
            <div className="small muted" data-testid="tc-last-run" data-reason={doc.lastRun.reason}>
              지난 자동 변환: {END_LABEL[doc.lastRun.reason]} — {doc.lastRun.done} / {doc.lastRun.total} 마침{doc.lastRun.message ? ` · ${doc.lastRun.message}` : ''}
            </div>
          )}
          {queueLeft.length > 0 && (
            <div className="small" data-testid="tc-queue">
              <span className="muted">대기열 {queueLeft.length}개:</span> {queueLeft.map((id) => doc.tcs.find((t) => t.id === id)?.title ?? id).join(' → ')}
            </div>
          )}
        </div>
      )}
      {note && (
        <div className="note" data-testid="tc-note-banner">
          {note}{' '}
          <Button size="sm" variant="ghost" icon={ChevronRight} onClick={onShowSets} data-testid="tc-show-sets">
            테스트 세트 보기
          </Button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <label className="pick-search tc-search">
        <Search size={14} strokeWidth={2} aria-hidden="true" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="TC 를 제목 · ID · 분류로 찾기" data-testid="tc-search" />
      </label>
      <div className="table-card">
        <table className="history-table tc-table" data-testid="tc-table">
          <thead>
            <tr>
              <th></th>
              <th>TC</th>
              <th>분류</th>
              <th>변환</th>
              <th>스크립트</th>
              <th>수동 단계</th>
              <th>최근 결과</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const n = checked.indexOf(t.id);
              const last = scriptLast(t);
              const isOpen = open.has(t.id);
              return [
                <tr key={t.id} className={cx(n >= 0 && 'hl')} data-testid="tc-row" data-id={t.id} data-order={n >= 0 ? n + 1 : undefined} data-status={t.conversion.status}>
                  <td className="nowrap">
                    <label className="tc-check">
                      <input type="checkbox" checked={n >= 0} onChange={(e) => toggle(t.id, e.target.checked)} aria-label={`${t.title} 체크`} data-testid="tc-check" />
                      {n >= 0 && <span className="order">{n + 1}</span>}
                    </label>
                  </td>
                  <td className="tc-title-cell">
                    <b>{t.title}</b>
                    <div className="muted small">{t.id}</div>
                  </td>
                  <td className="small">{t.category ?? <span className="muted">—</span>}</td>
                  <td>
                    <TcStatusBadge status={t.conversion.status} />
                    {queueLeft.includes(t.id) && t.conversion.status === 'pending' && <span className="muted small"> 대기열</span>}
                  </td>
                  <td className="small tc-script-cell">
                    {t.conversion.script ? (
                      last?.exists ? (
                        <>
                          <b>{last.name ?? t.conversion.script}</b>
                          {last.name && <div className="muted">{t.conversion.script}</div>}
                        </>
                      ) : (
                        <span className="warn">스크립트 없음</span>
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">
                    {t.conversion.script ? (
                      t.conversion.manualSteps ? (
                        <Badge tone="manual" data-testid="tc-manual-count" title="사람이 확인해야 하는 단계 수">
                          수동 {t.conversion.manualSteps}
                        </Badge>
                      ) : (
                        '0'
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {t.conversion.missingInfo.length > 0 && (
                      <Badge tone="warn" title="문서에 없는 정보가 있습니다">
                        정보 부족 {t.conversion.missingInfo.length}
                      </Badge>
                    )}
                  </td>
                  <td>{last?.lastRun ? <StatusBadge status={last.lastRun.status} /> : <span className="muted small">—</span>}</td>
                  <td>
                    <Button size="sm" icon={isOpen ? ChevronDown : ChevronRight} onClick={() => setOpen((s) => new Set(isOpen ? [...s].filter((x) => x !== t.id) : [...s, t.id]))} data-testid="tc-expand" aria-expanded={isOpen}>
                      {isOpen ? '접기' : '단계 대응'}
                    </Button>
                  </td>
                </tr>,
                isOpen ? (
                  <tr key={`${t.id}-d`} className="nested">
                    <td></td>
                    <td colSpan={7}>
                      <TcRowDetail project={project} doc={doc} tc={t} nav={nav} onChanged={() => void refresh()} />
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
        {!rows.length && <p className="muted small table-empty">찾는 TC 가 없습니다.</p>}
      </div>
      {doc.preconditions.length > 0 && (
        <div className="card" data-testid="tc-preconditions">
          <h3>사전 조건 스크립트</h3>
          <ul className="compact-list">
            {doc.preconditions.map((p) => (
              <li key={p.id} data-testid="tc-precondition" data-status={p.status}>
                <TcStatusBadge status={p.status} /> {p.text.split('\n')[0]} <span className="muted small">— TC {doc.tcs.filter((t) => t.preconditionId === p.id).length}개가 씀</span>
                {p.script && (
                  <div className="small">
                    <span className="muted">스크립트:</span> <ScriptLabel path={p.script} name={doc.scripts[p.script]?.name} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {dialog?.kind === 'convert' && (
        <ConvertDialog
          project={project}
          doc={doc}
          tcIds={dialog.tcIds}
          mode={dialog.mode}
          onClose={() => setDialog(undefined)}
          onStarting={setStarting}
          onStarted={(chatId) => {
            setDialog(undefined);
            void refresh().finally(() => setStarting(false));
            nav.openChat(chatId);
          }}
        />
      )}
      {dialog?.kind === 'sets' && (
        <TestSetDialog
          project={project}
          doc={doc}
          checked={checked}
          onClose={() => setDialog(undefined)}
          onDone={(v, msg) => {
            onProjectChanged(v);
            setDialog(undefined);
            setNote(msg);
          }}
        />
      )}
      {dialog?.kind === 'export' && <TcExportDialog project={project} source={{ docId: doc.id }} title={doc.name} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

// ---- the view ------------------------------------------------------------------------------------------

export function TcDocsView({
  project,
  active,
  nav,
  importRequest,
  onProjectChanged,
  onShowSets,
}: {
  project: ProjectView;
  active: boolean;
  nav: Nav;
  /** "TC 문서로 만들기" was pressed (a number that changes each time). */
  importRequest?: number;
  onProjectChanged: (p: ProjectView) => void;
  onShowSets: () => void;
}) {
  const pid = project.id;
  const [docs, setDocs] = useState<TcDocSummary[]>([]);
  const [openId, setOpenId] = useState<string | undefined>();
  const [imp, setImp] = useState<TcImportView | undefined>();
  const [renaming, setRenaming] = useState<{ id: string; to: string } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const refresh = useCallback(async () => {
    try {
      setDocs(await window.euta.tcDocs.list(pid));
    } catch (e) {
      setError(errText(e));
    }
  }, [pid]);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  useEffect(() => window.euta.tcDocs.onChanged((p) => p === pid && void refresh()), [pid, refresh]);
  useEffect(() => window.euta.tcDocs.onImportUpdate((v) => setImp((cur) => (cur && cur.importId === v.importId ? v : cur))), []);

  const startImport = useCallback(async () => {
    setError(undefined);
    try {
      const v = await window.euta.tcDocs.import(pid);
      if (v) {
        setImp(v);
        setOpenId(undefined);
      }
    } catch (e) {
      setError(errText(e));
    }
  }, [pid]);
  useEffect(() => {
    if (importRequest) void startImport();
  }, [importRequest, startImport]);

  if (imp)
    return (
      <TcImportPreview
        key={imp.importId}
        project={project}
        view={imp}
        nav={nav}
        onCancel={() => {
          void window.euta.tcDocs.cancelImport(imp.importId);
          setImp(undefined);
        }}
        onConfirmed={(id) => {
          setImp(undefined);
          setOpenId(id);
          void refresh();
        }}
      />
    );
  if (openId) return <TcDocDetail key={openId} project={project} docId={openId} nav={nav} onBack={() => (setOpenId(undefined), void refresh())} onProjectChanged={onProjectChanged} onShowSets={onShowSets} />;

  const readOnly = !!project.cloudView?.readOnly;
  return (
    <div className="tc-docs" data-testid="tc-docs">
      <PageHeader
        title="TC 문서"
        actions={
          !readOnly && (
            <Button variant="primary" icon={FileSpreadsheet} onClick={() => void startImport()} data-testid="tc-import" title="QA 가 쓰는 TC 문서(xlsx · csv · docx · md)를 가져와 스크립트로 변환합니다">
              TC 문서로 만들기
            </Button>
          )
        }
      />
      <p className="muted small">가져온 TC 문서는 이 PC 의 프로젝트에만 저장됩니다(원본 파일은 저장하지 않음){project.cloud ? ' — 만든 스크립트와 테스트 세트는 지금처럼 클라우드로 올라갑니다' : ''}.</p>
      {error && <div className="error">{error}</div>}
      <div className="table-card">
        <table className="history-table" data-testid="tc-doc-list">
          <thead>
            <tr>
              <th>이름</th>
              <th>TC</th>
              <th>변환 완료</th>
              <th>가져온 때</th>
              <th>동작</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} data-testid="tc-doc-row" data-id={d.id}>
                <td>
                  {renaming?.id === d.id ? (
                    <span className="inline">
                      <input value={renaming.to} onChange={(e) => setRenaming({ ...renaming, to: e.target.value })} data-testid="tc-doc-rename-input" />
                      <Button
                        size="sm"
                        icon={Check}
                        onClick={() =>
                          void window.euta.tcDocs.rename(pid, d.id, renaming.to).then(
                            () => (setRenaming(undefined), void refresh()),
                            (e) => setError(errText(e)),
                          )
                        }
                      >
                        확인
                      </Button>
                    </span>
                  ) : (
                    <button className="link script-name" onClick={() => setOpenId(d.id)}>
                      <b>{d.name}</b>
                    </button>
                  )}
                  <div className="muted small">{d.fileName}</div>
                </td>
                <td className="num">{d.tcCount}</td>
                <td className="nowrap">
                  <Badge tone={d.done === d.tcCount ? 'ok' : 'idle'}>
                    {d.done}/{d.tcCount}
                  </Badge>
                  {d.failed > 0 && <Badge tone="bad">실패 {d.failed}</Badge>}
                  {d.queued > 0 && <Badge tone="run">대기열 {d.queued}</Badge>}
                </td>
                <td className="muted small">{new Date(d.importedAt).toLocaleString()}</td>
                <td>
                  <div className="row-actions">
                    <Button size="sm" icon={Eye} onClick={() => setOpenId(d.id)} data-testid="tc-doc-open">
                      열기
                    </Button>
                    {!readOnly && (
                      <>
                        <Button size="sm" icon={Pencil} onClick={() => setRenaming({ id: d.id, to: d.name })} data-testid="tc-doc-rename">
                          이름 변경
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          icon={Trash}
                          onClick={() => {
                            if (window.confirm(`TC 문서 “${d.name}” 를 삭제할까요? 만든 스크립트와 테스트 세트는 남습니다.`)) void window.euta.tcDocs.delete(pid, d.id).then(refresh, (e) => setError(errText(e)));
                          }}
                          data-testid="tc-doc-delete"
                        >
                          삭제
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {docs.length === 0 && (
          <EmptyState
            icon={FileSpreadsheet}
            title="TC 문서가 없습니다."
            description="QA 의 TC 문서(절차 · 기대 결과)를 가져오면 TC 마다 스크립트로 변환하고, 테스트 세트로 묶어 실행할 수 있습니다."
            testId="tc-docs-empty"
          />
        )}
      </div>
    </div>
  );
}

