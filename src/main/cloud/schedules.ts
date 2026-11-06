// 예약 tab of a cloud project (SPEC 클라우드-앱-연동 "예약 탭" → SPEC 클라우드-실행-예약 "예약"): list with next
// run / last run / duration warning, create · edit · on/off · delete (editor+; the server decides).
// Scripts are addressed by path in the app and by id on the server (working-copy state maps them).
import type { CloudCadence, CloudScheduleForm, CloudScheduleView } from '../../shared/types.js';
import { InputError } from '../project/project-store.js';
import type { ProjectService } from '../project/service.js';
import type { CloudClient } from './client.js';
import type { ScheduleDto } from './types.js';
import { compactId, expandId, type WorkingCopy } from './workcopy.js';

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** "매시간 05분" · "매일 09:00" · "평일 09:00" · "매주 월 09:00" · "cron 0 9 * * 1-5" (Asia/Seoul). */
export function cadenceLabel(c: CloudCadence): string {
  switch (c.kind) {
    case 'hourly':
      return `매시간 ${String(c.minute).padStart(2, '0')}분`;
    case 'daily':
      return `매일 ${c.time}`;
    case 'weekdays':
      return `평일 ${c.time}`;
    case 'weekly':
      return `매주 ${DAYS[c.dayOfWeek] ?? '?'} ${c.time}`;
    case 'cron':
      return `cron ${c.expression}`;
  }
}

const minutes = (ms: number): string => (ms > 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}시간` : `${Math.round(ms / 60_000)}분`);

export function scheduleView(dto: ScheduleDto): CloudScheduleView {
  return {
    id: dto.id,
    name: dto.name,
    target: dto.target.kind === 'script' ? { kind: 'script', path: dto.target.script.path } : { kind: 'suite', ...(dto.target.suite.id ? { suiteId: compactId(dto.target.suite.id) } : {}), name: dto.target.suite.name },
    ...(dto.environment.id ? { envId: compactId(dto.environment.id) } : {}),
    envName: dto.environment.name,
    cadence: dto.cadence,
    cadenceLabel: cadenceLabel(dto.cadence),
    cron: dto.cron,
    timeLimitSec: dto.timeLimitSec,
    retryOnFailure: dto.retryOnFailure,
    enabled: dto.enabled,
    disabledReason: dto.disabledReason,
    nextRunAt: dto.nextRunAt,
    intervalMin: dto.intervalMin,
    createdBy: dto.createdBy.label,
    lastRun: dto.lastRun,
    ...(dto.durationWarning ? { warning: `최근 3회 평균 실행 시간(${minutes(dto.durationWarning.avgDurationMs)})이 예약 간격(${minutes(dto.durationWarning.intervalMs)})보다 깁니다 — 다음 회차가 겹쳐 건너뛸 수 있습니다` } : {}),
  };
}

export interface CloudSchedulesHost {
  call<T>(fn: (c: CloudClient) => Promise<T>): Promise<T>;
  cloudId(id: string): string;
  wc(id: string): WorkingCopy;
  projects: ProjectService;
  changed(id: string): void;
}

export class CloudSchedules {
  constructor(private readonly host: CloudSchedulesHost) {}

  async list(id: string): Promise<CloudScheduleView[]> {
    const pid = this.host.cloudId(id);
    return (await this.host.call((c) => c.schedules(pid))).map(scheduleView);
  }

  /** Form → server body: script path → script id (must be on the server), app ids → UUIDs. */
  private body(id: string, f: CloudScheduleForm, create: boolean): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    if (f.name !== undefined) b.name = String(f.name).trim();
    if (f.script !== undefined && f.script) {
      const sid = this.host.wc(id).state().scripts[f.script]?.id;
      if (!sid) throw new InputError(`아직 클라우드에 없는 스크립트입니다: ${f.script} — 먼저 보내세요`);
      b.scriptId = sid;
    } else if (f.suiteId) b.suiteId = expandId(f.suiteId);
    if (create && !b.scriptId && !b.suiteId) throw new InputError('예약할 스크립트나 테스트 세트를 고르세요');
    if (f.envId) b.environmentId = expandId(f.envId);
    if (f.cadence !== undefined) b.cadence = f.cadence;
    if (f.timeLimitSec !== undefined) b.timeLimitSec = f.timeLimitSec;
    if (f.retryOnFailure !== undefined) b.retryOnFailure = !!f.retryOnFailure;
    if (f.enabled !== undefined) b.enabled = !!f.enabled;
    return b;
  }

  async save(id: string, scheduleId: string | undefined, f: CloudScheduleForm): Promise<CloudScheduleView[]> {
    const pid = this.host.cloudId(id);
    const body = this.body(id, f, !scheduleId);
    const dto = scheduleId ? await this.host.call((c) => c.patchSchedule(pid, scheduleId, body)) : await this.host.call((c) => c.createSchedule(pid, body));
    const what = scheduleId ? (Object.keys(body).length === 1 && 'enabled' in body ? (body.enabled ? '켬' : '끔') : '수정') : '추가';
    this.host.projects.log(id, 'schedule.changed', 'user', `클라우드 예약 ${what}: ${dto.name} — ${cadenceLabel(dto.cadence)}`, {});
    this.host.changed(id);
    return this.list(id);
  }

  async remove(id: string, scheduleId: string): Promise<CloudScheduleView[]> {
    const pid = this.host.cloudId(id);
    await this.host.call((c) => c.deleteSchedule(pid, scheduleId));
    this.host.projects.log(id, 'schedule.changed', 'user', '클라우드 예약 삭제', {});
    this.host.changed(id);
    return this.list(id);
  }
}
