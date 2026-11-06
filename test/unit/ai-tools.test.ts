// AI chat tool layer against the engine fixture site — no model involved.
// Tools are reached through the real Agent SDK in-process MCP server (createSdkMcpServer
// + tool()) via an in-memory MCP client, i.e. the same path the CLI would use.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startFixtureServer, FIXTURE_USER, type FixtureServer } from '../../../euta-engine/packages/core/test/fixture-site/server.js';
import { createAppTools, type AppTools } from '../../src/main/ai/tools.js';
import { createEutaSdkServer } from '../../src/main/ai/sdk-server.js';
import { buildQueryOptions, buildSystemPrompt, DISALLOWED_BUILTINS, makeGate } from '../../src/main/ai/agent-options.js';
import { decideTool } from '../../src/main/ai/gate.js';
import { LiveStore } from '../../src/main/live-store.js';
import { aiServerConfig } from '../../src/main/project/run-options.js';
import { defaultDomains } from '../../src/shared/secret-rules.js';
import { loadSecrets } from '../../src/main/runner.js';

const EXAMPLES = resolve(import.meta.dirname, '../../../euta-engine/examples');
type Res = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

describe('AI gate', () => {
  const allowed = new Set(['run_script', 'get_run']);
  it('allows only registered euta tools from the in-process server', () => {
    expect(decideTool('mcp__euta__run_script', allowed)).toEqual({ behavior: 'allow' });
    expect(decideTool('mcp__euta__run_script', allowed, { name: 'euta', source: 'sdk' })).toEqual({ behavior: 'allow' });
    expect(decideTool('mcp__euta__run_script', allowed, { name: 'euta', source: 'user' }).behavior).toBe('deny');
    expect(decideTool('mcp__euta__rm_rf', allowed).behavior).toBe('deny');
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Task', 'mcp__other__run_script', 'mcp__eutax__run_script']) expect(decideTool(t, allowed).behavior).toBe('deny');
  });

  it('PreToolUse hook and canUseTool give the same deny-by-default decision', async () => {
    const seen: string[] = [];
    const g = makeGate(allowed, (n, d) => seen.push(`${n}:${d.behavior}`));
    const signal = new AbortController().signal;
    const hook = (name: string) =>
      g.preToolUse({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: {}, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '/' } as never, 't1', { signal });
    expect(await hook('Bash')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await hook('mcp__euta__get_run')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(await g.canUseTool('Write', { file_path: '/x' }, { signal, toolUseID: 't2', requestId: 'r2' })).toMatchObject({ behavior: 'deny' });
    expect(await g.canUseTool('mcp__euta__run_script', { path: 'a' }, { signal, toolUseID: 't3', requestId: 'r3', mcpServer: { name: 'euta', source: 'sdk' } })).toEqual({ behavior: 'allow', updatedInput: { path: 'a' } });
    expect(seen).toEqual(['Bash:deny', 'mcp__euta__get_run:allow', 'Write:deny', 'mcp__euta__run_script:allow']);
  });

  it('query options: isolated, gated, no built-ins, no bypass, no env override', () => {
    const server = createSdkMcpServer({ name: 'euta', version: '0', tools: [] });
    const o = buildQueryOptions({ mcpServer: server, allowedTools: allowed, abortController: new AbortController(), cwd: '/w', systemPrompt: 'p', resume: 'sess-1', model: 'sonnet' });
    expect(o).toMatchObject({ cwd: '/w', settingSources: [], skills: [], tools: [], strictMcpConfig: true, permissionMode: 'default', includePartialMessages: true, resume: 'sess-1', model: 'sonnet' });
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['euta']);
    expect(o.disallowedTools).toEqual(DISALLOWED_BUILTINS);
    for (const b of ['Bash', 'Write', 'Edit', 'Read', 'WebFetch']) expect(o.disallowedTools).toContain(b);
    expect(o.allowedTools).toBeUndefined(); // would auto-approve and shadow the gate
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    expect(o.env).toBeUndefined(); // CLI inherits the app env; nothing (auth) is added
    expect(o.hooks?.PreToolUse?.[0]?.hooks.length).toBe(1);
    expect(typeof o.canUseTool).toBe('function');
    expect(o.maxTurns).toBeGreaterThan(0);
  });

  it('system prompt names secrets but never values', () => {
    const p = buildSystemPrompt({ workDir: '/w', runsDir: '/r', secretNames: ['USER_EMAIL'] });
    expect(p).toContain('USER_EMAIL');
    expect(p).toContain('${secrets.NAME}');
    expect(p).not.toContain(FIXTURE_USER.email);
  });
});

