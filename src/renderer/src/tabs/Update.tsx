// App updates (SPEC 앱-배포-업데이트): the header notice ("새 버전 x.y.z 준비됨 — [다시 시작해서 업데이트]" /
// "새 버전 x.y.z — [내려받기]") with [바뀐 것], the "진행 중인 작업이 끊깁니다" confirmation, 앱 설정 › 업데이트,
// and the [업데이트] action the cloud "업데이트 필요" lock uses.
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Download, FileText, Hourglass, RefreshCw, RotateCw, X } from 'lucide-react';
import type { BusyWork, UpdateView } from '../../../shared/types';
import { errText } from './ScriptsTab';
import { Button, Dialog, DialogActions } from '../ui';

/** Update state, kept fresh from main. */
export function useUpdate(): UpdateView | undefined {
  const [v, setV] = useState<UpdateView | undefined>();
  useEffect(() => {
    void window.euta.update.state().then(setV);
    return window.euta.update.onChange(setV);
  }, []);
  return v;
}

const busyLines = (b: BusyWork): string[] => [
  ...(b.runs ? [`이 PC 실행 ${b.runs}개`] : []),
  ...(b.recording ? ['시연 녹화'] : []),
  ...(b.chats ? [`AI 대화 ${b.chats}개`] : []),
];

/**
 * The update actions shared by the header notice, 앱 설정 and the cloud lock: restart (asking first when this PC
 * is busy), installer download, release notes. Renders its own dialogs.
 */
