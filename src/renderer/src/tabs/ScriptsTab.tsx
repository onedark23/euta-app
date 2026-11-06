import { useCallback, useEffect, useState } from 'react';
import { Check, Cloud, Eye, FileCode, FileDown, FilePlus, FileSpreadsheet, FileText, Import, ListPlus, Pencil, Play, RefreshCw, RotateCcw, Save, ShieldCheck, Sparkles, Trash, Upload, Video, X } from 'lucide-react';
import type { DeletedScript, ProjectView, RecordingSummary, ScriptCheck, ScriptEntry } from '../../../shared/types';
import type { Nav } from '../App';
import { StatusBadge } from './LiveTab';
import type { RunWhere } from './RunTab';
import { ScriptDetail } from './ScriptDetail';
import { TestSets } from './TestSets';
import { TcDocsView, TcExportDialog } from './TcDocs';
import { hasUnsaved } from '../unsaved';
import { Badge, Button, EmptyState, PageHeader, Tabs } from '../ui';

export const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '');

/**
 * Project script library (SPEC "스크립트 라이브러리"): list, create, import, rename, delete, export, validate, run, open.
 * Top toggle [스크립트 | 테스트 세트] (SPEC "테스트 세트"): sets are made, edited and run here; checked scripts
 * go into a set with "테스트 세트에 넣기".
 */
