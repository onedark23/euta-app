// 테스트 세트 (SPEC 프로젝트-관리 "테스트 세트", 내부 이름 suite) — Scripts tab view: one card per set
// with run (where the Run tab says: 이 PC / 클라우드), latest result, item order with "항상 실행"
// marks, and inline editing (saved at once). A local run shows per-item progress + cancel on the card;
// a cloud run opens in Live like the Run tab does.
import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, FileDown, FileText, ListChecks, ListPlus, Pencil, Play, Plus, Trash, X } from 'lucide-react';
import type { CloudRunItem, ProjectView, ScriptEntry, Suite, SuiteRun } from '../../../shared/types';
import type { Nav } from '../App';
import { StatusBadge } from './LiveTab';
import { PrecheckReasons, useCloudPrecheck, type RunWhere } from './RunTab';
import { errText } from './ScriptsTab';
import { ScriptLabel } from './ScriptLabel';
import { Button, EmptyState, PickList } from '../ui';
import { TcExportDialog } from './TcDocs';

/** Latest result of a set, from a local suite run or a cloud suite run (whichever is newer). */
interface Latest {
  status: string;
  passed: number;
  total: number;
  at: string;
  durationMs: number | null;
  firstFail?: string;
  where: 'pc' | 'cloud';
  cloudRunId?: string;
}

const fromLocal = (r: SuiteRun): Latest => ({
  status: r.status,
  passed: r.items.filter((i) => i.status === 'passed').length,
  total: r.items.length,
  at: r.startedAt,
  durationMs: r.finishedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : null,
  ...(r.items.find((i) => i.status === 'failed' || i.status === 'error') ? { firstFail: r.items.find((i) => i.status === 'failed' || i.status === 'error')!.script } : {}),
  where: 'pc',
});

const fromCloud = (c: CloudRunItem): Latest => ({
  status: c.status,
  passed: c.summary?.passed ?? 0,
  total: c.summary?.total ?? 0,
  at: c.at,
  durationMs: c.durationMs,
  where: 'cloud',
  cloudRunId: c.id,
});

type SuiteForm = Parameters<typeof window.euta.suites.upsert>[2];

const FAILED = new Set(['failed', 'error', 'timeout', 'aborted']);
const ACTIVE = new Set(['queued', 'leased', 'running']);

/** Saves a suite patch and hands the new project view up; errors are shown on the card. */
type Save = (suiteId: string | undefined, patch: SuiteForm) => Promise<ProjectView>;

