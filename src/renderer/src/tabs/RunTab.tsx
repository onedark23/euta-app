import { useCallback, useEffect, useState } from 'react';
import { Cloud, Play, ShieldCheck } from 'lucide-react';
import type { BrowserEngine, CloudPrecheckView, CloudRunRequest, ProjectView, ScriptCheck, ScriptEntry } from '../../../shared/types';
import { errText } from './ScriptsTab';
import { Button, PageHeader, Switch } from '../ui';

export type RunWhere = 'pc' | 'cloud';

/** Precheck of a cloud run target, refreshed when the target changes (SPEC 실행 위치 선택). */
export function useCloudPrecheck(projectId: string, req: CloudRunRequest | undefined): { check?: CloudPrecheckView; loading: boolean; recheck: () => void } {
  const [check, setCheck] = useState<CloudPrecheckView | undefined>();
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(0);
  const key = req ? JSON.stringify(req) : '';
  useEffect(() => {
    if (!req) return setCheck(undefined);
    let alive = true;
    setLoading(true);
    void window.euta.cloud
      .precheck(projectId, req)
      .then((c) => alive && setCheck(c))
      .catch((e: unknown) => alive && setCheck({ ok: false, reasons: [errText(e)] }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key, n]);
  return { ...(check ? { check } : {}), loading, recheck: () => setN((x) => x + 1) };
}

export function PrecheckReasons({ check, loading }: { check?: CloudPrecheckView; loading: boolean }) {
  if (loading && !check) return <span className="muted small">클라우드 사전 검사 중…</span>;
  if (!check) return null;
  if (check.ok) return <span className="muted small" data-testid="cloud-precheck" data-ok="1">✓ 클라우드 실행 가능{check.credentialNames?.length ? ` · 테스트 계정 ${check.credentialNames.join(', ')}` : ''}</span>;
  return (
    <div className="issues bad" data-testid="cloud-precheck" data-ok="0">
      클라우드에서 실행할 수 없습니다
      <ul>
        {check.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Run tab: one script + Live. `where` (이 PC / 클라우드) lives in App — test sets in the Scripts tab
 * run where this tab says (SPEC 테스트 세트).
 */
export function RunTab({ project, active, request, onStarted, where, onWhere: setWhere }: { project: ProjectView; active: boolean; request?: { path: string; n: number; where?: RunWhere }; onStarted: (runId: string) => void; where: RunWhere; onWhere: (w: RunWhere) => void }) {
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);
  const [path, setPath] = useState('');
  const [envId, setEnvId] = useState(project.defaultEnvId ?? '');
  const [vars, setVars] = useState('');
  const [env, setEnv] = useState('');
  const [headless, setHeadless] = useState(project.browser.headless);
  const [browser, setBrowser] = useState<BrowserEngine>(project.browser.engine);
  const [check, setCheck] = useState<ScriptCheck | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const pid = project.id;
  // 실행 위치 (cloud projects, editor+): 이 PC (default) / 클라우드.
  const cloudCapable = !!project.cloud && !!project.cloudView?.canRun;
  const cloudReq = cloudCapable && where === 'cloud' && path ? { script: path, ...(envId ? { envId } : {}) } : undefined;
  const pre = useCloudPrecheck(pid, cloudReq);

  const refresh = useCallback(async () => {
    const l = await window.euta.scripts.list(pid);
    setScripts(l);
    setPath((p) => (p && l.some((s) => s.path === p) ? p : (l[0]?.path ?? '')));
  }, [pid]);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  useEffect(() => window.euta.scripts.onChanged((id) => id === pid && void refresh()), [pid, refresh]);
  useEffect(() => {
    if (request) {
      setPath(request.path);
      setWhere(request.where === 'cloud' && cloudCapable ? 'cloud' : 'pc');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  useEffect(() => {
    if (!cloudCapable) setWhere('pc');
  }, [cloudCapable]);
  // Cloud badges (보내기 대기) change with the script list → precheck again.
  useEffect(() => window.euta.scripts.onChanged((id) => id === pid && where === 'cloud' && pre.recheck()), [pid, where, pre]);
  useEffect(() => {
    if (envId && !project.environments.some((e) => e.id === envId)) setEnvId(project.defaultEnvId ?? '');
  }, [project.environments, project.defaultEnvId, envId]);

  const validate = async () => {
    if (!path) return;
    setError(undefined);
    try {
      setCheck(await window.euta.scripts.check(pid, path, envId || undefined, vars, env));
    } catch (e) {
      setError(errText(e));
    }
  };

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (where === 'cloud') {
        const r = await window.euta.cloud.startRun(pid, { script: path, ...(envId ? { envId } : {}), vars });
        onStarted(r.runId);
        return;
      }
      const r = await window.euta.startRun({ projectId: pid, script: path, ...(envId ? { envId } : {}), vars, env, headless, browser });
      onStarted(r.runId);
    } catch (e) {
      setError(errText(e));
      if (where === 'cloud') pre.recheck();
    } finally {
      setBusy(false);
    }
  };

  const selectedEnv = project.environments.find((e) => e.id === envId);
  const issues = check?.path === path ? check.issues : undefined;

  return (
    <div className="run-tab">
      <PageHeader title="실행" />
      <div className="card">
      {cloudCapable && (
        <div className="inline run-where" data-testid="run-where">
          <b>실행 위치</b>
          <label>
            <input type="radio" name="run-where" checked={where === 'pc'} onChange={() => setWhere('pc')} data-testid="run-where-pc" /> 이 PC
          </label>
          <label>
            <input type="radio" name="run-where" checked={where === 'cloud'} onChange={() => setWhere('cloud')} data-testid="run-where-cloud" /> <Cloud size={14} aria-hidden="true" /> 클라우드
          </label>
          {where === 'cloud' && <span className="muted small">서버에 저장된 버전 · 창 없이 · 클라우드 테스트 계정으로 실행 — 앱을 꺼도 계속됩니다</span>}
        </div>
      )}
      <div className="grid2">
        <div className="form-row">
          <label htmlFor="run-script">스크립트</label>
          <select id="run-script" value={path} onChange={(e) => setPath(e.target.value)} data-testid="run-script">
            {scripts.length === 0 && <option value="">(스크립트 없음)</option>}
            {scripts.map((s) => (
              <option key={s.path} value={s.path}>
                {s.path}
                {s.name ? ` — ${s.name}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="run-env">환경</label>
          <select id="run-env" value={envId} onChange={(e) => setEnvId(e.target.value)} data-testid="run-env">
            <option value="">(환경 없음 — BASE_URL 미설정)</option>
            {project.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.baseUrl ? ` — ${e.baseUrl}` : ''}
                {e.id === project.defaultEnvId ? ' (기본)' : ''}
              </option>
            ))}
          </select>
          {selectedEnv && (
            <span className="muted small" data-testid="run-env-info">
              BASE_URL={selectedEnv.baseUrl || '—'} · 변수 {Object.keys(selectedEnv.vars).join(', ') || '없음'} · 비밀값 {selectedEnv.secretNames.length ? `${selectedEnv.secretNames.join(', ')} (${selectedEnv.secretSource === 'file' ? '외부 파일' : '앱 저장소'}, 값 숨김)` : '없음'}
            </span>
          )}
        </div>
      </div>
      <div className="grid2">
        <div className="form-row">
          <label htmlFor="vars">실행 변수 (한 줄에 KEY=VALUE 하나 → ${'{vars.*}'})</label>
          <textarea id="vars" rows={3} value={vars} onChange={(e) => setVars(e.target.value)} spellCheck={false} />
        </div>
        <div className="form-row">
          <label htmlFor="env">환경 값 덮어쓰기 (KEY=VALUE → ${'{env.*}'}, 환경 값 위에 적용{where === 'cloud' ? ' — 이 PC 실행만' : ''})</label>
          <textarea id="env" data-testid="env" rows={3} value={env} onChange={(e) => setEnv(e.target.value)} spellCheck={false} />
        </div>
      </div>
      <div className="inline options" hidden={where === 'cloud'}>
        <Switch checked={headless} onChange={(e) => setHeadless(e.target.checked)} data-testid="headless" label={<>창 없이 실행 <span className="muted small">Headless</span></>} />
        <label>
          브라우저{' '}
          <select value={browser} onChange={(e) => setBrowser(e.target.value as BrowserEngine)}>
            <option value="chromium">chromium</option>
            <option value="firefox">firefox</option>
            <option value="webkit">webkit</option>
          </select>
        </label>
        {project.browser.device && <span className="muted small">기기: {project.browser.device} (프로젝트 기본값)</span>}
      </div>
      {check?.secretsError && <div className="error">{check.secretsError}</div>}
      {issues && (
        <div className={issues.length ? 'issues bad' : 'issues ok'} data-testid="validation">
          {issues.length === 0 ? (
            <span>✓ 검증 통과{check?.name ? ` — ${check.name}` : ''}</span>
          ) : (
            <>
              <strong>검증 오류 {issues.length}개</strong>
              <ul>
                {issues.map((i, n) => (
                  <li key={n}>
                    <code>{i.path}</code> {i.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <div className="inline">
        <Button icon={ShieldCheck} onClick={() => void validate()} disabled={!path} data-testid="validate">
          검증
        </Button>
        {project.cloudView && !project.cloudView.canRun ? (
          <span className="muted" data-testid="run-viewer-note">보기 역할은 실행할 수 없습니다 — 실행하려면 권한을 요청하세요.</span>
        ) : (
        <Button variant="primary" icon={where === 'cloud' ? Cloud : Play} onClick={() => void run()} disabled={!path || busy || (where === 'cloud' && !pre.check?.ok)} data-testid="run">
          {busy ? '시작 중…' : where === 'cloud' ? '클라우드에서 실행' : '실행'}
        </Button>
        )}
        {issues && issues.length > 0 && <span className="muted">문제를 고치기 전에는 실행이 “오류” 로 끝납니다.</span>}
      </div>
      {where === 'cloud' && <PrecheckReasons {...pre} />}
      {error && <div className="error">{error}</div>}
      </div>
      <p className="muted small">여러 스크립트를 순서대로 돌리려면 스크립트 탭 → 테스트 세트{cloudCapable ? ' (여기서 고른 실행 위치를 따릅니다)' : ''}.</p>
    </div>
  );
}