export function ScriptsTab({ project, active, focus, nav, runWhere, onProjectChanged }: { project: ProjectView; active: boolean; focus?: { path: string; n: number }; nav: Nav; runWhere: RunWhere; onProjectChanged: (p: ProjectView) => void }) {
  const [view, setView] = useState<'scripts' | 'sets' | 'tcdocs'>('scripts');
  /** "TC 문서로 만들기" → the TC 문서 view opens the file picker. */
  const [tcImport, setTcImport] = useState<number | undefined>();
  const [tcDocCount, setTcDocCount] = useState(0);
  const [exportPicked, setExportPicked] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [into, setInto] = useState('');
  const [intoName, setIntoName] = useState('');
  const [list, setList] = useState<ScriptEntry[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [checks, setChecks] = useState<Record<string, ScriptCheck>>({});
  const [renaming, setRenaming] = useState<{ path: string; to: string } | undefined>();
  const [creating, setCreating] = useState<string | undefined>();
  const [hl, setHl] = useState<string | undefined>();
  const [recs, setRecs] = useState<RecordingSummary[]>([]);
  const [recRename, setRecRename] = useState<{ id: string; to: string } | undefined>();
  const [detailPath, setDetailPath] = useState<string | undefined>();
  const [deleted, setDeleted] = useState<DeletedScript[]>([]);
  const pid = project.id;
  /** Cloud viewer: editing and running are hidden (SPEC 클라우드-앱-연동 "보기"). */
  const readOnly = !!project.cloudView?.readOnly;
  /** Cloud runner (실행 전용) and up may run; a viewer may not. */
  const canRun = !project.cloudView || project.cloudView.canRun;
  /** Test sets are server settings on a cloud project: online + editor. */
  const setsEditable = !project.cloudView || (project.cloudView.online && !project.cloudView.readOnly);

  const refresh = useCallback(async () => {
    try {
      setList(await window.euta.scripts.list(pid));
      setDeleted(await window.euta.scripts.deleted(pid));
    } catch (e) {
      setError(errText(e));
    }
  }, [pid]);

  const refreshRecs = useCallback(async () => {
    try {
      setRecs(await window.euta.recordings.list(pid));
    } catch (e) {
      setError(errText(e));
    }
  }, [pid]);

  useEffect(() => {
    if (active) {
      void refresh();
      void refreshRecs();
    }
  }, [active, refresh, refreshRecs]);
  useEffect(() => {
    const count = () => void window.euta.tcDocs.list(pid).then((l) => setTcDocCount(l.length), () => undefined);
    if (active) count();
    return window.euta.tcDocs.onChanged((p) => p === pid && count());
  }, [active, pid]);
  useEffect(() => window.euta.recordings.onUpdate((v) => v.projectId === pid && v.status === 'stopped' && void refreshRecs()), [pid, refreshRecs]);
  // File changes (outside editor, AI chat) refresh the list.
  useEffect(() => window.euta.scripts.onChanged((id) => id === pid && void refresh()), [pid, refresh]);
  useEffect(() => {
    if (!focus) return;
    setHl(focus.path);
    setView('scripts');
    if (!hasUnsaved()) setDetailPath(undefined);
  }, [focus]);
  useEffect(() => setPicked((p) => p.filter((x) => list.some((s) => s.path === x))), [list]);

  /** "테스트 세트에 넣기": append the checked scripts (list order, not already in the set) or make a new set. */
  const putIntoSet = () =>
    act(async () => {
      const order = list.map((s) => s.path).filter((p) => picked.includes(p));
      let name: string;
      if (into === '__new__') {
        name = intoName.trim();
        onProjectChanged(await window.euta.suites.upsert(pid, undefined, { name, scripts: order }));
      } else {
        const s = project.suites.find((x) => x.id === into);
        if (!s) throw new Error('테스트 세트를 고르세요');
        name = s.name;
        onProjectChanged(await window.euta.suites.upsert(pid, s.id, { scripts: [...s.scripts, ...order.filter((p) => !s.scripts.includes(p))] }));
      }
      setPicked([]);
      setIntoName('');
      setInto('');
      setNote(`테스트 세트 “${name}” 에 ${order.length}개를 넣었습니다`);
    });

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(undefined);
    setNote(undefined);
    try {
      await fn();
      if (done) setNote(done);
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  };

  const validate = async (path: string) => {
    try {
      const c = await window.euta.scripts.check(pid, path, project.defaultEnvId, '', '');
      setChecks((m) => ({ ...m, [path]: c }));
    } catch (e) {
      setError(errText(e));
    }
  };

  if (detailPath) {
    return (
      <div className="scripts" data-testid="scripts-tab">
        <ScriptDetail
          key={detailPath}
          project={project}
          path={detailPath}
          nav={nav}
          onBack={() => {
            setHl(detailPath);
            setDetailPath(undefined);
            void refresh();
          }}
        />
      </div>
    );
  }

  const toggle = (
    <div className="view-toggle">
      <Tabs
        asTablist
        testId="scripts-view"
        items={[
          { key: 'scripts', label: '스크립트', testId: 'scripts-view-scripts' },
          { key: 'sets', label: `테스트 세트${project.suites.length ? ` (${project.suites.length})` : ''}`, testId: 'scripts-view-sets' },
          { key: 'tcdocs', label: `TC 문서${tcDocCount ? ` (${tcDocCount})` : ''}`, testId: 'scripts-view-tcdocs', title: '자연어 TC 문서를 가져와 스크립트로 변환합니다' },
        ]}
        active={view}
        onSelect={(k) => setView(k as 'scripts' | 'sets' | 'tcdocs')}
      />
    </div>
  );

  if (view === 'tcdocs') {
    return (
      <div className="scripts" data-testid="scripts-tab">
        {toggle}
        <TcDocsView project={project} active={active && view === 'tcdocs'} nav={nav} {...(tcImport ? { importRequest: tcImport } : {})} onProjectChanged={onProjectChanged} onShowSets={() => setView('sets')} />
      </div>
    );
  }

  if (view === 'sets') {
    return (
      <div className="scripts" data-testid="scripts-tab">
        {toggle}
        <PageHeader title="테스트 세트" />
        <TestSets project={project} scripts={list} active={active} where={runWhere} nav={nav} onChanged={onProjectChanged} />
      </div>
    );
  }

  return (
    <div className="scripts" data-testid="scripts-tab">
      {toggle}
      <PageHeader
        title="스크립트"
        actions={
          <>
            {!readOnly && (
              <>
                <Button variant="primary" icon={Video} onClick={() => nav.startRecording()} data-testid="script-record" title="사이트를 직접 시연하면 스크립트로 만들어 줍니다">
                  시연으로 만들기
                </Button>
                <Button
                  icon={FileSpreadsheet}
                  onClick={() => {
                    setView('tcdocs');
                    setTcImport(Date.now());
                  }}
                  data-testid="script-tc-import"
                  title="QA 의 TC 문서(xlsx · csv · docx · md)를 가져와 TC 마다 스크립트로 변환합니다"
                >
                  TC 문서로 만들기
                </Button>
                <Button icon={FilePlus} onClick={() => setCreating('new-script.yaml')} data-testid="script-new">
                  새로 만들기
                </Button>
                <Button
                  icon={Import}
                  onClick={() =>
                    void act(async () => {
                      const got = await window.euta.scripts.import(pid);
                      if (got.length) setHl(got[0]);
                    }, '가져왔습니다')
                  }
                  data-testid="script-import"
                >
                  가져오기…
                </Button>
              </>
            )}
            <Button variant="ghost" icon={RefreshCw} onClick={() => void refresh()}>
              새로고침
            </Button>
          </>
        }
      />
      {project.cloudView && (
        <p className="muted small" data-testid="cloud-scripts-note">
          <Cloud className="lead-icon" size={14} aria-hidden="true" /> 클라우드 프로젝트 — 저장하면 클라우드에 새 버전으로 올라갑니다{project.cloudView.online ? '' : ' (지금은 오프라인: 보내기 대기로 쌓였다가 다시 연결되면 순서대로 보냅니다)'}. 이력은 서버 이력입니다.
        </p>
      )}
      <p className="muted small">
        폴더: <code>{project.dirs.scripts}</code> — 외부 편집기나 AI 채팅으로 고친 파일은 자동으로 목록에 반영됩니다. 스크립트에는 <code>target.baseUrl: {'${env.BASE_URL}'}</code> 를 쓰면 환경만 바꿔 같은 스크립트를 돌릴 수 있습니다.
      </p>
      {creating !== undefined && (
        <div className="inline card">
          <label>
            파일 이름 <input value={creating} onChange={(e) => setCreating(e.target.value)} data-testid="script-new-path" />
          </label>
          <Button
            variant="primary"
            icon={Check}
            onClick={() =>
              void act(async () => {
                const rel = await window.euta.scripts.create(pid, creating);
                setHl(rel);
                setCreating(undefined);
              })
            }
            data-testid="script-new-create"
          >
            만들기
          </Button>
          <Button icon={X} onClick={() => setCreating(undefined)}>
            취소
          </Button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {note && <div className="note" data-testid="scripts-note">{note}</div>}
      {setsEditable && picked.length > 0 && (
        <div className="inline card" data-testid="put-into-set">
          <b>{picked.length}개 선택</b>
          <select value={into} onChange={(e) => setInto(e.target.value)} data-testid="put-into-set-target">
            <option value="">테스트 세트 고르기…</option>
            {project.suites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="__new__">+ 새 테스트 세트</option>
          </select>
          {into === '__new__' && <input value={intoName} onChange={(e) => setIntoName(e.target.value)} placeholder="새 테스트 세트 이름" data-testid="put-into-set-name" />}
          <Button icon={ListPlus} disabled={!into || (into === '__new__' && !intoName.trim())} onClick={() => void putIntoSet()} data-testid="put-into-set-ok">
            테스트 세트에 넣기
          </Button>
          <Button icon={FileDown} onClick={() => setExportPicked(true)} data-testid="put-into-tcdoc" title="고른 스크립트를 자연어 TC 문서(xlsx · md)로 내보냅니다">
            TC 문서로 내보내기
          </Button>
          <Button variant="ghost" icon={X} onClick={() => setPicked([])}>
            선택 해제
          </Button>
        </div>
      )}
      {exportPicked && (
        <TcExportDialog project={project} source={{ scripts: list.map((s) => s.path).filter((p) => picked.includes(p)), name: project.name }} title={`스크립트 ${picked.length}개`} onClose={() => setExportPicked(false)} />
      )}
      <div className="table-card">
      <table className="history-table" data-testid="scripts">
        <thead>
          <tr>
            {setsEditable && <th></th>}
            <th>이름</th>
            <th>경로</th>
            <th>최근 실행</th>
            <th>동작</th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => {
            const c = checks[s.path];
            return (
              <tr key={s.path} data-testid="script-row" data-path={s.path} className={hl === s.path ? 'hl' : ''}>
                {setsEditable && (
                  <td>
                    <input
                      type="checkbox"
                      checked={picked.includes(s.path)}
                      onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.path] : p.filter((x) => x !== s.path)))}
                      title="테스트 세트에 넣을 스크립트로 고르기"
                      data-testid="script-pick"
                    />
                  </td>
                )}
                <td>
                  <button className="link script-name" onClick={() => setDetailPath(s.path)} title="단계 보기 · 편집 · 이력">
                    {s.name ?? <span className="muted">(이름 없음)</span>}
                  </button>
                </td>
                <td>
                  {renaming?.path === s.path ? (
                    <span className="inline">
                      <input value={renaming.to} onChange={(e) => setRenaming({ ...renaming, to: e.target.value })} data-testid="script-rename-input" />
                      <Button
                        size="sm"
                        icon={Check}
                        onClick={() =>
                          void act(async () => {
                            const rel = await window.euta.scripts.rename(pid, s.path, renaming.to);
                            setRenaming(undefined);
                            setHl(rel);
                          })
                        }
                        data-testid="script-rename-ok"
                      >
                        확인
                      </Button>
                      <Button size="sm" icon={X} onClick={() => setRenaming(undefined)}>
                        취소
                      </Button>
                    </span>
                  ) : (
                    <code className="file">{s.path}</code>
                  )}
                  {s.cloud && (
                    <div className="small">
                      {s.cloud.version !== undefined && (
                        <span className="muted" data-testid="script-version">
                          v{s.cloud.version}
                          {s.cloud.author ? ` · ${s.cloud.author}` : ''}{' '}
                        </span>
                      )}
                      {s.cloud.pending && (
                        <Badge tone={s.cloud.blocked ? 'bad' : 'warn'} data-testid="script-pending" data-blocked={s.cloud.blocked ?? ''}>
                          {s.cloud.blocked === 'conflict' ? '충돌' : s.cloud.blocked === 'rejected' ? '저장 거절' : '보내기 대기'}
                        </Badge>
                      )}
                      {s.cloud.remoteNewer !== undefined && (
                        <span className="warn" data-testid="script-remote-newer">
                          {' '}
                          · 다른 사람이 저장함 (v{s.cloud.remoteNewer})
                        </span>
                      )}
                    </div>
                  )}
                  {c && (
                    <div className={c.issues.length ? 'small error' : 'small ok-text'} data-testid="script-check">
                      {c.issues.length ? `검증 오류 ${c.issues.length}개: ${c.issues.map((i) => `${i.path} ${i.message}`).join('; ')}` : '✓ 검증 통과'}
                    </div>
                  )}
                </td>
                <td className="nowrap">
                  {s.lastRun ? (
                    <>
                      <StatusBadge status={s.lastRun.status} /> <span className="muted small">{new Date(s.lastRun.startedAt).toLocaleString()}</span>
                    </>
                  ) : (
                    <span className="muted small">—</span>
                  )}
                </td>
                <td>
                  <div className="row-actions">
                  <Button size="sm" icon={Eye} onClick={() => setDetailPath(s.path)} data-testid="script-detail-open" title="단계 보기 · 편집 · 이력">
                    보기
                  </Button>
                  {canRun && (
                    <Button size="sm" icon={Play} onClick={() => nav.runScript(s.path)} data-testid="script-run" title="이 PC 에서 실행 (실행 탭)">
                      실행
                    </Button>
                  )}
                  {canRun && project.cloud && (
                    <Button size="sm" icon={Cloud} onClick={() => nav.runScript(s.path, 'cloud')} data-testid="script-run-cloud" title={s.cloud?.pending ? '보내기 대기 중 — 먼저 보내야 클라우드에서 실행할 수 있습니다' : '실행 위치를 클라우드로 두고 실행 탭 열기 (사전 검사)'}>
                      실행
                    </Button>
                  )}
                  <Button size="sm" icon={ShieldCheck} onClick={() => void validate(s.path)} data-testid="script-validate">
                    검증
                  </Button>
                  <Button size="sm" icon={FileCode} onClick={() => void act(() => window.euta.scripts.open(pid, s.path))} title="기본 편집기로 열기">
                    열기
                  </Button>
                  {!readOnly && (
                    <Button size="sm" icon={Pencil} onClick={() => setRenaming({ path: s.path, to: s.path })} data-testid="script-rename">
                      이름 변경
                    </Button>
                  )}
                  <Button size="sm" icon={Upload} onClick={() => void act(() => window.euta.scripts.export(pid, s.path))}>
                    내보내기…
                  </Button>
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant="danger"
                      icon={Trash}
                      onClick={() => {
                        if (window.confirm(`${s.path} 를 삭제할까요?`)) void act(() => window.euta.scripts.delete(pid, s.path));
                      }}
                      data-testid="script-delete"
                    >
                      삭제
                    </Button>
                  )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {list.length === 0 && <EmptyState icon={FileText} title="스크립트가 없습니다." description="“시연으로 만들기” 로 사이트를 직접 보여 주거나, AI 탭에서 말로 시키세요. “새로 만들기”·“가져오기” 도 있습니다." />}
      </div>

      {deleted.length > 0 && (
        <details className="deleted-scripts" data-testid="deleted-scripts">
          <summary>삭제된 스크립트 ({deleted.length})</summary>
          <div className="table-card">
          <table className="history-table">
            <tbody>
              {deleted.map((d) => (
                <tr key={d.key} data-testid="deleted-row" data-path={d.path}>
                  <td>{d.name ?? <span className="muted">(이름 없음)</span>}</td>
                  <td>
                    <code className="file">{d.path}</code>
                  </td>
                  <td className="muted small">{new Date(d.at).toLocaleString()} 삭제</td>
                  <td>
                    <Button
                      size="sm"
                      icon={RotateCcw}
                      onClick={() =>
                        void act(async () => {
                          const rel = await window.euta.scripts.undelete(pid, d.key);
                          setHl(rel);
                        }, '복원했습니다')
                      }
                      data-testid="deleted-restore"
                    >
                      복원
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </details>
      )}

      <h3>시연 녹화</h3>
      <p className="muted small">녹화는 프로젝트에 저장됩니다(<code>recordings/</code>). “초안 저장” 은 AI 없이 기계적으로 변환해 라이브러리에 넣고, “AI로 정리” 는 새 AI 대화에서 검증·대기·측정을 보강해 저장·실행까지 합니다.</p>
      <div className="table-card">
      <table className="history-table" data-testid="recordings">
        <tbody>
          {recs.map((r) => (
            <tr key={r.id} data-testid="recording-row" data-id={r.id}>
              <td>
                {recRename?.id === r.id ? (
                  <span className="inline">
                    <input value={recRename.to} onChange={(e) => setRecRename({ ...recRename, to: e.target.value })} data-testid="recording-rename-input" />
                    <Button
                      size="sm"
                      icon={Check}
                      onClick={() =>
                        void act(async () => {
                          await window.euta.recordings.rename(pid, r.id, recRename.to);
                          setRecRename(undefined);
                          await refreshRecs();
                        })
                      }
                      data-testid="recording-rename-ok"
                    >
                      확인
                    </Button>
                  </span>
                ) : (
                  <b>{r.name}</b>
                )}
                <div className="muted small">
                  {new Date(r.startedAt).toLocaleString()} · 동작 {r.events} · 확인 {r.checkpoints} · 메모 {r.notes}
                  {r.sensitive ? ` · 민감 ${r.sensitive}` : ''}
                </div>
              </td>
              <td>
                <div className="row-actions">
                <Button
                  size="sm"
                  icon={Save}
                  onClick={() =>
                    void act(async () => {
                      const d = await window.euta.recordings.save(pid, r.id, r.envId);
                      setHl(d.path);
                      setNote(`초안 저장: ${d.path}${d.missingSecrets.length ? ` — 등록 필요한 비밀값: ${d.missingSecrets.join(', ')}` : ''}`);
                    })
                  }
                  data-testid="recording-save"
                >
                  초안 저장
                </Button>
                <Button size="sm" icon={Sparkles} onClick={() => void act(async () => nav.openChat(await window.euta.recordings.tidy(pid, r.id, r.envId)))} data-testid="recording-tidy">
                  AI로 정리
                </Button>
                <Button size="sm" icon={Pencil} onClick={() => setRecRename({ id: r.id, to: r.name })} data-testid="recording-rename">
                  이름 변경
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={Trash}
                  onClick={() => {
                    if (window.confirm(`녹화 “${r.name}” 를 삭제할까요?`)) void act(async () => (await window.euta.recordings.delete(pid, r.id), nav.recordingDeleted(r.id), await refreshRecs()));
                  }}
                  data-testid="recording-delete"
                >
                  삭제
                </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {recs.length === 0 && <p className="muted small table-empty">아직 녹화가 없습니다.</p>}
      </div>
    </div>
  );
}