function TestSetCard({
  project,
  suite,
  scripts,
  where,
  editable,
  canRunPc,
  latestLocal,
  latestCloud,
  startEditing,
  save,
  remove,
  nav,
}: {
  project: ProjectView;
  suite: Suite;
  scripts: ScriptEntry[];
  where: RunWhere;
  editable: boolean;
  canRunPc: boolean;
  latestLocal?: SuiteRun;
  latestCloud?: CloudRunItem;
  startEditing: boolean;
  save: Save;
  remove: (suiteId: string) => Promise<void>;
  nav: Nav;
}) {
  const pid = project.id;
  const [editing, setEditing] = useState(startEditing);
  const [name, setName] = useState(suite.name);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const nameOf = new Map(scripts.map((x) => [x.path, x.name]));
  const label = (path: string) => <ScriptLabel path={path} name={nameOf.get(path)} />;
  const [error, setError] = useState<string | undefined>();
  const [firstFail, setFirstFail] = useState<string | undefined>();
  const [exporting, setExporting] = useState(false);
  useEffect(() => setName(suite.name), [suite.name]);
  const cloudReq = where === 'cloud' ? { suiteId: suite.id } : undefined;
  const pre = useCloudPrecheck(pid, cloudReq);
  const always = new Set(suite.alwaysRun ?? []);
  const running = latestLocal?.status === 'running' ? latestLocal : undefined;

  const local = latestLocal ? fromLocal(latestLocal) : undefined;
  const cloud = latestCloud ? fromCloud(latestCloud) : undefined;
  const latest = local && cloud ? (local.at >= cloud.at ? local : cloud) : (local ?? cloud);
  // First failing script of a cloud run: its children, read once per run.
  const cloudFailId = latest?.where === 'cloud' && FAILED.has(latest.status) ? latest.cloudRunId : undefined;
  useEffect(() => {
    setFirstFail(undefined);
    if (!cloudFailId) return;
    let alive = true;
    void window.euta.cloud
      .runChildren(pid, cloudFailId)
      .then((kids) => alive && setFirstFail(kids.find((k) => FAILED.has(k.status))?.name))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pid, cloudFailId]);

  const patch = async (p: SuiteForm) => {
    setError(undefined);
    try {
      await save(suite.id, p);
    } catch (e) {
      setError(errText(e));
    }
  };
  const move = (i: number, d: number) => {
    const next = [...suite.scripts];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    void patch({ scripts: next });
  };
  const run = async () => {
    setError(undefined);
    try {
      if (where === 'cloud') {
        const r = await window.euta.cloud.startRun(pid, { suiteId: suite.id });
        nav.openRun(r.runId);
        return;
      }
      await window.euta.suites.run(pid, suite.id);
    } catch (e) {
      setError(errText(e));
      if (where === 'cloud') pre.recheck();
    }
  };
  const openReport = async () => {
    setError(undefined);
    try {
      if (latest?.where === 'cloud' && latest.cloudRunId) await window.euta.cloud.openWebRun(pid, latest.cloudRunId);
      else if (latestLocal && !(await window.euta.suites.openReport(pid, latestLocal.id))) setError('리포트를 만들 수 없습니다');
    } catch (e) {
      setError(errText(e));
    }
  };
  const envName = project.environments.find((e) => e.id === (suite.envId ?? project.defaultEnvId))?.name;
  const canRun = where === 'cloud' ? !!pre.check?.ok : canRunPc && !running;

  return (
    <div className="card testset-card" data-testid="testset-card" data-name={suite.name}>
      <div className="inline between">
        <div className="inline">
          <b className="testset-name">{suite.name}</b>
          <span className="muted small">
            환경 {suite.envId ? envName : `프로젝트 기본(${envName ?? '-'})`} · {suite.scripts.length}개{suite.stopOnFailure ? ' · 실패 시 중단' : ''}
          </span>
        </div>
        <div className="inline">
          {(where === 'cloud' || canRunPc) && (
            <Button size="sm" icon={Play} disabled={!canRun || !suite.scripts.length} onClick={() => void run()} data-testid="testset-run" title={where === 'cloud' ? '클라우드에서 실행 (실행 탭에서 실행 위치를 바꿉니다)' : '이 PC 에서 실행'}>
              {where === 'cloud' ? '클라우드에서 실행' : '실행'}
            </Button>
          )}
          {running && (
            <Button size="sm" icon={X} onClick={() => void window.euta.suites.cancel(running.id)} data-testid="testset-cancel" title="진행 중인 스크립트가 끝나면 남은 항목을 건너뜁니다 (항상 실행 항목은 실행)">
              취소
            </Button>
          )}
          {suite.scripts.length > 0 && (
            <Button size="sm" icon={FileDown} onClick={() => setExporting(true)} data-testid="testset-export" title="이 테스트 세트를 자연어 TC 문서(xlsx · md)로 내보냅니다">
              TC 문서로 내보내기
            </Button>
          )}
          {editable && (
            <Button size="sm" icon={editing ? Check : Pencil} active={editing} onClick={() => setEditing((x) => !x)} data-testid="testset-edit">
              {editing ? '편집 닫기' : '편집'}
            </Button>
          )}
        </div>
      </div>
      {exporting && <TcExportDialog project={project} source={{ suiteId: suite.id }} title={suite.name} onClose={() => setExporting(false)} />}
      {where === 'cloud' && !pre.check?.ok && <PrecheckReasons {...pre} />}
      <div className="small testset-latest" data-testid="testset-latest" data-status={latest?.status ?? ''}>
        {latest ? (
          <>
            최근 결과 <StatusBadge status={latest.status} /> {latest.passed}/{latest.total} 통과 · {new Date(latest.at).toLocaleString()}
            {latest.durationMs !== null ? ` · ${(latest.durationMs / 1000).toFixed(1)}s` : ''}
            {latest.where === 'cloud' ? ' · ☁ 클라우드' : ''}
            {(latest.firstFail ?? firstFail) && (
              <>
                {' '}
                · 첫 실패 <span data-testid="testset-first-fail" data-path={latest.firstFail ?? firstFail}>{label((latest.firstFail ?? firstFail)!)}</span>
              </>
            )}
            {latest.status !== 'running' && !(latest.where === 'cloud' && ACTIVE.has(latest.status)) && (
              <>
                {' '}
                <Button size="sm" icon={FileText} onClick={() => void openReport()} title={latest.where === 'cloud' ? '웹의 실행 상세(테스트 세트 리포트)를 브라우저로 엽니다' : '이 실행의 테스트 세트 리포트를 엽니다'} data-testid="testset-report">
                  리포트{latest.where === 'cloud' ? ' ↗' : ''}
                </Button>
              </>
            )}
          </>
        ) : (
          <span className="muted">아직 실행하지 않았습니다</span>
        )}
      </div>
      {running || (latestLocal && latest === local && !editing) ? (
        <ol className="compact-list" data-testid="testset-progress" data-status={latestLocal!.status}>
          {latestLocal!.items.map((i, n) => (
            <li key={n} data-testid="testset-progress-item" data-status={i.status}>
              <StatusBadge status={i.status} /> {label(i.script)}
              {i.alwaysRun && <> <span className="tag">항상 실행</span></>}
            </li>
          ))}
        </ol>
      ) : null}
      {!editing ? (
        <div className="small testset-order" data-testid="testset-order">
          {suite.scripts.length === 0 ? (
            <span className="muted">항목이 없습니다{editable ? ' — 편집에서 스크립트를 추가하세요' : ''}</span>
          ) : (
            suite.scripts.map((s, i) => (
              <span key={`${s}-${i}`} data-testid="testset-item" data-always={always.has(s) ? '1' : '0'}>
                {i > 0 && <span className="muted"> → </span>}
                {label(s)}
                {always.has(s) && <> <span className="tag">항상 실행</span></>}
              </span>
            ))
          )}
        </div>
      ) : (
        <div className="testset-edit" data-testid="testset-editor">
          <div className="inline">
            <label>
              이름{' '}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name !== suite.name && void patch({ name })}
                onKeyDown={(e) => e.key === 'Enter' && name.trim() && name !== suite.name && void patch({ name })}
                data-testid="testset-name-input"
              />
            </label>
            <label>
              환경{' '}
              <select value={suite.envId ?? ''} onChange={(e) => void patch({ envId: e.target.value })} data-testid="testset-env">
                <option value="">프로젝트 기본</option>
                {project.environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label title={project.cloud ? '이 PC 의 옵션입니다 (클라우드 실행은 실패해도 다음 항목으로 갑니다)' : undefined}>
              <input type="checkbox" checked={suite.stopOnFailure} onChange={(e) => void patch({ stopOnFailure: e.target.checked })} data-testid="testset-stop" /> 실패 시 중단
            </label>
          </div>
          <ol className="edit-items">
            {suite.scripts.map((s, i) => (
              <li key={`${s}-${i}`} className="edit-item" data-testid="testset-edit-item" data-path={s}>
                <span className="order">{i + 1}</span>
                <span className="grow">{label(s)}</span>
                <label className="small" title="앞 항목이 실패해 멈추거나 취소해도 실행합니다 (정리 스크립트용)">
                  <input
                    type="checkbox"
                    checked={always.has(s)}
                    onChange={(e) => void patch({ alwaysRun: e.target.checked ? [...always, s] : [...always].filter((x) => x !== s) })}
                    data-testid="testset-always"
                  />{' '}
                  항상 실행
                </label>{' '}
                <span className="item-actions">
                  <Button size="sm" icon={ArrowUp} disabled={i === 0} onClick={() => move(i, -1)} title="한 칸 위로" data-testid="testset-up">
                    위로
                  </Button>
                  <Button size="sm" icon={ArrowDown} disabled={i === suite.scripts.length - 1} onClick={() => move(i, 1)} title="한 칸 아래로" data-testid="testset-down">
                    아래로
                  </Button>
                  <Button size="sm" variant="danger" icon={X} onClick={() => void patch({ scripts: suite.scripts.filter((_x, j) => j !== i) })} title="이 테스트 세트에서 빼기 (스크립트는 지우지 않음)" data-testid="testset-remove">
                    빼기
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          <PickList
            testId="testset-picker"
            placeholder="추가할 스크립트를 이름이나 파일명으로 찾기"
            query={query}
            onQueryChange={setQuery}
            picked={picked}
            onPickedChange={setPicked}
            items={scripts.map((x) => ({
              key: x.path,
              label: label(x.path),
              search: `${x.name ?? ''}\n${x.path}`,
              ...(suite.scripts.includes(x.path) ? { note: <span className="tag sub">들어 있음</span> } : {}),
            }))}
          >
            <div>
            <Button
              icon={ListPlus}
              disabled={!picked.length}
              onClick={() => {
                // Checked scripts go to the end in the order they were checked.
                void patch({ scripts: [...suite.scripts, ...picked] }).then(() => {
                  setPicked([]);
                  setQuery('');
                });
              }}
              data-testid="testset-add"
            >
              {picked.length ? `선택한 ${picked.length}개 추가` : '항목 추가'}
            </Button>
            </div>
          </PickList>
          <div className="inline">
            <Button
              size="sm"
              variant="danger"
              icon={Trash}
              onClick={() => {
                if (window.confirm(`테스트 세트 “${suite.name}” 를 삭제할까요? 스크립트는 지우지 않습니다.`)) void remove(suite.id).catch((e: unknown) => setError(errText(e)));
              }}
              data-testid="testset-delete"
            >
              테스트 세트 삭제
            </Button>
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function TestSets({ project, scripts, active, where, nav, onChanged }: { project: ProjectView; scripts: ScriptEntry[]; active: boolean; where: RunWhere; nav: Nav; onChanged: (p: ProjectView) => void }) {
  const pid = project.id;
  const cv = project.cloudView;
  /** Cloud: suites are server settings (online + editor); local projects: always. */
  const editable = !cv || (cv.online && !cv.readOnly);
  const canRunPc = !cv || cv.canRun;
  const effWhere: RunWhere = project.cloud && cv?.canRun ? where : 'pc';
  const [localRuns, setLocalRuns] = useState<Record<string, SuiteRun>>({});
  const [cloudRuns, setCloudRuns] = useState<Record<string, CloudRunItem>>({});
  const [newName, setNewName] = useState<string | undefined>();
  const [fresh, setFresh] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const h = await window.euta.history.list(pid);
      const byId: Record<string, SuiteRun> = {};
      for (const r of h.suiteRuns) if (!byId[r.suiteId]) byId[r.suiteId] = r; // newest first
      setLocalRuns(byId);
      if (project.cloud) {
        const c = await window.euta.cloud.history(pid);
        const cb: Record<string, CloudRunItem> = {};
        for (const r of c.runs) if (r.kind === 'suite' && r.suiteId && (!cb[r.suiteId] || cb[r.suiteId]!.at < r.at)) cb[r.suiteId] = r;
        setCloudRuns(cb);
      }
    } catch (e) {
      setError(errText(e));
    }
  }, [pid, project.cloud]);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  useEffect(() => window.euta.suites.onUpdate((r) => r.projectId === pid && setLocalRuns((m) => ({ ...m, [r.suiteId]: r }))), [pid]);
  useEffect(() => window.euta.cloud.onRunsChanged((id) => id === pid && active && void refresh()), [pid, active, refresh]);

  // The new card has taken `startEditing` at mount; coming back to this view later opens no editor.
  useEffect(() => {
    if (fresh && project.suites.some((s) => s.id === fresh)) setFresh(undefined);
  }, [fresh, project.suites]);

  const save: Save = async (suiteId, patch) => {
    const v = await window.euta.suites.upsert(pid, suiteId, patch);
    onChanged(v);
    return v;
  };
  const remove = async (suiteId: string) => onChanged(await window.euta.suites.delete(pid, suiteId));
  const create = async () => {
    if (!newName?.trim()) return;
    setError(undefined);
    try {
      const before = new Set(project.suites.map((s) => s.id));
      const v = await save(undefined, { name: newName, scripts: [] });
      setFresh(v?.suites.find((s) => !before.has(s.id))?.id);
      setNewName(undefined);
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className="testsets" data-testid="testsets">
      <div className="inline between">
        <p className="muted small">
          여러 스크립트를 순서대로(직렬) 실행합니다. “항상 실행” 항목은 앞 항목이 실패해 멈추거나 취소해도 실행합니다(정리 스크립트용).
          {project.cloud && cv?.canRun ? ` 실행 위치: ${effWhere === 'cloud' ? '☁ 클라우드' : '이 PC'} (실행 탭에서 바꿉니다).` : ''}
        </p>
        {editable && newName === undefined && (
          <Button variant="primary" icon={Plus} onClick={() => setNewName('')} data-testid="testset-new">
            새 테스트 세트
          </Button>
        )}
      </div>
      {newName !== undefined && (
        <div className="inline card">
          <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} placeholder="테스트 세트 이름 (예: 로그인 점검)" data-testid="testset-new-name" />
          <Button variant="primary" icon={Check} disabled={!newName.trim()} onClick={() => void create()} data-testid="testset-new-create">
            만들기
          </Button>
          <Button icon={X} onClick={() => setNewName(undefined)}>
            취소
          </Button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {project.suites.map((s) => (
        <TestSetCard
          key={s.id}
          project={project}
          suite={s}
          scripts={scripts}
          where={effWhere}
          editable={editable}
          canRunPc={canRunPc}
          {...(localRuns[s.id] ? { latestLocal: localRuns[s.id] } : {})}
          {...(cloudRuns[s.id] ? { latestCloud: cloudRuns[s.id] } : {})}
          startEditing={fresh === s.id}
          save={save}
          remove={remove}
          nav={nav}
        />
      ))}
      {project.suites.length === 0 && <EmptyState icon={ListChecks} title="테스트 세트가 없습니다." {...(editable ? { description: '“새 테스트 세트” 로 만들거나, 스크립트 목록에서 여러 개를 골라 “테스트 세트에 넣기” 를 누르세요.' } : {})} />}
    </div>
  );
}
