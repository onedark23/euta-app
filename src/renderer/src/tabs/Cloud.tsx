// euta cloud screens (SPEC 클라우드-앱-연동): app settings > 클라우드 (server · device login ·
// logout), the sidebar connection chip, "클라우드 프로젝트 찾기", the conflict screen (3 choices),
// and the members list. The device token and test-credential values never reach this process.
import { useCallback, useEffect, useState } from 'react';
import { Check, Cloud, Copy, Download, KeyRound, LogIn, LogOut, RefreshCw, Save, UserMinus, UserPlus, X } from 'lucide-react';
import type { CloudAccessRequestView, CloudConflictView, CloudMemberView, CloudRole, CloudStatusView, ProjectView } from '../../../shared/types';

const ROLES: CloudRole[] = ['owner', 'editor', 'runner', 'viewer'];
import { errText } from './ScriptsTab';
import { Button, cx, Dialog, Switch } from '../ui';

export const ROLE_LABEL: Record<string, string> = { owner: '소유자', editor: '편집자', runner: '실행자', viewer: '보기' };
const STATE_LABEL: Record<string, string> = { none: '클라우드 미설정', signed_out: '로그인 필요', online: '연결됨', offline: '오프라인 (재시도 중)', login_required: '로그인 필요' };

/** Cloud connection status, kept fresh from main. */
export function useCloudStatus(): CloudStatusView | undefined {
  const [s, setS] = useState<CloudStatusView | undefined>();
  useEffect(() => {
    void window.euta.cloud.status().then(setS);
    return window.euta.cloud.onStatus(setS);
  }, []);
  return s;
}

/** Sidebar chip: 연결됨 · 오프라인(재시도 중) · 로그인 필요. */
export function CloudChip({ status, onClick }: { status?: CloudStatusView; onClick: () => void }) {
  if (!status || status.state === 'none') return null;
  return (
    <button className={cx('nav-item', 'cloud-chip', status.state)} onClick={onClick} data-testid="cloud-chip" data-state={status.state} title={status.lastError ?? status.serverUrl}>
      <Cloud className="nav-icon" size={16} aria-hidden="true" />
      <span className="name">
        {STATE_LABEL[status.state]}
        {status.pending > 0 && ` · 보내기 대기 ${status.pending}`}
      </span>
    </button>
  );
}

