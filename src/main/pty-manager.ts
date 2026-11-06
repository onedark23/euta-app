// Terminal sessions (node-pty, ADR-011). Starts the user's shell or the user-installed,
// unmodified `claude` / `codex` binary. The only environment change is buildPtyEnv's
// five EUTA_* variables (node-pty itself also sets TERM from `name` and PWD from `cwd`).
import { homedir } from 'node:os';
import pty from 'node-pty';
import type { PtyKind, TerminalInfo } from '../shared/types.js';
import { buildPtyEnv, defaultShell, findExecutable, spawnSpecFor, type PtyEnvInput } from './terminal-env.js';

export interface PtyEvents {
  onData(id: number, data: string): void;
  onExit(id: number, exitCode: number): void;
}

export class PtyManager {
  private readonly terms = new Map<number, pty.IPty>();
  private nextId = 1;

  constructor(
    private readonly envInput: () => PtyEnvInput,
    private readonly events: PtyEvents,
  ) {}

  info(): TerminalInfo {
    const claude = findExecutable('claude');
    const codex = findExecutable('codex');
    return {
      shell: defaultShell(),
      claude: claude ? { found: true, path: claude } : { found: false },
      codex: codex ? { found: true, path: codex } : { found: false },
    };
  }

  spawn(kind: PtyKind, cols: number, rows: number): number {
    let file: string;
    let args: string[];
    if (kind === 'shell') {
      file = defaultShell();
      args = process.platform === 'win32' ? [] : ['-l'];
    } else {
      const exe = findExecutable(kind);
      if (!exe) throw new Error(`${kind} CLI not found on PATH`);
      ({ file, args } = spawnSpecFor(exe));
    }
    const term = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: clamp(cols, 20, 500, 80),
      rows: clamp(rows, 5, 300, 24),
      cwd: homedir(),
      env: buildPtyEnv(process.env, this.envInput()),
    });
    const id = this.nextId++;
    this.terms.set(id, term);
    term.onData((d) => this.events.onData(id, d));
    term.onExit(({ exitCode }) => {
      this.terms.delete(id);
      this.events.onExit(id, exitCode);
    });
    return id;
  }

  write(id: number, data: string): void {
    if (typeof data === 'string' && data.length <= 1_000_000) this.terms.get(id)?.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    try {
      this.terms.get(id)?.resize(clamp(cols, 20, 500, 80), clamp(rows, 5, 300, 24));
    } catch {
      /* terminal already exited */
    }
  }

  kill(id: number): void {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    try {
      t.kill();
    } catch {
      /* already gone */
    }
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

function clamp(n: unknown, min: number, max: number, dflt: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : dflt;
}
