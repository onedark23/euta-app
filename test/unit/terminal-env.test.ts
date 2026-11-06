import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_ENV_PATTERN, EUTA_ENV_KEYS, buildPtyEnv, findExecutable, mergePath, spawnSpecFor } from '../../src/main/terminal-env.js';

const server = { url: 'http://127.0.0.1:5555', token: 'a'.repeat(64), runsDir: '/Users/u/Library/Application Support/euta-app/runs' };

describe('buildPtyEnv', () => {
  it('adds exactly the seven EUTA_* variables (incl. the secret rules) to the inherited environment', () => {
    const base = { PATH: '/usr/bin:/bin', HOME: '/Users/u', LANG: 'ko_KR.UTF-8', SHELL: '/bin/zsh' };
    const env = buildPtyEnv(base, server);
    const added = Object.keys(env).filter((k) => !(k in base));
    expect(added.sort()).toEqual([...EUTA_ENV_KEYS].sort());
    for (const [k, v] of Object.entries(base)) expect(env[k]).toBe(v);
    expect(env.EUTA_APP_URL).toBe(server.url);
    expect(env.EUTA_APP_TOKEN).toBe(server.token);
    expect(env.EUTA_APP_EVENTS_URL).toBe(`${server.url}/events`);
    expect(env.EUTA_APP_EVENTS_TOKEN).toBe(server.token);
    expect(env.EUTA_RUNS_DIR).toBe(server.runsDir);
    expect([...EUTA_ENV_KEYS].sort()).toEqual(['EUTA_ALLOWED_DOMAINS', 'EUTA_APP_EVENTS_TOKEN', 'EUTA_APP_EVENTS_URL', 'EUTA_APP_TOKEN', 'EUTA_APP_URL', 'EUTA_RESTRICT_SECRETS', 'EUTA_RUNS_DIR']);
    // secret rules for the engine MCP server the CLI starts (SPEC 프로젝트-관리 "secrets 규칙")
    expect(env.EUTA_RESTRICT_SECRETS).toBe('1');
    expect(env.EUTA_ALLOWED_DOMAINS).toBe(','); // empty list that survives the plugin launcher (it drops empty EUTA_*)
    expect(buildPtyEnv({}, { ...server, allowedDomains: ['dev.example.com', 'login.example.com'] }).EUTA_ALLOWED_DOMAINS).toBe('dev.example.com,login.example.com');
    expect(Object.keys(env).filter((k) => AUTH_ENV_PATTERN.test(k))).toEqual([]);
  });

  it('never sets auth variables; user-set ones pass through byte-identical', () => {
    const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'user-own-value', OPENAI_BASE_URL: 'http://x' };
    const env = buildPtyEnv(base, server);
    expect(env.ANTHROPIC_API_KEY).toBe('user-own-value');
    expect(env.OPENAI_BASE_URL).toBe('http://x');
    const authKeys = Object.keys(env).filter((k) => AUTH_ENV_PATTERN.test(k)).sort();
    expect(authKeys).toEqual(Object.keys(base).filter((k) => AUTH_ENV_PATTERN.test(k)).sort());
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('replaces stale EUTA_* values and drops undefined entries', () => {
    const env = buildPtyEnv({ PATH: '/bin', EUTA_APP_URL: 'http://old', EUTA_APP_TOKEN: 'old', EUTA_RUNS_DIR: '/old', X: undefined }, server);
    expect(env.EUTA_RUNS_DIR).toBe(server.runsDir);
    expect(env.EUTA_APP_URL).toBe(server.url);
    expect(env.EUTA_APP_TOKEN).toBe(server.token);
    expect('X' in env).toBe(false);
  });

  it('can use a separate events token', () => {
    const env = buildPtyEnv({}, { ...server, eventsToken: 'b'.repeat(64) });
    expect(env.EUTA_APP_EVENTS_TOKEN).toBe('b'.repeat(64));
  });
});

describe('CLI detection', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const mk = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'euta-cli-'));
    dirs.push(d);
    return d;
  };

  it('finds an executable on PATH and skips non-executables / directories', () => {
    const a = mk();
    const b = mk();
    writeFileSync(join(a, 'claude'), '#!/bin/sh\n');
    chmodSync(join(a, 'claude'), 0o644); // not executable
    mkdirSync(join(a, 'codex')); // directory
    writeFileSync(join(b, 'claude'), '#!/bin/sh\n');
    chmodSync(join(b, 'claude'), 0o755);
    const env = { PATH: [a, 'relative/dir', b].join(':') };
    expect(findExecutable('claude', env, 'darwin')).toBe(join(b, 'claude'));
    expect(findExecutable('codex', env, 'darwin')).toBeUndefined();
    expect(findExecutable('claude', { PATH: '' }, 'darwin')).toBeUndefined();
  });

  it('tries PATHEXT on Windows and wraps .cmd shims with cmd.exe', () => {
    const a = mk();
    writeFileSync(join(a, 'codex.cmd'), '@echo off\n');
    const env = { PATH: a, PATHEXT: '.EXE;.CMD' };
    const found = findExecutable('codex', env, 'win32');
    expect(found).toBe(join(a, 'codex.cmd'));
    expect(spawnSpecFor(found!, { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'win32')).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', found],
    });
    expect(spawnSpecFor('/usr/local/bin/claude', {}, 'darwin')).toEqual({ file: '/usr/local/bin/claude', args: [] });
  });

  it('merges PATH lists without duplicates', () => {
    expect(mergePath('/a:/b', '/b:/c', ':')).toBe('/a:/b:/c');
    expect(mergePath(undefined, '/c', ':')).toBe('/c');
  });
});
