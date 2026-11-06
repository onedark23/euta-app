import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, LogIn, LogOut, Plus, RefreshCw, Send, Square, Trash, Video } from 'lucide-react';
import type { AiInfo, AuthState, ChatItem, ChatSummary, ChatView, ProjectView, TcConvertProgress } from '../../../shared/types';
import { MODELS } from './SettingsTab';
import { errText } from './ScriptsTab';
import { StatusBadge } from './LiveTab';
import { TcProgressText } from './TcDocs';
import { Badge, Button, statusLabel } from '../ui';

function AuthChip({ active }: { active: boolean }) {
  const [s, setS] = useState<AuthState | undefined>();
  const [waiting, setWaiting] = useState(false);
  const [msg, setMsg] = useState<string | undefined>();
  const poll = useRef<number | undefined>(undefined);

  const refresh = async (force = false) => setS(await window.euta.ai.authStatus(force));

  useEffect(() => {
    if (active) void refresh();
  }, [active]);
  useEffect(() => () => window.clearInterval(poll.current), []);

  const login = async () => {
    setMsg(undefined);
    const r = await window.euta.ai.login();
    if (!r.ok) {
      setMsg(`${r.error ?? '로그인 실패'} — 터미널에서 \`${r.command}\` 를 실행하세요.`);
      return;
    }
    setWaiting(true);
    const until = Date.now() + 3 * 60_000;
    window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      const st = await window.euta.ai.authStatus(true);
      setS(st);
      if (st.status === 'signed-in' || Date.now() > until) {
        window.clearInterval(poll.current);
        setWaiting(false);
      }
    }, 2000);
  };

  const logout = async () => {
    const r = await window.euta.ai.logout();
    if (!r.ok) setMsg(r.error);
    await refresh(true);
  };

  if (!s)
    return (
      <Badge tone="idle" data-testid="auth-chip" data-status="loading">
        Claude: 확인 중…
      </Badge>
    );
  return (
    <div className="auth">
      <Badge tone={s.status === 'signed-in' ? 'ok' : s.status === 'unknown' ? 'idle' : 'warn'} data-testid="auth-chip" data-status={s.status} title={s.cli ? `${s.cli.source}: ${s.cli.path}` : ''}>
        {s.status === 'signed-in' && (
          <>
            Claude: {s.email ?? '로그인됨'}
            {s.subscriptionType ? ` (${s.subscriptionType})` : ''}
          </>
        )}
        {s.status === 'signed-out' && <>Claude 로그인 필요</>}
        {s.status === 'cli-missing' && <>Claude Code CLI 없음</>}
        {s.status === 'unknown' && <>Claude 상태 확인 불가</>}
      </Badge>
      {s.status === 'signed-out' && (
        <Button variant="primary" size="sm" icon={LogIn} onClick={() => void login()} disabled={waiting} data-testid="auth-login">
          {waiting ? '브라우저에서 로그인 대기 중…' : '로그인'}
        </Button>
      )}
      {s.status === 'signed-in' && (
        <Button variant="ghost" size="sm" icon={LogOut} onClick={() => void logout()} data-testid="auth-logout">
          로그아웃
        </Button>
      )}
      <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => void refresh(true)} data-testid="auth-refresh">
        새로고침
      </Button>
      {s.status === 'cli-missing' && (
        <div className="warn small" data-testid="auth-install">
          Claude Code 설치: <code>curl -fsSL https://claude.ai/install.sh | bash</code> (또는 <code>npm install -g @anthropic-ai/claude-code</code>) 후 새로고침.
        </div>
      )}
      {s.status === 'unknown' && s.error && <div className="muted small">{s.error}</div>}
      {s.notSubscription && (
        <div className="warn small" data-testid="auth-not-subscription">
          구독(claude.ai)이 아닌 인증({s.authMethod ?? s.apiKeySource})이 사용됩니다 — 사용량이 구독이 아닌 경로로 청구될 수 있습니다.
        </div>
      )}
      {s.envWarnings.length > 0 && (
        <div className="warn small" data-testid="auth-env-warning">
          환경변수 {s.envWarnings.join(', ')} 가 설정되어 있어 사용량이 구독이 아닌 API·클라우드 경로로 청구될 수 있습니다(값은 표시하지 않음).
        </div>
      )}
      {msg && <div className="error small">{msg}</div>}
    </div>
  );
}

