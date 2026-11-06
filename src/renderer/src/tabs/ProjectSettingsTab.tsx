import { useEffect, useState } from 'react';
import { Cloud, CloudUpload, FileInput, KeyRound, Plus, RotateCcw, Save, Star, Trash, TriangleAlert, X } from 'lucide-react';
import type { BrowserEngine, CloudConvertResult, CloudStatusView, EnvironmentView, ProjectView, VaultStatus } from '../../../shared/types';
import { CloudMembers, useCloudStatus } from './Cloud';
import { ConvertDialog } from './CloudAccess';
import { errText } from './ScriptsTab';
import { Button, PageHeader, Switch } from '../ui';

const toLines = (vars: Record<string, string>): string =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
const fromLines = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

type Apply = (fn: () => Promise<ProjectView | unknown>) => Promise<boolean>;

/**
 * Cloud project test credentials (SPEC "이 PC 실행과 테스트 계정"): the server never returns values,
 * so this PC's runs use the local vault (key = cloud projectId/envId/NAME). Each name shows
 * "클라우드: 등록됨/없음 · 이 PC: 등록됨/없음"; saving to the cloud too is a separate choice.
 */
function CloudCredentials({ project, env, vault, apply, editable }: { project: ProjectView; env: EnvironmentView; vault?: VaultStatus; apply: Apply; editable: boolean }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [toPc, setToPc] = useState(true);
  const [toCloud, setToCloud] = useState(false);
  const cloudNames = env.cloud?.credentialNames ?? [];
  const names = [...new Set([...cloudNames, ...env.secretNames])].sort();
  const save = async () => {
    // The value goes to main once; the field is cleared and never shown again.
    const ok = await apply(async () => {
      if (toPc) await window.euta.projects.setSecret(project.id, env.id, name, value);
      if (toCloud) await window.euta.cloud.setCredential(project.id, env.id, name, value);
      return window.euta.projects.get(project.id);
    });
    if (ok) {
      setValue('');
      setName('');
    }
  };
  return (
    <div className="secrets" data-testid="cloud-credentials">
      <b>테스트 계정</b>
      <ul className="secret-list">
        {names.map((n) => {
          const inCloud = cloudNames.includes(n);
          const onPc = env.secretNames.includes(n);
          return (
            <li key={n} data-testid="cred-item" data-name={n} data-cloud={inCloud ? '1' : '0'} data-pc={onPc ? '1' : '0'}>
              <code>{n}</code> <span className={inCloud ? 'ok-text' : 'muted'}>클라우드: {inCloud ? '등록됨' : '없음'}</span> · <span className={onPc ? 'ok-text' : 'warn'}>이 PC: {onPc ? '등록됨' : '없음'}</span>{' '}
              <Button size="sm" icon={KeyRound} onClick={() => (setName(n), setValue(''))} data-testid="cred-edit">
                값 입력
              </Button>
              {onPc && (
                <>
                  {' '}
                  <Button size="sm" variant="danger" icon={Trash} onClick={() => void apply(() => window.euta.projects.removeSecret(project.id, env.id, n))} data-testid="cred-remove-pc">
                    이 PC 값 삭제
                  </Button>
                </>
              )}
              {inCloud && editable && (
                <>
                  {' '}
                  <Button size="sm" variant="danger" icon={Trash} onClick={() => window.confirm(`클라우드의 ${n} 을(를) 삭제할까요? (클라우드 실행에 쓰는 값)`) && void apply(() => window.euta.cloud.removeCredential(project.id, env.id, n))} data-testid="cred-remove-cloud">
                    클라우드에서 삭제
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {vault && !vault.available && (
        <div className="warn small inline">
          <TriangleAlert size={14} aria-hidden="true" /> {vault.reason ?? '이 PC 에 비밀값을 안전하게 저장할 수 없습니다.'}
        </div>
      )}
      <div className="inline">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름 (예: USER_PASSWORD)" data-testid="cred-name" />
        <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="값 (저장 후 다시 표시되지 않음)" data-testid="cred-value" />
        <label>
          <input type="checkbox" checked={toPc} onChange={(e) => setToPc(e.target.checked)} data-testid="cred-pc" /> 이 PC
        </label>
        <label title={editable ? '클라우드 실행에 쓰는 값 (편집자 이상)' : '오프라인이거나 권한이 없습니다'}>
          <input type="checkbox" checked={toCloud && editable} disabled={!editable} onChange={(e) => setToCloud(e.target.checked)} data-testid="cred-cloud" /> 클라우드에도
        </label>
        <Button icon={Save} disabled={!name || !value || (!toPc && !(toCloud && editable)) || (toPc && vault?.available === false)} onClick={() => void save()} data-testid="cred-save">
          저장
        </Button>
      </div>
      <div className="muted small">이 PC 에서 실행할 때는 이 PC 값을 씁니다(구성원마다 따로 입력). 클라우드 값은 서버가 다시 보여 주지 않습니다. 스크립트에서 {'${secrets.NAME}'} 으로 씁니다.</div>
    </div>
  );
}

function SecretsEditor({ project, env, vault, apply }: { project: ProjectView; env: EnvironmentView; vault?: VaultStatus; apply: Apply }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState<string | undefined>();
  const save = async (n: string) => {
    // The value goes to main once; the field is cleared and never shown again.
    const ok = await apply(() => window.euta.projects.setSecret(project.id, env.id, n, value));
    if (ok) {
      setValue('');
      setName('');
      setReplacing(undefined);
    }
  };
  const pickFile = async () => {
    const f = await window.euta.pickFile('secrets');
    if (f) await apply(() => window.euta.projects.upsertEnv(project.id, env.id, { secretsFile: f }));
  };
  return (
    <div className="secrets" data-testid="secrets">
      <div className="inline">
        <b>비밀값</b>
        <label>
          <input type="radio" checked={env.secretSource === 'vault'} onChange={() => void apply(() => window.euta.projects.upsertEnv(project.id, env.id, { secretsFile: '' }))} data-testid="secrets-vault" /> 앱 저장소 (OS 보안 저장소로 암호화)
        </label>
        <label>
          <input type="radio" checked={env.secretSource === 'file'} onChange={() => void pickFile()} data-testid="secrets-file" /> 외부 비밀값 파일
        </label>
      </div>
      {env.secretSource === 'file' ? (
        <div className="small">
          파일: <code className="path">{env.secretsFile}</code>{' '}
          <Button size="sm" icon={FileInput} onClick={() => void pickFile()}>
            변경…
          </Button>
          {env.secretsError && <div className="error">{env.secretsError}</div>}
          <div className="muted">이름: {env.secretNames.join(', ') || '없음'} (값은 표시하지 않음)</div>
        </div>
      ) : (
        <>
          {vault && !vault.available && (
            <div className="warn small inline" data-testid="vault-warning">
              <TriangleAlert size={14} aria-hidden="true" /> {vault.reason ?? '이 환경에서는 비밀값을 안전하게 저장할 수 없습니다.'} — 저장이 거부됩니다. 외부 비밀값 파일을 쓰세요.
            </div>
          )}
          <ul className="secret-list">
            {env.secretNames.map((n) => (
              <li key={n} data-testid="secret-item" data-name={n}>
                <code>{n}</code> <span className="muted">••••••</span>{' '}
                {replacing === n ? (
                  <span className="inline">
                    <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="새 값" data-testid="secret-replace-value" />
                    <Button size="sm" icon={Save} disabled={!value} onClick={() => void save(n)}>
                      교체
                    </Button>
                    <Button size="sm" icon={X} onClick={() => (setReplacing(undefined), setValue(''))}>
                      취소
                    </Button>
                  </span>
                ) : (
                  <>
                    <Button size="sm" icon={KeyRound} onClick={() => (setReplacing(n), setValue(''))}>
                      교체
                    </Button>{' '}
                    <Button size="sm" variant="danger" icon={Trash} onClick={() => void apply(() => window.euta.projects.removeSecret(project.id, env.id, n))} data-testid="secret-remove">
                      삭제
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="inline">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름 (예: USER_PASSWORD)" data-testid="secret-name" />
            <input type="password" autoComplete="off" value={replacing ? '' : value} onChange={(e) => setValue(e.target.value)} placeholder="값 (저장 후 다시 표시되지 않음)" data-testid="secret-value" disabled={!!replacing} />
            <Button icon={Save} disabled={!name || !value || !!replacing || vault?.available === false} onClick={() => void save(name)} data-testid="secret-save">
              저장
            </Button>
          </div>
          <div className="muted small">스크립트에서 {'${secrets.NAME}'} 으로 씁니다. 값은 화면·AI·로그·리포트에 나오지 않습니다.</div>
        </>
      )}
    </div>
  );
}

function EnvCard({ project, env, vault, apply, editable }: { project: ProjectView; env: EnvironmentView; vault?: VaultStatus; apply: Apply; editable: boolean }) {
  const [name, setName] = useState(env.name);
  const [baseUrl, setBaseUrl] = useState(env.baseUrl);
  const [vars, setVars] = useState(toLines(env.vars));
  const domainsOf = (e: EnvironmentView) => (e.cloud ? e.cloud.allowedDomains : e.domains).join(', ');
  const [domains, setDomains] = useState(domainsOf(env));
  useEffect(() => {
    setName(env.name);
    setBaseUrl(env.baseUrl);
    setVars(toLines(env.vars));
    setDomains(domainsOf(env));
  }, [env]);
  const cloud = !!project.cloud;
  const dirty = name !== env.name || baseUrl !== env.baseUrl || vars !== toLines(env.vars) || domains !== domainsOf(env);
  return (
    <div className="card env-card" data-testid="env-card" data-env-name={env.name} data-env-id={env.id}>
      <div className="inline between">
        <div className="inline">
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="env-name" className="env-name" disabled={!editable} />
          {project.defaultEnvId === env.id ? (
            <span className="tag">기본</span>
          ) : (
            editable && (
              <Button size="sm" icon={Star} onClick={() => void apply(() => window.euta.projects.update(project.id, { defaultEnvId: env.id }))} data-testid="env-make-default">
                기본으로
              </Button>
            )
          )}
          {env.cloud && !env.cloud.cloudRunnable && (
            <span className="warn small" data-testid="env-private" title={env.cloud.addressReason}>
              사설·사내 주소 — 클라우드 실행 불가 (이 PC 실행은 가능)
            </span>
          )}
        </div>
        {editable && (
          <Button
            size="sm"
            variant="danger"
            icon={Trash}
            onClick={() => {
              if (window.confirm(`환경 "${env.name}" 와 그 ${cloud ? '테스트 계정(클라우드·이 PC)' : '비밀값'} 을 삭제할까요?`)) void apply(() => window.euta.projects.deleteEnv(project.id, env.id));
            }}
            data-testid="env-delete"
          >
            환경 삭제
          </Button>
        )}
      </div>
      <div className="grid2">
        <div className="form-row">
          <label>주소 (BASE_URL)</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging.example.com" data-testid="env-url" disabled={!editable} />
        </div>
        <div className="form-row">
          <label>변수 (KEY=VALUE, {'${env.KEY}'} — 비밀값 금지)</label>
          <textarea rows={2} value={vars} onChange={(e) => setVars(e.target.value)} spellCheck={false} data-testid="env-vars" disabled={!editable} />
        </div>
      </div>
      <div className="form-row">
        <label>
          허용 도메인 — 테스트 계정({'${secrets.*}'})을 입력할 수 있는 페이지 호스트, 쉼표로 구분 ({cloud ? '클라우드 실행과 이 PC 실행 모두' : '이 PC 의 모든 실행·AI 채팅·터미널 MCP'})
        </label>
        <div className="inline">
          <input value={domains} onChange={(e) => setDomains(e.target.value)} data-testid="env-domains" disabled={!editable} className="grow" placeholder={cloud ? '' : '비우면 어디서도 입력하지 않음'} />
          {!cloud && env.domainsDefault && (
            <span className="muted small" data-testid="env-domains-default">
              기본값(주소 호스트)
            </span>
          )}
          {!cloud && !env.domainsDefault && editable && (
            <Button size="sm" icon={RotateCcw} onClick={() => void apply(() => window.euta.projects.upsertEnv(project.id, env.id, { allowedDomains: null }))} data-testid="env-domains-reset">
              주소 호스트로 되돌리기
            </Button>
          )}
        </div>
      </div>
      {dirty && editable && (
        <Button
          variant="primary"
          size="sm"
          icon={Save}
          onClick={() =>
            void apply(() =>
              window.euta.projects.upsertEnv(project.id, env.id, {
                name,
                baseUrl,
                vars: fromLines(vars),
                ...(domains !== domainsOf(env) ? { allowedDomains: domains.split(/[\s,]+/).filter(Boolean) } : {}),
              }),
            )
          }
          data-testid="env-save"
        >
          환경 저장
        </Button>
      )}
      {cloud ? <CloudCredentials project={project} env={env} vault={vault} apply={apply} editable={editable} /> : <SecretsEditor project={project} env={env} vault={vault} apply={apply} />}
    </div>
  );
}

export function ProjectSettingsTab({ project, onChanged, onDeleted, onConverted }: { project: ProjectView; onChanged: (p: ProjectView) => void; onDeleted: () => void; onConverted?: (r: CloudConvertResult) => void }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [vault, setVault] = useState<VaultStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [newEnv, setNewEnv] = useState({ name: '', baseUrl: '' });
  const [device, setDevice] = useState(project.browser.device ?? '');
  const [del, setDel] = useState<{ blocker?: string; typed: string } | undefined>();
  const cv = project.cloudView;
  const [testRules, setTestRules] = useState(cv?.testRules ?? '');
  const [converting, setConverting] = useState(false);
  const status: CloudStatusView | undefined = useCloudStatus();
  /** Cloud: server-side settings need a connection and an editor role (offline → read only). */
  const editable = !cv || (cv.online && !cv.readOnly);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setDevice(project.browser.device ?? '');
    setTestRules(project.cloudView?.testRules ?? '');
  }, [project]);
  useEffect(() => {
    void window.euta.vaultStatus().then(setVault);
  }, [project.id]);

  const apply: Apply = async (fn) => {
    setError(undefined);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'environments' in (r as object)) onChanged(r as ProjectView);
      else onChanged(await window.euta.projects.get(project.id));
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  };

  const setBrowser = (patch: Partial<{ engine: BrowserEngine; device: string; headless: boolean }>) => void apply(() => window.euta.projects.update(project.id, { browser: { ...project.browser, ...patch } }));

  return (
    <div className="project-settings" data-testid="project-settings">
      <PageHeader title="프로젝트 설정" />
      {cv && (
        <p className="muted small" data-testid="cloud-settings-note">
          <Cloud className="lead-icon" size={14} aria-hidden="true" /> 클라우드 프로젝트 — 설정·환경·테스트 계정·테스트 세트·구성원은 클라우드에 저장됩니다(구성원 모두에게 보임).
          {!cv.online ? ' 지금은 오프라인이라 읽기만 할 수 있습니다.' : cv.readOnly ? (cv.canRun ? ' 내 역할이 실행자라 설정은 읽기만 할 수 있습니다(실행만 가능).' : ' 내 역할이 보기라 읽기만 할 수 있습니다.') : ''}
        </p>
      )}
      {cv && (
        <p className="muted small" data-testid="cloud-birth">
          클라우드 프로젝트 ID <code>{cv.projectId}</code>
          {cv.birth && ` · 출처 ${cv.birth.origin === 'web' ? '웹에서 만듦' : cv.birth.origin === 'app' ? '앱에서 올림' : '예전 프로젝트'}${cv.birth.createdBy ? ` · 만든 사람 ${cv.birth.createdBy}` : ''}`}
          {cv.visibility && ` · 공개 범위 ${cv.visibility === 'org' ? '조직 공개' : '구성원만'}`}
        </p>
      )}
      {error && (
        <div className="error" data-testid="settings-error">
          {error}
        </div>
      )}

      <h3>기본 정보</h3>
      <div className="card">
      <div className="grid2">
        <div className="form-row">
          <label>이름</label>
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="project-name-input" disabled={!editable} />
        </div>
        <div className="form-row">
          <label>설명</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} />
        </div>
      </div>
      <div className="inline">
        {(name !== project.name || description !== project.description) && (
          <Button variant="primary" size="sm" icon={Save} onClick={() => void apply(() => window.euta.projects.update(project.id, { name, description }))} data-testid="project-info-save">
            저장
          </Button>
        )}
        <Switch checked={project.pinned} onChange={(e) => void apply(() => window.euta.projects.update(project.id, { pinned: e.target.checked }))} data-testid="project-pin" label="사이드바에 고정" />
        <span className="muted small">
          저장 위치: <code>{project.dirs.root}</code>
        </span>
      </div>
      {cv && (
        <div className="form-row">
          <label>테스트 규칙 (실사용 부작용 주의 — 전용 계정·게시 금지 채널·정리 방법 등)</label>
          <textarea rows={3} value={testRules} onChange={(e) => setTestRules(e.target.value)} disabled={!editable} data-testid="project-test-rules" style={{ fontFamily: 'inherit' }} />
          {editable && testRules !== cv.testRules && (
            <div>
              <Button variant="primary" size="sm" icon={Save} onClick={() => void apply(() => window.euta.projects.update(project.id, { testRules }))} data-testid="project-test-rules-save">
                테스트 규칙 저장
              </Button>
            </div>
          )}
        </div>
      )}
      </div>

      <h3>환경</h3>
      <p className="muted small">실행할 때 환경을 고릅니다. 스크립트의 {'${env.BASE_URL}'} 은 환경 주소, 변수는 {'${env.KEY}'}, 비밀값은 {'${secrets.NAME}'} 으로 들어갑니다.</p>
      {project.environments.map((e) => (
        <EnvCard key={e.id} project={project} env={e} vault={vault} apply={apply} editable={editable} />
      ))}
      {editable && (
      <div className="inline card">
        <input value={newEnv.name} onChange={(e) => setNewEnv({ ...newEnv, name: e.target.value })} placeholder="새 환경 이름 (예: staging)" data-testid="env-add-name" />
        <input value={newEnv.baseUrl} onChange={(e) => setNewEnv({ ...newEnv, baseUrl: e.target.value })} placeholder="주소 https://…" data-testid="env-add-url" className="grow" />
        <Button
          icon={Plus}
          disabled={!newEnv.name.trim()}
          onClick={() => void apply(() => window.euta.projects.upsertEnv(project.id, undefined, newEnv)).then((ok) => ok && setNewEnv({ name: '', baseUrl: '' }))}
          data-testid="env-add"
        >
          환경 추가
        </Button>
      </div>
      )}

      <h3>기본 브라우저</h3>
      <div className="inline options card">
        <label>
          엔진{' '}
          <select value={project.browser.engine} onChange={(e) => setBrowser({ engine: e.target.value as BrowserEngine })} data-testid="project-browser" disabled={!editable}>
            <option value="chromium">chromium</option>
            <option value="firefox">firefox</option>
            <option value="webkit">webkit</option>
          </select>
        </label>
        <label>
          디바이스{' '}
          <input value={device} onChange={(e) => setDevice(e.target.value)} onBlur={() => device !== (project.browser.device ?? '') && setBrowser({ device })} placeholder="(데스크톱) 예: iPhone 15" disabled={!editable} />
        </label>
        <Switch checked={project.browser.headless} onChange={(e) => setBrowser({ headless: e.target.checked })} data-testid="project-headless" label={<>창 없이 실행{cv ? ' (이 PC)' : ''} <span className="muted small">Headless</span></>} />
      </div>

      {cv && (
        <>
          <h3>구성원</h3>
          <div className="card">
            <CloudMembers project={project} canManage={cv.can.includes('member.manage')} online={cv.online} />
          </div>
        </>
      )}

      {!cv && status && status.state !== 'none' && !project.uploadedTo && (
        <>
          <h3>클라우드로 올리기</h3>
          <div className="card">
          <p className="muted small">
            이 프로젝트를 <b>그대로 클라우드 프로젝트로 바꿉니다</b>(사이드바에는 하나만 남습니다). 설정·환경(주소·변수)·스크립트(현재 내용)·테스트 세트는 서버로 올라가고, 테스트 계정 <b>값</b>은 올리지 않습니다. 이 PC 의 실행 기록·테스트 세트 실행·리포트·AI 대화·시연 녹화·작업 로그와 이 PC 테스트 계정 값은 그대로 옮겨집니다(서버로 가지 않음).
          </p>
          <Button icon={CloudUpload} disabled={status.state !== 'online'} onClick={() => setConverting(true)} data-testid="upload-cloud" title="확인 대화상자에서 올라가는 것·옮겨지는 것을 보여 줍니다">
            클라우드로 올리기…
          </Button>
          {status.state !== 'online' && <span className="muted small"> 클라우드에 로그인·연결되어 있어야 합니다.</span>}
          </div>
          {converting && (
            <ConvertDialog
              project={project}
              onClose={() => setConverting(false)}
              onDone={(r) => {
                setConverting(false);
                onConverted?.(r);
              }}
            />
          )}
        </>
      )}

      <h3>위험</h3>
      {!del ? (
        <Button
          variant="danger"
          icon={Trash}
          onClick={async () => {
            const blocker = await window.euta.projects.deleteCheck(project.id);
            setDel({ typed: '', ...(blocker ? { blocker } : {}) });
          }}
          data-testid="project-delete"
        >
          {cv ? '이 PC 의 작업 사본 지우기…' : '프로젝트 삭제…'}
        </Button>
      ) : (
        <div className="card danger-box" data-testid="project-delete-dialog">
          {del.blocker ? (
            <p className="error">{del.blocker}</p>
          ) : (
            <>
              <p>
                {cv ? (
                  <>
                    이 PC 의 작업 사본(로컬 실행 결과·AI 대화·녹화·이 PC 테스트 계정 값)이 <b>영구 삭제</b>됩니다. 클라우드 프로젝트는 그대로이며 다시 열 수 있습니다.
                  </>
                ) : (
                  <>
                    프로젝트 폴더(스크립트·실행 결과·대화·작업 로그)와 저장된 비밀값이 <b>영구 삭제</b>됩니다.
                  </>
                )}{' '}
                확인하려면 프로젝트 이름 <code>{project.name}</code> 을 입력하세요.
              </p>
              <input value={del.typed} onChange={(e) => setDel({ ...del, typed: e.target.value })} data-testid="project-delete-input" />{' '}
              <Button
                variant="danger"
                icon={Trash}
                disabled={del.typed !== project.name}
                onClick={async () => {
                  const ok = await apply(async () => {
                    await window.euta.projects.delete(project.id);
                    return project;
                  });
                  if (ok) onDeleted();
                }}
                data-testid="project-delete-confirm"
              >
                삭제
              </Button>
            </>
          )}{' '}
          <Button icon={X} onClick={() => setDel(undefined)}>
            취소
          </Button>
        </div>
      )}
    </div>
  );
}
