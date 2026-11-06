// Secret rules on every local run (SPEC 프로젝트-관리 "secrets 규칙", PLAN_euta-cloud 결정 "secrets 규칙 적용
// 범위"): allowed-domain defaults and normalization, project.json backward compatibility, and the wiring
// of placement + domains into each local run path — run button / suites (startRun), the AI chat tool
// config, the advanced terminal's MCP environment — plus the Korean wording of violations.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, FIXTURE_USER, type FixtureServer } from '../../../euta-engine/packages/core/test/fixture-site/server.js';
import { LiveStore } from '../../src/main/live-store.js';
import { ProjectService, type CloudBridge } from '../../src/main/project/service.js';
import { aiServerConfig } from '../../src/main/project/run-options.js';
import { buildPtyEnv } from '../../src/main/terminal-env.js';
import { cleanDomain, defaultDomains, koSecretRule, parseDomains } from '../../src/shared/secret-rules.js';
import { mockSafeStorage } from './helpers.js';

const LEAK = `version: 1
name: leak
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: "/login?p=\${secrets.USER_PASSWORD}"
`;
const LOGIN = `version: 1
name: login
target:
  baseUrl: \${env.BASE_URL}
defaults:
  timeout: 5s
steps:
  - goto: /login
  - fill: { target: { label: 이메일 }, value: "\${secrets.USER_EMAIL}" }
  - fill: { target: { label: 비밀번호 }, value: "\${secrets.USER_PASSWORD}" }
  - click: { target: { role: button, name: 로그인 } }
  - expect: { url: /dashboard }
`;

describe('secret rule helpers', () => {
  it('cleanDomain / parseDomains normalize hosts and refuse non-hosts', () => {
    expect(cleanDomain('https://Login.Example.com:8443/path?q')).toBe('login.example.com');
    expect(cleanDomain('*.example.com')).toBe('example.com');
    expect(cleanDomain('.example.com.')).toBe('example.com');
    expect(cleanDomain('127.0.0.1:5800')).toBe('127.0.0.1');
    expect(cleanDomain('not a host!')).toBeUndefined();
    expect(parseDomains('a.com, https://a.com/x b.com  bad_host!')).toEqual({ domains: ['a.com', 'b.com'], invalid: ['bad_host!'] });
  });

  it('defaultDomains: saved list wins, else the address host, else nowhere', () => {
    expect(defaultDomains({ baseUrl: 'https://dev.example.com/app' })).toEqual(['dev.example.com']);
    expect(defaultDomains({ baseUrl: 'https://dev.example.com', allowedDomains: ['sso.example.com'] })).toEqual(['sso.example.com']);
    expect(defaultDomains({ baseUrl: 'https://dev.example.com', allowedDomains: [] })).toEqual([]);
    expect(defaultDomains({ baseUrl: '' })).toEqual([]);
    expect(defaultDomains(undefined)).toEqual([]);
  });

  it('koSecretRule turns the engine messages into Korean and keeps the rest', () => {
    expect(koSecretRule('  steps[0].goto: ${secrets.PW} is only allowed in the value of a fill or type step (secret placement rule)')).toBe(
      '  steps[0].goto: ${secrets.PW} 는 입력 스텝(fill 의 value · type 의 text)에만 쓸 수 있습니다 — 주소·변수·확인·이름 등에 넣으면 테스트 계정이 바깥으로 나갈 수 있어 실행하지 않습니다 (secrets 규칙)',
    );
    expect(koSecretRule('secret input blocked: page host "evil.test" is not an allowed domain (dev.example.com)')).toMatch(/^테스트 계정 입력 차단: 지금 페이지 "evil\.test" 는 허용 도메인\(dev\.example\.com\)이 아닙니다/);
    expect(koSecretRule('secret input blocked: page host "about:blank" is not an allowed domain (no allowed domains configured)')).toMatch(/이 환경에 허용 도메인이 없습니다/);
    expect(koSecretRule('timeout 5000ms exceeded')).toBe('timeout 5000ms exceeded');
  });
});