function ToolCard({ item, onOpenRun }: { item: Extract<ChatItem, { kind: 'tool' }>; onOpenRun: (runId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool-card ${item.status}`} data-testid="tool-card" data-status={item.status} data-name={item.name}>
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</span>
        <span className="tag">euta</span>
        <b>{item.name}</b>
        <span className="muted ellipsis">{item.inputSummary}</span>
        <Badge tone={item.status === 'running' ? 'run' : item.status === 'error' ? 'bad' : 'ok'}>{item.status === 'running' ? '실행 중…' : statusLabel(item.status)}</Badge>
        {item.runStatus && <StatusBadge status={item.runStatus} />}
        {item.result && !open && <span className="muted small ellipsis">{item.result.split('\n')[0]}</span>}
        {item.runId && (
          <button
            className="link small"
            data-testid="tool-open-live"
            onClick={(e) => {
              e.stopPropagation();
              onOpenRun(item.runId!);
            }}
          >
            실시간 탭에서 보기 →
          </button>
        )}
      </div>
      {open && (
        <div className="tool-body">
          <div className="muted small">입력</div>
          <pre>{item.input}</pre>
          {item.result && (
            <>
              <div className="muted small">결과</div>
              <pre>{item.result}</pre>
            </>
          )}
        </div>
      )}
      {item.image && <img className="tool-image" src={item.image} alt={`${item.name} 스크린샷`} />}
    </div>
  );
}

function Item({ item, onOpenRun }: { item: ChatItem; onOpenRun: (runId: string) => void }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user" data-testid="msg-user">
          {item.text}
        </div>
      );
    case 'assistant':
      return (
        <div className="msg assistant" data-testid="msg-assistant" data-streaming={item.streaming ? '1' : '0'}>
          {item.text}
          {item.streaming && <span className="cursor">▍</span>}
        </div>
      );
    case 'tool':
      return <ToolCard item={item} onOpenRun={onOpenRun} />;
    case 'notice':
      return (
        <div className={`msg notice ${item.level}`} data-testid="msg-notice" data-level={item.level}>
          {item.text}
        </div>
      );
  }
}

/** "말로 시키기" examples shown above the input (SPEC 스크립트-작성-시연녹화 보조 입구). */
export const CHAT_EXAMPLES = [
  '로그인해서 보고서를 PDF로 내보내기 테스트 만들어줘',
  '회원가입 흐름을 직접 돌아보고 테스트 스크립트로 만들어줘',
  'login.yaml 실행하고 실패하면 원인 분석해줘',
];

export function AiChat({
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
  const pid = project.id;
  const [info, setInfo] = useState<AiInfo | undefined>();
  const [list, setList] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<ChatView | undefined>();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | undefined>();
  const bottom = useRef<HTMLDivElement>(null);
  const selectedId = useRef<string | undefined>(undefined);
  // TC auto conversions of the project: the chat they drive shows "n / N 진행 중" + [중지].
  const [autos, setAutos] = useState<TcConvertProgress[]>([]);
  useEffect(() => {
    const load = () => void window.euta.tcDocs.progress(pid).then(setAutos, () => setAutos([]));
    load();
    return window.euta.tcDocs.onChanged((p) => p === pid && load());
  }, [pid]);

  const refreshList = async () => setList(await window.euta.ai.chats(pid));

  useEffect(() => {
    void window.euta.ai.info(pid).then(setInfo);
    void window.euta.ai.chats(pid).then(async (l) => {
      setList(l);
      if (l[0] && !selectedId.current) {
        selectedId.current = l[0].id;
        setChat(await window.euta.ai.chat(pid, l[0].id));
      }
    });
    return window.euta.ai.onChatUpdate((projectId, c) => {
      if (projectId !== pid) return;
      if (c.id === selectedId.current) setChat(c);
      setList((prev) => {
        const s = { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, busy: c.busy };
        return [s, ...prev.filter((p) => p.id !== c.id)].sort((a, b) => b.updatedAt - a.updatedAt);
      });
    });
  }, [pid]);

  useEffect(() => {
    if (active) void window.euta.ai.info(pid).then(setInfo);
  }, [active, pid]);

  useEffect(() => {
    if (openChat) void select(openChat.id);
  }, [openChat]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [chat?.items.length, chat?.items.at(-1)]);

  const select = async (id: string) => {
    selectedId.current = id;
    setChat(await window.euta.ai.chat(pid, id));
  };

  const newChat = async () => {
    const c = await window.euta.ai.newChat(pid);
    selectedId.current = c.id;
    setChat(c);
    await refreshList();
  };

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setError(undefined);
    let c = chat;
    if (!c) {
      c = await window.euta.ai.newChat(pid);
      selectedId.current = c.id;
      setChat(c);
    }
    try {
      await window.euta.ai.send(pid, c.id, text);
      setInput('');
    } catch (e) {
      setError(errText(e));
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!chat?.busy) void send();
    }
  };

  const del = async (id: string) => {
    await window.euta.ai.deleteChat(pid, id);
    if (selectedId.current === id) {
      selectedId.current = undefined;
      setChat(undefined);
    }
    await refreshList();
  };

  const setModel = async (m: string) => {
    await window.euta.appSettings.set({ aiModel: m });
    setInfo(await window.euta.ai.info(pid));
  };

  const setEnv = async (envId: string) => {
    setError(undefined);
    try {
      let c = chat;
      if (!c) {
        c = await window.euta.ai.newChat(pid, envId);
        selectedId.current = c.id;
        await refreshList();
      } else c = await window.euta.ai.setChatEnv(pid, c.id, envId);
      setChat(c);
    } catch (e) {
      setError(errText(e));
    }
  };

  const items = chat?.items ?? [];
  const auto = chat ? autos.find((a) => a.chatId === chat.id) : undefined;
  // Between auto conversion messages the chat is not busy, but the app sends the next item itself.
  const busy = !!chat?.busy || !!auto;
  const envId = chat ? (chat.envId ?? '') : (project.defaultEnvId ?? '');
  const env = project.environments.find((e) => e.id === envId);

  return (
    <div className="chat" data-testid="ai-chat">
      <aside className="chat-list">
        <Button icon={Plus} onClick={() => void newChat()} data-testid="chat-new">
          새 채팅
        </Button>
        <Button icon={Video} onClick={onRecord} data-testid="ai-record" title="사이트를 직접 시연하면 AI 가 테스트로 정리합니다">
          시연으로 만들기
        </Button>
        <ul>
          {list.map((c) => (
            <li key={c.id} className={c.id === chat?.id ? 'sel' : ''} onClick={() => void select(c.id)} data-testid="chat-item" data-chat-id={c.id}>
              <div className="name">
                {c.busy && <Badge tone="run">…</Badge>} {c.title}
              </div>
              <div className="inline between">
                <span className="muted small">{new Date(c.updatedAt).toLocaleString()}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Trash}
                  onClick={(e) => {
                    e.stopPropagation();
                    void del(c.id);
                  }}
                >
                  삭제
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </aside>
      <section className="chat-main">
        <header className="chat-head">
          <AuthChip active={active} />
          <div className="inline small">
            <span className="muted">실행 환경</span>
            <select value={envId} onChange={(e) => void setEnv(e.target.value)} disabled={busy} data-testid="ai-env" title="AI 의 run_script · session_open 이 쓰는 주소·변수·비밀값">
              <option value="">(환경 없음)</option>
              {project.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.baseUrl ? ` — ${e.baseUrl}` : ''}
                </option>
              ))}
            </select>
            {env && <span className="muted">비밀값: {env.secretNames.join(', ') || '없음'} (이름만 AI 에 전달)</span>}
          </div>
          <div className="inline small">
            <span className="muted">작업 폴더</span>
            <code className="path" data-testid="ai-workdir">
              {info?.workDir ?? '…'}
            </code>
            <span className="muted">(프로젝트 스크립트 폴더 — AI 가 저장한 스크립트가 바로 목록에 나타납니다)</span>
            <select value={info?.model ?? ''} onChange={(e) => void setModel(e.target.value)} data-testid="ai-model" title="모델 (새 채팅부터 적용)">
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {info?.fakeAgent && <span className="tag">테스트 에이전트</span>}
          </div>
          <div className="muted small" data-testid="ai-usage-note">
            본인 PC · 본인 Claude 구독 · 본인 사용 전용입니다. AI 는 euta 도구만 쓸 수 있고(셸·파일 편집 없음), 비밀값은 보지 못합니다.
          </div>
        </header>
        {auto && (
          <div className="chat-tc-progress inline small" data-testid="chat-tc-progress">
            <span className="muted">TC 자동 변환 · {auto.docName}</span>
            <TcProgressText p={auto} />
            <Button size="sm" variant="danger" icon={Square} disabled={auto.stopping} onClick={() => void window.euta.tcDocs.stop(pid, auto.docId).catch((e: unknown) => setError(errText(e)))} data-testid="chat-tc-stop" title="지금 메시지를 멈추고 자동 진행을 끝냅니다 (남은 대기열은 그대로)">
              중지
            </Button>
          </div>
        )}
        <div className="chat-messages" data-testid="chat-messages">
          {items.length === 0 && (
            <div className="muted chat-empty">
              예: “login.yaml 실행하고 실패 원인 분석해줘”, “로그인 흐름 테스트 스크립트 만들어줘” — 선택한 환경 주소({env?.baseUrl || '없음'})로 실행됩니다.
            </div>
          )}
          {items.map((i) => (
            <Item key={i.id} item={i} onOpenRun={onOpenRun} />
          ))}
          {busy && chat?.thinking && (
            <div className="msg thinking muted" data-testid="chat-thinking">
              생각 중…
            </div>
          )}
          <div ref={bottom} />
        </div>
        {error && <div className="error">{error}</div>}
        {!busy && (
          <div className="chat-examples inline small" data-testid="chat-examples">
            <span className="muted">말로 시키기:</span>
            {CHAT_EXAMPLES.map((x) => (
              <button key={x} className="chip" onClick={() => setInput(x)} data-testid="chat-example">
                {x}
              </button>
            ))}
            <span className="muted">또는</span>
            <button className="link small" onClick={onRecord}>
              시연으로 보여주기 →
            </button>
          </div>
        )}
        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={3}
            placeholder={auto ? 'TC 자동 변환 중입니다 — [중지] 한 뒤 메시지를 보낼 수 있습니다' : '요청을 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)'}
            disabled={!!auto}
            data-testid="chat-input"
          />
          {busy ? (
            <Button variant="danger" icon={Square} onClick={() => (auto ? void window.euta.tcDocs.stop(pid, auto.docId).catch(() => undefined) : chat && void window.euta.ai.stop(pid, chat.id))} data-testid="chat-stop">
              멈추기
            </Button>
          ) : (
            <Button variant="primary" icon={Send} onClick={() => void send()} disabled={!input.trim()} data-testid="chat-send">
              보내기
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