export function useUpdateActions(): {
  restart: () => Promise<void>;
  download: () => Promise<void>;
  showNotes: () => void;
  /** [업데이트] (cloud lock): whatever the current state allows — restart, download, or check now. */
  updateNow: () => Promise<void>;
  error: string | undefined;
  dialogs: ReactElement;
} {
  const [busy, setBusy] = useState<BusyWork | undefined>();
  const [notes, setNotes] = useState<UpdateView['available'] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const guard = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    }
  };
  const restart = useCallback(
    () =>
      guard(async () => {
        const r = await window.euta.update.restart(false);
        if (!r.restarting) setBusy(r.busy);
      }),
    [],
  );
  const download = useCallback(() => guard(() => window.euta.update.download()), []);
  const showNotes = useCallback(() => void window.euta.update.state().then((v) => setNotes(v.available)), []);
  const updateNow = useCallback(
    () =>
      guard(async () => {
        let v = await window.euta.update.state();
        if (!v.available) v = await window.euta.update.check();
        if (v.available?.ready) {
          const r = await window.euta.update.restart(false);
          if (!r.restarting) setBusy(r.busy);
        } else if (v.available?.downloadUrl) await window.euta.update.download();
        else if (v.available) setError(`새 버전 ${v.available.version} 을 내려받는 중입니다 — 준비되면 위쪽에 알립니다`);
        else setError(v.lastCheck?.result === 'error' ? `업데이트를 확인하지 못했습니다: ${v.lastCheck.message ?? ''}` : '새 버전을 찾지 못했습니다 — 잠시 뒤 다시 확인하세요');
      }),
    [],
  );
  const dialogs = (
    <>
      {busy && (
        <Dialog label="진행 중인 작업이 끊깁니다" data-testid="update-busy-dialog">
          <h3>진행 중인 작업이 끊깁니다</h3>
          <p>다시 시작하면 지금 진행 중인 작업이 멈춥니다.</p>
          <ul data-testid="update-busy-list">
            {busyLines(busy).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="muted small">[끝나면 업데이트] 를 고르면 작업이 모두 끝났을 때 다시 알려 드립니다. 앱을 끌 때도 업데이트가 설치됩니다.</p>
          <DialogActions>
            <Button icon={X} onClick={() => setBusy(undefined)} data-testid="update-busy-cancel">
              취소
            </Button>
            <Button
              icon={Hourglass}
              onClick={() =>
                void guard(async () => {
                  await window.euta.update.whenIdle();
                  setBusy(undefined);
                })
              }
              data-testid="update-when-idle"
            >
              끝나면 업데이트
            </Button>
            <Button
              variant="danger"
              icon={RotateCw}
              onClick={() =>
                void guard(async () => {
                  await window.euta.update.restart(true);
                  setBusy(undefined);
                })
              }
              data-testid="update-force"
            >
              끊고 업데이트
            </Button>
          </DialogActions>
        </Dialog>
      )}
      {notes && (
        <Dialog label={`${notes.version} 에서 바뀐 것`} onBackdropClick={() => setNotes(undefined)} data-testid="update-notes-dialog">
          <h3>{notes.version} 에서 바뀐 것</h3>
          <div className="update-notes" onClick={(e) => e.stopPropagation()}>
            {notes.notes ?? '릴리스 노트가 없습니다.'}
          </div>
          <DialogActions>
            <Button icon={X} onClick={() => setNotes(undefined)} data-testid="update-notes-close">
              닫기
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
  return { restart, download, showNotes, updateNow, error, dialogs };
}

/** Header notice above every screen (hidden until the next version, or until it is ready). */
export function UpdateBanner() {
  const v = useUpdate();
  const a = useUpdateActions();
  const [hidden, setHidden] = useState<string | undefined>();
  const av = v?.available;
  if (!v || !av || hidden === av.version) return a.dialogs;
  const manual = v.mode === 'manual';
  if (!manual && !av.ready) return a.dialogs; // downloading in the background: nothing to do yet
  return (
    <>
      <div className="banner update-banner" data-testid="update-banner" data-mode={v.mode} data-version={av.version}>
        <RefreshCw size={16} aria-hidden="true" />
        <span>
          {manual ? (
            <>
              새 버전 <strong>{av.version}</strong> 이 나왔습니다
            </>
          ) : v.waiting ? (
            <>
              새 버전 <strong>{av.version}</strong> 준비됨 — 진행 중인 작업이 끝나면 다시 알려 드립니다
            </>
          ) : (
            <>
              새 버전 <strong>{av.version}</strong> 준비됨
            </>
          )}
        </span>
        {manual ? (
          av.downloadUrl && (
            <Button size="sm" variant="primary" icon={Download} onClick={() => void a.download()} title="설치 파일을 브라우저로 내려받습니다 — 내려받은 뒤 직접 설치하세요" data-testid="update-download">
              내려받기
            </Button>
          )
        ) : v.waiting ? (
          <Button size="sm" icon={X} onClick={() => void window.euta.update.cancelWait()} title="기다리지 않고 지금 상태로 둡니다" data-testid="update-cancel-wait">
            기다리기 취소
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={RotateCw} onClick={() => void a.restart()} title="앱을 다시 시작하면서 새 버전을 설치합니다" data-testid="update-restart">
            다시 시작해서 업데이트
          </Button>
        )}
        <Button size="sm" icon={FileText} onClick={a.showNotes} title="이 버전에서 바뀐 것" data-testid="update-notes">
          바뀐 것
        </Button>
        <Button size="sm" icon={X} onClick={() => setHidden(av.version)} title="이 알림 닫기 (다음 실행 때 다시 알립니다)" data-testid="update-hide">
          닫기
        </Button>
        {a.error && <span className="error">{a.error}</span>}
      </div>
      {a.dialogs}
    </>
  );
}

const MODE_LABEL: Record<UpdateView['mode'], string> = {
  auto: '자동 — 뒤에서 내려받고, 다시 시작할 때 설치',
  manual: '알림 — 새 버전이 나오면 설치 파일을 내려받아 직접 설치',
  off: '개발 실행 — 업데이트를 확인하지 않음',
};

const fmt = (iso: string) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

/** 앱 설정 › 업데이트. */
export function UpdateSettings() {
  const v = useUpdate();
  const a = useUpdateActions();
  const [checking, setChecking] = useState(false);
  if (!v) return null;
  const av = v.available;
  return (
    <div className="card" data-testid="update-settings" data-mode={v.mode}>
      <h3>업데이트</h3>
      <div className="form-row">
        <label>지금 버전</label>
        <span>
          <strong data-testid="update-version">{v.version}</strong> <span className="muted small">채널 {v.channel === 'alpha' ? '알파' : v.channel === 'beta' ? '베타' : v.channel === 'stable' ? '정식' : v.channel}</span>
        </span>
        <span className="muted small">{MODE_LABEL[v.mode]}</span>
      </div>
      <div className="form-row">
        <label>받는 곳</label>
        <span data-testid="update-source">{v.source ?? '확인할 때 정합니다'}</span>
        <span className="muted small">연결한 클라우드 서버가 앱을 배포하면 그 서버, 아니면 GitHub</span>
      </div>
      <div className="form-row">
        <label>마지막 확인</label>
        <span data-testid="update-last-check" data-result={v.lastCheck?.result ?? ''}>
          {v.checking
            ? '확인 중…'
            : v.lastCheck
              ? `${fmt(v.lastCheck.at)} — ${v.lastCheck.result === 'latest' ? '최신 버전입니다' : v.lastCheck.result === 'available' ? `새 버전 ${av?.version ?? ''}${v.mode === 'auto' ? (av?.ready ? ' 준비됨' : ' 내려받는 중') : ''}` : `확인 실패 (다음 확인 때 다시) — ${v.lastCheck.message ?? ''}`}`
              : '아직 확인하지 않았습니다 (앱 시작 30초 뒤, 그 뒤 6시간마다)'}
        </span>
      </div>
      <div className="inline">
        <Button
          icon={RefreshCw}
          disabled={v.mode === 'off' || v.checking || checking}
          onClick={() => {
            setChecking(true);
            void window.euta.update.check().finally(() => setChecking(false));
          }}
          title={v.mode === 'off' ? '개발 실행에서는 확인하지 않습니다' : '업데이트 서버에 새 버전이 있는지 지금 확인합니다'}
          data-testid="update-check"
        >
          업데이트 확인
        </Button>
        {av && (v.mode === 'manual' ? av.downloadUrl : av.ready) && (
          <Button
            variant="primary"
            icon={v.mode === 'manual' ? Download : RotateCw}
            onClick={() => void (v.mode === 'manual' ? a.download() : a.restart())}
            data-testid="update-settings-act"
          >
            {v.mode === 'manual' ? `${av.version} 내려받기` : '다시 시작해서 업데이트'}
          </Button>
        )}
        {av && (
          <Button icon={FileText} onClick={a.showNotes} data-testid="update-settings-notes">
            바뀐 것
          </Button>
        )}
      </div>
      <p className="muted small">프로젝트 · 금고 · 실행 기록은 업데이트로 바뀌지 않습니다.</p>
      {a.error && <div className="error">{a.error}</div>}
      {a.dialogs}
    </div>
  );
}
