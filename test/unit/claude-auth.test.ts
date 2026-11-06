// Claude sign-in via the official CLI — exercised with FAKE `claude` scripts only
// (never the real CLI: no login, no model, no credentials).
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { billingEnvWarnings, BILLING_ENV_KEYS, bundledClaudePath, ClaudeAuth, findUserClaude, parseAuthStatus, resolveClaudeCli, unpackedPath } from '../../src/main/ai/claude-auth.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'euta-auth-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write an executable fake `claude` that records its args and runs `body`. */
function fakeClaude(dir: string, body: string): string {
  const p = join(dir, 'claude');
  writeFileSync(p, `#!/bin/sh\necho "$@" >> "${join(dir, 'calls.log')}"\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'me@example.com', orgId: 'o', orgName: 'Me Org', subscriptionType: 'max' });

function auth(bin: string | undefined, extraEnv: Record<string, string> = {}, statusTimeoutMs?: number): ClaudeAuth {
  const env = { PATH: '/usr/bin:/bin', HOME: tmp(), ...extraEnv, ...(bin ? { EUTA_CLAUDE_BIN: bin } : {}) };
  return new ClaudeAuth({ env, ...(statusTimeoutMs ? { statusTimeoutMs } : {}), resolveCli: (e) => resolveClaudeCli(e, () => undefined) });
}

describe('claude auth status (fake CLI)', () => {
  it('signed in: email / org / plan labels from the JSON', async () => {
    const d = tmp();
    const s = await auth(fakeClaude(d, `echo '${SIGNED_IN}'`)).status();
    expect(s).toMatchObject({ status: 'signed-in', email: 'me@example.com', orgName: 'Me Org', subscriptionType: 'max', authMethod: 'claude.ai', notSubscription: false, envWarnings: [] });
    expect(s.cli?.source).toBe('override');
    expect(readFileSync(join(d, 'calls.log'), 'utf8').trim()).toBe('auth status --json');
  });

  it('signed out even with a non-zero exit code', async () => {
    const s = await auth(fakeClaude(tmp(), `echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'; exit 1`)).status();
    expect(s.status).toBe('signed-out');
    expect(s.email).toBeUndefined();
  });

  it('API-key login is flagged as not the subscription', async () => {
    const s = await auth(fakeClaude(tmp(), `echo '{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}'`)).status();
    expect(s).toMatchObject({ status: 'signed-in', notSubscription: true, apiKeySource: 'ANTHROPIC_API_KEY' });
  });

  it('garbage output → unknown (no credential-file fallback)', async () => {
    const s = await auth(fakeClaude(tmp(), 'echo "oops"')).status();
    expect(s.status).toBe('unknown');
  });

  it('missing binary → cli-missing', async () => {
    const s = await auth(join(tmp(), 'nope')).status();
    expect(s.status).toBe('cli-missing');
    const none = await new ClaudeAuth({ env: { PATH: '/nonexistent', HOME: tmp() }, resolveCli: (e) => resolveClaudeCli(e, () => undefined) }).status();
    expect(none.status).toBe('cli-missing');
  });

  it('hang → killed at the timeout, reported as unknown', async () => {
    const t0 = Date.now();
    const s = await auth(fakeClaude(tmp(), 'exec sleep 30'), {}, 600).status();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(s.status).toBe('unknown');
    expect(s.error).toMatch(/timed out/);
  });

  it('caches for a short while; force re-runs', async () => {
    const d = tmp();
    const a = auth(fakeClaude(d, `echo '${SIGNED_IN}'`));
    await a.status();
    await a.status();
    await a.status(true);
    expect(readFileSync(join(d, 'calls.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('login runs `auth login --claudeai` detached-from-UI; logout runs `auth logout`', async () => {
    const d = tmp();
    const a = auth(fakeClaude(d, 'exit 0'));
    expect(a.startLogin()).toMatchObject({ ok: true, command: 'claude auth login' });
    expect(await a.logout()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 300));
    a.dispose();
    const calls = readFileSync(join(d, 'calls.log'), 'utf8');
    expect(calls).toContain('auth login --claudeai');
    expect(calls).toContain('auth logout');
    expect(auth(join(d, 'missing')).startLogin().ok).toBe(false);
  });

  it('parses JSON surrounded by noise', () => {
    expect(parseAuthStatus('warning\n{"loggedIn":true}\n')).toEqual({ loggedIn: true });
    expect(parseAuthStatus('')).toBeUndefined();
  });
});

describe('billing env warnings', () => {
  it('reports names of set variables only, never values', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-SECRETVALUE', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: '', PATH: '/bin' };
    const w = billingEnvWarnings(env);
    expect(w).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']);
    expect(JSON.stringify(w)).not.toContain('SECRETVALUE');
    expect(BILLING_ENV_KEYS).toContain('CLAUDE_CODE_USE_VERTEX');
  });

  it('status carries the warnings (names only)', async () => {
    const s = await auth(fakeClaude(tmp(), `echo '${SIGNED_IN}'`), { ANTHROPIC_API_KEY: 'sk-ant-SECRETVALUE' }).status();
    expect(s.envWarnings).toEqual(['ANTHROPIC_API_KEY']);
    expect(JSON.stringify(s)).not.toContain('SECRETVALUE');
  });
});

describe('CLI resolution', () => {
  it('finds the user CLI in ~/.local/bin or PATH, skipping cmux shims', () => {
    const home = tmp();
    const shim = join(home, 'cmux-cli-shims');
    mkdirSync(shim);
    fakeClaude(shim, '');
    expect(findUserClaude({ HOME: home, PATH: shim })).toBeUndefined();
    const bin = join(home, 'bin');
    mkdirSync(bin);
    fakeClaude(bin, '');
    expect(findUserClaude({ HOME: home, PATH: `${shim}:${bin}` })).toBe(join(bin, 'claude'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    fakeClaude(join(home, '.local/bin'), '');
    expect(findUserClaude({ HOME: home, PATH: bin })).toBe(join(home, '.local/bin/claude'));
  });

  it('prefers the SDK bundled CLI over the user CLI; override wins', () => {
    const home = tmp();
    mkdirSync(join(home, 'bin'));
    const user = fakeClaude(join(home, 'bin'), '');
    expect(resolveClaudeCli({ HOME: home, PATH: join(home, 'bin') }, () => '/x/bundled/claude')).toEqual({ path: '/x/bundled/claude', source: 'bundled' });
    expect(resolveClaudeCli({ HOME: home, PATH: join(home, 'bin') }, () => undefined)).toEqual({ path: user, source: 'user' });
    expect(resolveClaudeCli({ HOME: home, PATH: '', EUTA_CLAUDE_BIN: user }, () => '/x')).toEqual({ path: user, source: 'override' });
  });

  it('resolves the SDK bundled binary in this install (not executed) and maps asar paths', () => {
    const p = bundledClaudePath();
    expect(p && existsSync(p)).toBeTruthy();
    expect(p).toMatch(/claude-agent-sdk-darwin-arm64|claude-agent-sdk-[a-z0-9]+-[a-z0-9]+/);
    expect(unpackedPath('/A/euta.app/Contents/Resources/app.asar/node_modules/x/claude')).toBe('/A/euta.app/Contents/Resources/app.asar.unpacked/node_modules/x/claude');
  });
});
