// E2E for euta cloud C3 (SPEC 클라우드-앱-연동 완료 기준 C3) against a REAL local euta cloud server + a REAL
// runner process (sibling repo builds, fresh database, ALLOW_PRIVATE_TARGETS=true dev-only so the runner can
// reach the engine fixture site on 127.0.0.1):
//   secrets rule on local runs (URL secret → validation error, secret fill on a disallowed host → step error,
//   both in Korean) → upload a project → run a script in the cloud from the Run tab (precheck, Live progress
//   with the 클라우드 badge) → app notification for my run + click opens it → schedule from the 예약 tab →
//   quit the app → the scheduled run fires on the server → relaunch → History shows it → open (files are
//   downloaded into cloud-runs/<id>/ and replayed) → run on this PC and "클라우드에 올리기" (version link).
// EUTA_E2E_EXECUTABLE runs it against the packaged app.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUD_DIR, CloudTestServer } from './cloud-server.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = resolve(appDir, '../euta-engine');
const tmpRoot = join(appDir, '.e2e-tmp', `cloud-runs-${Date.now()}`);
const userData = join(tmpRoot, 'userData');
const shotsDir = process.env.EUTA_E2E_SHOTS ?? join(appDir, 'test-results/screens');
const fakeClaude = join(tmpRoot, 'fake-claude');
const OWNER = 'runner-owner@example.com';
const USER_EMAIL = 'qa.user@example.com';
const USER_PASSWORD = 's3cret P@ss&word!';
const RUNNER_TOKEN = randomBytes(24).toString('hex');

const SCRIPT = `version: 1
name: 로그인 흐름
target:
  baseUrl: \${env.BASE_URL}
defaults:
  timeout: 10s
steps:
  - goto: /login
  - fill: { target: { label: 이메일 }, value: "\${secrets.USER_EMAIL}" }
  - fill: { target: { label: 비밀번호 }, value: "\${secrets.USER_PASSWORD}" }
  - click: { target: { role: button, name: 로그인 } }
    name: 로그인
  - expect: { url: /dashboard }
`;
const LEAK = `version: 1
name: 주소에 비밀번호
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: "/login?p=\${secrets.USER_PASSWORD}"
`;

let fixture: ChildProcess | undefined;
let runner: ChildProcess | undefined;
let fixtureUrl = '';
const cloud = new CloudTestServer(join(tmpRoot, 'cloud'), OWNER, { RUNNER_TOKEN, ALLOW_PRIVATE_TARGETS: 'true' });
const apps: ElectronApplication[] = [];

async function startFixture(): Promise<string> {
  const port = String(6200 + Math.floor(Math.random() * 400));
  fixture = spawn('pnpm', ['fixture'], { cwd: engineDir, env: { ...process.env, PORT: port }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('fixture server did not start')), 30_000);
    fixture!.stdout!.on('data', (c: Buffer) => {
      const m = /listening on (http:\/\/\S+)/.exec(c.toString());
      if (m?.[1]) {
        clearTimeout(timer);
        res(m[1]);
      }
    });
  });
}

/** The sibling repo's runner as a local Node process (README "로컬에서 돌리는 법"). */
function startRunner(): void {
  const work = join(tmpRoot, 'runner-work');
  mkdirSync(work, { recursive: true });
  const log = createWriteStream(join(tmpRoot, 'runner.log'), { flags: 'a' });
  runner = spawn(process.execPath, [join(CLOUD_DIR, 'packages/runner/dist/main.js')], {
    cwd: join(CLOUD_DIR, 'packages/runner'),
    env: { ...process.env, EUTA_SERVER_URL: cloud.internalUrl, EUTA_RUNNER_TOKEN: RUNNER_TOKEN, RUNNER_CONCURRENCY: '2', RUNNER_LOCATION: 'E2E 러너', RUNNER_WORK_DIR: work, RUNNER_CLAIM_WAIT_MS: '2000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runner.stdout!.pipe(log);
  runner.stderr!.pipe(log);
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const executablePath = process.env.EUTA_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [appDir] }),
    cwd: appDir,
    env: { ...(process.env as Record<string, string>), EUTA_E2E: '1', EUTA_USER_DATA_DIR: userData, BASE_URL: 'http://127.0.0.1:9/not-the-environment', SHELL: '/bin/sh', EUTA_CLAUDE_BIN: fakeClaude },
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on('dialog', (d) => void d.accept());
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function close(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => undefined);
  apps.splice(apps.indexOf(app), 1);
}

async function stubOpenDialog(app: ElectronApplication, files: string[]): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: f })) as unknown as typeof dialog.showOpenDialog;
  }, files);
}

