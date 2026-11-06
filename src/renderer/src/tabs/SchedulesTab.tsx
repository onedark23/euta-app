// 예약 tab of a cloud project (SPEC 클라우드-앱-연동 "예약 탭"): the same list / editor as the web — next run,
// last run, duration warning, create · edit · on/off · delete (editor+; viewers read only). Runs keep going
// while this app is closed (the server's scheduler fires them).
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Check, Cloud, Pencil, Plus, RefreshCw, Trash, TriangleAlert, X } from 'lucide-react';
import type { CloudCadence, CloudScheduleForm, CloudScheduleView, ProjectView, ScriptEntry } from '../../../shared/types';
import { StatusBadge } from './LiveTab';
import { errText } from './ScriptsTab';
import { Button, EmptyState, PageHeader, Switch } from '../ui';

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

type Draft = { id?: string; name: string; target: string; envId: string; kind: CloudCadence['kind']; minute: number; time: string; dayOfWeek: number; expression: string; timeLimitMin: string; retry: boolean; enabled: boolean };

const emptyDraft = (project: ProjectView, firstScript?: string): Draft => ({
  name: '',
  target: firstScript ? `script:${firstScript}` : project.suites[0] ? `suite:${project.suites[0].id}` : '',
  envId: project.defaultEnvId ?? '',
  kind: 'daily',
  minute: 0,
  time: '09:00',
  dayOfWeek: 1,
  expression: '0 9 * * 1-5',
  timeLimitMin: '',
  retry: false,
  enabled: true,
});

function toDraft(s: CloudScheduleView): Draft {
  const c = s.cadence;
  return {
    id: s.id,
    name: s.name,
    target: s.target.kind === 'script' ? `script:${s.target.path ?? ''}` : `suite:${s.target.suiteId ?? ''}`,
    envId: s.envId ?? '',
    kind: c.kind,
    minute: c.kind === 'hourly' ? c.minute : 0,
    time: 'time' in c ? c.time : '09:00',
    dayOfWeek: c.kind === 'weekly' ? c.dayOfWeek : 1,
    expression: c.kind === 'cron' ? c.expression : s.cron,
    timeLimitMin: s.timeLimitSec ? String(Math.round(s.timeLimitSec / 60)) : '',
    retry: s.retryOnFailure,
    enabled: s.enabled,
  };
}

function cadenceOf(d: Draft): CloudCadence {
  switch (d.kind) {
    case 'hourly':
      return { kind: 'hourly', minute: d.minute };
    case 'weekly':
      return { kind: 'weekly', dayOfWeek: d.dayOfWeek, time: d.time };
    case 'cron':
      return { kind: 'cron', expression: d.expression };
    default:
      return { kind: d.kind, time: d.time };
  }
}

function formOf(d: Draft): CloudScheduleForm {
  const [k, v] = [d.target.slice(0, d.target.indexOf(':')), d.target.slice(d.target.indexOf(':') + 1)];
  const min = Number(d.timeLimitMin);
  return {
    name: d.name,
    ...(k === 'script' ? { script: v } : { suiteId: v }),
    ...(d.envId ? { envId: d.envId } : {}),
    cadence: cadenceOf(d),
    timeLimitSec: d.timeLimitMin.trim() && Number.isFinite(min) && min > 0 ? Math.round(min * 60) : null,
    retryOnFailure: d.retry,
    enabled: d.enabled,
  };
}

