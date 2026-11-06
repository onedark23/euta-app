// Claude sign-in state for the AI chat, via the official CLI only (ADR-015, CLAUDE.md
// AI policy): `claude auth status` (JSON), `claude auth login`, `claude auth logout`.
// The app never reads, stores or forwards credentials or tokens (no credential file,
// no keychain access), never sets auth environment variables, and never implements OAuth.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import type { AuthState, ClaudeCliSource } from '../../shared/types.js';

const STATUS_TIMEOUT_MS = 8_000;
const LOGOUT_TIMEOUT_MS = 15_000;
const LOGIN_MAX_MS = 10 * 60_000;
const CACHE_MS = 10_000;

/** Env vars that route the agent away from the Claude subscription (presence only; values are never read out). */
export const BILLING_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
] as const;

/** Names of billing-relevant env vars that are set (non-empty). Never returns values. */
export function billingEnvWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  return BILLING_ENV_KEYS.filter((k) => typeof env[k] === 'string' && env[k]!.trim() !== '');
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Packaged apps keep native executables outside app.asar (asarUnpack). */
export function unpackedPath(p: string): string {
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

/**
 * The CLI binary bundled with @anthropic-ai/claude-agent-sdk for this platform
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]`) — the binary
 * `query()` runs. Resolved from the SDK's own location; in a packaged app the
 * asar path is mapped to app.asar.unpacked.
 */
export function bundledClaudePath(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const sdkEntry = req.resolve('@anthropic-ai/claude-agent-sdk');
    const fromSdk = createRequire(sdkEntry);
    const p = fromSdk.resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${platform === 'win32' ? '.exe' : ''}`);
    const real = unpackedPath(p);
    return isExecutableFile(real) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** PATH dirs of terminal shims that wrap `claude` (they can hang a nested call). */
const SHIM_MARKERS = ['cmux-cli-shims', 'cmux.app'];

export function findUserClaude(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const names = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((e) => `claude${e.toLowerCase()}`) : ['claude'];
  const home = env.HOME || (platform === 'win32' ? env.USERPROFILE : undefined) || homedir();
  for (const n of names) {
    const p = join(home, '.local', 'bin', n);
    if (isExecutableFile(p)) return p;
  }
  for (const dir of (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir || !(dir.startsWith('/') || /^[A-Za-z]:\\/.test(dir)) || SHIM_MARKERS.some((m) => dir.includes(m))) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (isExecutableFile(p)) return p;
    }
  }
  return undefined;
}

export interface ClaudeCli {
  path: string;
  source: ClaudeCliSource;
}

/**
 * Which `claude` runs the auth commands. Order: EUTA_CLAUDE_BIN (explicit override,
 * used by tests) → the SDK's bundled CLI (exactly what the chat runs; always present in
 * the packaged app) → the user's installed CLI (~/.local/bin, PATH without shims).
 * All of them share this machine's Claude Code sign-in.
 */
export function resolveClaudeCli(env: NodeJS.ProcessEnv = process.env, bundled: () => string | undefined = bundledClaudePath): ClaudeCli | undefined {
  const override = env.EUTA_CLAUDE_BIN?.trim();
  if (override) return isExecutableFile(override) ? { path: override, source: 'override' } : undefined;
  const b = bundled();
  if (b) return { path: b, source: 'bundled' };
  const u = findUserClaude(env);
  return u ? { path: u, source: 'user' } : undefined;
}

interface StatusJson {
  loggedIn?: unknown;
  authMethod?: unknown;
  apiProvider?: unknown;
  apiKeySource?: unknown;
  email?: unknown;
  orgName?: unknown;
  subscriptionType?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Parse `claude auth status` stdout (JSON object; tolerate a stray line around it). */
export function parseAuthStatus(stdout: string): StatusJson | undefined {
  const a = stdout.indexOf('{');
  const b = stdout.lastIndexOf('}');
  if (a < 0 || b < a) return undefined;
  try {
    const v = JSON.parse(stdout.slice(a, b + 1)) as unknown;
    return v && typeof v === 'object' ? (v as StatusJson) : undefined;
  } catch {
    return undefined;
  }
}

/** Map parsed status JSON to the UI state. Only identity labels are kept (no tokens exist in this output). */
export function toAuthState(json: StatusJson | undefined, cli: ClaudeCli, env: NodeJS.ProcessEnv, error?: string): AuthState {
  const base = { cli: { path: cli.path, source: cli.source }, checkedAt: Date.now(), envWarnings: billingEnvWarnings(env) };
  if (!json || typeof json.loggedIn !== 'boolean') {
    return { ...base, status: 'unknown', ...(error ? { error } : { error: 'could not read `claude auth status` output' }) };
  }
  const authMethod = str(json.authMethod);
  const apiKeySource = str(json.apiKeySource);
  const notSubscription = !!json.loggedIn && ((authMethod !== undefined && authMethod !== 'claude.ai') || apiKeySource !== undefined);
  return {
    ...base,
    status: json.loggedIn ? 'signed-in' : 'signed-out',
    ...(json.loggedIn && str(json.email) ? { email: str(json.email)! } : {}),
    ...(json.loggedIn && str(json.orgName) ? { orgName: str(json.orgName)! } : {}),
    ...(json.loggedIn && str(json.subscriptionType) ? { subscriptionType: str(json.subscriptionType)! } : {}),
    ...(authMethod ? { authMethod } : {}),
    ...(str(json.apiProvider) ? { apiProvider: str(json.apiProvider)! } : {}),
    ...(apiKeySource ? { apiKeySource } : {}),
    notSubscription,
  };
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string; error?: string }> {
  return new Promise((resolveRun) => {
    execFile(bin, args, { env, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolveRun({ code: 0, stdout: String(stdout) });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string };
      const timedOut = e.killed || e.signal === 'SIGKILL';
      // Do not echo stderr: keep messages generic (it is CLI output we do not control).
      resolveRun({ code: typeof e.code === 'number' ? e.code : null, stdout: String(stdout ?? ''), error: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exited with ${e.code ?? e.signal ?? 'error'}` });
    });
  });
}

