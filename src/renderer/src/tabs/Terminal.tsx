import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Square, SquareTerminal } from 'lucide-react';
import type { PtyKind, TerminalInfo } from '../../../shared/types';
import { Button } from '../ui';

const DARK = '(prefers-color-scheme: dark)';

/**
 * xterm colors from the design tokens (ui/tokens.css). xterm needs concrete color values, so they are
 * read from the computed CSS variables — light or dark, whichever the app shows now.
 */
export function terminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const dark = window.matchMedia(DARK).matches;
  const ansi = { red: v('--bad'), green: v('--ok'), yellow: v('--warn'), blue: v('--run'), magenta: v('--accent'), cyan: v('--focus') };
  return {
    background: v('--surface'),
    foreground: v('--text'),
    cursor: v('--accent'),
    cursorAccent: v('--surface'),
    selectionBackground: v('--accent-soft'),
    black: dark ? v('--surface-2') : v('--text'),
    white: dark ? v('--text') : v('--muted'),
    brightBlack: v('--muted'),
    brightWhite: dark ? v('--text') : v('--muted'),
    ...ansi,
    brightRed: ansi.red,
    brightGreen: ansi.green,
    brightYellow: ansi.yellow,
    brightBlue: ansi.blue,
    brightMagenta: ansi.magenta,
    brightCyan: ansi.cyan,
  };
}

export function Terminal({ active, info }: { active: boolean; info?: TerminalInfo }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | undefined>(undefined);
  const fit = useRef<FitAddon | undefined>(undefined);
  const current = useRef<number | undefined>(undefined);
  const [running, setRunning] = useState<{ id: number; kind: PtyKind } | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const t = new XTerm({ cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace', scrollback: 5000, allowProposedApi: false, theme: terminalTheme() });
    // The app theme follows nativeTheme (앱 설정 "화면 테마") → prefers-color-scheme changes → recolor.
    const media = window.matchMedia(DARK);
    const recolor = () => (t.options.theme = terminalTheme());
    media.addEventListener('change', recolor);
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    t.writeln('\x1b[2m위 버튼으로 셸이나 직접 설치한 claude / codex CLI 를 시작하세요.\x1b[0m');
    const offInput = t.onData((d) => current.current !== undefined && window.euta.term.write(current.current, d));
    const offResize = t.onResize(({ cols, rows }) => current.current !== undefined && window.euta.term.resize(current.current, cols, rows));
    const offData = window.euta.term.onData((id, data) => id === current.current && t.write(data));
    const offExit = window.euta.term.onExit((id, code) => {
      if (id !== current.current) return;
      t.writeln(`\r\n\x1b[2m[프로세스 종료 — 코드 ${code}]\x1b[0m`);
      current.current = undefined;
      setRunning(undefined);
    });
    const ro = new ResizeObserver(() => {
      try {
        if (host.current?.offsetParent) f.fit();
      } catch {
        /* not visible yet */
      }
    });
    ro.observe(host.current!);
    return () => {
      media.removeEventListener('change', recolor);
      ro.disconnect();
      offInput.dispose();
      offResize.dispose();
      offData();
      offExit();
      if (current.current !== undefined) window.euta.term.kill(current.current);
      t.dispose();
    };
  }, []);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try {
          fit.current?.fit();
        } catch {
          /* ignore */
        }
        term.current?.focus();
      });
    }
  }, [active]);

  const start = async (kind: PtyKind) => {
    const t = term.current!;
    setError(undefined);
    if (current.current !== undefined) window.euta.term.kill(current.current);
    current.current = undefined;
    t.reset();
    try {
      fit.current?.fit();
    } catch {
      /* ignore */
    }
    try {
      const id = await window.euta.term.spawn(kind, t.cols, t.rows);
      current.current = id;
      setRunning({ id, kind });
      t.focus();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const stop = () => {
    if (current.current !== undefined) window.euta.term.kill(current.current);
    current.current = undefined;
    setRunning(undefined);
  };

  return (
    <div className="terminal-panel">
      <div className="inline term-bar">
        <Button size="sm" icon={SquareTerminal} onClick={() => void start('shell')} data-testid="term-shell" title={info?.shell}>
          셸
        </Button>
        <Button size="sm" icon={SquareTerminal} onClick={() => void start('claude')} disabled={!info?.claude.found} data-testid="term-claude" title={info?.claude.path ?? 'PATH 에 claude 가 없습니다'}>
          claude
        </Button>
        <Button size="sm" icon={SquareTerminal} onClick={() => void start('codex')} disabled={!info?.codex.found} data-testid="term-codex" title={info?.codex.path ?? 'PATH 에 codex 가 없습니다'}>
          codex
        </Button>
        {running && (
          <>
            <span className="muted small" data-testid="term-running">
              실행 중: {running.kind}
            </span>
            <Button size="sm" variant="danger" icon={Square} onClick={stop}>
              멈추기
            </Button>
          </>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="xterm-host" ref={host} data-testid="terminal" />
    </div>
  );
}
