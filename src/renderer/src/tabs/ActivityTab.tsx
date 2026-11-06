import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, ScrollText, RefreshCw } from 'lucide-react';
import type { ActivityActor, ActivityEvent, CloudActivityView } from '../../../shared/types';
import type { Nav } from '../App';
import { errText } from './ScriptsTab';
import { Button, EmptyState, PageHeader } from '../ui';

const GROUPS: { id: string; label: string; kinds: string[] }[] = [
  { id: '', label: '전체', kinds: [] },
  { id: 'run', label: '실행', kinds: ['run.started', 'run.finished'] },
  { id: 'suite', label: '테스트 세트', kinds: ['suite.started', 'suite.finished'] },
  { id: 'chat', label: 'AI 대화', kinds: ['chat.started', 'chat.turn'] },
  { id: 'recording', label: '시연 녹화', kinds: ['recording.started', 'recording.finished', 'recording.converted'] },
  { id: 'tcdoc', label: 'TC 문서', kinds: ['tcdoc.imported', 'tcdoc.converted', 'tcdoc.exported', 'tcdoc.deleted'] },
  { id: 'script', label: '스크립트', kinds: ['script.created', 'script.imported', 'script.renamed', 'script.deleted', 'script.changed'] },
  { id: 'settings', label: '설정', kinds: ['project.created', 'project.updated', 'env.created', 'env.updated', 'env.deleted', 'secret.set', 'secret.removed', 'settings.changed'] },
];
const ACTORS: { id: '' | ActivityActor; label: string }[] = [
  { id: '', label: '모든 행위자' },
  { id: 'user', label: '사용자' },
  { id: 'ai', label: 'AI 채팅' },
  { id: 'mcp', label: '외부 MCP' },
  { id: 'suite', label: '테스트 세트' },
];

/** Project activity timeline (SPEC "작업 로그 타임라인"): newest first, kind/actor filters, click → target. */
export function ActivityTab({ projectId, active, nav, cloud }: { projectId: string; active: boolean; nav: Nav; cloud?: boolean }) {
  const [items, setItems] = useState<ActivityEvent[]>([]);
  const [shared, setShared] = useState<CloudActivityView[]>([]);
  const [group, setGroup] = useState('');
  const [actor, setActor] = useState<'' | ActivityActor>('');
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const kinds = GROUPS.find((g) => g.id === group)?.kinds ?? [];
      setItems(await window.euta.activity.list(projectId, { ...(kinds.length ? { kinds } : {}), ...(actor ? { actors: [actor] } : {}), limit: 1000 }));
      setError(undefined);
    } catch (e) {
      setError(errText(e));
    }
  }, [projectId, group, actor]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  // Cloud project: the shared (server) log of every member, next to this PC's log.
  useEffect(() => {
    if (active && cloud) void window.euta.cloud.activity(projectId).then(setShared, () => setShared([]));
  }, [active, cloud, projectId, items]);
  useEffect(() => window.euta.activity.onAppended((id) => id === projectId && active && void refresh()), [projectId, active, refresh]);

  const go = (e: ActivityEvent) => {
    if (e.ref?.runId) nav.openHistoryRun(e.ref.runId);
    else if (e.ref?.chatId) nav.openChat(e.ref.chatId);
    else if (e.ref?.script) nav.openScript(e.ref.script);
  };

  return (
    <div className="activity" data-testid="activity-tab">
      <PageHeader
        title="작업 로그"
        actions={
        <>
          <select value={group} onChange={(e) => setGroup(e.target.value)} data-testid="activity-kind">
            {GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
          <select value={actor} onChange={(e) => setActor(e.target.value as '' | ActivityActor)} data-testid="activity-actor">
            {ACTORS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <Button variant="ghost" icon={RefreshCw} onClick={() => void refresh()}>
            새로고침
          </Button>
        </>
        }
      />
      {error && <div className="error">{error}</div>}
      <ul className="timeline-list card" data-testid="activity-list" hidden={items.length === 0}>
        {items.map((e, i) => {
          const link = !!(e.ref?.runId || e.ref?.chatId || e.ref?.script);
          return (
            <li key={`${e.at}-${i}`} data-testid="activity-item" data-kind={e.kind} data-actor={e.actor} className={link ? 'link-row' : ''} onClick={() => link && go(e)}>
              <span className="muted small nowrap">{new Date(e.at).toLocaleString()}</span>
              <span className={`tag actor-${e.actor}`}>{ACTORS.find((a) => a.id === e.actor)?.label ?? e.actor}</span>
              <code className="small">{e.kind}</code>
              <span className="summary">{e.summary}</span>
              {link && <ChevronRight className="muted" size={16} aria-hidden="true" />}
            </li>
          );
        })}
      </ul>
      {items.length === 0 && <EmptyState icon={ScrollText} title="기록이 없습니다." />}
      {cloud && (
        <>
          <h3>클라우드 작업 로그 (구성원 전체)</h3>
          <ul className="timeline-list card" data-testid="cloud-activity-list" hidden={shared.length === 0}>
            {shared.map((e, i) => (
              <li key={`${e.at}-${i}`} data-testid="cloud-activity-item" data-kind={e.kind}>
                <span className="muted small nowrap">{new Date(e.at).toLocaleString()}</span>
                <span className="tag actor-user">{e.actor}</span>
                <code className="small">{e.kind}</code>
                <span className="summary">{e.summary}</span>
              </li>
            ))}
          </ul>
          {shared.length === 0 && <p className="muted small">기록이 없거나 오프라인입니다.</p>}
        </>
      )}
    </div>
  );
}
