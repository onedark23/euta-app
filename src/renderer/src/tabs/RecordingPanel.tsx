import { useEffect, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Check, CircleCheck, EyeOff, FileSpreadsheet, Flag, Pause, Pencil, Play, Save, SkipForward, Sparkles, Square, StickyNote, Trash, Undo2, Video, X } from 'lucide-react';
import type { CheckpointKind, DraftView, ProjectView, RecEvent, RecordingView, TcDocTc } from '../../../shared/types';
import { errText } from './ScriptsTab';
import { Button, Dialog, DialogActions } from '../ui';

export const CHECKPOINT_LABELS: Record<CheckpointKind, string> = {
  visible: '보임',
  hidden: '숨김',
  textEquals: '텍스트 같음',
  textContains: '텍스트 포함',
  url: '현재 주소',
  count: '개수',
};

const KIND_LABELS: Record<string, string> = {
  navigate: '이동',
  click: '클릭',
  dblclick: '더블클릭',
  fill: '입력',
  select: '선택',
  check: '체크',
  uncheck: '체크 해제',
  press: '키',
  upload: '업로드',
  download: '다운로드',
  scroll: '스크롤',
  checkpoint: '확인',
  unrecorded: '녹화 안 됨',
};

function targetText(t: RecEvent['target']): string {
  const c = t?.chosen as Record<string, unknown> | undefined;
  if (!c) return '';
  if (c.role) return `${String(c.role)} “${String(c.name ?? '')}”`;
  for (const k of ['label', 'placeholder', 'text', 'testId', 'css']) if (c[k] !== undefined) return `${k} “${String(c[k])}”`;
  return '';
}

function describe(e: RecEvent): string {
  switch (e.kind) {
    case 'navigate':
      return `${e.url}${e.nav === 'action' ? ' (동작 결과)' : e.nav === 'start' ? ' (시작)' : ''}`;
    case 'fill':
      return `${targetText(e.target)} ← ${e.sensitive ? `••• 민감 — 값 저장 안 함 (\${secrets.${e.secretHint ?? 'SECRET'}})` : `“${e.value ?? ''}”`}`;
    case 'select':
      return `${targetText(e.target)} ← ${(e.values ?? []).join(', ')}`;
    case 'press':
      return `${e.key ?? ''}${e.target ? ` @ ${targetText(e.target)}` : ''}`;
    case 'upload':
      return `${targetText(e.target)} ← ${(e.files ?? []).join(', ')}`;
    case 'download':
      return e.download?.name ?? '';
    case 'checkpoint':
      return `${CHECKPOINT_LABELS[e.checkpoint?.kind ?? 'visible']}: ${e.checkpoint?.kind === 'url' ? String(e.checkpoint.value ?? '') : targetText(e.target)}`;
    case 'unrecorded':
      return e.reason === 'popup' ? `팝업·새 탭 ${e.url}` : `iframe ${e.url}`;
    case 'click':
      return `${targetText(e.target)}${e.interactive === false ? ' (빈 영역 — 초안에서 제외)' : ''}`;
    default:
      return targetText(e.target);
  }
}

