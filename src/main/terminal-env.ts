// Environment + executable resolution for the terminal panel (P3, ADR-011).
//
// Policy (RESEARCH_AI-구독-연동-방식, CLAUDE.md "AI 연동 금지선"):
//  - the child inherits the user's environment unchanged and gets ONLY the five
//    EUTA_* variables of EUTA_ENV_KEYS added; no auth-related variable is ever set;
//  - the vendor CLI is launched as-is (absolute path of the user's install), never
//    wrapped or patched; no credential/config/keychain location is read.
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';

/**
 * The only variables the app adds to the pty child (orchestrator contract, ADR-009/011):
 * app endpoint + token for plugin hooks, events endpoint + token for the MCP forwarder,
 * the app's runs dir so MCP-driven runs land in the app's History, and the secret rules
 * every local run applies (SPEC 프로젝트-관리 "secrets 규칙" — read by the engine MCP server).
 */
export const EUTA_ENV_KEYS = ['EUTA_APP_URL', 'EUTA_APP_TOKEN', 'EUTA_APP_EVENTS_URL', 'EUTA_APP_EVENTS_TOKEN', 'EUTA_RUNS_DIR', 'EUTA_RESTRICT_SECRETS', 'EUTA_ALLOWED_DOMAINS'] as const;

/** Names the app must never set (checked in tests; the app only ever adds EUTA_ENV_KEYS). */
export const AUTH_ENV_PATTERN = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|OPENAI_|CODEX_API_KEY$|AWS_BEARER_TOKEN_BEDROCK$)/;

export type Env = Record<string, string | undefined>;

export interface PtyEnvInput {
  url: string;
  token: string;
  /** Defaults to `token`. */
  eventsToken?: string;
  runsDir: string;
  /** Allowed domains of the open project (union over its environments). */
  allowedDomains?: string[];
}

/**
 * Child environment for the pty: a copy of `base` (the user's environment) with
 * exactly the EUTA_ENV_KEYS set (both URL pairs explicitly). Stale values of those
 * keys in `base` are replaced. Nothing else is added, removed or changed.
 */
export function buildPtyEnv(base: Env, input: PtyEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.EUTA_APP_URL = input.url;
  env.EUTA_APP_TOKEN = input.token;
  env.EUTA_APP_EVENTS_URL = `${input.url}/events`;
  env.EUTA_APP_EVENTS_TOKEN = input.eventsToken ?? input.token;
  env.EUTA_RUNS_DIR = input.runsDir;
  env.EUTA_RESTRICT_SECRETS = '1';
  // No allowed domain = secret input nowhere. "," (not "") because the plugin launcher drops empty EUTA_*
  // variables, and an unset variable would turn the domain gate off; the engine reads "," as an empty list.
  env.EUTA_ALLOWED_DOMAINS = input.allowedDomains?.length ? input.allowedDomains.join(',') : ',';
  return env;
}

function isExecutableFile(p: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an executable on PATH (like `which`). On Windows, PATHEXT extensions are tried
 * (claude.exe, codex.cmd from npm shims, ...).
 */
export function findExecutable(name: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? '';
  const sep = platform === 'win32' ? ';' : delimiter;
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  for (const dir of pathVar.split(sep)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/** Default interactive shell for the platform. */
export function defaultShell(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return findExecutable('pwsh', env, platform) ?? env.ComSpec ?? 'powershell.exe';
  }
  return env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

/**
 * How to spawn a CLI in the pty. Unix: the binary itself. Windows: `.cmd`/`.bat` npm
 * shims cannot be spawned directly by ConPTY, so they go through `cmd.exe /d /s /c`.
 * The CLI still runs unmodified with no extra arguments.
 */
export function spawnSpecFor(exePath: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(exePath)) {
    return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', exePath] };
  }
  return { file: exePath, args: [] };
}

const PATH_MARK = '__EUTA_PATH__';

/**
 * macOS/Linux GUI launches (Finder, Dock) get a minimal PATH, so user-installed CLIs
 * (and `node` for MCP servers) are not found. Ask the user's login shell for its PATH.
 * Only PATH is read; the value is never logged. Returns undefined on failure/timeout.
 */
export function loginShellPath(shell: string, timeoutMs = 4000): Promise<string | undefined> {
  const tryOnce = (args: string[]): Promise<string | undefined> =>
    new Promise((resolve) => {
      execFile(shell, [...args, `printf '%s' "${PATH_MARK}$PATH${PATH_MARK}"`], { timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } }, (err, stdout) => {
        if (err && !stdout) return resolve(undefined);
        const m = new RegExp(`${PATH_MARK}(.*?)${PATH_MARK}`, 's').exec(stdout);
        resolve(m?.[1] || undefined);
      });
    });
  return tryOnce(['-l', '-c']).then((p) => p ?? tryOnce(['-i', '-l', '-c']));
}

/** Merge PATH lists keeping order and removing duplicates (login shell entries first). */
export function mergePath(primary: string | undefined, secondary: string | undefined, sep = delimiter): string {
  const out: string[] = [];
  for (const part of [...(primary ?? '').split(sep), ...(secondary ?? '').split(sep)]) {
    if (part && !out.includes(part)) out.push(part);
  }
  return out.join(sep);
}

/**
 * Startup fix (darwin/linux only): replace process.env.PATH with the login shell PATH
 * merged with the current one. This is the only environment change the app makes
 * to its own process; children inherit it like they would from a terminal launch.
 */
export async function fixProcessPath(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'win32') return false;
  const p = await loginShellPath(defaultShell(process.env, platform));
  if (!p) return false;
  process.env.PATH = mergePath(p, process.env.PATH);
  return true;
}
