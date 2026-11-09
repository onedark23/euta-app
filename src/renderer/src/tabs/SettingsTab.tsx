import { useEffect, useState } from 'react';
import { Check, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { AppInfo, AppSettings, AppTheme, VaultStatus } from '../../../shared/types';
import { CloudSettings } from './Cloud';
import { UpdateSettings } from './Update';
import { PageHeader, Tabs } from '../ui';

const THEMES: { key: AppTheme; label: string }[] = [
  { key: 'system', label: '시스템' },
  { key: 'light', label: '밝게' },
  { key: 'dark', label: '어둡게' },
];

export const MODELS = [
  { id: '', label: '기본 모델' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
];

/** App-wide settings only (SPEC "앱 설정(전역)"); everything site-specific lives in the project. */
export function AppSettingsTab() {
  const [s, setS] = useState<AppSettings | undefined>();
  const [info, setInfo] = useState<AppInfo | undefined>();
  const [vault, setVault] = useState<VaultStatus | undefined>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.euta.appSettings.get().then(setS);
    void window.euta.appInfo().then(setInfo);
    void window.euta.vaultStatus().then(setVault);
  }, []);

  if (!s) return null;
  const save = async (patch: Partial<AppSettings>) => {
    setS(await window.euta.appSettings.set(patch));
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  return (
    <div className="settings" data-testid="app-settings-page">
      <PageHeader
        title="앱 설정"
        meta={
          saved && (
            <span className="muted small inline">
              <Check size={14} aria-hidden="true" /> 저장됨
            </span>
          )
        }
      />
      <div className="card">
      <div className="form-row">
        <label>화면 테마</label>
        <div>
          <Tabs testId="app-theme" label="화면 테마" items={THEMES.map((t) => ({ ...t, testId: `app-theme-${t.key}` }))} active={s.theme} onSelect={(k) => void save({ theme: k as AppTheme })} />
        </div>
        <span className="muted small">시스템 = OS 의 밝은·어두운 모드를 따릅니다. 밝게·어둡게는 OS 설정과 관계없이 고정하며, 앱을 다시 켜도 유지됩니다.</span>
      </div>
      <div className="form-row">
        <label>AI 채팅 기본 모델 (새 채팅부터 적용)</label>
        <select value={s.aiModel} onChange={(e) => void save({ aiModel: e.target.value })} data-testid="app-ai-model" className="narrow">
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>비밀값 저장소</label>
        {vault?.available ? (
          <span className="inline ok-text" data-testid="vault-status" data-available="1">
            <ShieldCheck size={16} aria-hidden="true" /> OS 보안 저장소로 암호화{vault.backend ? ` (${vault.backend})` : ''} — <code>vault.json</code> 에는 암호문만 저장됩니다.
          </span>
        ) : (
          <span className="inline warn" data-testid="vault-status" data-available="0">
            <TriangleAlert size={16} aria-hidden="true" /> {vault?.reason ?? '확인 중…'}
          </span>
        )}
      </div>
      </div>
      <CloudSettings />
      <UpdateSettings />
      <div className="card">
      <div className="form-row">
        <label>데이터 위치</label>
        <span>
          <code className="path">{info?.userData}</code>
        </span>
        <span className="muted small">
          app.json(앱 전역) · vault.json(암호문) · projects/&lt;id&gt;/(프로젝트별 설정·스크립트·실행·대화·작업 로그) · cloud/(클라우드 연결 · 클라우드 프로젝트 작업 사본). 이전 버전의 전역 데이터(settings.json · runs/ · chats/)는 읽지 않으며 지우지도 않습니다.
        </span>
      </div>
      </div>
      <div className="muted small">
        euta {info ? `· Electron ${info.versions.electron} · Node ${info.versions.node}` : ''}
      </div>
    </div>
  );
}