const row = (page: Page, path: string) => page.locator(`[data-testid=script-row][data-path="${path}"]`);
const shot = (page: Page, name: string) => page.screenshot({ path: join(shotsDir, name) });

async function newLocalProject(app: ElectronApplication, page: Page, name: string, scripts: string[]): Promise<void> {
  await page.getByTestId('project-new').click();
  await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('new-project-url').fill(fixtureUrl);
  await page.getByTestId('new-project-create').click();
  await expect(page.getByTestId('project-name')).toHaveText(name);
  await page.getByTestId('tab-project').click();
  const card = page.getByTestId('env-card').first();
  for (const [k, v] of [
    ['USER_EMAIL', USER_EMAIL],
    ['USER_PASSWORD', USER_PASSWORD],
  ] as const) {
    await card.getByTestId('secret-name').fill(k);
    await card.getByTestId('secret-value').fill(v);
    await card.getByTestId('secret-save').click();
    await expect(card.locator(`[data-testid=secret-item][data-name=${k}]`)).toBeVisible();
  }
  await page.getByTestId('tab-scripts').click();
  await stubOpenDialog(app, scripts);
  await page.getByTestId('script-import').click();
  for (const s of scripts) await expect(row(page, s.split('/').pop()!)).toBeVisible();
}

/** Run tab (this PC) → Live; returns the run detail locator once finished. */
async function runHere(page: Page, script: string): Promise<ReturnType<Page['getByTestId']>> {
  await page.getByTestId('tab-run').click();
  if (await page.getByTestId('run-where-pc').count()) await page.getByTestId('run-where-pc').check();
  await page.getByTestId('run-script').selectOption(script);
  const detail = page.getByTestId('run-detail');
  const before = (await detail.count()) ? await detail.getAttribute('data-run-id') : null;
  await page.getByTestId('run').click();
  await expect(page.getByTestId('tab-live')).toHaveAttribute('aria-selected', 'true');
  if (before) await expect(detail).not.toHaveAttribute('data-run-id', before);
  await expect(detail.getByTestId('run-status')).not.toHaveAttribute('data-status', /running|unknown/, { timeout: 90_000 });
  return detail;
}

type Notif = { title: string; projectId: string; runId?: string };
const notifications = (app: ElectronApplication): Promise<Notif[]> => app.evaluate(() => (globalThis as unknown as { __eutaTest: { notifications: () => Notif[] } }).__eutaTest.notifications());

test.beforeAll(async () => {
  const why = CloudTestServer.available() ?? (existsSync(join(CLOUD_DIR, 'packages/runner/dist/main.js')) ? undefined : 'euta-cloud runner is not built');
  test.skip(!!why, why);
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });
  writeFileSync(fakeClaude, `#!/bin/sh\nif [ "$1 $2" = "auth status" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"e2e@example.com","subscriptionType":"max"}'; fi\n`);
  chmodSync(fakeClaude, 0o755);
  writeFileSync(join(tmpRoot, 'login-flow.yaml'), SCRIPT);
  writeFileSync(join(tmpRoot, 'leak.yaml'), LEAK);
  fixtureUrl = await startFixture();
  await cloud.start();
  startRunner();
  await cloud.signUp(OWNER, 'owner');
});