/** 앱 설정 > 클라우드. */
export function CloudSettings() {
  const status = useCloudStatus();
  const [url, setUrl] = useState('');
  const [notify, setNotify] = useState<boolean | undefined>();
  useEffect(() => {
    void window.euta.appSettings.get().then((s) => setNotify(s.cloudNotify));
  }, []);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (status && !url) setUrl(status.serverUrl);
  }, [status, url]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    }
  };
  if (!status) return null;
  return (
    <div className="card cloud-settings" data-testid="cloud-settings" data-state={status.state}>
      <h3>클라우드</h3>
      <div className="form-row">
        <label>서버 주소</label>
        <div className="inline">
          <input className="grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://euta.example.com" data-testid="cloud-server-url" />
          {url.trim() && url.trim().replace(/\/+$/, '') !== status.serverUrl && (
            <Button icon={Save} onClick={() => void act(() => window.euta.cloud.setServer(url))} data-testid="cloud-server-save">
              저장
            </Button>
          )}
        </div>
        <span className="muted small">서버를 바꾸면 로그아웃됩니다. 클라우드 프로젝트의 작업 사본은 이 PC 에 남습니다.</span>
      </div>
      <div className="form-row">
        <label>연결 상태</label>
        <span data-testid="cloud-state" data-state={status.state}>
          {STATE_LABEL[status.state]}
          {status.user && (
            <>
              {' '}
              — <b data-testid="cloud-user">{status.user.email}</b> ({status.user.name})
            </>
          )}
          {status.pending > 0 && <span className="warn"> · 보내기 대기 {status.pending}건</span>}
        </span>
        {status.lastError && <span className="warn small">{status.lastError}</span>}
      </div>
      {status.login ? (
        <div className="banner" data-testid="cloud-login-pending">
          브라우저에서 이 코드를 확인하고 승인하세요: <b className="user-code" data-testid="cloud-user-code">{status.login.userCode}</b>
          <div className="muted small">
            승인 화면: <code>{status.login.verificationUri}</code> · 만료 {new Date(status.login.expiresAt).toLocaleTimeString()}
          </div>
          <Button size="sm" icon={X} onClick={() => void act(() => window.euta.cloud.cancelLogin())}>
            취소
          </Button>
        </div>
      ) : (
        <div className="inline">
          {status.serverUrl && (status.state === 'signed_out' || status.state === 'login_required') && (
            <Button variant="primary" icon={LogIn} onClick={() => void act(() => window.euta.cloud.login())} data-testid="cloud-login">
              로그인
            </Button>
          )}
          {status.state === 'offline' && (
            <Button icon={RefreshCw} onClick={() => void act(() => window.euta.cloud.reconnect())} data-testid="cloud-reconnect">
              다시 연결
            </Button>
          )}
          {status.user && (
            <Button
              icon={LogOut}
              onClick={() => {
                if (status.pending > 0 && !window.confirm(`보내기 대기 중인 저장이 ${status.pending}건 있습니다. 로그아웃하면 다시 로그인할 때까지 보내지 않습니다. 로그아웃할까요?`)) return;
                void act(() => window.euta.cloud.logout());
              }}
              data-testid="cloud-logout"
            >
              로그아웃
            </Button>
          )}
        </div>
      )}
      <div className="form-row">
        <Switch
          checked={notify ?? true}
          disabled={notify === undefined}
          onChange={(e) => {
            const v = e.target.checked;
            setNotify(v);
            void act(() => window.euta.appSettings.set({ cloudNotify: v }));
          }}
          data-testid="cloud-notify"
          label="앱 알림 — 앱이 켜져 있는 동안 내가 구성원인 프로젝트의 예약 실행 실패·회복과 내가 요청한 클라우드 실행의 종료를 OS 알림으로 받습니다(클릭하면 그 실행). 앱이 꺼져 있던 동안의 알림은 다음에 켤 때 받습니다."
        />
      </div>
      {error && <div className="error">{error}</div>}
      <p className="muted small">
        로그인은 장치 인가 방식입니다 — 앱이 코드를 받고 시스템 브라우저에서 승인하면 앱이 토큰을 받습니다. 토큰은 OS 보안 저장소로 암호화해 이 PC 에만 둡니다.
      </p>
    </div>
  );
}