export interface ClaudeAuthOptions {
  env?: NodeJS.ProcessEnv;
  resolveCli?: (env: NodeJS.ProcessEnv) => ClaudeCli | undefined;
  statusTimeoutMs?: number;
}

/** Sign-in status/login/logout through the official CLI, cached for 10 s. */
export class ClaudeAuth {
  private cache?: AuthState;
  private login?: ChildProcess;
  private loginTimer?: NodeJS.Timeout;

  constructor(private readonly o: ClaudeAuthOptions = {}) {}

  private env(): NodeJS.ProcessEnv {
    return this.o.env ?? process.env;
  }

  cli(): ClaudeCli | undefined {
    return (this.o.resolveCli ?? ((e) => resolveClaudeCli(e)))(this.env());
  }

  async status(force = false): Promise<AuthState> {
    if (!force && this.cache && Date.now() - this.cache.checkedAt < CACHE_MS) return this.cache;
    const env = this.env();
    const cli = this.cli();
    let state: AuthState;
    if (!cli) {
      state = { status: 'cli-missing', checkedAt: Date.now(), envWarnings: billingEnvWarnings(env) };
    } else {
      // `auth status` may exit non-zero when signed out: parse stdout regardless.
      const r = await run(cli.path, ['auth', 'status', '--json'], env, this.o.statusTimeoutMs ?? STATUS_TIMEOUT_MS);
      state = toAuthState(parseAuthStatus(r.stdout), cli, env, r.error);
    }
    this.cache = state;
    return state;
  }

  /**
   * Start `claude auth login --claudeai` (the CLI opens the browser and waits for the
   * callback). Does not wait; the UI polls status(force). The child is killed after
   * 10 minutes or on app quit.
   */
  startLogin(): { ok: boolean; command: string; error?: string } {
    const command = 'claude auth login';
    const cli = this.cli();
    if (!cli) return { ok: false, command, error: 'claude CLI not found' };
    this.stopLogin();
    try {
      const child = spawn(cli.path, ['auth', 'login', '--claudeai'], { env: this.env(), stdio: 'ignore', windowsHide: true });
      child.on('error', () => undefined);
      child.on('exit', () => {
        if (this.login === child) this.login = undefined;
        this.cache = undefined;
      });
      this.login = child;
      this.loginTimer = setTimeout(() => this.stopLogin(), LOGIN_MAX_MS);
      this.loginTimer.unref();
      this.cache = undefined;
      return { ok: true, command };
    } catch {
      return { ok: false, command, error: 'could not start claude auth login' };
    }
  }

  async logout(): Promise<{ ok: boolean; error?: string }> {
    const cli = this.cli();
    if (!cli) return { ok: false, error: 'claude CLI not found' };
    const r = await run(cli.path, ['auth', 'logout'], this.env(), LOGOUT_TIMEOUT_MS);
    this.cache = undefined;
    return r.error ? { ok: false, error: `claude auth logout ${r.error}` } : { ok: true };
  }

  stopLogin(): void {
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = undefined;
    if (this.login && this.login.exitCode === null) this.login.kill();
    this.login = undefined;
  }

  dispose(): void {
    this.stopLogin();
  }
}

/** Exists for the packaged-app check: the bundled CLI path the chat will use. */
export function claudeExecutableForAgent(): string | undefined {
  const b = bundledClaudePath();
  return b && existsSync(b) ? b : undefined;
}
