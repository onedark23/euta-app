import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Clock, CloudUpload, ExternalLink, FileText, FolderOpen, RefreshCw, Search } from 'lucide-react';
import type { CloudHistoryView, CloudRunItem, HistoryItem, SuiteRun } from '../../../shared/types';
import { mergeHistory, rowSource } from '../../../shared/history-merge';
import { StatusBadge } from './LiveTab';
import { errText } from './ScriptsTab';
import { Badge, Button, EmptyState, IconButton, PageHeader } from '../ui';

interface CloudCtx {
  /** Upload this local run ("클라우드에 올리기"); undefined = not allowed here. */
  upload?: (r: HistoryItem) => void;
  uploads: Record<string, string>;
  busy?: string;
}

function RunRow({ r, projectId, onOpen, nested, cloud, uploadedAs }: { r: HistoryItem; projectId: string; onOpen: (id: string) => void; nested?: boolean; cloud?: CloudCtx; uploadedAs?: string }) {
  const open = async () => {
    const runId = await window.euta.history.open(projectId, r.id);
    if (runId) onOpen(runId);
  };
  const up = uploadedAs ?? cloud?.uploads[r.id];
  return (
    <tr data-testid="history-row" data-run-id={r.id} data-env={r.envName ?? ''} data-source="local" className={nested ? 'nested' : ''}>
      <td className="nowrap">{new Date(r.startedAt).toLocaleString()}</td>
      <td>
        {nested && <span className="muted">↳ </span>}
        {r.name}
        <div className="muted small">{r.id}</div>
      </td>
      <td>{r.envName ?? <span className="muted">—</span>}</td>
      <td className="nowrap">
        이 PC · {r.source === 'ai' ? 'AI' : r.source === 'mcp' ? 'MCP' : nested ? '테스트 세트' : '앱'}
        {up && (
          <span className="tag cloud-tag" data-testid="history-uploaded" title={`클라우드 실행 ${up}`}>
            ☁ 올림
          </span>
        )}
      </td>
      <td className="nowrap">이 PC</td>
      <td>
        <StatusBadge status={r.status} />
      </td>
      <td className="nowrap">
        {r.passed}/{r.total}
        {r.failed ? ` · ${r.failed}✗` : ''}
        {r.errors ? ` · ${r.errors}!` : ''}
        {r.skipped - (r.manual ?? 0) > 0 ? ` · ${r.skipped - (r.manual ?? 0)}↷` : ''}
        {r.manual ? (
          <>
            {' '}
            <Badge tone="manual" data-testid="history-manual" title="사람이 확인해야 하는 단계 (수동 확인)">
              수동 {r.manual}
            </Badge>
          </>
        ) : null}
      </td>
      <td>{r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : ''}</td>
      <td>
        <div className="row-actions">
        <Button size="sm" icon={FolderOpen} onClick={() => void open()}>
          열기
        </Button>
        <Button size="sm" icon={FileText} disabled={!r.hasReport} onClick={() => void window.euta.history.openReport(projectId, r.id, 'window')}>
          리포트
        </Button>
        <IconButton icon={ExternalLink} label="시스템 브라우저로 리포트 열기 (report.html)" disabled={!r.hasReport} onClick={() => void window.euta.history.openReport(projectId, r.id, 'browser')} />
        {cloud?.upload && !up && r.status !== 'running' && (
          <Button size="sm" icon={CloudUpload} onClick={() => cloud.upload!(r)} disabled={cloud.busy === r.id} data-testid="history-upload" title="이 로컬 실행의 결과 폴더를 클라우드 실행 이력에 올립니다 (출처 로컬 올림)">
            {cloud.busy === r.id ? '올리는 중…' : '클라우드에 올리기'}
          </Button>
        )}
        </div>
      </td>
    </tr>
  );
}

const SKIP_LABEL: Record<string, string> = { overlap: '겹침', missed: '놓침', 'daily-cap': '하루 실행 상한' };

