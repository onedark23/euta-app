import { useEffect, useMemo, useState } from 'react';
import { Ban, ChevronDown, ChevronRight, Cloud, FileText, MousePointerClick, X } from 'lucide-react';
import { isManualCheck, type RunView, type StepView, type SuiteRun } from '../../../shared/types';
import { ScriptLabel } from './ScriptLabel';
import { Badge, Button, EmptyState, runTone, statusLabel, Switch } from '../ui';

const fmtMs = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`);
const fmtVal = (v: unknown) => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/** A run state as a badge — the Korean word (SPEC 글쓰기), the tone from SPEC 상태 매핑; `data-status` keeps the raw value. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={status === 'flaky' ? 'warn' : runTone(status)} data-status={status}>
      {statusLabel(status)}
    </Badge>
  );
}

/**
 * A step's state: a `manual` step the run reached is "수동 확인 필요" (manual tone, SPEC_UI-디자인-시스템);
 * one not reached after a failure stays an ordinary 건너뜀.
 */
export function StepStatusBadge({ step }: { step: { status: string; manual?: unknown; error?: unknown } }) {
  if (isManualCheck(step))
    return (
      <Badge tone="manual" data-status="manual" data-testid="manual-badge">
        수동 확인 필요
      </Badge>
    );
  return <StatusBadge status={step.status} />;
}

/** "수동 확인: …" + "이유: …" under a manual step. */
export function ManualNote({ manual }: { manual?: { instruction: string; reason?: string } }) {
  if (!manual) return null;
  return (
    <div className="manual-note small" data-testid="manual-note">
      수동 확인: {manual.instruction}
      {manual.reason && <div className="muted">이유: {manual.reason}</div>}
    </div>
  );
}

/** Every manual step counts (reached or not), like the engine report and the web. */
export const manualCount = (steps: { manual?: unknown }[]): number => steps.filter((s) => !!s.manual).length;

function CloudCancel({ projectId, runId }: { projectId: string; runId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <>
      <Button
        size="sm"
        variant="danger"
        icon={Ban}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void window.euta.cloud
            .cancelRun(projectId, runId)
            .catch((e: unknown) => setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Input)?Error: /, '')))
            .finally(() => setBusy(false));
        }}
        data-testid="run-cloud-cancel"
      >
        {busy ? '취소 중…' : '클라우드 실행 취소'}
      </Button>
      {error && <span className="error small">{error}</span>}
    </>
  );
}

function useImage(runId: string | undefined, rel: string | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    if (!runId || !rel) {
      setSrc(undefined);
      return;
    }
    void window.euta.artifactImage(runId, rel).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [runId, rel]);
  return src;
}

/** One run's live content (steps, screenshot, expects, metrics, console/network) — also inside a test set item. */
export function RunDetail({ run, inSet }: { run: RunView; inSet?: boolean }) {
  const [pinnedShot, setPinnedShot] = useState<string | undefined>();
  useEffect(() => setPinnedShot(undefined), [run.runId]);
  const shot = pinnedShot ?? run.latestScreenshot;
  const img = useImage(run.runId, shot);

  const lastMetrics = useMemo(() => {
    const m = new Map<string, { name: string; value: number; unit: string; stepId?: string }>();
    for (const x of run.metrics ?? []) m.set(`${x.name}@${x.stepId ?? ''}`, x);
    return [...m.values()].slice(-40);
  }, [run.metrics]);

  return (
    <div className={`run-detail${inSet ? ' in-set' : ''}`} data-testid="run-detail" data-run-id={run.runId}>
      <header className="run-head">
        <h2>
          {run.name} <StatusBadge status={run.status} />
          {run.cloud && (
            <span className="tag cloud-tag" data-testid="run-cloud" data-cloud-status={run.cloud.status}>
              <Cloud size={12} aria-hidden="true" /> 클라우드 · {statusLabel(run.cloud.status)}
              {run.cloud.flaky ? ' · 불안정' : ''}
            </span>
          )}
          {run.cloud?.canCancel && run.projectId && <CloudCancel projectId={run.projectId} runId={run.cloud.runId} />}
        </h2>
        {run.cloud && (
          <div className="muted small" data-testid="run-cloud-info">
            출처 {run.cloud.sourceLabel} · 요청 {run.cloud.requestedBy} · 실행 위치 {run.cloud.runnerLocation ?? '(배정 전)'}
            {run.cloud.downloaded ? ' · 내려받은 결과 파일로 다시 보기' : ' · 앱을 꺼도 클라우드에서 계속됩니다'}
            {!run.cloud.downloaded && run.cloud.resultFiles === 'expired' ? ' · 파일 만료 (요약만)' : ''}
          </div>
        )}
        <div className="muted small run-facts">
          <span data-testid="run-status" data-status={run.status}>
            {run.source === 'cloud' ? '클라우드 실행 (서버 요약)' : run.source === 'mcp' ? 'MCP 로 실행' : run.source === 'ai' ? 'AI 채팅으로 실행' : run.source === 'app' ? '앱에서 실행' : '실행 이력에서 다시 보기'}
          </span>
          {run.kind && ` · ${run.kind === 'session' ? '세션' : '스크립트'}`}
          {run.browser && ` · ${run.browser}${run.headless ? ' (창 없이)' : ''}`}
          {run.baseUrl && ` · ${run.baseUrl}`}
          {run.durationMs !== undefined && ` · ${fmtMs(run.durationMs)}`}
          {run.summary && ` · ${run.summary.passed}/${run.summary.total} 통과${run.summary.failed ? `, 실패 ${run.summary.failed}` : ''}${run.summary.error ? `, 오류 ${run.summary.error}` : ''}${run.summary.skipped - manualCount(run.steps) > 0 ? `, 건너뜀 ${run.summary.skipped - manualCount(run.steps)}` : ''}`}
          {manualCount(run.steps) > 0 && (
            <>
              {' · '}
              <Badge tone="manual" data-testid="run-manual-count">
                수동 확인 필요 {manualCount(run.steps)}
              </Badge>
            </>
          )}
          {run.maxSeq > run.eventCount && ` · 이벤트 ${run.maxSeq - run.eventCount}개 누락`}
          {run.recovered && ' · steps.jsonl 에서 복구'}
        </div>
        {run.error && <div className="error">{run.error}</div>}
      </header>
      <div className="live-grid">
        <div className="timeline table-card">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>동작</th>
                <th>이름 / 대상</th>
                <th>상태</th>
                <th>시간</th>
              </tr>
            </thead>
            <tbody data-testid="timeline">
              {run.steps.map((s: StepView) => (
                <tr key={s.stepId} className={`step ${s.status}${shot && s.screenshot === shot ? ' shown' : ''}`} data-testid="step-row" data-status={s.status} data-manual={s.manual ? (isManualCheck(s) ? 'reached' : 'not-reached') : undefined} onClick={() => s.screenshot && setPinnedShot(s.screenshot)}>
                  <td>{s.stepId}</td>
                  <td>{s.action}</td>
                  <td className="ellipsis" title={s.target}>
                    {s.name ?? s.target ?? ''}
                    <ManualNote manual={s.manual} />
                    {s.error && <div className="step-error">{s.error}</div>}
                  </td>
                  <td>
                    <StepStatusBadge step={s} />
                    {s.optional ? <span className="muted small"> 선택 단계</span> : null}
                  </td>
                  <td>{fmtMs(s.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="side">
          <div className="shot card">
            <div className="inline between">
              <strong>스크린샷</strong>
              {pinnedShot && (
                <button className="link" onClick={() => setPinnedShot(undefined)}>
                  최신 보기
                </button>
              )}
            </div>
            {img ? <img src={img} alt={shot} data-testid="screenshot" /> : <div className="muted small">{shot ? '불러오는 중…' : '아직 없음'}</div>}
            {shot && <div className="muted small">{shot}</div>}
          </div>
          <details open className="card">
            <summary>확인 ({run.expects.length})</summary>
            <ul className="compact">
              {run.expects.slice(-50).map((x, i) => (
                <li key={i} className={x.passed ? 'ok' : 'bad'}>
                  {x.passed ? '✓' : '✗'} [{x.stepId}] {x.condition}: 기대 {fmtVal(x.expected)}, 실제 {fmtVal(x.actual)}
                </li>
              ))}
            </ul>
          </details>
          <details open className="card">
            <summary>지표 ({lastMetrics.length})</summary>
            <ul className="compact">
              {lastMetrics.map((m, i) => (
                <li key={i}>
                  {m.name} = {m.value}
                  {m.unit} {m.stepId && <span className="muted">[{m.stepId}]</span>}
                </li>
              ))}
            </ul>
          </details>
          <details open={run.consoleErrors.length + run.networkFailures.length > 0} className="card">
            <summary>
              콘솔 오류 ({run.consoleErrors.length}) · 네트워크 실패 ({run.networkFailures.length})
            </summary>
            <ul className="compact">
              {run.consoleErrors.slice(-30).map((c, i) => (
                <li key={`c${i}`} className="bad">
                  [{c.level}] {c.text}
                </li>
              ))}
              {run.networkFailures.slice(-30).map((n, i) => (
                <li key={`n${i}`} className="bad">
                  {n.method} {n.url} {n.status ?? n.errorText ?? ''} {fmtMs(n.durationMs)}
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>
    </div>
  );
}

/** A test set run in Live (SPEC 프로젝트-관리 "Live 화면 — 테스트 세트 묶음"): this PC's SuiteRun or a cloud set parent. */
interface LiveGroup {
  key: string;
  where: 'pc' | 'cloud';
  name: string;
  envName?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  items: { runId?: string; script: string; status: string; alwaysRun?: boolean; durationMs?: number }[];
  /** This PC: the SuiteRun id; cloud: the parent run (its RunView). */
  suiteRunId?: string;
  cloud?: RunView;
}

const DONE = new Set(['passed', 'failed', 'error', 'skipped']);

function groupsOf(runs: Map<string, RunView>, suiteRuns: SuiteRun[]): LiveGroup[] {
  const out: LiveGroup[] = [];
  for (const s of suiteRuns) {
    // A set shows in Live while it runs or when one of its runs is in Live (this session, or opened from History).
    if (s.status !== 'running' && !s.items.some((i) => i.runId && runs.has(i.runId))) continue;
    out.push({
      key: `suite:${s.id}`,
      where: 'pc',
      name: s.suiteName,
      envName: s.envName,
      status: s.status,
      startedAt: s.startedAt,
      ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
      items: s.items.map((i) => ({ ...(i.runId ? { runId: i.runId } : {}), script: i.script, status: i.status, ...(i.alwaysRun ? { alwaysRun: true } : {}), ...(i.runId && runs.get(i.runId)?.durationMs !== undefined ? { durationMs: runs.get(i.runId)!.durationMs! } : {}) })),
      suiteRunId: s.id,
    });
  }
  for (const v of runs.values()) {
    if (v.source !== 'cloud' || v.cloud?.kind !== 'suite') continue;
    out.push({
      key: v.runId,
      where: 'cloud',
      name: v.name.replace(/^테스트 세트: /, ''),
      ...(v.cloud.envName ? { envName: v.cloud.envName } : {}),
      status: v.status,
      ...(v.startedAt ? { startedAt: v.startedAt } : {}),
      ...(v.cloud.finishedAt ? { finishedAt: v.cloud.finishedAt } : {}),
      items: (v.suiteItems ?? []).map((i) => ({ ...i })),
      cloud: v,
    });
  }
  return out;
}

const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function SetDetail({ g, runs, names, projectId, selected }: { g: LiveGroup; runs: Map<string, RunView>; names: Map<string, string | undefined>; projectId?: string; selected?: string }) {
  const running = g.status === 'running';
  const now = useNow(running);
  const [toggled, setToggled] = useState<Map<number, boolean>>(new Map());
  const [note, setNote] = useState<string | undefined>();
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    setToggled(new Map());
    setCancelling(false);
  }, [g.key]);
  // Opening a finished script of the set (History "Open", a click in the run list) unfolds it.
  useEffect(() => {
    const i = g.items.findIndex((x) => x.runId && x.runId === selected);
    const v = selected ? runs.get(selected) : undefined;
    if (i >= 0 && v && v.status !== 'running' && v.status !== 'unknown') setToggled((m) => (m.get(i) === undefined ? new Map(m).set(i, true) : m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, g.key]);
  const done = g.items.filter((i) => DONE.has(i.status)).length;
  const elapsed = g.startedAt ? (g.finishedAt ? new Date(g.finishedAt).getTime() : running ? now : new Date(g.startedAt).getTime()) - new Date(g.startedAt).getTime() : undefined;
  const openReport = async () => {
    setNote(undefined);
    try {
      if (g.where === 'cloud' && projectId && g.cloud?.cloud) await window.euta.cloud.openWebRun(projectId, g.cloud.cloud.runId);
      else if (projectId && g.suiteRunId && !(await window.euta.suites.openReport(projectId, g.suiteRunId))) setNote('리포트를 만들 수 없습니다');
    } catch (e) {
      setNote(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Input)?Error: /, ''));
    }
  };
  return (
    <div className="run-detail set-detail" data-testid="set-detail" data-key={g.key} data-where={g.where} data-status={g.status}>
      <header className="set-head" data-testid="set-head">
        <div className="inline between">
          <h2>
            테스트 세트: {g.name} <StatusBadge status={g.status} />
            {g.where === 'cloud' && (
              <span className="tag cloud-tag">
                <Cloud size={12} aria-hidden="true" /> 클라우드
              </span>
            )}
          </h2>
          <div className="inline">
            {running && g.where === 'pc' && g.suiteRunId && (
              <Button
                size="sm"
                variant="danger"
                icon={X}
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  void window.euta.suites.cancel(g.suiteRunId!);
                }}
                title="진행 중인 스크립트가 끝나면 남은 항목을 건너뜁니다 (항상 실행 항목은 실행)"
                data-testid="set-cancel"
              >
                {cancelling ? '취소 요청됨' : '취소'}
              </Button>
            )}
            {running && g.where === 'cloud' && g.cloud?.cloud?.canCancel && projectId && <CloudCancel projectId={projectId} runId={g.cloud.cloud.runId} />}
            {!running && (
              <Button size="sm" icon={FileText} onClick={() => void openReport()} title={g.where === 'cloud' ? '웹의 실행 상세(테스트 세트 리포트)를 브라우저로 엽니다' : '테스트 세트 리포트를 엽니다'} data-testid="set-report">
                리포트{g.where === 'cloud' ? ' ↗' : ''}
              </Button>
            )}
          </div>
        </div>
        <div className="muted small set-facts">
          {g.envName && <span>환경 <b>{g.envName}</b></span>}
          <span data-testid="set-progress">
            진행 <b>{done}/{g.items.length}</b>
          </span>
          {elapsed !== undefined && (
            <span data-testid="set-elapsed">
              {running ? '경과' : '소요'} <b>{fmtElapsed(elapsed)}</b>
            </span>
          )}
          <span>{g.where === 'cloud' ? '실행 위치 클라우드' : '실행 위치 이 PC'}</span>
        </div>
        {note && <div className="error small">{note}</div>}
      </header>
      <ol className="set-items" data-testid="set-items">
        {g.items.map((it, i) => {
          const v = it.runId ? runs.get(it.runId) : undefined;
          const open = toggled.get(i) ?? it.status === 'running';
          return (
            <li key={i} className={`set-item ${it.status}${open ? ' open' : ''}`} data-testid="set-item" data-status={it.status} data-open={open ? '1' : '0'} data-path={it.script}>
              <button className="set-item-head" onClick={() => setToggled((m) => new Map(m).set(i, !open))} aria-expanded={open} title={open ? '접기' : '펼치기'} data-testid="set-item-toggle">
                <span className="chev">{open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}</span>
                <span className="order">{i + 1}</span>
                <span className="grow">
                  <ScriptLabel path={it.script} name={names.get(it.script) ?? (v && v.name !== v.runId && v.name !== it.script ? v.name : undefined)} />
                  {it.alwaysRun && (
                    <>
                      {' '}
                      <span className="tag sub">항상 실행</span>
                    </>
                  )}
                </span>
                {it.durationMs !== undefined && <span className="muted small">{fmtMs(it.durationMs)}</span>}
                {v && manualCount(v.steps) > 0 && (
                  <Badge tone="manual" data-testid="set-item-manual" title="사람이 확인해야 하는 단계 (수동 확인)">
                    수동 {manualCount(v.steps)}
                  </Badge>
                )}
                <StatusBadge status={it.status} />
              </button>
              {open && (
                <div className="set-item-body">
                  {v ? (
                    <RunDetail run={v} inSet />
                  ) : (
                    <div className="muted small">
                      {it.status === 'pending' ? '아직 차례가 오지 않았습니다.' : it.status === 'skipped' ? '실행하지 않았습니다 (건너뜀).' : it.runId ? '실행 내용을 불러오는 중…' : '실행 기록이 없습니다.'}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface Props {
  runs: Map<string, RunView>;
  selected?: string;
  onSelect: (id: string) => void;
  follow: boolean;
  onFollow: (f: boolean) => void;
  /** This PC's test set runs of the project (Live groups their runs). */
  suiteRuns?: SuiteRun[];
  projectId?: string;
}

export function LiveTab({ runs, selected, onSelect, follow, onFollow, suiteRuns = [], projectId }: Props) {
  const groups = useMemo(() => groupsOf(runs, suiteRuns), [runs, suiteRuns]);
  const members = useMemo(() => {
    const m = new Map<string, LiveGroup>();
    for (const g of groups) {
      m.set(g.key, g);
      for (const i of g.items) if (i.runId) m.set(i.runId, g);
    }
    return m;
  }, [groups]);
  const [names, setNames] = useState<Map<string, string | undefined>>(new Map());
  const scriptsKey = groups.map((g) => g.items.map((i) => i.script).join(',')).join('|');
  useEffect(() => {
    if (!projectId || !scriptsKey) return;
    let alive = true;
    void window.euta.scripts
      .list(projectId)
      .then((l) => alive && setNames(new Map(l.map((x) => [x.path, x.name]))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId, scriptsKey]);

  // Run list: sets (one entry each) and runs that belong to no set, newest first.
  const entries = useMemo(() => {
    const standalone = [...runs.values()].filter((r) => !members.has(r.runId));
    const list: ({ kind: 'run'; at: string; upd: number; run: RunView } | { kind: 'set'; at: string; upd: number; g: LiveGroup })[] = [
      ...standalone.map((r) => ({ kind: 'run' as const, at: r.startedAt ?? '', upd: r.updatedAt, run: r })),
      ...groups.map((g) => ({ kind: 'set' as const, at: g.startedAt ?? '', upd: 0, g })),
    ];
    return list.sort((a, b) => b.at.localeCompare(a.at) || b.upd - a.upd);
  }, [runs, groups, members]);
  const group = selected ? members.get(selected) : undefined;
  const run = !group && selected ? runs.get(selected) : undefined;

  return (
    <div className="live">
      <aside className="run-list">
        <div className="inline between run-list-head">
          <strong>실행 목록</strong>
          <Switch className="muted small" checked={follow} onChange={(e) => onFollow(e.target.checked)} label="새 실행 따라가기" />
        </div>
        {entries.length === 0 && <p className="muted small">아직 실행이 없습니다. 실행 탭에서 시작하거나, 실행 이력에서 열거나, Claude·Codex 에서 MCP 로 실행하세요.</p>}
        <ul>
          {entries.map((e) =>
            e.kind === 'set' ? (
              <li key={e.g.key} className={`set-entry${group?.key === e.g.key ? ' sel' : ''}`} onClick={() => onSelect(e.g.items.find((i) => i.status === 'running' && i.runId)?.runId ?? e.g.key)} data-testid="live-set-item" data-key={e.g.key}>
                <div className="inline between">
                  <span className="name">테스트 세트: {e.g.name}</span>
                  <StatusBadge status={e.g.status} />
                </div>
                <div className="muted small">
                  {e.g.where === 'cloud' && <span className="tag cloud-tag">클라우드</span>} {e.g.items.filter((i) => DONE.has(i.status)).length}/{e.g.items.length} 완료{e.g.envName ? ` · ${e.g.envName}` : ''}
                </div>
              </li>
            ) : (
              <li key={e.run.runId} className={e.run.runId === selected ? 'sel' : ''} onClick={() => onSelect(e.run.runId)} data-testid="live-run-item" data-run-id={e.run.runId}>
                <div className="inline between">
                  <span className="name">{e.run.name}</span>
                  <StatusBadge status={e.run.cloud && e.run.source === 'cloud' ? e.run.cloud.status : e.run.status} />
                </div>
                <div className="muted small">
                  {e.run.cloud && (
                    <span className="tag cloud-tag" data-testid="live-cloud-badge">
                      클라우드
                    </span>
                  )}{' '}
                  {e.run.cloud ? `${e.run.cloud.sourceLabel}${e.run.cloud.downloaded ? ' · 결과 파일' : ''}` : e.run.source === 'mcp' ? 'MCP' : e.run.source === 'ai' ? 'AI' : e.run.source === 'app' ? '앱' : '실행 이력'} · {e.run.runId.split(/[_-]/).pop()}
                </div>
              </li>
            ),
          )}
        </ul>
      </aside>
      {group ? (
        <SetDetail g={group} runs={runs} names={names} {...(projectId ? { projectId } : {})} {...(selected ? { selected } : {})} />
      ) : !run ? (
        <div className="run-detail">
          <EmptyState icon={MousePointerClick} title="실행을 고르세요." />
        </div>
      ) : (
        <RunDetail run={run} />
      )}
    </div>
  );
}
