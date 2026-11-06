// E2E for euta cloud sync (SPEC 클라우드-앱-연동 완료 기준 C2) against a REAL local euta cloud server
// (sibling repo's docker compose PostgreSQL + built server, fresh database, admin-approval mode):
// device login → upload a local project → a second account sees the same state (viewer, then
// editor after the invitation) → both save the same script → conflict screen ③ copy / ② theirs →
// offline edits on both PCs → reconnect resend (A) / restart + stop at the conflict + ① mine (B) →
// outside editor change → AI save conflict (scripted test agent) → no plaintext token or test
// credential value under either userData. EUTA_E2E_EXECUTABLE runs it against the packaged app.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudTestServer } from './cloud-server.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = resolve(appDir, '../euta-engine');
const tmpRoot = join(appDir, '.e2e-tmp', `cloud-${Date.now()}`);
const userDataA = join(tmpRoot, 'userData-A');
const userDataB = join(tmpRoot, 'userData-B');
const shotsDir = process.env.EUTA_E2E_SHOTS ?? join(appDir, 'test-results/screens');
const fakeClaude = join(tmpRoot, 'fake-claude');
const OWNER = 'owner@example.com';
const MEMBER = 'member@example.com';
// Fixture site credentials (engine packages/core/test/fixture-site/server.ts FIXTURE_USER).
const USER_EMAIL = 'qa.user@example.com';
const USER_PASSWORD = 's3cret P@ss&word!';
const CLOUD_ONLY_VALUE = 'cloud-only-Credential-Value-7781';

const SCRIPT = `# 로그인 흐름 (클라우드 E2E)
version: 1
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

let fixture: ChildProcess | undefined;
let fixtureUrl = '';
const cloud = new CloudTestServer(join(tmpRoot, 'cloud'), OWNER);
const apps: ElectronApplication[] = [];

async function startFixture(): Promise<string> {
  const port = String(5800 + Math.floor(Math.random() * 400));
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

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const executablePath = process.env.EUTA_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [appDir] }),
    cwd: appDir,
    env: {
      ...(process.env as Record<string, string>),
      EUTA_E2E: '1',
      EUTA_USER_DATA_DIR: userData,
      BASE_URL: 'http://127.0.0.1:9/not-the-environment',
      SHELL: '/bin/sh',
      EUTA_E2E_FAKE_AGENT: '1',
      EUTA_CLAUDE_BIN: fakeClaude,
    },
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

/** App settings → 클라우드: server address, device login approved "in the browser" by `email`. */
async function login(page: Page, email: string): Promise<void> {
  await page.getByTestId('app-settings').click();
  const urlInput = page.getByTestId('cloud-server-url');
  if ((await urlInput.inputValue()) !== cloud.url) {
    await urlInput.fill(cloud.url);
    await page.getByTestId('cloud-server-save').click();
  }
  await expect(page.getByTestId('cloud-state')).toHaveAttribute('data-state', 'signed_out');
  await page.getByTestId('cloud-login').click();
  const code = (await page.getByTestId('cloud-user-code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9-]{6,}$/);
  await cloud.approveDevice(await cloud.signIn(email), code);
  await expect(page.getByTestId('cloud-state')).toHaveAttribute('data-state', 'online', { timeout: 30_000 });
  await expect(page.getByTestId('cloud-user')).toHaveText(email);
  await expect(page.getByTestId('cloud-chip')).toHaveAttribute('data-state', 'online');
}

async function stubOpenDialog(app: ElectronApplication, files: string[]): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: f })) as unknown as typeof dialog.showOpenDialog;
  }, files);
}

const step = (page: Page, id: string) => page.locator(`[data-testid=detail-step][data-step-id="${id}"]`);
const row = (page: Page, path: string) => page.locator(`[data-testid=script-row][data-path="${path}"]`);

async function openDetail(page: Page, path: string): Promise<void> {
  await page.getByTestId('tab-scripts').click();
  if (await page.getByTestId('script-detail').count()) {
    if ((await page.getByTestId('script-detail').getAttribute('data-path')) === path) return;
    await page.getByTestId('detail-back').click();
  }
  await row(page, path).getByTestId('script-detail-open').click();
  await expect(page.getByTestId('script-detail')).toHaveAttribute('data-path', path);
}

/** Editor: change step `id`'s field, wait until it can be saved. */
async function editField(page: Page, id: string, field: 'f-url' | 'f-name', value: string): Promise<void> {
  await page.getByTestId('detail-edit').click();
  await step(page, id).locator('.step-main').click();
  await page.getByTestId('step-form').getByTestId(field).fill(value);
  await expect(page.getByTestId('edit-status')).toContainText('저장할 수 있습니다');
}

async function serverScript(cookie: string, projectId: string, path: string): Promise<{ version: number; source: string }> {
  const r = await cloud.req('GET', `/api/projects/${projectId}/scripts/${path}`, { cookie });
  expect(r.status).toBe(200);
  return r.body as { version: number; source: string };
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(shotsDir, name) });

function allFiles(root: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, n.name);
    if (n.isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

test.beforeAll(async () => {
  const why = CloudTestServer.available();
  test.skip(!!why, why);
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });
  writeFileSync(fakeClaude, `#!/bin/sh\nif [ "$1 $2" = "auth status" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"e2e@example.com","subscriptionType":"max"}'; fi\n`);
  chmodSync(fakeClaude, 0o755);
  writeFileSync(join(tmpRoot, 'login-flow.yaml'), SCRIPT);
  fixtureUrl = await startFixture();
  await cloud.start();
  // Accounts (admin-approval mode): the admin is active at once; the member waits for approval.
  await cloud.signUp(OWNER, 'owner');
  await cloud.signUp(MEMBER, 'member');
  await cloud.approveUser(await cloud.signIn(OWNER), MEMBER);
});

