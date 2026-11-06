import { useEffect, useMemo, useState } from 'react';
import { Bell, CornerDownRight, Dot, MessageSquare, Square, Wrench, type LucideIcon } from 'lucide-react';
import type { AppInfo, HookEntry, HookSessionView, ProjectView, TerminalInfo } from '../../../shared/types';
import { Terminal } from './Terminal';
import { AiChat } from './AiChat';
import { Badge, statusLabel, Tabs } from '../ui';

const HOOK_ICON: Record<string, LucideIcon> = { prompt: MessageSquare, tool: Wrench, subagent: CornerDownRight, stop: Square, notification: Bell };

function Entry({ e }: { e: HookEntry }) {
  const [open, setOpen] = useState(false);
  const Icon = HOOK_ICON[e.kind] ?? Dot;
  const expandable = !!(e.input || e.detail);
  return (
    <li className={`hook ${e.kind}${e.isEuta ? ' euta' : ''}${e.status ? ` ${e.status}` : ''}`} data-testid="hook-entry" data-kind={e.kind} data-euta={e.isEuta ? '1' : '0'}>
      <div className="hook-line" onClick={() => expandable && setOpen(!open)}>
        <span className="hook-icon">
          <Icon size={14} aria-hidden />
        </span>
        <span className="hook-time muted">{new Date(e.ts).toLocaleTimeString()}</span>
        {e.isEuta && <span className="tag">euta</span>}
        {e.agentId && e.kind === 'tool' && <span className="tag sub">하위 에이전트</span>}
        {e.status && e.kind !== 'prompt' && <Badge tone={e.status === 'done' ? 'ok' : e.status === 'failed' ? 'bad' : 'run'} data-status={e.status}>{statusLabel(e.status)}</Badge>}
        <span className="hook-summary">{e.summary}</span>
      </div>
      {open && (
        <div className="hook-detail">
          {e.input && (
            <>
              <div className="muted small">입력</div>
              <pre>{e.input}</pre>
            </>
          )}
          {e.detail && (
            <>
              <div className="muted small">{e.status === 'failed' ? '오류' : e.kind === 'prompt' ? '프롬프트' : '응답'}</div>
              <pre>{e.detail}</pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Help({ app, term }: { app?: AppInfo; term?: TerminalInfo }) {
  const mcp = app?.mcpServerPath ?? '/abs/path/euta-engine/packages/mcp-server/dist/index.js';
  const plugin = app?.pluginDir ?? '/abs/path/euta-claude-plugin';
  const runs = app?.runsDir ?? '<runs dir>';
  return (
    <details className="help card" open={!term?.claude.found && !term?.codex.found}>
      <summary>Claude Code · Codex 연결 방법</summary>
      <p>
        터미널은 <b>직접 설치한</b> <code>claude</code> / <code>codex</code> 를 그대로 실행합니다. 로그인은 평소처럼 CLI 안에서 하세요 — 이 앱은 자격 증명을 보지도 저장하지도 않습니다. 앱은 터미널 환경에 <code>EUTA_APP_URL</code>, <code>EUTA_APP_TOKEN</code>, <code>EUTA_APP_EVENTS_URL</code>, <code>EUTA_APP_EVENTS_TOKEN</code>, <code>EUTA_RUNS_DIR</code> 만 더해, euta 플러그인·MCP 서버가 이 창에 알릴 수 있게 합니다.
      </p>
      {term && !term.claude.found && (
        <p className="warn">
          PATH 에 <code>claude</code> 가 없습니다. Claude Code 설치: <code>curl -fsSL https://claude.ai/install.sh | bash</code> (또는 <code>npm install -g @anthropic-ai/claude-code</code>) 후 앱을 다시 켜세요.
        </p>
      )}
      {term && !term.codex.found && (
        <p className="warn">
          PATH 에 <code>codex</code> 가 없습니다. Codex CLI 설치: <code>npm install -g @openai/codex</code> (또는 <code>brew install --cask codex</code>) 후 앱을 다시 켜세요.
        </p>
      )}
      <p>
        <b>Claude Code — euta 플러그인 (권장):</b> MCP 도구, 스킬, 활동 훅.
      </p>
      <pre>{`claude plugin marketplace add ${plugin}\nclaude plugin install euta@euta-tools`}</pre>
      <p>
        <b>Claude Code — MCP 만:</b> (활동 패널 없음, 실행은 그대로 실시간 탭에 나옵니다)
      </p>
      <pre>{`claude mcp add euta -e EUTA_RUNS_DIR=${runs} -- node ${mcp}`}</pre>
      <p>
        <b>Codex:</b>
      </p>
      <pre>{`codex mcp add euta --env EUTA_RUNS_DIR=${runs} -- node ${mcp}`}</pre>
      <p className="muted small">로컬 주소: {app?.serverUrl} (토큰 보호, 이 PC 안에서만 접속). EUTA_RUNS_DIR = 이 프로젝트의 실행 폴더 — MCP 로 시작한 실행이 이 프로젝트의 실행 이력에 나옵니다.</p>
    </details>
  );
}

/** Advanced option: hosts the user's own claude/codex CLI in a terminal (ADR-011) + hook activity (ADR-012). */
function AdvancedTerminal({ active }: { active: boolean }) {
  const [sessions, setSessions] = useState<Map<string, HookSessionView>>(new Map());
  const [selected, setSelected] = useState<string | undefined>();
  const [app, setApp] = useState<AppInfo | undefined>();
  const [term, setTerm] = useState<TerminalInfo | undefined>();

  useEffect(() => {
    void window.euta.appInfo().then(setApp);
    void window.euta.term.info().then(setTerm);
    void window.euta.hooks.list().then((l) => setSessions(new Map(l.map((s) => [s.sessionId, s]))));
    return window.euta.hooks.onUpdate((s) => {
      setSessions((prev) => new Map(prev).set(s.sessionId, s));
      setSelected((cur) => cur ?? s.sessionId);
    });
  }, []);

  useEffect(() => {
    if (active) void window.euta.appInfo().then(setApp);
  }, [active]);

  const list = useMemo(() => [...sessions.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)), [sessions]);
  const sess = (selected && sessions.get(selected)) || list[0];

  return (
    <div className="ai">
      <div className="ai-left">
        <Terminal active={active} info={term} />
      </div>
      <div className="ai-right">
        <Help app={app} term={term} />
        <div className="inline between">
          <strong>AI 활동</strong>
          {list.length > 1 && (
            <select value={sess?.sessionId} onChange={(e) => setSelected(e.target.value)}>
              {list.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.sessionId.slice(0, 8)} {s.cwd ? `— ${s.cwd}` : ''} {s.ended ? '(끝남)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        {!sess ? (
          <p className="muted small">아직 활동이 없습니다. Claude Code(euta 플러그인)의 훅 이벤트가 여기에 나옵니다: 프롬프트, 도구 호출(euta 도구는 강조), 하위 에이전트, 멈춤·알림.</p>
        ) : (
          <div className="hook-session" data-testid="hook-session" data-session-id={sess.sessionId}>
            <div className="muted small">
              세션 {sess.sessionId} {sess.cwd && `· ${sess.cwd}`} {sess.ended && '· 끝남'}
            </div>
            <ul className="hooks">
              {sess.entries
                .slice()
                .reverse()
                .map((e) => (
                  <Entry key={e.id} e={e} />
                ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** AI tab: in-app chat (Agent SDK, ADR-015) by default; the terminal is an advanced option. */
export function AiTab({
  project,
  active,
  onOpenRun,
  openChat,
  onRecord,
}: {
  project: ProjectView;
  active: boolean;
  onOpenRun: (runId: string) => void;
  openChat?: { id: string; n: number };
  onRecord: () => void;
}) {
  const [mode, setMode] = useState<'chat' | 'terminal'>('chat');
  useEffect(() => {
    if (openChat) setMode('chat');
  }, [openChat]);
  return (
    <div className="ai-tab">
      <div className="ai-modes">
        <Tabs
          items={[
            { key: 'chat', label: '채팅', testId: 'ai-mode-chat' },
            { key: 'terminal', label: '고급: 터미널', testId: 'ai-advanced-toggle', title: '직접 설치한 claude / codex CLI 를 터미널에서 실행 (MCP + 플러그인)' },
          ]}
          active={mode}
          onSelect={(k) => setMode(k as 'chat' | 'terminal')}
        />
      </div>
      {/* Both stay mounted so the pty and the chat survive switching. */}
      <div className="ai-pane" hidden={mode !== 'chat'}>
        <AiChat project={project} active={active && mode === 'chat'} onOpenRun={onOpenRun} openChat={openChat} onRecord={onRecord} />
      </div>
      <div className="ai-pane" hidden={mode !== 'terminal'} data-testid="ai-advanced">
        <AdvancedTerminal active={active && mode === 'terminal'} />
      </div>
    </div>
  );
}