/** A cloud run row: summary at once; "열기" downloads its result files (cache) and replays them. */
function CloudRow({ c, projectId, onOpen, nested, setNote }: { c: CloudRunItem; projectId: string; onOpen: (id: string) => void; nested?: boolean; setNote: (s: string | undefined) => void }) {
  const [busy, setBusy] = useState(false);
  const [kids, setKids] = useState<CloudRunItem[] | undefined>();
  const open = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const r = await window.euta.cloud.openRun(projectId, c.id);
      if (r.expired) setNote('파일 만료 — 보관 기간이 지나 결과 파일이 지워졌습니다. 요약만 실시간 탭에 보입니다.');
      onOpen(r.liveId);
    } catch (e) {
      setNote(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = async () => {
    if (kids) return setKids(undefined);
    try {
      setKids(await window.euta.cloud.runChildren(projectId, c.id));
    } catch (e) {
      setNote(errText(e));
    }
  };
  const src = rowSource({ kind: 'cloud', at: c.at, cloud: c });
  const s = c.summary;
  return (
    <>
      <tr data-testid="history-row" data-run-id={c.id} data-env={c.envName} data-source="cloud" data-cloud-source={c.source} data-files={c.resultFiles} className={`cloud-row${nested ? ' nested' : ''}`}>
        <td className="nowrap">{new Date(c.at).toLocaleString()}</td>
        <td>
          {nested && <span className="muted">↳ </span>}
          {c.kind === 'suite' && (
            <button className="link" onClick={() => void toggle()} aria-label={kids ? '접기' : '펼치기'} data-testid="history-cloud-expand">
              {kids ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            </button>
          )}{' '}
          {c.kind === 'suite' ? <b>테스트 세트: {c.name}</b> : c.name}
          <div className="muted small">
            ☁ {c.requestedBy}
            {c.scriptVersion ? ` · v${c.scriptVersion}` : ''}
            {c.localModified && (
              <span className="tag warn-tag" data-testid="history-local-modified">
                로컬 수정본
              </span>
            )}
            {c.attempt > 1 ? ' · 재실행' : ''}
            {c.skipReason ? ` · 건너뜀(${SKIP_LABEL[c.skipReason] ?? c.skipReason})` : ''}
          </div>
        </td>
        <td>{c.envName}</td>
        <td className="nowrap">
          <span className="tag cloud-tag">클라우드</span> {src.source.replace('클라우드 · ', '')}
        </td>
        <td className="nowrap" data-testid="history-location">
          {src.location}
        </td>
        <td>
          <StatusBadge status={c.flaky && c.status === 'passed' ? 'flaky' : c.status} />
        </td>
        <td className="nowrap">{s ? `${s.passed}/${s.total}${s.failed ? ` · ${s.failed}✗` : ''}${s.error ? ` · ${s.error}!` : ''}` : ''}</td>
        <td>{c.durationMs !== null ? `${(c.durationMs / 1000).toFixed(1)}s` : ''}</td>
        <td>
          <div className="row-actions">
          {c.resultFiles === 'expired' ? (
            <span className="muted small" data-testid="history-expired" title="보관 기간(30일)이 지나 결과 파일이 지워졌습니다 — 요약만 남아 있습니다">
              파일 만료
            </span>
          ) : null}
          <Button size="sm" icon={FolderOpen} onClick={() => void open()} disabled={busy} data-testid="history-cloud-open" title={c.resultFiles === 'present' ? '결과 파일을 내려받아(캐시) 엽니다' : '요약을 엽니다'}>
            {busy ? '받는 중…' : '열기'}
          </Button>
          {c.kind === 'suite' ? (
            <Button
              size="sm"
              icon={ExternalLink}
              disabled={c.status === 'queued' || c.status === 'leased' || c.status === 'running'}
              onClick={() => void window.euta.cloud.openWebRun(projectId, c.id).catch((e) => setNote(errText(e)))}
              title="웹의 실행 상세(테스트 세트 리포트)를 브라우저로 엽니다"
              data-testid="history-cloud-report"
            >
              리포트 ↗
            </Button>
          ) : (
            <Button size="sm" icon={FileText} disabled={c.resultFiles !== 'present'} onClick={() => void window.euta.cloud.openReport(projectId, c.id, 'window').catch((e) => setNote(errText(e)))} data-testid="history-cloud-report">
              리포트
            </Button>
          )}
          </div>
        </td>
      </tr>
      {kids?.map((k) => <CloudRow key={k.id} c={k} projectId={projectId} onOpen={onOpen} nested setNote={setNote} />)}
    </>
  );
}

export function HistoryTab({ projectId, active, onOpen, cloud }: { projectId: string; active: boolean; onOpen: (runId: string) => void; cloud?: boolean }) {
  const [data, setData] = useState<{ runs: HistoryItem[]; suiteRuns: SuiteRun[] }>({ runs: [], suiteRuns: [] });
  const [cloudData, setCloudData] = useState<CloudHistoryView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [uploading, setUploading] = useState<string | undefined>();
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [local, c] = await Promise.all([window.euta.history.list(projectId), cloud ? window.euta.cloud.history(projectId) : Promise.resolve(undefined)]);
      setData(local);
      setCloudData(c);
      setError(undefined);
    } catch (e) {
      setError(errText(e));
    }
  }, [projectId, cloud]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);
  useEffect(() => window.euta.suites.onUpdate((r) => r.projectId === projectId && r.status !== 'running' && void refresh()), [projectId, refresh]);
  // Cloud runs arrive through the project's feed (run.* events) — reload while the tab is shown.
  useEffect(() => window.euta.cloud.onRunsChanged((id) => id === projectId && active && void refresh()), [projectId, active, refresh]);

  const upload = async (r: HistoryItem) => {
    setUploading(r.id);
    setNote(undefined);
    try {
      const u = await window.euta.cloud.uploadRun(projectId, r.id);
      setNote(`클라우드에 올렸습니다 — ${u.localModified ? '로컬 수정본 (클라우드에 같은 내용의 버전이 없음)' : `클라우드 버전 v${u.version} 에 연결`}`);
      await refresh();
    } catch (e) {
      setNote(errText(e));
    } finally {
      setUploading(undefined);
    }
  };
  const cloudCtx: CloudCtx | undefined = cloud ? { uploads: cloudData?.uploads ?? {}, ...(cloudData?.canUpload ? { upload: (r: HistoryItem) => void upload(r) } : {}), ...(uploading ? { busy: uploading } : {}) } : undefined;

  const rows = useMemo(() => mergeHistory(data, cloudData?.runs, cloudData?.uploads ?? {}, filter), [data, cloudData, filter]);

  return (
    <div className="history">
      <PageHeader
        title="실행 이력"
        actions={
          <>
            <label className="search-box">
              <Search size={14} aria-hidden="true" />
              <input placeholder={cloud ? '찾기: 이름 / 상태 / 환경 / 클라우드' : '찾기: 이름 / 상태 / 환경'} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
            <Button variant="ghost" icon={RefreshCw} onClick={() => void refresh()} data-testid="history-refresh">
              새로고침
            </Button>
          </>
        }
      />
      {error && <div className="error">{error}</div>}
      {cloudData?.error && (
        <div className="muted small" data-testid="history-cloud-error">
          ☁ {cloudData.error}
        </div>
      )}
      {note && (
        <div className="banner" data-testid="history-note">
          {note}
        </div>
      )}
      <div className="table-card">
      <table className="history-table">
        <thead>
          <tr>
            <th>시작</th>
            <th>이름</th>
            <th>환경</th>
            <th>출처</th>
            <th>실행 위치</th>
            <th>상태</th>
            <th>단계</th>
            <th>소요 시간</th>
            <th>동작</th>
          </tr>
        </thead>
        <tbody data-testid="history-rows">
          {rows.map((row) =>
            row.kind === 'cloud' ? (
              <CloudRow key={row.cloud.id} c={row.cloud} projectId={projectId} onOpen={onOpen} setNote={setNote} />
            ) : row.kind === 'run' ? (
              <RunRow key={row.run.id} r={row.run} projectId={projectId} onOpen={onOpen} {...(cloudCtx ? { cloud: cloudCtx } : {})} {...(row.uploadedAs ? { uploadedAs: row.uploadedAs } : {})} />
            ) : (
              <Fragment key={row.suite.id}>
                <tr className="suite-row" data-testid="history-suite" data-suite-run-id={row.suite.id} data-status={row.suite.status} onClick={() => setOpen((s) => new Set(s.has(row.suite.id) ? [...s].filter((x) => x !== row.suite.id) : [...s, row.suite.id]))}>
                  <td className="nowrap">{new Date(row.suite.startedAt).toLocaleString()}</td>
                  <td>
                    {open.has(row.suite.id) ? <ChevronDown className="lead-icon" size={16} aria-hidden="true" /> : <ChevronRight className="lead-icon" size={16} aria-hidden="true" />} <b>테스트 세트: {row.suite.suiteName}</b>
                    <div className="muted small">
                      스크립트 {row.suite.items.length}개{row.suite.stopOnFailure ? ' · 실패 시 중단' : ''}
                      {row.suite.items.some((i) => i.alwaysRun) ? ` · 항상 실행 ${row.suite.items.filter((i) => i.alwaysRun).length}` : ''}
                      {row.suite.cancelled ? ' · 취소됨' : ''}
                      {row.suite.interrupted ? ' · 앱 종료로 중단' : ''}
                    </div>
                  </td>
                  <td>{row.suite.envName}</td>
                  <td>이 PC · 테스트 세트</td>
                  <td>이 PC</td>
                  <td>
                    <StatusBadge status={row.suite.status} />
                  </td>
                  <td className="nowrap">
                    {row.suite.items.filter((i) => i.status === 'passed').length}/{row.suite.items.length}
                    {row.suite.items.some((i) => i.status === 'skipped') ? ` · ${row.suite.items.filter((i) => i.status === 'skipped').length}↷` : ''}
                  </td>
                  <td>{row.suite.finishedAt ? `${((new Date(row.suite.finishedAt).getTime() - new Date(row.suite.startedAt).getTime()) / 1000).toFixed(1)}s` : ''}</td>
                  <td className="nowrap">
                    {row.suite.status !== 'running' && (
                      <Button
                        size="sm"
                        icon={FileText}
                        onClick={(e) => {
                          e.stopPropagation();
                          setNote(undefined);
                          void window.euta.suites
                            .openReport(projectId, row.suite.id)
                            .then((ok) => !ok && setNote('리포트를 만들 수 없습니다'))
                            .catch((err: unknown) => setNote(errText(err)));
                        }}
                        title="테스트 세트 리포트 (요약 · 지난 실행 대비 · 실패 상세)"
                        data-testid="history-suite-report"
                      >
                        리포트
                      </Button>
                    )}
                  </td>
                </tr>
                {open.has(row.suite.id) && row.runs.map((r) => <RunRow key={r.id} r={r} projectId={projectId} onOpen={onOpen} nested {...(cloudCtx ? { cloud: cloudCtx } : {})} />)}
              </Fragment>
            ),
          )}
        </tbody>
      </table>
      {rows.length === 0 && <EmptyState icon={Clock} title="이 프로젝트에 실행 기록이 아직 없습니다." />}
      </div>
    </div>
  );
}