function Editor({ project, scripts, draft, onCancel, onSaved }: { project: ProjectView; scripts: ScriptEntry[]; draft: Draft; onCancel: () => void; onSaved: (l: CloudScheduleView[]) => void }) {
  const [d, setD] = useState(draft);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await window.euta.cloud.saveSchedule(project.id, d.id, formOf(d)));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" data-testid="schedule-editor">
      <div className="grid2">
        <div className="form-row">
          <label>이름</label>
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} placeholder="예: 매일 아침 로그인" data-testid="schedule-name" />
        </div>
        <div className="form-row">
          <label>대상</label>
          <select value={d.target} onChange={(e) => set({ target: e.target.value })} data-testid="schedule-target">
            {scripts.map((s) => (
              <option key={s.path} value={`script:${s.path}`} disabled={!s.cloud?.version || s.cloud.pending}>
                {s.path}
                {s.cloud?.pending ? ' (보내기 대기)' : !s.cloud?.version ? ' (클라우드에 없음)' : ''}
              </option>
            ))}
            {project.suites.map((s) => (
              <option key={s.id} value={`suite:${s.id}`}>
                테스트 세트: {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>환경</label>
          <select value={d.envId} onChange={(e) => set({ envId: e.target.value })} data-testid="schedule-env">
            <option value="">(테스트 세트·프로젝트 기본)</option>
            {project.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>주기 (Asia/Seoul, 최소 10분 간격)</label>
          <div className="inline">
            <select value={d.kind} onChange={(e) => set({ kind: e.target.value as Draft['kind'] })} data-testid="schedule-kind">
              <option value="hourly">매시간</option>
              <option value="daily">매일</option>
              <option value="weekdays">평일</option>
              <option value="weekly">매주</option>
              <option value="cron">직접 입력 (cron)</option>
            </select>
            {d.kind === 'hourly' && (
              <label>
                <input type="number" min={0} max={59} value={d.minute} onChange={(e) => set({ minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })} data-testid="schedule-minute" className="num" />분
              </label>
            )}
            {d.kind === 'weekly' && (
              <select value={d.dayOfWeek} onChange={(e) => set({ dayOfWeek: Number(e.target.value) })} data-testid="schedule-dow">
                {DAYS.map((x, i) => (
                  <option key={i} value={i}>
                    {x}요일
                  </option>
                ))}
              </select>
            )}
            {(d.kind === 'daily' || d.kind === 'weekdays' || d.kind === 'weekly') && <input type="time" value={d.time} onChange={(e) => set({ time: e.target.value })} data-testid="schedule-time" />}
            {d.kind === 'cron' && <input value={d.expression} onChange={(e) => set({ expression: e.target.value })} placeholder="분 시 일 월 요일" data-testid="schedule-cron" />}
          </div>
        </div>
        <div className="form-row">
          <label>시간 제한 (분, 비우면 프로젝트 기본 6시간 · 최대 24시간)</label>
          <input value={d.timeLimitMin} onChange={(e) => set({ timeLimitMin: e.target.value.replace(/[^\d.]/g, '') })} data-testid="schedule-limit" />
        </div>
        <div className="form-row checks">
          <label>
            <input type="checkbox" checked={d.retry} onChange={(e) => set({ retry: e.target.checked })} data-testid="schedule-retry" /> 실패 시 1회 재실행 (재실행이 통과하면 "불안정")
          </label>
          <Switch checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="schedule-enabled" label="켜짐" />
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="inline">
        <Button variant="primary" icon={Check} disabled={busy || !d.name.trim() || !d.target} onClick={() => void save()} data-testid="schedule-save">
          {d.id ? '예약 저장' : '예약 추가'}
        </Button>
        <Button icon={X} onClick={onCancel}>
          취소
        </Button>
      </div>
    </div>
  );
}

export function SchedulesTab({ project, active }: { project: ProjectView; active: boolean }) {
  const [list, setList] = useState<CloudScheduleView[] | undefined>();
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState<Draft | undefined>();
  const editable = !project.cloudView?.readOnly && !!project.cloudView?.online && (project.cloudView?.can.length ? project.cloudView.can.includes('schedule.manage') : true);
  const pid = project.id;

  const refresh = useCallback(async () => {
    try {
      const [l, s] = await Promise.all([window.euta.cloud.schedules(pid), window.euta.scripts.list(pid)]);
      setList(l);
      setScripts(s);
      setError(undefined);
    } catch (e) {
      setError(errText(e));
    }
  }, [pid]);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  useEffect(() => window.euta.cloud.onRunsChanged((id) => id === pid && active && void refresh()), [pid, active, refresh]);

  const act = async (fn: () => Promise<CloudScheduleView[]>) => {
    setError(undefined);
    try {
      setList(await fn());
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className="schedules" data-testid="schedules">
      <PageHeader
        title="예약"
        actions={
          <>
            <Button variant="ghost" icon={RefreshCw} onClick={() => void refresh()} data-testid="schedules-refresh">
              새로고침
            </Button>
            {editable && !editing && (
              <Button variant="primary" icon={Plus} onClick={() => setEditing(emptyDraft(project, scripts.find((s) => s.cloud?.version && !s.cloud.pending)?.path))} data-testid="schedule-new">
                예약 추가
              </Button>
            )}
          </>
        }
      />
      <p className="muted small" data-testid="schedules-note">
        <Cloud className="lead-icon" size={14} aria-hidden="true" /> 예약은 euta cloud 서버가 정해진 시각에 실행합니다 — 이 앱이나 PC 가 꺼져 있어도 돕니다. 결과는 실행 이력에 &ldquo;클라우드 · 예약&rdquo; 으로 보이고, 실패·회복은 Teams·앱 알림으로 옵니다.
        {!editable && (project.cloudView?.readOnly ? ' 보기 역할은 예약을 바꿀 수 없습니다.' : !project.cloudView?.online ? ' 오프라인 — 다시 연결되면 바꿀 수 있습니다.' : '')}
      </p>
      {error && <div className="error">{error}</div>}
      {editing && (
        <Editor
          project={project}
          scripts={scripts}
          draft={editing}
          onCancel={() => setEditing(undefined)}
          onSaved={(l) => {
            setList(l);
            setEditing(undefined);
          }}
        />
      )}
      <div className="table-card">
      <table className="history-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>대상</th>
            <th>환경</th>
            <th>주기</th>
            <th>다음 실행</th>
            <th>마지막 실행</th>
            <th>상태</th>
            <th>동작</th>
          </tr>
        </thead>
        <tbody>
          {(list ?? []).map((s) => (
            <tr key={s.id} data-testid="schedule-row" data-schedule-id={s.id} data-enabled={s.enabled ? '1' : '0'}>
              <td>
                {s.name}
                <div className="muted small">
                  {s.createdBy}
                  {s.retryOnFailure ? ' · 실패 시 1회 재실행' : ''}
                  {s.timeLimitSec ? ` · 제한 ${Math.round(s.timeLimitSec / 60)}분` : ''}
                </div>
                {s.warning && (
                  <div className="warn small inline" data-testid="schedule-warning">
                    <TriangleAlert size={14} aria-hidden="true" /> {s.warning}
                  </div>
                )}
              </td>
              <td>{s.target.kind === 'script' ? (s.target.path ?? '(삭제된 스크립트)') : `테스트 세트: ${s.target.name ?? '(삭제됨)'}`}</td>
              <td>{s.envName ?? '—'}</td>
              <td className="nowrap">{s.cadenceLabel}</td>
              <td className="nowrap" data-testid="schedule-next">
                {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}
              </td>
              <td className="nowrap">{s.lastRun ? <StatusBadge status={s.lastRun.skipReason ? 'skipped' : s.lastRun.flaky ? 'flaky' : s.lastRun.status} /> : <span className="muted">—</span>}</td>
              <td className="nowrap">
                {editable ? (
                  <Switch checked={s.enabled} onChange={(e) => void act(() => window.euta.cloud.saveSchedule(pid, s.id, { enabled: e.target.checked }))} data-testid="schedule-toggle" label={s.enabled ? '켜짐' : '꺼짐'} />
                ) : s.enabled ? (
                  '켜짐'
                ) : (
                  '꺼짐'
                )}
                {s.disabledReason && <div className="muted small">{s.disabledReason === 'project_trashed' ? '프로젝트 휴지통 — 자동 꺼짐' : s.disabledReason}</div>}
              </td>
              <td>
                {editable && (
                  <div className="row-actions">
                    <Button size="sm" icon={Pencil} onClick={() => setEditing(toDraft(s))} data-testid="schedule-edit">
                      편집
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon={Trash}
                      onClick={() => {
                        if (window.confirm(`예약 "${s.name}" 를 삭제할까요?`)) void act(() => window.euta.cloud.deleteSchedule(pid, s.id));
                      }}
                      data-testid="schedule-delete"
                    >
                      삭제
                    </Button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list && list.length === 0 && <EmptyState icon={CalendarClock} title="예약이 없습니다." />}
      </div>
    </div>
  );
}