/** The TC a recording demonstrates ("시연으로 변환"), read from its TC document. */
function useTc(projectId: string, ref: { docId: string; tcId: string } | undefined): { tc?: TcDocTc; docName?: string } {
  const [got, setGot] = useState<{ tc?: TcDocTc; docName?: string }>({});
  const key = ref ? `${ref.docId}/${ref.tcId}` : '';
  useEffect(() => {
    if (!ref) return setGot({});
    let alive = true;
    void window.euta.tcDocs.get(projectId, ref.docId).then(
      (d) => alive && setGot({ tc: d.tcs.find((t) => t.id === ref.tcId), docName: d.name }),
      () => alive && setGot({}),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key]);
  return got;
}

/** Start dialog: environment, start path, recording name (and, for "시연으로 변환", the TC). */
export function RecordStartDialog({ project, tc: tcRef, onCancel, onStarted }: { project: ProjectView; tc?: { docId: string; tcId: string }; onCancel: () => void; onStarted: (v: RecordingView) => void }) {
  const [envId, setEnvId] = useState(project.defaultEnvId ?? project.environments[0]?.id ?? '');
  const [startPath, setStartPath] = useState('/');
  const [name, setName] = useState('');
  const { tc } = useTc(project.id, tcRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const env = project.environments.find((e) => e.id === envId);
  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onStarted(await window.euta.recordings.start(project.id, { envId, startPath, name, ...(tcRef ? { tc: tcRef } : {}) }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog label="시연으로 스크립트 만들기" className="rec-start-dialog" data-testid="rec-start">
        <h3>{tcRef ? 'TC 를 시연으로 변환' : '시연으로 스크립트 만들기'}</h3>
        {tcRef && (
          <div className="card tc-rec-target" data-testid="rec-start-tc">
            <FileSpreadsheet className="lead-icon" size={14} aria-hidden="true" /> <b>{tc?.title ?? tcRef.tcId}</b> <span className="muted small">{tcRef.tcId}</span>
            <p className="muted small">녹화 패널에 이 TC 의 단계가 뜹니다. 단계마다 동작을 하고(기대 결과는 [확인] 으로 찍고) [다음 단계] 를 누르세요. 저장하면 TC 단계마다 묶인 스크립트가 됩니다.</p>
          </div>
        )}
        <p className="muted small">
          브라우저가 열리면 사이트를 평소처럼 사용하세요. 패널에 “여기서 로그인”, “합계가 1,200원이어야 함” 같은 메모를 남기고, <b>확인</b> 버튼으로 “이게 보여야 함 / 이 값이어야 함” 을 찍어 두면 AI 가 검증까지 넣어 정리합니다. 비밀번호 입력란의 값은 녹화하지 않습니다.
        </p>
        <div className="form-row">
          <label htmlFor="rec-env">환경</label>
          <select id="rec-env" value={envId} onChange={(e) => setEnvId(e.target.value)} data-testid="rec-start-env">
            {project.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.baseUrl ? ` — ${e.baseUrl}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="rec-path">시작 경로 {env?.baseUrl ? <span className="muted small">({env.baseUrl} 기준)</span> : null}</label>
          <input id="rec-path" value={startPath} onChange={(e) => setStartPath(e.target.value)} placeholder="/login" data-testid="rec-start-path" />
        </div>
        <div className="form-row">
          <label htmlFor="rec-name">녹화 이름</label>
          <input id="rec-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={tc ? `${tc.id} ${tc.title}` : '예: 로그인 후 보고서 내보내기'} data-testid="rec-start-name" />
        </div>
        {error && <div className="error">{error}</div>}
        <DialogActions>
          <Button icon={X} onClick={onCancel}>
            취소
          </Button>
          <Button variant="primary" icon={Video} disabled={busy || !project.environments.length} onClick={() => void start()} data-testid="rec-start-go">
            {busy ? '브라우저 여는 중…' : '녹화 시작'}
          </Button>
        </DialogActions>
    </Dialog>
  );
}

function Row({ e, live, pid, rid, onError }: { e: RecEvent; live: boolean; pid: string; rid: string; onError: (m: string) => void }) {
  const [noting, setNoting] = useState<string | undefined>();
  const [expected, setExpected] = useState<string | undefined>();
  const ctl = (action: 'sensitive' | 'delete' | 'annotate' | 'expected', arg: Record<string, unknown>) => window.euta.recordings.control(pid, rid, action, arg).catch((x) => onError(errText(x)));
  const editableExpected = e.kind === 'checkpoint' && e.checkpoint && ['textEquals', 'textContains', 'count'].includes(e.checkpoint.kind);
  return (
    <li className={`rec-row ${e.kind}${e.sensitive ? ' sensitive' : ''}`} data-testid="rec-row" data-kind={e.kind} data-seq={e.seq}>
      <div className="rec-line">
        <span className="rec-kind">{KIND_LABELS[e.kind] ?? e.kind}</span>
        <span className="rec-desc">{describe(e)}</span>
      </div>
      {editableExpected && (
        <div className="inline small">
          <span className="muted">기대값</span>
          {expected === undefined ? (
            <>
              <code data-testid="rec-row-expected-value">{String(e.checkpoint?.value ?? '')}</code>
              {live && (
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setExpected(String(e.checkpoint?.value ?? ''))} data-testid="rec-row-expected">
                  바꾸기
                </Button>
              )}
            </>
          ) : (
            <>
              <input value={expected} onChange={(x) => setExpected(x.target.value)} data-testid="rec-row-expected-input" />
              <Button
                size="sm"
                icon={Check}
                onClick={() => {
                  void ctl('expected', { seq: e.seq, value: e.checkpoint?.kind === 'count' ? Number(expected) : expected });
                  setExpected(undefined);
                }}
              >
                확인
              </Button>
            </>
          )}
        </div>
      )}
      {e.note && noting === undefined && (
        <div className="rec-note small">
          <StickyNote size={12} aria-hidden="true" /> {e.note}
        </div>
      )}
      {noting !== undefined && (
        <div className="inline small">
          <input
            autoFocus
            value={noting}
            onChange={(x) => setNoting(x.target.value)}
            onKeyDown={(x) => {
              if (x.key === 'Enter' && !x.nativeEvent.isComposing) {
                void ctl('annotate', { seq: e.seq, text: noting });
                setNoting(undefined);
              }
            }}
            data-testid="rec-row-note-input"
          />
        </div>
      )}
      {live && e.kind !== 'unrecorded' && !(e.kind === 'navigate' && e.nav === 'start') && (
        <div className="rec-actions">
          {e.kind === 'fill' && !e.sensitive && (
            <Button size="sm" variant="ghost" icon={EyeOff} onClick={() => void ctl('sensitive', { seq: e.seq })} data-testid="rec-row-sensitive" title="값을 지우고 비밀값으로 바꿉니다">
              민감
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={StickyNote} onClick={() => setNoting(e.note ?? '')} data-testid="rec-row-note">
            메모
          </Button>
          <Button size="sm" variant="ghost" icon={Trash} onClick={() => void ctl('delete', { seq: e.seq })} data-testid="rec-row-delete">
            삭제
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * TC step guide on the recording panel (SPEC TC-문서-변환 "시연으로 변환"): the TC steps with the current
 * one highlighted and its expected result; [다음 단계] closes the step (its actions become one group). A step
 * with an expected result and no checkpoint asks once whether to add one (skippable).
 */
function TcGuide({ project, view, live, onArmCheckpoint, onError }: { project: ProjectView; view: RecordingView; live: boolean; onArmCheckpoint: () => void; onError: (m: string) => void }) {
  const { tc, docName } = useTc(project.id, view.tcRef);
  const [asked, setAsked] = useState<number | undefined>();
  if (!view.tcRef) return null;
  if (!tc) return <div className="tc-guide card muted small">TC 를 불러오는 중… ({view.tcRef.tcId})</div>;
  const marks = view.stepMarks ?? [];
  const lastTo = marks.at(-1)?.toSeq ?? 0;
  const current = tc.steps.find((s) => !marks.some((m) => m.no === s.no));
  const isLast = current && tc.steps[tc.steps.length - 1]?.no === current.no;
  const checked = view.events.some((e) => e.seq > lastTo && e.kind === 'checkpoint');
  const mark = async () => {
    if (!current) return;
    try {
      await window.euta.recordings.control(project.id, view.id, 'markStep', { no: current.no });
      setAsked(undefined);
    } catch (e) {
      onError(errText(e));
    }
  };
  const next = () => {
    if (current?.expected && !checked && asked !== current.no) return setAsked(current.no);
    void mark();
  };
  return (
    <div className="tc-guide card" data-testid="tc-guide" data-current={current?.no ?? 'done'}>
      <div className="small">
        <FileSpreadsheet className="lead-icon" size={14} aria-hidden="true" /> <b>{tc.title}</b> <span className="muted">{tc.id}{docName ? ` · ${docName}` : ''}</span>
      </div>
      <ol className="tc-guide-steps">
        {tc.steps.map((s) => {
          const done = marks.some((m) => m.no === s.no);
          const cur = current?.no === s.no;
          return (
            <li key={s.no} className={done ? 'is-done' : cur ? 'is-current' : ''} data-testid="tc-guide-step" data-no={s.no} data-state={done ? 'done' : cur ? 'current' : 'todo'}>
              <span className="order">{done ? <Check size={12} aria-label="끝냄" /> : s.no}</span>
              <span>
                {s.action}
                {cur && s.expected && (
                  <div className="tc-guide-expected small" data-testid="tc-guide-expected">
                    기대 결과: {s.expected}
                  </div>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {live && current && asked === current.no && (
        <div className="warn small tc-guide-ask" data-testid="tc-guide-ask">
          이 단계에 기대 결과가 있는데 확인(체크포인트)을 걸지 않았습니다. 기대 결과 확인을 걸까요?
          <div className="row-actions">
            <Button
              size="sm"
              variant="primary"
              icon={CircleCheck}
              onClick={() => {
                setAsked(undefined);
                onArmCheckpoint();
              }}
              data-testid="tc-guide-ask-check"
            >
              확인 걸기
            </Button>
            <Button size="sm" icon={SkipForward} onClick={() => void mark()} data-testid="tc-guide-ask-skip" title="사람이 확인할 단계(수동 확인)로 남깁니다">
              건너뛰기
            </Button>
          </div>
        </div>
      )}
      {live && current && asked !== current.no && (
        <Button variant="primary" icon={isLast ? Flag : ArrowRight} onClick={next} data-testid="tc-guide-next" title="지금까지의 동작을 이 TC 단계로 묶습니다">
          {isLast ? '마지막 단계 끝내기' : `다음 단계 (${current.no} 끝)`}
        </Button>
      )}
      {!current && <div className="ok-text small">모든 단계를 마쳤습니다{live ? ' — [종료] 를 누르세요' : ''}.</div>}
    </div>
  );
}

/** Live recording panel (SPEC "녹화 패널"): events, notes, checkpoints, pause, undo, stop → save / AI tidy-up. */
export function RecordingPanel({
  project,
  view,
  onClose,
  onOpenChat,
  onOpenScript,
}: {
  project: ProjectView;
  view: RecordingView;
  onClose: () => void;
  onOpenChat: (chatId: string) => void;
  onOpenScript: (path: string) => void;
}) {
  const pid = project.id;
  const rid = view.id;
  const live = view.status === 'recording' || view.status === 'paused';
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<CheckpointKind>('visible');
  const [error, setError] = useState<string | undefined>();
  const [envId, setEnvId] = useState(view.envId ?? project.defaultEnvId ?? '');
  const [draft, setDraft] = useState<DraftView | undefined>();
  const [saved, setSaved] = useState<DraftView | undefined>();
  const [tidyMsg, setTidyMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const ctl = async (action: 'pause' | 'resume' | 'checkpoint' | 'undo' | 'note' | 'stop', arg?: Record<string, unknown>) => {
    setError(undefined);
    try {
      await window.euta.recordings.control(pid, rid, action, arg);
    } catch (e) {
      setError(errText(e));
    }
  };

  useEffect(() => {
    setSaved(undefined);
    setDraft(undefined);
  }, [rid]);
  useEffect(() => {
    if (view.status === 'stopped') void window.euta.recordings.draft(pid, rid, envId).then(setDraft, (e) => setError(errText(e)));
  }, [view.status, pid, rid, envId]);

  const addNote = () => {
    if (!note.trim()) return;
    void ctl('note', { text: note });
    setNote('');
  };
  const onNoteKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      addNote();
    }
  };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setSaved(await window.euta.recordings.save(pid, rid, envId));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const tidy = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onOpenChat(await window.euta.recordings.tidy(pid, rid, envId, tidyMsg));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  // Notes interleaved after the event they follow.
  const rows: ({ t: 'e'; e: RecEvent } | { t: 'n'; text: string; i: number })[] = [];
  const notesAt = new Map<number, { text: string; i: number }[]>();
  view.notes.forEach((n, i) => notesAt.set(n.afterSeq, [...(notesAt.get(n.afterSeq) ?? []), { text: n.text, i }]));
  for (const n of notesAt.get(0) ?? []) rows.push({ t: 'n', ...n });
  for (const e of view.events) {
    rows.push({ t: 'e', e });
    for (const n of notesAt.get(e.seq) ?? []) rows.push({ t: 'n', ...n });
  }

  return (
    <aside className="rec-panel" data-testid="rec-panel" data-status={view.status} data-recording-id={rid}>
      <div className="inline between">
        <strong className="inline">
          {view.status === 'recording' && <span className="rec-dot" aria-hidden="true" />}
          {view.status === 'paused' && <Pause size={14} aria-hidden="true" />}
          시연 녹화 — {view.name}
        </strong>
        {!live && view.status !== 'stopping' && (
          <Button size="sm" variant="ghost" icon={X} onClick={onClose} data-testid="rec-close">
            닫기
          </Button>
        )}
      </div>
      <div className="muted small ellipsis" title={view.url}>
        {view.status === 'recording' ? '녹화 중' : view.status === 'paused' ? '일시정지' : view.status === 'stopping' ? '저장 중…' : '종료됨'} · {view.url || '—'}
      </div>

      {view.tcRef && <TcGuide project={project} view={view} live={live} onArmCheckpoint={() => void ctl('checkpoint', { kind })} onError={setError} />}

      {live && (
        <>
          <div className="inline rec-controls">
            <select value={kind} onChange={(e) => setKind(e.target.value as CheckpointKind)} data-testid="rec-cp-kind" title="확인 종류">
              {(Object.keys(CHECKPOINT_LABELS) as CheckpointKind[]).map((k) => (
                <option key={k} value={k}>
                  {CHECKPOINT_LABELS[k]}
                </option>
              ))}
            </select>
            {view.checkpoint ? (
              <Button size="sm" icon={X} onClick={() => void ctl('checkpoint', { kind: '' })} data-testid="rec-checkpoint-cancel">
                확인 취소
              </Button>
            ) : (
              <Button variant="primary" size="sm" icon={CircleCheck} onClick={() => void ctl('checkpoint', { kind })} data-testid="rec-checkpoint" title="다음 클릭은 실행되지 않고 검증 대상으로 잡힙니다">
                확인
              </Button>
            )}
            {view.status === 'recording' ? (
              <Button size="sm" icon={Pause} onClick={() => void ctl('pause')} data-testid="rec-pause">
                일시정지
              </Button>
            ) : (
              <Button size="sm" icon={Play} onClick={() => void ctl('resume')} data-testid="rec-resume">
                재개
              </Button>
            )}
            <Button size="sm" icon={Undo2} onClick={() => void ctl('undo')} data-testid="rec-undo">
              마지막 동작 취소
            </Button>
            <Button size="sm" variant="danger" icon={Square} onClick={() => void ctl('stop')} data-testid="rec-stop">
              종료
            </Button>
          </div>
          {view.checkpoint && (
            <div className="warn small" data-testid="rec-checkpoint-armed">
              확인 모드: {CHECKPOINT_LABELS[view.checkpoint]} — 브라우저에서 확인할 요소를 클릭하세요 (클릭은 실행되지 않습니다, Esc 취소)
            </div>
          )}
          <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={onNoteKey} placeholder="메모 (Enter): 예) 여기서 로그인, 합계가 1,200원이어야 함" data-testid="rec-note" className="rec-note-input" />
        </>
      )}

      <ol className="rec-events" data-testid="rec-events">
        {rows.map((r) =>
          r.t === 'e' ? (
            <Row key={`e${r.e.seq}`} e={r.e} live={live} pid={pid} rid={rid} onError={setError} />
          ) : (
            <li key={`n${r.i}`} className="rec-row memo" data-testid="rec-memo">
              <StickyNote size={12} aria-hidden="true" /> {r.text}
            </li>
          ),
        )}
      </ol>
      {view.events.length <= 1 && live && <p className="muted small">브라우저에서 동작하면 여기에 실시간으로 나타납니다.</p>}

      {view.status === 'stopped' && (
        <div className="rec-result card" data-testid="rec-result">
          <div className="inline small">
            <span className="muted">확인 실행 환경</span>
            <select value={envId} onChange={(e) => setEnvId(e.target.value)} data-testid="rec-result-env">
              {project.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          {view.tcRef && <div className="small muted">TC 단계마다 묶은 초안입니다. 확인을 걸지 않은 기대 결과는 “수동 확인” 단계가 됩니다. 저장하면 TC 문서에 변환 완료로 남습니다.</div>}
          {draft && (
            <div className="small">
              초안: 스텝 {draft.yaml.split('\n').filter((l) => /^ {2}- /.test(l)).length}개 · 비밀값 {draft.secrets.join(', ') || '없음'}
              {draft.missingSecrets.length > 0 && (
                <div className="warn" data-testid="rec-missing">
                  등록이 필요한 비밀값: <b>{draft.missingSecrets.join(', ')}</b> — 프로젝트 설정 → 환경 → 비밀값에 추가하세요.
                </div>
              )}
            </div>
          )}
          <div className="inline">
            <Button icon={Save} onClick={() => void save()} disabled={busy || !!saved} data-testid="rec-save">
              AI 없이 저장
            </Button>
            <Button variant="primary" icon={Sparkles} onClick={() => void tidy()} disabled={busy} data-testid="rec-tidy">
              AI로 정리
            </Button>
          </div>
          <textarea rows={2} value={tidyMsg} onChange={(e) => setTidyMsg(e.target.value)} placeholder="AI 에게 덧붙일 말 (선택): 예) 결제 실패 경우도 만들어줘" data-testid="rec-tidy-msg" />
          {saved?.path && (
            <div className="ok-text small" data-testid="rec-saved" data-path={saved.path}>
              <Check className="lead-icon" size={14} aria-hidden="true" /> 라이브러리에 저장: <code>{saved.path}</code>{' '}
              <button className="link small" onClick={() => onOpenScript(saved.path!)}>
                스크립트 탭에서 보기 →
              </button>
            </div>
          )}
        </div>
      )}
      {error && <div className="error small">{error}</div>}
    </aside>
  );
}
