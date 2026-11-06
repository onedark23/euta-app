// Stage 15 "한 프로젝트 + 권한" screens (SPEC 클라우드-앱-연동 "프로젝트 종류" · "올리기 — 전환" · "합치기"):
// [클라우드에서 받기] list, [권한 요청] dialog, the role badges (보기 전용 · 실행 전용), the "접근 권한 없음"
// lock, the conversion confirmation and the merge (fixed target) dialog.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Cloud, CloudUpload, Combine, Copy, Download, FolderOpen, KeyRound, Lock, RefreshCw, Search, Settings, Trash, X } from 'lucide-react';
import type { CloudConvertPreview, CloudConvertResult, CloudMergeChoice, CloudMergeChoices, CloudMergePlan, CloudProjectItem, CloudReceiveList, CloudStatusView, ProjectView } from '../../../shared/types';
import { errText } from './ScriptsTab';
import { Badge, Button, Dialog, DialogActions, EmptyState, PageHeader, runTone, statusLabel } from '../ui';

export const ROLE_NAME: Record<string, string> = { owner: '소유자', editor: '편집자', runner: '실행자', viewer: '보기' };
const ORIGIN_NAME: Record<string, string> = { web: '웹에서 만듦', app: '앱에서 올림', unknown: '예전 프로젝트' };

// ---- [권한 요청] ------------------------------------------------------------------------------