describe('secret rules on local runs (fixture site)', () => {
  let site: FixtureServer;
  let userData: string;
  let live: LiveStore;
  let svc: ProjectService;

  beforeAll(async () => {
    site = await startFixtureServer();
    userData = mkdtempSync(join(tmpdir(), 'euta-secret-rules-'));
    live = new LiveStore({ throttleMs: 0 });
    svc = new ProjectService({ userData, safeStorage: mockSafeStorage(), live, watch: false, processEnv: { PATH: process.env.PATH } });
  });
  afterAll(async () => {
    await svc.dispose();
    live.dispose();
    await site.close();
    rmSync(userData, { recursive: true, force: true });
  });

  const waitRun = (runId: string) => new Promise<void>((res) => {
    const t = setInterval(() => {
      const v = live.get(runId);
      if (v && v.status !== 'running' && v.status !== 'unknown') {
        clearInterval(t);
        res();
      }
    }, 50);
  });

  it('project.json without allowedDomains → address host; a saved list is used as-is; null resets', () => {
    const p = svc.create({ name: 'Rules', baseUrl: site.url });
    const env = p.environments[0]!;
    expect(env.allowedDomains).toBeUndefined();
    expect(env.domains).toEqual(['127.0.0.1']);
    expect(env.domainsDefault).toBe(true);
    // an older project.json has no field at all — reading it still gives the default
    const file = join(svc.store.dir(p.id), 'project.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.environments[0].allowedDomains).toBeUndefined();
    const v1 = svc.upsertEnv(p.id, env.id, { allowedDomains: 'https://sso.example.com/login, *.example.com' });
    expect(v1.environments[0]!).toMatchObject({ allowedDomains: ['sso.example.com', 'example.com'], domains: ['sso.example.com', 'example.com'] });
    expect(v1.environments[0]!.domainsDefault).toBeUndefined();
    expect(() => svc.upsertEnv(p.id, env.id, { allowedDomains: ['bad host!'] })).toThrow(/허용 도메인은 호스트 이름/);
    const v2 = svc.upsertEnv(p.id, env.id, { allowedDomains: null });
    expect(v2.environments[0]!.allowedDomains).toBeUndefined();
    expect(v2.environments[0]!.domains).toEqual(['127.0.0.1']);
  });

  it('every local path gets restrictSecrets + the environment domains (run assembly, AI config, terminal union)', () => {
    const p = svc.list().find((x) => x.name === 'Rules')!;
    const env = svc.view(p.id).environments[0]!;
    const ctx = svc.runContext(p.id, env.id);
    expect(ctx.allowedDomains).toEqual(['127.0.0.1']);
    const ai = aiServerConfig(ctx);
    expect(ai).toMatchObject({ restrictSecrets: true, allowedDomains: ['127.0.0.1'] });
    svc.upsertEnv(p.id, undefined, { name: 'stg', baseUrl: 'https://stg.example.com' });
    expect(svc.terminalDomains(p.id).sort()).toEqual(['127.0.0.1', 'stg.example.com']);
    const pty = buildPtyEnv({}, { url: 'http://127.0.0.1:1', token: 't', runsDir: '/r', allowedDomains: svc.terminalDomains(p.id) });
    expect(pty.EUTA_RESTRICT_SECRETS).toBe('1');
    expect(pty.EUTA_ALLOWED_DOMAINS!.split(',').sort()).toEqual(['127.0.0.1', 'stg.example.com']);
  });

  it('run button: ${secrets.*} in a URL → validation error before launching, shown in Korean; 검증 shows it too', async () => {
    const p = svc.list().find((x) => x.name === 'Rules')!;
    const envId = svc.view(p.id).defaultEnvId!;
    svc.setSecret(p.id, envId, 'USER_PASSWORD', FIXTURE_USER.password);
    svc.setSecret(p.id, envId, 'USER_EMAIL', FIXTURE_USER.email);
    writeFileSync(join(svc.view(p.id).dirs.scripts, 'leak.yaml'), LEAK);
    const check = svc.checkScript(p.id, 'leak.yaml', envId, '', '');
    expect(check.issues).toEqual([{ path: 'steps[0].goto', message: expect.stringMatching(/^\$\{secrets\.USER_PASSWORD\} 는 입력 스텝/) }]);
    expect(svc.scriptDetail(p.id, 'leak.yaml', envId).ruleIssues).toHaveLength(1);
    expect(svc.scriptDetail(p.id, 'leak.yaml', envId).issues).toEqual([]); // saving is not blocked
    const h = svc.startRun({ projectId: p.id, script: 'leak.yaml', envId, vars: '', env: '' });
    const r = await h.result;
    expect(r).toMatchObject({ status: 'error', steps: [] });
    await waitRun(h.runId);
    expect(live.get(h.runId)?.error).toMatch(/steps\[0\]\.goto: \$\{secrets\.USER_PASSWORD\} 는 입력 스텝/);
    expect(readFileSync(join(h.runDir, 'run.json'), 'utf8')).not.toContain(FIXTURE_USER.password);
  });

  it('secret fill on a host outside the allowed domains → that step errors (Korean in Live); the default host passes', async () => {
    const p = svc.list().find((x) => x.name === 'Rules')!;
    const envId = svc.view(p.id).defaultEnvId!;
    writeFileSync(join(svc.view(p.id).dirs.scripts, 'login.yaml'), LOGIN);
    svc.upsertEnv(p.id, envId, { allowedDomains: ['example.com'] });
    const blocked = svc.startRun({ projectId: p.id, script: 'login.yaml', envId, vars: '', env: '' });
    const b = await blocked.result;
    expect(b.status).toBe('error');
    expect(b.steps[1]).toMatchObject({ status: 'error', error: 'secret input blocked: page host "127.0.0.1" is not an allowed domain (example.com)' });
    await waitRun(blocked.runId);
    expect(live.get(blocked.runId)?.steps.find((s) => s.stepId === '2')?.error).toMatch(/^테스트 계정 입력 차단: 지금 페이지 "127\.0\.0\.1" 는 허용 도메인\(example\.com\)이 아닙니다/);
    svc.upsertEnv(p.id, envId, { allowedDomains: null });
    const ok = await svc.startRun({ projectId: p.id, script: 'login.yaml', envId, vars: '', env: '' }).result;
    expect(ok.status).toBe('passed');
  });

  it('local runs keep the local-only behaviour: no input: os validation error, local record defaults', async () => {
    const p = svc.list().find((x) => x.name === 'Rules')!;
    const envId = svc.view(p.id).defaultEnvId!;
    writeFileSync(join(svc.view(p.id).dirs.scripts, 'os.yaml'), `version: 1\nname: os\ntarget:\n  baseUrl: \${env.BASE_URL}\nsteps:\n  - goto: /login\n    input: os\n`);
    const r = await svc.startRun({ projectId: p.id, script: 'os.yaml', envId, vars: '', env: '', headless: true }).result;
    expect(r.validationIssues).toBeUndefined(); // headless refusal at run time, not the cloud validation rule
    expect(JSON.parse(readFileSync(join(r.runDir, 'run.json'), 'utf8')).record).toMatchObject({ video: true, trace: true });
  });

  it('cloud project: the server environment list is the one used (this PC runs)', () => {
    const p = svc.list().find((x) => x.name === 'Rules')!;
    const env = svc.view(p.id).environments[0]!;
    const bridge = { envExtra: () => ({ credentialNames: [], allowedDomains: ['dev.example.com'], cloudRunnable: true }) } as unknown as CloudBridge;
    const s2 = svc as unknown as { cloud?: CloudBridge; store: { isCloud: (id: string) => boolean } };
    const isCloud = s2.store.isCloud;
    s2.store.isCloud = () => true;
    s2.cloud = bridge;
    try {
      expect(svc.domainsFor(p.id, svc.store.env(p.id, env.id))).toEqual(['dev.example.com']);
    } finally {
      s2.store.isCloud = isCloud;
      s2.cloud = undefined;
    }
  });
});