test.afterAll(async () => {
  for (const a of [...apps]) await close(a);
  runner?.kill('SIGTERM');
  await cloud.dispose();
  if (fixture?.pid) {
    try {
      process.kill(-fixture.pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('cloud runs: secrets rule locally, cloud run + Live + notification, schedule while the app is closed, History, upload', async () => {
  test.setTimeout(900_000);
  const cookie = await cloud.signIn(OWNER);
  let { app, page } = await launch();

  // ── 1) secrets rule on local runs (SPEC 프로젝트-관리 "secrets 규칙")
  await newLocalProject(app, page, 'Rules', [join(tmpRoot, 'login-flow.yaml'), join(tmpRoot, 'leak.yaml')]);
  await page.getByTestId('tab-project').click();
  const card = page.getByTestId('env-card').first();
  await expect(card.getByTestId('env-domains')).toHaveValue('127.0.0.1');
  await expect(card.getByTestId('env-domains-default')).toBeVisible();
  // URL secret: the Run tab check shows it, the run stops before launching a browser — Korean text
  await page.getByTestId('tab-run').click();
  await page.getByTestId('run-script').selectOption('leak.yaml');
  await page.getByTestId('validate').click();
  await expect(page.getByTestId('validation')).toContainText('는 입력 스텝(fill 의 value · type 의 text)에만 쓸 수 있습니다');
  let detail = await runHere(page, 'leak.yaml');
  await expect(detail.getByTestId('run-status')).toHaveAttribute('data-status', 'error');
  await expect(detail).toContainText('${secrets.USER_PASSWORD} 는 입력 스텝');
  await expect(detail.getByTestId('step-row')).toHaveCount(0);
  await shot(page, 'r1-secret-url-rejected.png');
  // secret fill on a host outside the allowed domains → that step errors
  await page.getByTestId('tab-project').click();
  await card.getByTestId('env-domains').fill('example.com');
  await card.getByTestId('env-save').click();
  await expect(card.getByTestId('env-domains-reset')).toBeVisible();
  detail = await runHere(page, 'login-flow.yaml');
  await expect(detail.getByTestId('run-status')).toHaveAttribute('data-status', 'error');
  await expect(detail.locator('[data-testid=step-row][data-status=error]')).toContainText('테스트 계정 입력 차단: 지금 페이지 "127.0.0.1" 는 허용 도메인(example.com)이 아닙니다');
  await shot(page, 'r2-secret-host-blocked.png');
  // back to the default (address host) → passes
  await page.getByTestId('tab-project').click();
  await card.getByTestId('env-domains-reset').click();
  await expect(card.getByTestId('env-domains')).toHaveValue('127.0.0.1');
  detail = await runHere(page, 'login-flow.yaml');
  await expect(detail.getByTestId('run-status')).toHaveAttribute('data-status', 'passed');

  // ── 2) cloud: login, project uploaded with this PC's values, cloud test credentials (server side)
  await page.getByTestId('app-settings').click();
  await page.getByTestId('cloud-server-url').fill(cloud.url);
  await page.getByTestId('cloud-server-save').click();
  await page.getByTestId('cloud-login').click();
  const code = (await page.getByTestId('cloud-user-code').textContent())!.trim();
  await cloud.approveDevice(cookie, code);
  await expect(page.getByTestId('cloud-state')).toHaveAttribute('data-state', 'online', { timeout: 30_000 });
  await expect(page.getByTestId('cloud-notify')).toBeChecked();
  await page.locator('[data-testid=project-item]', { hasText: 'Rules' }).click();
  await page.getByTestId('tab-project').click();
  await page.getByTestId('upload-cloud').click();
  await page.getByTestId('upload-confirm').click();
  await expect(page.getByTestId('project-name')).toHaveText('☁ Rules');
  const localId = (await page.getByTestId('project').getAttribute('data-project-id'))!;
  const pid = `${localId.slice(0, 8)}-${localId.slice(8, 12)}-${localId.slice(12, 16)}-${localId.slice(16, 20)}-${localId.slice(20)}`;
  const envs = (await cloud.req('GET', `/api/projects/${pid}/environments`, { cookie })).body.environments as { id: string; allowedDomains: string[] }[];
  expect(envs[0]!.allowedDomains).toEqual(['127.0.0.1']);
  for (const [k, v] of [
    ['USER_EMAIL', USER_EMAIL],
    ['USER_PASSWORD', USER_PASSWORD],
  ]) {
    expect((await cloud.req('PUT', `/api/projects/${pid}/environments/${envs[0]!.id}/credentials/${k}`, { cookie, body: { value: v } })).status).toBeLessThan(300);
  }
  await page.getByTestId('tab-scripts').click();
  await expect(row(page, 'login-flow.yaml').getByTestId('script-version')).toContainText('v1', { timeout: 30_000 });

  // ── 3) run location 클라우드: precheck, request, Live progress with the badge
  // leak.yaml breaks the cloud placement rule → the precheck reason shows next to the button
  await row(page, 'leak.yaml').getByTestId('script-run-cloud').click();
  await expect(page.getByTestId('run-where-cloud')).toBeChecked();
  await expect(page.getByTestId('cloud-precheck')).toHaveAttribute('data-ok', '0', { timeout: 20_000 });
  await expect(page.getByTestId('cloud-precheck')).toContainText('secrets 규칙 위반');
  await expect(page.getByTestId('run')).toBeDisabled();
  await page.getByTestId('run-script').selectOption('login-flow.yaml');
  await expect(page.getByTestId('cloud-precheck')).toHaveAttribute('data-ok', '1', { timeout: 20_000 });
  await shot(page, 'r3-cloud-precheck.png');
  await page.getByTestId('run').click();
  detail = page.getByTestId('run-detail');
  await expect(detail.getByTestId('run-cloud')).toBeVisible();
  await expect(page.locator('[data-testid=live-run-item] [data-testid=live-cloud-badge]').first()).toBeVisible();
  await expect(detail.getByTestId('run-cloud')).toHaveAttribute('data-cloud-status', 'passed', { timeout: 180_000 });
  await expect(detail.getByTestId('run-cloud-info')).toContainText('E2E 러너');
  await expect(detail.getByTestId('step-row')).toHaveCount(5);
  await shot(page, 'r4-cloud-live.png');
  const firstRunId = (await detail.getAttribute('data-run-id'))!;

  // ── 4) app notification for my run (GET /api/me/events) and its click → the run (downloaded replay)
  await expect.poll(async () => (await notifications(app)).map((n) => n.title), { timeout: 60_000 }).toContain('클라우드 실행 끝: 통과 — login-flow.yaml');
  const notes = await notifications(app);
  expect(notes.find((n) => n.title.startsWith('클라우드 실행 끝'))).toMatchObject({ projectId: localId, runId: firstRunId });
  await page.getByTestId('tab-scripts').click();
  await app.evaluate((_e, i) => (globalThis as unknown as { __eutaTest: { clickNotification: (i: number) => void } }).__eutaTest.clickNotification(i), notes.findIndex((n) => n.runId === firstRunId));
  await expect(page.getByTestId('tab-live')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('run-detail').getByTestId('run-cloud-info')).toContainText('내려받은 결과 파일');
  await expect(page.getByTestId('run-detail').getByTestId('screenshot')).toBeVisible({ timeout: 20_000 });

  // ── 5) 예약 tab: a schedule a couple of minutes ahead, then quit the app
  await page.getByTestId('tab-schedules').click();
  await expect(page.getByTestId('schedules-note')).toContainText('꺼져 있어도 돕니다');
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('schedule-name').fill('E2E 매시간');
  await page.getByTestId('schedule-target').selectOption('script:login-flow.yaml');
  await page.getByTestId('schedule-kind').selectOption('hourly');
  const now = new Date();
  const minute = (now.getUTCMinutes() + (now.getUTCSeconds() > 40 ? 2 : 1)) % 60;
  await page.getByTestId('schedule-minute').fill(String(minute));
  await page.getByTestId('schedule-save').click();
  const schedRow = page.getByTestId('schedule-row').first();
  await expect(schedRow).toContainText(`매시간 ${String(minute).padStart(2, '0')}분`);
  await expect(schedRow.getByTestId('schedule-next')).not.toHaveText('—');
  await shot(page, 'r5-schedule.png');
  const sched = (await cloud.req('GET', `/api/projects/${pid}/schedules`, { cookie })).body.schedules[0] as { id: string; nextRunAt: string };
  await close(app);

  // ── 6) app closed: the server fires the occurrence, the runner runs it
  const fired = await (async () => {
    const until = Date.parse(sched.nextRunAt) + 240_000;
    for (;;) {
      const r = (await cloud.req('GET', `/api/projects/${pid}/runs?source=schedule`, { cookie })).body.runs as { id: string; status: string; scheduleId: string }[];
      const done = r.find((x) => x.scheduleId === sched.id && !['queued', 'leased', 'running'].includes(x.status));
      if (done) return done;
      if (Date.now() > until) throw new Error(`scheduled run did not finish (next ${sched.nextRunAt}) — see ${tmpRoot}/runner.log`);
      await new Promise((res) => setTimeout(res, 3000));
    }
  })();
  expect(fired.status).toBe('passed');

  // ── 7) relaunch: History shows the scheduled run (source 예약, runner location), open downloads + replays
  ({ app, page } = await launch());
  await expect(page.getByTestId('project-name')).toHaveText('☁ Rules');
  await page.getByTestId('tab-history').click();
  const schedHistory = page.locator(`[data-testid=history-row][data-run-id="${fired.id}"]`);
  await expect(schedHistory).toHaveAttribute('data-cloud-source', 'schedule', { timeout: 30_000 });
  await expect(schedHistory.getByTestId('history-location')).toHaveText('E2E 러너');
  await expect(schedHistory).toContainText('예약');
  await shot(page, 'r6-history-merged.png');
  await schedHistory.getByTestId('history-cloud-open').click();
  await expect(page.getByTestId('tab-live')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('run-detail').getByTestId('run-status')).toHaveAttribute('data-status', 'passed');
  await expect(page.getByTestId('run-detail').getByTestId('step-row')).toHaveCount(5);
  await expect(page.getByTestId('run-detail').getByTestId('screenshot')).toBeVisible({ timeout: 20_000 });
  const cacheDir = join(userData, 'cloud');
  const cached = readdirSync(cacheDir, { recursive: true }).map(String).filter((p) => p.includes(`cloud-runs/${fired.id}/`) || p.includes(`cloud-runs\\${fired.id}\\`));
  expect(cached.some((p) => p.endsWith('report.html'))).toBe(true);
  expect(cached.some((p) => p.endsWith('steps.jsonl'))).toBe(true);
  await shot(page, 'r7-history-open.png');

  // ── 8) a run on this PC → "클라우드에 올리기" → linked to the cloud version
  detail = await runHere(page, 'login-flow.yaml');
  await expect(detail.getByTestId('run-status')).toHaveAttribute('data-status', 'passed');
  const localRunId = (await detail.getAttribute('data-run-id'))!;
  await page.getByTestId('tab-history').click();
  const localRow = page.locator(`[data-testid=history-row][data-run-id="${localRunId}"]`);
  await expect(localRow).toHaveAttribute('data-source', 'local');
  await localRow.getByTestId('history-upload').click();
  await expect(page.getByTestId('history-note')).toContainText('클라우드 버전 v1 에 연결');
  await expect(localRow.getByTestId('history-uploaded')).toBeVisible();
  const uploaded = (await cloud.req('GET', `/api/projects/${pid}/runs?source=local_upload`, { cookie })).body.runs as { runnerLocation: string; script: { version: number }; localModified: boolean }[];
  expect(uploaded).toHaveLength(1);
  expect(uploaded[0]).toMatchObject({ runnerLocation: 'PC — owner', localModified: false, script: { version: 1 } });
  await shot(page, 'r8-uploaded.png');

  // no test credential value anywhere under userData (cloud values never come back; this PC's are encrypted)
  const hits = readdirSync(userData, { recursive: true })
    .map((p) => join(userData, String(p)))
    .filter((p) => {
      try {
        const b = readFileSync(p);
        return b.includes(USER_PASSWORD) || b.includes(encodeURIComponent(USER_PASSWORD));
      } catch {
        return false;
      }
    });
  expect(hits).toEqual([]);
  await close(app);
});