export function AccessRequestDialog({ project, name, onClose, onSent }: { project: string; name: string; onClose: () => void; onSent: (r: { role: 'editor' | 'runner'; createdAt: string }) => void }) {
  const [role, setRole] = useState<'editor' | 'runner'>('runner');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onSent(await window.euta.cloud.requestAccess(project, role, memo));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog label="권한 요청" className="access-dialog" data-testid="access-dialog">
      <h3>권한 요청 — {name}</h3>
      <p className="muted small">소유자에게 알림이 갑니다. 소유자가 승인하면 다음 동기화 때 화면이 바뀝니다. 요청은 30일 뒤 만료됩니다.</p>
      <div className="form-row">
        <label>원하는 역할</label>
        <div className="inline choice-buttons" role="radiogroup" aria-label="원하는 역할">
          <Button icon={role === 'runner' ? Check : undefined} active={role === 'runner'} aria-pressed={role === 'runner'} onClick={() => setRole('runner')} data-testid="access-role-runner" title="실행 · 테스트 세트 실행 · 로컬 실행 올리기 (편집은 못 함)">
            실행자 — 실행만
          </Button>
          <Button icon={role === 'editor' ? Check : undefined} active={role === 'editor'} aria-pressed={role === 'editor'} onClick={() => setRole('editor')} data-testid="access-role-editor" title="스크립트 · 테스트 세트 · 환경 · 예약 편집과 실행">
            편집자 — 편집과 실행
          </Button>
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="access-memo">메모 (선택, 200자)</label>
        <textarea id="access-memo" rows={3} maxLength={200} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="예: 배포 전 회귀 테스트를 돌려야 합니다" data-testid="access-memo" style={{ fontFamily: 'inherit' }} />
        <span className="muted small">{memo.length}/200</span>
      </div>
      {error && <div className="error">{error}</div>}
      <DialogActions>
        <Button icon={X} onClick={onClose}>
          취소
        </Button>
        <Button variant="primary" icon={KeyRound} disabled={busy} onClick={() => void send()} data-testid="access-send">
          {busy ? '보내는 중…' : '요청 보내기'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---- [클라우드에서 받기] ----------------------------------------------------------------------------

function ReceiveRow({ p, busy, onReceive, onRequest }: { p: CloudProjectItem; busy?: string; onReceive: (p: CloudProjectItem) => void; onRequest: (p: CloudProjectItem) => void }) {
  return (
    <tr data-testid="cloud-project-row" data-name={p.name} data-role={p.role}>
      <td>
        <b className="inline">
          <Cloud size={16} aria-hidden="true" /> {p.name}
        </b>
        {p.description && <div className="muted small">{p.description}</div>}
      </td>
      <td className="small">{p.createdBy ?? <span className="muted">—</span>}</td>
      <td className="small">{p.origin ? ORIGIN_NAME[p.origin] : <span className="muted">—</span>}</td>
      <td>
        <Badge tone="neutral">{ROLE_NAME[p.role] ?? p.role}</Badge>
      </td>
      <td className="small">
        {p.lastRun ? (
          <>
            <Badge tone={runTone(p.lastRun.status, p.lastRun.flaky)}>{statusLabel(p.lastRun.flaky && p.lastRun.status === 'passed' ? 'flaky' : p.lastRun.status)}</Badge> <span className="muted">{new Date(p.lastRun.at).toLocaleString()}</span>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <div className="row-actions">
          <Button
            size="sm"
            variant={p.localId ? 'secondary' : 'primary'}
            icon={p.localId ? FolderOpen : Download}
            disabled={!!busy}
            onClick={() => onReceive(p)}
            data-testid="cloud-project-open"
            data-action={p.localId ? 'open' : 'receive'}
            title={p.localId ? '이미 이 PC 에 받은 프로젝트 — 사이드바에서 엽니다' : '이 PC 에 작업 사본을 만들고 사이드바에 추가합니다'}
          >
            {busy === p.id ? '받는 중…' : p.localId ? '열기' : '받기'}
          </Button>
          {p.openRequest ? (
            <Badge tone="run" data-testid="access-pending" title={`${ROLE_NAME[p.openRequest.role]} 요청 — ${new Date(p.openRequest.createdAt).toLocaleString()}`}>
              요청 중 ({ROLE_NAME[p.openRequest.role]})
            </Badge>
          ) : (
            p.canRequestAccess && (
              <Button size="sm" icon={KeyRound} onClick={() => onRequest(p)} data-testid="access-request" title="편집자 또는 실행자 역할을 소유자에게 요청합니다">
                권한 요청
              </Button>
            )
          )}
        </div>
      </td>
    </tr>
  );
}

function ReceiveTable({ title, hint, items, busy, onReceive, onRequest, testId }: { title: string; hint: string; items: CloudProjectItem[]; busy?: string; onReceive: (p: CloudProjectItem) => void; onRequest: (p: CloudProjectItem) => void; testId: string }) {
  return (
    <>
      <h3>
        {title} <span className="muted small">{items.length}개</span>
      </h3>
      <p className="muted small">{hint}</p>
      <div className="table-card">
        <table className="history-table" data-testid={testId}>
          <thead>
            <tr>
              <th>이름</th>
              <th>만든 사람</th>
              <th>출처</th>
              <th>내 역할</th>
              <th>최근 실행</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <ReceiveRow key={p.id} p={p} busy={busy} onReceive={onReceive} onRequest={onRequest} />
            ))}
          </tbody>
        </table>
        {items.length === 0 && <EmptyState icon={Cloud} title="프로젝트가 없습니다." />}
      </div>
    </>
  );
}

/** [클라우드에서 받기] (SPEC 프로젝트 종류): 내 프로젝트 / 조직 공개 → [받기] · [열기] · [권한 요청]. */
export function CloudReceive({ status, onOpen, onSettings }: { status?: CloudStatusView; onOpen: (localId: string) => void; onSettings: () => void }) {
  const [list, setList] = useState<CloudReceiveList | undefined>();
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [asking, setAsking] = useState<CloudProjectItem | undefined>();
  const online = status?.state === 'online';
  const load = useCallback(async () => {
    setError(undefined);
    try {
      setList(await window.euta.cloud.projects());
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  useEffect(() => {
    if (online) void load();
  }, [online, load]);
  const filter = (items: CloudProjectItem[]) => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((p) => p.name.toLowerCase().includes(s) || (p.createdBy ?? '').toLowerCase().includes(s)) : items;
  };
  const receive = async (p: CloudProjectItem) => {
    setBusy(p.id);
    setError(undefined);
    try {
      onOpen(p.localId ?? (await window.euta.cloud.openRemote(p.id)));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="cloud-find" data-testid="cloud-find-page">
      <PageHeader
        title="클라우드에서 받기"
        actions={
          online && (
            <Button variant="ghost" icon={RefreshCw} onClick={() => void load()} data-testid="cloud-receive-refresh">
              새로고침
            </Button>
          )
        }
      />
      {!online ? (
        <p className="warn inline">
          클라우드에 연결되어 있지 않습니다.{' '}
          <Button size="sm" icon={Settings} onClick={onSettings}>
            앱 설정 → 클라우드
          </Button>
        </p>
      ) : (
        <>
          <div className="inline">
            <Search size={16} aria-hidden="true" />
            <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름이나 만든 사람으로 찾기" data-testid="cloud-receive-search" />
          </div>
          <p className="muted small">[받기]를 누르면 이 PC 에 작업 사본이 생기고 사이드바에 추가됩니다. 이미 받은 프로젝트는 [열기]입니다(두 번 받지 않습니다). 웹에서 만든 프로젝트도 받아서 씁니다.</p>
          {list && (
            <>
              <ReceiveTable title="내 프로젝트" hint="내가 구성원인 프로젝트 (소유자 · 편집자 · 실행자)." items={filter(list.mine)} busy={busy} onReceive={(p) => void receive(p)} onRequest={setAsking} testId="cloud-projects-mine" />
              <ReceiveTable title="조직 공개" hint="조직 구성원 누구나 볼 수 있는 프로젝트 — 내 역할은 보기입니다. 실행·편집하려면 [권한 요청]." items={filter(list.org)} busy={busy} onReceive={(p) => void receive(p)} onRequest={setAsking} testId="cloud-projects-org" />
            </>
          )}
        </>
      )}
      {error && <div className="error">{error}</div>}
      {asking && (
        <AccessRequestDialog
          project={asking.id}
          name={asking.name}
          onClose={() => setAsking(undefined)}
          onSent={() => {
            setAsking(undefined);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ---- role badges in the project header ---------------------------------------------------------------

/** 보기 전용 / 실행 전용 (+ [권한 요청] / 요청 중) / 접근 권한 없음 — decided by `can` (API_CONTRACT §0). */
export function RoleBadges({ project, onChanged }: { project: ProjectView; onChanged: (p: ProjectView) => void }) {
  const cv = project.cloudView;
  const [open, setOpen] = useState<{ role: 'editor' | 'runner'; createdAt: string } | null | undefined>();
  const [asking, setAsking] = useState(false);
  const askable = !!cv && cv.readOnly && cv.canRequestAccess && cv.online;
  useEffect(() => {
    if (!askable) return setOpen(undefined);
    let alive = true;
    void window.euta.cloud.myAccessRequest(project.id).then((r) => alive && setOpen(r));
    return () => {
      alive = false;
    };
  }, [askable, project.id, cv?.role]);
  if (!cv) return null;
  if (cv.accessLost)
    return (
      <Badge tone="bad" data-testid="access-lost-badge" title="이 클라우드 프로젝트를 더 볼 수 없습니다 — 이 PC 의 실행 기록만 남아 있습니다">
        <Lock size={12} aria-hidden="true" /> 접근 권한 없음
      </Badge>
    );
  if (!cv.readOnly) return null;
  return (
    <>
      {cv.canRun ? (
        <Badge tone="neutral" data-testid="runonly-badge" data-role={cv.role} title="내 역할이 실행자 — 실행만 할 수 있습니다(스크립트·테스트 계정·설정 편집은 숨김)">
          실행 전용
        </Badge>
      ) : (
        <Badge tone="neutral" data-testid="readonly-badge" data-role={cv.role} title="내 역할이 보기 — 편집·실행 버튼을 숨깁니다">
          보기 전용
        </Badge>
      )}
      {askable &&
        (open ? (
          <Badge tone="run" data-testid="access-pending" title={new Date(open.createdAt).toLocaleString()}>
            권한 요청 중 ({ROLE_NAME[open.role]})
          </Badge>
        ) : (
          <Button size="sm" icon={KeyRound} onClick={() => setAsking(true)} data-testid="access-request" title="편집자 또는 실행자 역할을 소유자에게 요청합니다">
            권한 요청
          </Button>
        ))}
      {cv.online && (
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void window.euta.cloud.refreshAccess(project.id).then(onChanged)} data-testid="access-refresh" title="내 역할을 서버에서 다시 읽습니다">
          역할 새로고침
        </Button>
      )}
      {asking && (
        <AccessRequestDialog
          project={project.id}
          name={project.name}
          onClose={() => setAsking(false)}
          onSent={(r) => {
            setAsking(false);
            setOpen(r);
          }}
        />
      )}
    </>
  );
}

// ---- "접근 권한 없음" lock --------------------------------------------------------------------------

export function AccessLostPanel({ project, onChanged, onDeleted, children }: { project: ProjectView; onChanged: (p: ProjectView) => void; onDeleted: () => void; children: ReactNode }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const at = project.cloudView?.accessLost?.at;
  return (
    <>
      <div className="card danger-box" data-testid="access-lost" style={{ margin: 'var(--sp-3) var(--sp-6) 0' }}>
        <h3 className="inline">
          <Lock size={18} aria-hidden="true" /> 접근 권한 없음
        </h3>
        <p>
          이 클라우드 프로젝트를 더 볼 수 없습니다 — 구성원에서 내보내졌거나, 공개 범위가 "구성원만"으로 바뀌었거나, 삭제되었습니다{at ? ` (${new Date(at).toLocaleString()})` : ''}. 서버 내용은 더 받지 않습니다.
        </p>
        <p className="muted small">이 PC 에서 실행한 기록·리포트만 [실행 이력]·[실시간]에서 볼 수 있습니다. 다시 초대받으면 잠금이 풀립니다.</p>
        <div className="inline">
          <Button
            icon={RefreshCw}
            onClick={async () => {
              setError(undefined);
              try {
                onChanged(await window.euta.cloud.refreshAccess(project.id));
              } catch (e) {
                setError(errText(e));
              }
            }}
            data-testid="access-recheck"
            title="서버에 다시 물어봅니다 — 다시 초대받았으면 잠금이 풀립니다"
          >
            다시 확인
          </Button>
          {!confirm ? (
            <Button variant="danger" icon={Trash} onClick={() => setConfirm(true)} data-testid="access-lost-delete" title="이 PC 의 작업 사본(실행 기록·대화·녹화·이 PC 테스트 계정 값)을 지웁니다">
              이 PC 에서 지우기
            </Button>
          ) : (
            <>
              <span className="warn small">이 PC 의 실행 기록·대화·녹화·이 PC 테스트 계정 값을 영구 삭제합니다.</span>
              <Button
                variant="danger"
                icon={Trash}
                onClick={async () => {
                  setError(undefined);
                  try {
                    await window.euta.projects.delete(project.id);
                    onDeleted();
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
                data-testid="access-lost-delete-confirm"
              >
                지우기
              </Button>
              <Button icon={X} onClick={() => setConfirm(false)}>
                취소
              </Button>
            </>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      <div className="project-body">
        <main className="content">{children}</main>
      </div>
    </>
  );
}

// ---- 올리기 = 전환: confirmation ------------------------------------------------------------------

export function ConvertDialog({ project, onClose, onDone }: { project: ProjectView; onClose: () => void; onDone: (r: CloudConvertResult) => void }) {
  const [pre, setPre] = useState<CloudConvertPreview | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    void window.euta.cloud.convertPreview(project.id).then(setPre, (e) => setError(errText(e)));
  }, [project.id]);
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await window.euta.cloud.upload(project.id));
    } catch (e) {
      setError(`${errText(e)} — 로컬 프로젝트는 그대로입니다. 다시 누르면 서버에 만든 프로젝트를 이어서 씁니다.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog label="클라우드로 올리기" className="convert-dialog" data-testid="convert-dialog">
      <h3>“{project.name}” 을 클라우드 프로젝트로 올립니다</h3>
      <p className="muted small">올리면 이 프로젝트가 그대로 클라우드 프로젝트(구름 표시)가 됩니다 — 사이드바에는 이 프로젝트 하나만 남습니다. 내가 소유자가 되고 조직에 공개(보기)됩니다.</p>
      {pre ? (
        <div className="grid2 convert-summary">
          <div className="card">
            <b className="inline">
              <CloudUpload size={16} aria-hidden="true" /> 서버로 올라가는 것
            </b>
            <ul className="small" data-testid="convert-to-server">
              <li>설정 · 환경 {pre.environments.length}개{pre.environments.length ? ` (${pre.environments.join(', ')})` : ''}</li>
              <li>스크립트 {pre.scripts}개 (현재 내용)</li>
              <li>테스트 세트 {pre.suites}개</li>
              <li>테스트 계정은 이름만{pre.credentialNames.length ? ` (${pre.credentialNames.join(', ')})` : ''} — 값은 올리지 않습니다</li>
              {pre.skippedEnvs.length > 0 && <li className="warn">주소가 없어 올리지 않는 환경: {pre.skippedEnvs.join(', ')}</li>}
            </ul>
          </div>
          <div className="card">
            <b className="inline">
              <FolderOpen size={16} aria-hidden="true" /> 이 PC 에 그대로 옮겨지는 것
            </b>
            <ul className="small" data-testid="convert-moved">
              <li>실행 기록 {pre.runs}건 · 테스트 세트 실행 {pre.suiteRuns}건 · 리포트 · 시각 비교 기준</li>
              <li>AI 대화 {pre.chats}개 · 시연 녹화 {pre.recordings}개 · 작업 로그</li>
              <li>이 PC 테스트 계정 값 (이 PC 실행용 — 서버로 가지 않음)</li>
            </ul>
          </div>
        </div>
      ) : (
        !error && <p className="muted">확인하는 중…</p>
      )}
      {error && <div className="error">{error}</div>}
      <DialogActions>
        <Button icon={X} onClick={onClose} disabled={busy}>
          취소
        </Button>
        <Button variant="primary" icon={CloudUpload} disabled={busy || !pre} onClick={() => void go()} data-testid="upload-confirm">
          {busy ? '올리는 중…' : '클라우드로 올리기'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---- 합치기 (fixed target) -------------------------------------------------------------------------

/** Above a local project that was uploaded the old way (`uploadedTo`): [클라우드 프로젝트와 합치기] or why not. */
export function MergeBanner({ project, online, onMerged }: { project: ProjectView; online: boolean; onMerged: (localId: string) => void }) {
  const [st, setSt] = useState<{ ok: boolean; message?: string; targetName?: string } | undefined>();
  const [dialog, setDialog] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.euta.cloud.mergeStatus(project.id).then(
      (r) => alive && setSt(r),
      (e) => alive && setSt({ ok: false, message: errText(e) }),
    );
    return () => {
      alive = false;
    };
  }, [project.id, online]);
  const up = project.uploadedTo!;
  return (
    <div className="banner" data-testid="uploaded-banner" data-merge={st?.ok ? 'ok' : 'no'}>
      <Cloud size={16} aria-hidden="true" /> 예전에 클라우드로 올린 프로젝트 — 클라우드 프로젝트 “{st?.targetName ?? up.name}” 과 따로 있습니다.{' '}
      {st?.ok ? (
        <Button size="sm" icon={Combine} onClick={() => setDialog(true)} data-testid="merge-open" title="이 로컬 프로젝트를 그 클라우드 프로젝트 하나로 합칩니다 (대상은 바꿀 수 없음)">
          클라우드 프로젝트와 합치기
        </Button>
      ) : (
        st?.message && (
          <span className="muted small" data-testid="merge-refused">
            {st.message}
          </span>
        )
      )}
      {dialog && (
        <MergeDialog
          project={project}
          onClose={() => setDialog(false)}
          onDone={(id) => {
            setDialog(false);
            onMerged(id);
          }}
        />
      )}
    </div>
  );
}

function ChoiceButtons<T extends string>({ value, options, onPick, testId }: { value?: T; options: { key: T; label: string; title: string }[]; onPick: (v: T) => void; testId: string }) {
  return (
    <div className="inline choice-buttons" role="radiogroup">
      {options.map((o) => (
        <Button key={o.key} size="sm" active={value === o.key} icon={value === o.key ? Check : o.key === 'both' ? Copy : undefined} aria-pressed={value === o.key} onClick={() => onPick(o.key)} data-testid={`${testId}-${o.key}`} title={o.title}>
          {o.label}
        </Button>
      ))}
    </div>
  );
}

export function MergeDialog({ project, onClose, onDone }: { project: ProjectView; onClose: () => void; onDone: (localId: string) => void }) {
  const [plan, setPlan] = useState<CloudMergePlan | undefined>();
  const [choices, setChoices] = useState<CloudMergeChoices>({ scripts: {}, suites: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    void window.euta.cloud.mergePlan(project.id).then(setPlan, (e) => setError(errText(e)));
  }, [project.id]);
  const missing = useMemo(() => (plan ? plan.differ.filter((d) => !choices.scripts[d.path]).length + plan.suiteChoices.filter((s) => !choices.suites[s.name]).length : 0), [plan, choices]);
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onDone((await window.euta.cloud.mergeApply(project.id, choices)).localId);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const nothingToPick = plan && plan.differ.length === 0 && plan.suiteChoices.length === 0;
  return (
    <Dialog label="클라우드 프로젝트와 합치기" className="merge-dialog" data-testid="merge-dialog">
      <h3>“{project.name}” 을 클라우드 프로젝트 “{plan?.target.name ?? project.uploadedTo?.name}” 과 합칩니다</h3>
      <p className="muted small">대상은 이 프로젝트를 올렸던 클라우드 프로젝트 하나로 정해져 있습니다. 합치면 이 로컬 항목은 사라지고 클라우드 프로젝트 하나만 남습니다.</p>
      {!plan ? (
        !error && <p className="muted">비교하는 중…</p>
      ) : (
        <>
          <ul className="small" data-testid="merge-summary">
            <li>
              서버로 올릴 스크립트 <b>{plan.uploadScripts.length}</b>개{plan.uploadScripts.length ? ` (${plan.uploadScripts.join(', ')})` : ''} · 양쪽이 같은 스크립트 {plan.sameScripts.length}개 · 서버에만 있는 스크립트 {plan.serverOnlyScripts.length}개(그대로)
            </li>
            <li>
              고를 것 <b data-testid="merge-pick-count">{plan.differ.length + plan.suiteChoices.length}</b>개 · 올릴 테스트 세트 {plan.uploadSuites.length}개 · 올릴 환경 {plan.uploadEnvs.length}개
            </li>
            <li>
              이 PC 에서 옮길 실행 기록 <b>{plan.runs}</b>건 (대화·녹화·작업 로그·기준 이미지도 함께)
            </li>
          </ul>
          {nothingToPick && (
            <p className="ok-text" data-testid="merge-identical">
              <Check size={14} aria-hidden="true" /> 스크립트와 테스트 세트 내용이 서로 같아 고를 것이 없습니다.
            </p>
          )}
          {plan.differ.map((d) => (
            <div key={d.path} className="card merge-item" data-testid="merge-script" data-path={d.path}>
              <div className="inline">
                <b>{d.name ?? d.path}</b> {d.name && <code className="small muted">{d.path}</code>} <span className="muted small">양쪽이 다름 — 서버 → 로컬: {d.summary}</span>
              </div>
              <div className="diff conflict-diff">
                {d.rows.map((r, i) => (
                  <div key={i} className={`diff-row ${r.kind}`} style={{ paddingLeft: 8 + r.depth * 20 }}>
                    {r.kind === 'changed' ? (
                      <>
                        <span className="diff-before">서버 − {r.before}</span>
                        <span className="diff-after">로컬 + {r.after}</span>
                      </>
                    ) : r.kind === 'removed' ? (
                      <span>서버에만 − {r.before}</span>
                    ) : r.kind === 'added' ? (
                      <span>로컬에만 + {r.after}</span>
                    ) : (
                      <span className="muted">  {r.after}</span>
                    )}
                  </div>
                ))}
              </div>
              <ChoiceButtons<CloudMergeChoice>
                value={choices.scripts[d.path]}
                testId="merge-choice"
                onPick={(v) => setChoices((c) => ({ ...c, scripts: { ...c.scripts, [d.path]: v } }))}
                options={[
                  { key: 'local', label: '로컬 것', title: '로컬 내용을 서버의 새 버전으로 올립니다' },
                  { key: 'server', label: '서버 것', title: '서버 내용을 그대로 둡니다 (로컬 변경은 버림)' },
                  { key: 'both', label: `둘 다 (로컬 것을 ${d.copyPath})`, title: '서버 것은 그대로, 로컬 것은 다른 이름으로 올립니다' },
                ]}
              />
            </div>
          ))}
          {plan.suiteChoices.map((s) => (
            <div key={s.name} className="card merge-item" data-testid="merge-suite" data-name={s.name}>
              <div>
                테스트 세트 <b>{s.name}</b> <span className="muted small">— 로컬: {s.local.join(' → ') || '(비어 있음)'} / 서버: {s.server.join(' → ') || '(비어 있음)'}</span>
              </div>
              <ChoiceButtons<'local' | 'server'>
                value={choices.suites[s.name]}
                testId="merge-suite-choice"
                onPick={(v) => setChoices((c) => ({ ...c, suites: { ...c.suites, [s.name]: v } }))}
                options={[
                  { key: 'local', label: '로컬 것', title: '로컬 스크립트 목록으로 서버 테스트 세트를 바꿉니다' },
                  { key: 'server', label: '서버 것', title: '서버 테스트 세트를 그대로 둡니다' },
                ]}
              />
            </div>
          ))}
        </>
      )}
      {error && <div className="error" data-testid="merge-error">{error}</div>}
      <DialogActions>
        <Button icon={X} onClick={onClose} disabled={busy}>
          취소
        </Button>
        <Button variant="primary" icon={Combine} disabled={busy || !plan || missing > 0} onClick={() => void go()} data-testid="merge-confirm" title={missing ? `아직 고르지 않은 것 ${missing}개` : '합치기'}>
          {busy ? '합치는 중…' : missing ? `합치기 (고를 것 ${missing}개 남음)` : '합치기'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