test.afterAll(async () => {
  for (const a of [...apps]) await close(a);
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

test('cloud sync: login, upload, shared state, conflicts, offline resend, outside change, AI conflict, no plaintext', async () => {
  test.setTimeout(600_000);
  const ownerCookie = await cloud.signIn(OWNER);
  const memberCookie = await cloud.signIn(MEMBER);

  // ── 1) PC A (owner): device login → local project with this PC's secrets + a script → upload.
  let { app: appA, page: a } = await launch(userDataA);
  await login(a, OWNER);
  await shot(a, 'c1-login.png');
  await a.getByTestId('project-new').click();
  await a.getByTestId('new-project-name').fill('Shared Portal');
  await a.getByTestId('new-project-url').fill(fixtureUrl);
  await a.getByTestId('new-project-create').click();
  await expect(a.getByTestId('project-name')).toHaveText('Shared Portal');
  await a.getByTestId('tab-project').click();
  const card = a.getByTestId('env-card').first();
  for (const [k, v] of [
    ['USER_EMAIL', USER_EMAIL],
    ['USER_PASSWORD', USER_PASSWORD],
  ] as const) {
    await card.getByTestId('secret-name').fill(k);
    await card.getByTestId('secret-value').fill(v);
    await card.getByTestId('secret-save').click();
    await expect(card.locator(`[data-testid=secret-item][data-name=${k}]`)).toBeVisible();
  }
  await a.getByTestId('tab-scripts').click();
  await stubOpenDialog(appA, [join(tmpRoot, 'login-flow.yaml')]);
  await a.getByTestId('script-import').click();
  await expect(row(a, 'login-flow.yaml')).toBeVisible();

  await a.getByTestId('tab-project').click();
  // 올리기 = 전환 (stage 15): the local project becomes the cloud project in place.
  await a.getByTestId('upload-cloud').click();
  await a.getByTestId('upload-confirm').click();
  await expect(a.getByTestId('upload-result')).toContainText('USER_EMAIL, USER_PASSWORD');
  await expect(a.getByTestId('project-name')).toHaveText('☁ Shared Portal');
  await expect(a.getByTestId('project-item')).toHaveCount(1);
  await shot(a, 'c2-uploaded.png');
  const localId = (await a.getByTestId('project').getAttribute('data-project-id'))!;
  const pid = `${localId.slice(0, 8)}-${localId.slice(8, 12)}-${localId.slice(12, 16)}-${localId.slice(16, 20)}-${localId.slice(20)}`;
  const serverId = createHash('sha256').update(cloud.url).digest('hex').slice(0, 12);
  const fileA = join(userDataA, 'cloud', serverId, 'projects', pid, 'scripts', 'login-flow.yaml');
  const fileB = join(userDataB, 'cloud', serverId, 'projects', pid, 'scripts', 'login-flow.yaml');
  await a.getByTestId('tab-scripts').click();
  await expect(row(a, 'login-flow.yaml').getByTestId('script-version')).toContainText('v1', { timeout: 30_000 });
  expect(readFileSync(fileA, 'utf8')).toBe(SCRIPT);
  // Dual status on A: values were not uploaded (cloud: 없음), this PC's values moved along.
  await a.getByTestId('tab-project').click();
  await expect(a.locator('[data-testid=cred-item][data-name=USER_EMAIL]')).toHaveAttribute('data-cloud', '0');
  await expect(a.locator('[data-testid=cred-item][data-name=USER_EMAIL]')).toHaveAttribute('data-pc', '1');

  // A local run of the cloud project uses this PC's vault values (key = cloud project/env ids).
  await openDetail(a, 'login-flow.yaml');
  await a.getByTestId('detail-run').click();
  await expect(a.getByTestId('detail-last-run').locator('[data-status=passed]')).toHaveText('통과', { timeout: 120_000 });

  // ── 2) PC B (member, not invited yet = 보기): finds the project, sees the same state, read-only.
  let { app: appB, page: b } = await launch(userDataB);
  await login(b, MEMBER);
  await b.getByTestId('cloud-find').click();
  await b.locator('[data-testid=cloud-project-row][data-name="Shared Portal"]').getByTestId('cloud-project-open').click();
  await expect(b.getByTestId('project-name')).toHaveText('☁ Shared Portal');
  await expect(b.getByTestId('readonly-badge')).toBeVisible();
  await expect(row(b, 'login-flow.yaml').getByTestId('script-version')).toContainText('v1', { timeout: 30_000 });
  await expect(row(b, 'login-flow.yaml').getByTestId('script-run')).toHaveCount(0);
  await expect(b.getByTestId('script-new')).toHaveCount(0);
  await openDetail(b, 'login-flow.yaml');
  await expect(b.getByTestId('detail-edit')).toHaveCount(0);
  await expect(b.getByTestId('detail-step')).toHaveCount(5);
  await shot(b, 'c3-member-viewer.png');

  // A invites B as editor (A is the organization admin — the server has no member directory yet).
  await a.getByTestId('tab-project').click();
  await a.getByTestId('member-email').fill(MEMBER);
  await a.getByTestId('member-role').selectOption('editor');
  await a.getByTestId('member-invite').click();
  await expect(a.locator(`[data-testid=member-item][data-email="${MEMBER}"]`)).toHaveAttribute('data-role', 'editor');
  // A also stores USER_PASSWORD in the cloud (this PC + cloud).
  const credA = a.getByTestId('env-card').first();
  await credA.getByTestId('cred-name').fill('USER_PASSWORD');
  await credA.getByTestId('cred-value').fill(USER_PASSWORD);
  await credA.getByTestId('cred-cloud').check();
  await credA.getByTestId('cred-save').click();
  await expect(a.locator('[data-testid=cred-item][data-name=USER_PASSWORD]')).toHaveAttribute('data-cloud', '1');
  // A cloud-only credential (never on this PC).
  await credA.getByTestId('cred-name').fill('API_SECRET_KEY');
  await credA.getByTestId('cred-value').fill(CLOUD_ONLY_VALUE);
  await credA.getByTestId('cred-pc').uncheck();
  await credA.getByTestId('cred-cloud').check();
  await credA.getByTestId('cred-save').click();
  await expect(a.locator('[data-testid=cred-item][data-name=API_SECRET_KEY]')).toHaveAttribute('data-pc', '0');
  await shot(a, 'c4-owner-credentials.png');

  // B: the role change and the settings arrive live (feed) — editor now, same environment.
  await expect(b.getByTestId('readonly-badge')).toHaveCount(0, { timeout: 20_000 });
  await b.getByTestId('tab-project').click();
  await expect(b.getByTestId('env-card').first().getByTestId('env-url')).toHaveValue(fixtureUrl);
  await expect(b.locator('[data-testid=cred-item][data-name=USER_PASSWORD]')).toHaveAttribute('data-cloud', '1');
  await expect(b.locator('[data-testid=cred-item][data-name=USER_PASSWORD]')).toHaveAttribute('data-pc', '0');
  // USER_EMAIL exists only on A's PC (values are never uploaded) → nothing to show on B.
  await expect(b.locator('[data-testid=cred-item][data-name=USER_EMAIL]')).toHaveCount(0);
  await expect(b.locator('[data-testid=cred-item][data-name=API_SECRET_KEY]')).toHaveAttribute('data-cloud', '1');
  await shot(b, 'c5-member-same-state.png');

  // ── 3) Both edit the same script; A saves first → B's save opens the conflict screen.
  // Round 1: ③ my text as a copy.
  await openDetail(a, 'login-flow.yaml');
  await openDetail(b, 'login-flow.yaml');
  await editField(b, '1', 'f-url', '/login?from=member-1');
  await editField(a, '4', 'f-name', '로그인 (A-1)');
  await a.getByTestId('edit-save').click();
  await expect(a.getByTestId('detail-note')).toContainText('버전 2');
  await expect(b.getByTestId('cloud-remote-saved')).toBeVisible({ timeout: 20_000 });
  await b.getByTestId('edit-save').click();
  const dlg = b.getByTestId('conflict-dialog');
  await expect(dlg).toHaveAttribute('data-path', 'login-flow.yaml');
  await expect(dlg.getByTestId('conflict-server-version')).toContainText('버전 2');
  await expect(dlg.locator('[data-testid=conflict-row][data-kind=changed]').first()).toBeVisible();
  await expect(dlg.getByTestId('conflict-choose-copy')).toContainText('login-flow-member.yaml');
  await shot(b, 'c6-conflict-3-choices.png');
  await dlg.getByTestId('conflict-choose-copy').click();
  await expect(dlg).toHaveCount(0);
  expect((await serverScript(ownerCookie, pid, 'login-flow-member.yaml')).source).toContain('/login?from=member-1');
  expect((await serverScript(ownerCookie, pid, 'login-flow.yaml')).version).toBe(2);
  await a.getByTestId('detail-back').click();
  await expect(row(a, 'login-flow-member.yaml')).toBeVisible({ timeout: 20_000 });

  // Round 2: ② take the server's version.
  await openDetail(a, 'login-flow.yaml');
  await openDetail(b, 'login-flow.yaml');
  await editField(b, '1', 'f-url', '/login?from=member-2');
  await editField(a, '4', 'f-name', '로그인 (A-2)');
  await a.getByTestId('edit-save').click();
  await expect(a.getByTestId('detail-note')).toContainText('버전 3');
  await expect(b.getByTestId('cloud-remote-saved')).toBeVisible({ timeout: 20_000 });
  await b.getByTestId('edit-save').click();
  await b.getByTestId('conflict-dialog').getByTestId('conflict-choose-theirs').click();
  await expect(b.getByTestId('conflict-dialog')).toHaveCount(0);
  await expect(step(b, '4').getByTestId('step-title')).toHaveText('로그인 (A-2)');
  await expect(step(b, '1').getByTestId('step-sentence')).toHaveText('/login 으로 이동');
  expect(readFileSync(fileB, 'utf8')).not.toContain('member-2');

  // ── 4) Offline: the server stops; both PCs keep editing (saves wait in pending/).
  await cloud.stop();
  await expect(a.getByTestId('cloud-chip')).toHaveAttribute('data-state', 'offline', { timeout: 30_000 });
  await expect(b.getByTestId('cloud-chip')).toHaveAttribute('data-state', 'offline', { timeout: 30_000 });
  await expect(a.getByTestId('offline-badge')).toBeVisible();
  await editField(a, '4', 'f-name', '로그인 (A-offline)');
  await a.getByTestId('edit-save').click();
  await expect(a.getByTestId('detail-note')).toContainText('보내기 대기');
  await expect(a.getByTestId('pending-badge')).toContainText('1');
  await editField(b, '1', 'f-url', '/login?from=member-offline');
  await b.getByTestId('edit-save').click();
  await expect(b.getByTestId('detail-note')).toContainText('보내기 대기');
  await openDetail(b, 'login-flow-member.yaml');
  await editField(b, '1', 'f-url', '/login?from=copy-offline');
  await b.getByTestId('edit-save').click();
  await expect(b.getByTestId('pending-badge')).toContainText('2');
  await b.getByTestId('detail-back').click();
  await expect(row(b, 'login-flow.yaml').getByTestId('script-pending')).toHaveText('보내기 대기');
  await shot(b, 'c7-offline-pending.png');
  // B's PC is switched off with its queue; the server comes back; A resends.
  await close(appB);
  await cloud.restart();
  await expect(a.getByTestId('cloud-chip')).toHaveAttribute('data-state', 'online', { timeout: 30_000 });
  await expect(a.getByTestId('pending-badge')).toHaveCount(0, { timeout: 30_000 });
  let srv = await serverScript(ownerCookie, pid, 'login-flow.yaml');
  expect(srv.version).toBe(4);
  expect(srv.source).toContain('로그인 (A-offline)');
  // B starts again: its queue is sent in order and stops at the conflict (login-flow), the copy waits behind it.
  ({ app: appB, page: b } = await launch(userDataB));
  await expect(b.getByTestId('cloud-chip')).toHaveAttribute('data-state', 'online', { timeout: 30_000 });
  const dlg2 = b.getByTestId('conflict-dialog');
  await expect(dlg2).toHaveAttribute('data-path', 'login-flow.yaml', { timeout: 30_000 });
  await expect(dlg2.getByTestId('conflict-server-version')).toContainText('버전 4');
  await expect(row(b, 'login-flow-member.yaml').getByTestId('script-pending')).toBeVisible();
  await shot(b, 'c8-reconnect-conflict.png');
  await dlg2.getByTestId('conflict-choose-mine').click();
  await expect(dlg2).toHaveCount(0);
  await expect(b.getByTestId('pending-badge')).toHaveCount(0, { timeout: 30_000 });
  srv = await serverScript(ownerCookie, pid, 'login-flow.yaml');
  expect(srv.version).toBe(5);
  expect(srv.source).toContain('/login?from=member-offline');
  expect((await serverScript(ownerCookie, pid, 'login-flow-member.yaml')).source).toContain('/login?from=copy-offline');
  await expect.poll(() => readFileSync(fileA, 'utf8'), { timeout: 20_000 }).toContain('/login?from=member-offline');

  // ── 5) Outside editor change on A → "앱 바깥 변경" version → B follows.
  await a.getByTestId('detail-back').click();
  writeFileSync(fileA, readFileSync(fileA, 'utf8').replace('name: 로그인 흐름', 'name: 로그인 흐름 (바깥 편집기)'));
  await expect.poll(() => readFileSync(fileB, 'utf8'), { timeout: 30_000 }).toContain('로그인 흐름 (바깥 편집기)');
  srv = await serverScript(ownerCookie, pid, 'login-flow.yaml');
  expect(srv.version).toBe(6);
  await openDetail(b, 'login-flow.yaml');
  await b.getByTestId('detail-history').click();
  await expect(b.locator('[data-testid=version-row][data-version="6"]')).toHaveAttribute('data-actor', 'external');
  await expect(b.locator('[data-testid=version-row][data-version="6"]')).toContainText('앱 바깥 변경');
  await expect(b.locator('[data-testid=version-row][data-version="5"]').getByTestId('version-author')).toHaveText('member');
  await shot(b, 'c9-server-history.png');

  // ── 6) AI save conflict: the AI reads, B saves meanwhile, the AI's save is refused with "re-read".
  await openDetail(a, 'login-flow.yaml');
  await a.getByTestId('detail-ai').click();
  await a.getByTestId('ai-ask-input').fill('pauseBeforeSave: 6000 마지막에 시간 측정을 추가해줘');
  await a.getByTestId('ai-ask-send').click();
  await expect(a.getByTestId('ai-chat')).toBeVisible();
  await expect(a.locator('[data-testid=tool-card][data-name=read_file]')).toHaveCount(1, { timeout: 60_000 });
  const cur = await serverScript(memberCookie, pid, 'login-flow.yaml');
  const put = await cloud.req('PUT', `/api/projects/${pid}/scripts/login-flow.yaml`, { cookie: memberCookie, body: { source: cur.source.replace('timeout: 10s', 'timeout: 12s'), baseVersion: cur.version, origin: 'web' } });
  expect(put.status).toBe(200);
  await expect(a.locator('[data-testid=tool-card][data-name=save_script]')).toHaveAttribute('data-status', 'error', { timeout: 60_000 });
  await expect(a.locator('[data-testid=msg-assistant]').last()).toContainText('저장 충돌', { timeout: 60_000 });
  await expect(a.locator('[data-testid=msg-assistant]').last()).toContainText('read_file');
  await expect(a.locator('[data-testid=cloud-notice][data-kind=ai-conflict]')).toBeVisible();
  await shot(a, 'c10-ai-conflict.png');
  srv = await serverScript(ownerCookie, pid, 'login-flow.yaml');
  expect(srv.version).toBe(7);
  expect(srv.source).toContain('timeout: 12s');
  expect(srv.source).not.toContain('AI 가 추가한 시간 측정');
  await expect.poll(() => readFileSync(fileA, 'utf8'), { timeout: 20_000 }).toContain('timeout: 12s');

  // ── 7) No device token or test-credential value in plain text under either userData.
  const tokenA = await appA.evaluate(() => (globalThis as unknown as { __eutaTest: { cloud: { account: { token(): string | undefined } } } }).__eutaTest.cloud.account.token());
  const tokenB = await appB.evaluate(() => (globalThis as unknown as { __eutaTest: { cloud: { account: { token(): string | undefined } } } }).__eutaTest.cloud.account.token());
  expect(tokenA && tokenA.length > 16).toBeTruthy();
  expect(tokenB && tokenB !== tokenA).toBeTruthy();
  await close(appA);
  await close(appB);
  const needles = [tokenA!, tokenB!, USER_PASSWORD, USER_EMAIL, CLOUD_ONLY_VALUE, encodeURIComponent(USER_PASSWORD), Buffer.from(USER_PASSWORD).toString('base64'), Buffer.from(tokenA!).toString('base64')];
  const files = [...allFiles(userDataA), ...allFiles(userDataB)];
  const hits: string[] = [];
  for (const f of files) {
    const buf = readFileSync(f);
    for (const n of needles) if (buf.includes(Buffer.from(n))) hits.push(`${f.slice(tmpRoot.length)} (${n.slice(0, 4)}…)`);
  }
  console.log(`plaintext scan: ${files.length} files under both userData dirs, ${hits.length} hits`);
  expect(hits).toEqual([]);
  console.log(`screenshots: ${shotsDir}`);
});