describe('AI tools through the Agent SDK in-process MCP server (fixture site)', () => {
  let site: FixtureServer;
  let root: string;
  let work: string;
  let app: AppTools;
  let client: Client;
  const live = new LiveStore({ throttleMs: 0 });
  const transcript: string[] = [];

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Res> => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as Res;
    transcript.push(JSON.stringify(r));
    return r;
  };
  const json = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await call(name, args);
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    return JSON.parse(r.content[0]!.text!) as T;
  };

  beforeAll(async () => {
    site = await startFixtureServer();
    root = mkdtempSync(join(tmpdir(), 'euta-ai-tools-'));
    work = join(root, 'work');
    mkdirSync(work, { recursive: true });
    const secretsFile = join(root, 'secrets.json');
    writeFileSync(secretsFile, JSON.stringify({ USER_EMAIL: FIXTURE_USER.email, USER_PASSWORD: FIXTURE_USER.password }));
    // Project environment → tool config (ADR-016): BASE_URL from the environment, secrets from its file.
    const project = { id: 'proj001', name: 'Fixture', description: '', browser: { engine: 'chromium' as const, headless: true }, pinned: false, createdAt: '', lastOpenedAt: '', environments: [], suites: [] };
    const env = { id: 'env0001', name: 'local', baseUrl: site.url, vars: {}, secretNames: [], secretsFile };
    // Secret rules (SPEC 프로젝트-관리 "secrets 규칙"): the environment's allowed domains = its address host by default.
    const config = aiServerConfig({ project, projectDir: root, env, secrets: loadSecrets(secretsFile).secrets, allowedDomains: defaultDomains(env), processEnv: { ...process.env, BASE_URL: 'http://127.0.0.1:9/not-this' } });
    expect(config).toMatchObject({ restrictSecrets: true, allowedDomains: ['127.0.0.1'] });
    app = createAppTools({ config, workDir: work, live, projectId: 'proj001', secretsFile });
    const server = createEutaSdkServer({ tool, createSdkMcpServer }, app.tools);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    client = new Client({ name: 'euta-ai-test', version: '0' });
    await client.connect(b);
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await app?.shutdown();
    live.dispose();
    await site?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists every euta tool with a JSON schema (zod shapes convert)', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...app.names].sort());
    expect(tools.length).toBe(18);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['get_page_map', 'check_script_targets']));
    const run = tools.find((t) => t.name === 'run_script')!;
    expect(Object.keys(run.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['path', 'yaml', 'headed']));
    const step = tools.find((t) => t.name === 'session_step')!;
    expect(step.inputSchema.required).toEqual(expect.arrayContaining(['sessionId', 'step']));
  });

  it('validate → run (secrets) → get_run, and the run feeds the LiveStore as an AI run', async () => {
    const v = await json<{ valid: boolean }>('validate_script', { path: join(EXAMPLES, 'login-download.yaml') });
    expect(v.valid).toBe(true);
    const run = await json<{ runId: string; status: string; summary: { total: number } }>('run_script', { path: join(EXAMPLES, 'login-download.yaml') });
    expect(run.status).toBe('passed');
    const detail = await json<{ runId: string; artifacts: { path: string }[] }>('get_run', { runId: run.runId.split('_').pop() });
    expect(detail.runId).toBe(run.runId);
    const view = live.get(run.runId);
    expect(view?.source).toBe('ai');
    expect(view?.projectId).toBe('proj001');
    expect(view?.status).toBe('passed');
    expect(view?.runDir && existsSync(view.runDir)).toBeTruthy();
    const shot = await call('get_screenshot', { runId: run.runId, file: detail.artifacts.find((f) => f.path.endsWith('.png'))!.path });
    expect(shot.content[1]?.type).toBe('image');
  });

  it('secret rules: ${secrets.*} in a URL is refused by validate_script and run_script (no browser)', async () => {
    const leak = `version: 1\nname: leak\ntarget: { baseUrl: "${site.url}" }\nsteps:\n  - goto: "/login?p=\${secrets.USER_PASSWORD}"\n`;
    const v = await json<{ valid: boolean; issues: { path: string; message: string }[] }>('validate_script', { yaml: leak });
    expect(v.valid).toBe(false);
    expect(v.issues).toEqual([{ path: 'steps[0].goto', message: expect.stringMatching(/only allowed in the value of a fill or type step/) }]);
    const run = await json<{ status: string; steps: unknown[]; validationIssues: unknown[] }>('run_script', { yaml: leak });
    expect(run).toMatchObject({ status: 'error', steps: [] });
    expect(run.validationIssues).toHaveLength(1);
  });

  it('session round trip: open → step → snapshot → export into the working folder → close', async () => {
    const opened = await json<{ sessionId: string; headless: boolean }>('session_open', { baseUrl: site.url, name: 'ai explore', browser: { headless: true }, record: { video: false, trace: false, har: false } });
    const sid = opened.sessionId;
    expect(live.get(sid)?.source).toBe('ai');
    const st = await json<{ status: string }>('session_step', { sessionId: sid, step: { goto: '/login' } });
    expect(st.status).toBe('passed');
    await json('session_step', { sessionId: sid, step: { fill: { target: { label: '이메일' }, value: '${secrets.USER_EMAIL}' } } });
    const snap = await call('session_snapshot', { sessionId: sid });
    expect(snap.content[0]?.text).toMatch(/textbox "이메일"/);
    const outside = await call('session_export', { sessionId: sid, savePath: join(root, 'outside.yaml') });
    expect(outside.isError).toBe(true); // writeRoot = working folder
    const exp = await call('session_export', { sessionId: sid, savePath: 'scripts/explored.yaml' });
    expect(exp.isError, exp.content[0]?.text).toBeFalsy();
    expect(readFileSync(join(work, 'scripts/explored.yaml'), 'utf8')).toContain('${secrets.USER_EMAIL}');
    const closed = await json<{ kind: string; status: string }>('session_close', { sessionId: sid });
    expect(closed).toMatchObject({ kind: 'session', status: 'passed' });
  });

  it('working-folder file tools: list, read, save (scoped, guarded)', async () => {
    const saved = await json<{ savedTo: string; valid: boolean }>('save_script', { path: 'new/login.yaml', yaml: 'version: 1\nname: n\nsteps:\n  - goto: /login\n' });
    expect(saved.savedTo).toBe(join(realpathSync(work), 'new/login.yaml'));
    expect((await call('save_script', { path: 'new/login.yaml', yaml: 'x: 1' })).isError).toBe(true); // no silent overwrite
    expect((await call('save_script', { path: '../escape.yaml', yaml: 'x: 1' })).isError).toBe(true);
    expect((await call('save_script', { path: 'a.sh', yaml: 'x' })).isError).toBe(true);
    // Validated BEFORE saving (ADR-046): a schema error (the real case — expect.visible with `level`) saves nothing.
    const bad = await call('save_script', { path: 'new/heading.yaml', yaml: 'version: 1\nname: h\nsteps:\n  - expect: { visible: { role: heading, name: 로그인, level: 1 } }\n' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/NOT saved/);
    expect(bad.content[0]?.text).toMatch(/level/);
    expect(existsSync(join(work, 'new/heading.yaml'))).toBe(false);
    // The app's write path (cloud: the send queue, origin ai_mcp) is never reached for an invalid script.
    const writes: string[] = [];
    const viaApp = createAppTools({ config: app.config, workDir: work, writeScript: (abs) => void writes.push(abs) });
    const r = (await viaApp.byName.get('save_script')!.handler({ path: 'new/heading.yaml', yaml: 'version: 1\nname: h\nsteps:\n  - expect: { visible: { role: heading, level: 1 } }\n' })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(writes).toEqual([]);
    await viaApp.shutdown();
    // Environment matters (an unset secret / env name) do not block the save, like the cloud server.
    const envRef = await json<{ valid: boolean }>('save_script', { path: 'new/env.yaml', yaml: 'version: 1\nname: e\ntarget:\n  baseUrl: ${env.NOT_SET_ANYWHERE}\nsteps:\n  - fill: { target: { label: x }, value: "${secrets.NOT_CONFIGURED}" }\n' });
    expect(envRef.valid).toBe(false);
    expect(existsSync(join(work, 'new/env.yaml'))).toBe(true);
    rmSync(join(work, 'new/env.yaml'));
    const listed = await json<{ entries: { path: string }[] }>('list_files', { pattern: '.yaml', depth: 3 });
    expect(listed.entries.map((e) => e.path).sort()).toEqual(['new/login.yaml', 'scripts/explored.yaml']);
    const read = await call('read_file', { path: 'new/login.yaml' });
    expect(read.content[1]?.text).toContain('goto: /login');

    writeFileSync(join(work, 'notes.txt'), `password is ${FIXTURE_USER.password}`);
    const masked = await call('read_file', { path: 'notes.txt' });
    expect(masked.content[1]?.text).toBe('password is ***');
    mkdirSync(join(work, '.hidden'));
    writeFileSync(join(work, '.hidden/x.txt'), 'x');
    writeFileSync(join(work, 'secrets.json'), '{}');
    symlinkSync(join(root, 'secrets.json'), join(work, 'link.json'));
    for (const p of ['.hidden/x.txt', 'secrets.json', 'link.json', '../secrets.json', join(root, 'secrets.json')]) {
      expect((await call('read_file', { path: p })).isError, p).toBe(true);
    }
  });

  it('never returns a secret value in any tool result', () => {
    expect(transcript.length).toBeGreaterThan(10);
    const hits = transcript.filter((t) => t.includes(FIXTURE_USER.email) || t.includes(FIXTURE_USER.password));
    expect(hits).toEqual([]);
  });
});