/** Conflict screen (SPEC 충돌): my text ↔ the server's latest as step sentences + 3 choices. */
export function ConflictDialog({ view, online, onClose, onResolved }: { view: CloudConflictView; online: boolean; onClose: () => void; onResolved: (p: ProjectView) => void }) {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const choose = async (choice: 'mine' | 'theirs' | 'copy') => {
    setBusy(true);
    setError(undefined);
    try {
      onResolved(await window.euta.cloud.resolve(view.projectId, view.ticket, choice));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const rejected = view.status === 'rejected';
  return (
    <Dialog label={rejected ? '저장 거절' : '충돌'} className="conflict-dialog" data-testid="conflict-dialog" data-path={view.path} data-ticket={view.ticket} data-status={view.status}>
        <h3>{rejected ? '클라우드가 저장을 거절했습니다' : '충돌 — 서버에 더 새로운 버전이 있습니다'}</h3>
        <p>
          <code>{view.path}</code> · 내 저장(출처: {view.origin}){' '}
          {rejected ? (
            <span className="error">{view.error}</span>
          ) : view.server ? (
            <>
              ↔ 서버 최신 <b data-testid="conflict-server-version">버전 {view.server.version}</b>
              {view.server.author ? ` · ${view.server.author}` : ''}
              {view.server.at ? ` · ${new Date(view.server.at).toLocaleString()}` : ''}
            </>
          ) : (
            <span className="warn">↔ 서버에서 삭제됨</span>
          )}
        </p>
        {rejected && view.laterSaves > 0 && (
          <p className="small" data-testid="conflict-later-saves">
            이 스크립트의 뒤 저장이 {view.laterSaves}개 더 있습니다. [이 저장만 버리기] 를 누르면 거절된 이 저장만 빼고 뒤 저장을 보냅니다(내 PC 의 파일은 그대로).
          </p>
        )}
        {!rejected && (
          <>
            <div className="small muted">
              서버 최신 → 내 것: <span data-testid="conflict-summary">{view.summary}</span>
              {view.header.length > 0 && ` · 머리 정보: ${view.header.join(', ')}`}
            </div>
            <div className="diff conflict-diff">
              {view.rows.map((r, i) => (
                <div key={i} className={`diff-row ${r.kind}`} style={{ paddingLeft: 8 + r.depth * 20 }} data-testid="conflict-row" data-kind={r.kind}>
                  {r.kind === 'changed' ? (
                    <>
                      <span className="diff-before">서버 − {r.before}</span>
                      <span className="diff-after">내 것 + {r.after}</span>
                    </>
                  ) : r.kind === 'removed' ? (
                    <span>서버에만 − {r.before}</span>
                  ) : r.kind === 'added' ? (
                    <span>내 것에만 + {r.after}</span>
                  ) : (
                    <span className="muted">  {r.after}</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        {!online && <div className="warn small">오프라인 — 다시 연결되면 고를 수 있습니다.</div>}
        {/* Numbered choices read left to right (① first); "나중에" closes without choosing. */}
        <div className="conflict-choices">
          {rejected ? (
            <>
              <Button variant="primary" icon={RefreshCw} disabled={busy || !online} onClick={() => void choose('mine')} data-testid="conflict-choose-mine">
                다시 보내기
              </Button>
              <Button variant="danger" icon={view.laterSaves > 0 ? X : Download} disabled={busy || !online} onClick={() => void choose('theirs')} data-testid="conflict-choose-theirs">
                {view.laterSaves > 0 ? `이 저장만 버리기 (뒤 저장 ${view.laterSaves}개 보내기)` : '내 저장 버리기 (서버 것 받기)'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" icon={Check} disabled={busy || !online} onClick={() => void choose('mine')} data-testid="conflict-choose-mine">
                ① 내 것으로 새 버전
              </Button>
              <Button variant="danger" icon={Download} disabled={busy || !online} onClick={() => void choose('theirs')} data-testid="conflict-choose-theirs">
                ② 서버 것 받기 (내 변경 버림)
              </Button>
              <Button icon={Copy} disabled={busy || !online} onClick={() => void choose('copy')} data-testid="conflict-choose-copy">
                ③ 내 것을 사본으로 <code>{view.copyPath}</code>
              </Button>
            </>
          )}
          <Button variant="ghost" icon={X} onClick={onClose} data-testid="conflict-later">
            나중에
          </Button>
        </div>
        <p className="muted small">해결할 때까지 이 프로젝트의 다른 보내기 대기분도 멈춰 있습니다(순서 유지).</p>
        {error && <div className="error">{error}</div>}
    </Dialog>
  );
}

/** Project settings > 구성원 (cloud). */
export function CloudMembers({ project, canManage, online }: { project: ProjectView; canManage: boolean; online: boolean }) {
  const [members, setMembers] = useState<CloudMemberView[] | undefined>();
  const [suggest, setSuggest] = useState<{ id: string; email: string; name: string }[]>([]);
  const [email, setEmail] = useState('');
  // Organization user search (`GET /api/users?q=`) as the person types; null = old server (no search).
  useEffect(() => {
    if (!canManage || !online || !email.trim()) return;
    let alive = true;
    const t = setTimeout(() => {
      void window.euta.cloud
        .searchUsers(email.trim())
        .then((l) => alive && setSuggest(l ?? []))
        .catch(() => undefined);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [email, canManage, online]);
  const [role, setRole] = useState<CloudRole>('editor');
  const [requests, setRequests] = useState<CloudAccessRequestView[]>([]);
  const [grant, setGrant] = useState<Record<string, CloudRole>>({});
  const [error, setError] = useState<string | undefined>();
  const load = useCallback(async () => {
    try {
      setMembers(await window.euta.cloud.members(project.id));
      if (canManage) setRequests(await window.euta.cloud.accessRequests(project.id));
      setError(undefined);
    } catch (e) {
      setError(errText(e));
    }
  }, [project.id, canManage]);
  useEffect(() => {
    if (online) void load();
  }, [online, load]);
  // 권한 요청이 왔다 / 역할이 바뀌었다 (cloud notice) → read the members and requests again.
  useEffect(() => window.euta.cloud.onNotice((n) => n.projectId === project.id && n.kind === 'access' && online && void load()), [project.id, online, load]);
  const decide = async (id: string, approve: boolean, r?: CloudRole) => {
    setError(undefined);
    try {
      setRequests(await window.euta.cloud.decideAccess(project.id, id, approve, r));
      setMembers(await window.euta.cloud.members(project.id));
    } catch (e) {
      setError(errText(e));
    }
  };
  const act = async (fn: () => Promise<CloudMemberView[]>) => {
    setError(undefined);
    try {
      setMembers(await fn());
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  };
  return (
    <div className="cloud-members" data-testid="cloud-members">
      {!online && <p className="muted small">오프라인 — 구성원은 다시 연결된 뒤에 볼 수 있습니다.</p>}
      <ul className="secret-list">
        {(members ?? []).map((m) => (
          <li key={m.userId} data-testid="member-item" data-email={m.email} data-role={m.role}>
            <b>{m.name}</b> <span className="muted">{m.email}</span> <span className="tag sub">{ROLE_LABEL[m.role]}</span>
            {!m.active && <span className="warn small"> (비활성)</span>}
            {canManage && online && (
              <>
                {' '}
                <select value={m.role} aria-label={`${m.name} 의 역할`} onChange={(e) => void act(() => window.euta.cloud.setMember(project.id, m.email, e.target.value as CloudRole))} data-testid="member-role-change">
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>{' '}
                <Button size="sm" variant="danger" icon={UserMinus} onClick={() => window.confirm(`${m.name} 을(를) 내보낼까요?`) && void act(() => window.euta.cloud.removeMember(project.id, m.userId))}>
                  내보내기
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {canManage && online && (
        <div className="inline">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="초대할 구성원 이름·이메일 (검색)" data-testid="member-email" list={`member-suggest-${project.id}`} />
          <datalist id={`member-suggest-${project.id}`} data-testid="member-suggest">
            {suggest.map((u) => (
              <option key={u.id} value={u.email}>
                {u.name}
              </option>
            ))}
          </datalist>
          <select value={role} onChange={(e) => setRole(e.target.value as CloudRole)} data-testid="member-role">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <Button icon={UserPlus} disabled={!email.trim()} onClick={() => void act(() => window.euta.cloud.setMember(project.id, email, role)).then((ok) => ok && setEmail(''))} data-testid="member-invite">
            초대
          </Button>
        </div>
      )}
      {canManage && online && requests.length > 0 && (
        <div className="card" data-testid="access-requests">
          <b className="inline">
            <KeyRound size={16} aria-hidden="true" /> 권한 요청 {requests.length}건
          </b>
          <ul className="secret-list">
            {requests.map((r) => (
              <li key={r.id} data-testid="access-request-item" data-email={r.user.email}>
                <b>{r.user.name}</b> <span className="muted small">{r.user.email}</span> — <span className="tag sub">{ROLE_LABEL[r.role]}</span> 요청
                {r.memo && <span className="muted"> · “{r.memo}”</span>} <span className="muted small">{new Date(r.createdAt).toLocaleString()}</span>{' '}
                <select value={grant[r.id] ?? r.role} aria-label="승인할 역할" onChange={(e) => setGrant({ ...grant, [r.id]: e.target.value as CloudRole })} data-testid="access-grant-role">
                  {ROLES.map((x) => (
                    <option key={x} value={x}>
                      {ROLE_LABEL[x]}로 승인
                    </option>
                  ))}
                </select>{' '}
                <Button size="sm" variant="primary" icon={Check} onClick={() => void decide(r.id, true, grant[r.id] ?? r.role)} data-testid="access-approve" title="이 역할로 구성원에 넣습니다">
                  승인
                </Button>{' '}
                <Button size="sm" variant="danger" icon={X} onClick={() => void decide(r.id, false)} data-testid="access-reject">
                  거절
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted small">조직 공개 프로젝트에서 초대받지 않은 구성원은 "보기" 역할입니다(실행·편집 불가). 실행자는 실행만, 편집자는 편집과 실행을 합니다. 구성원 관리는 소유자만 합니다.</p>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
