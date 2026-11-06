// E2E for stage 15 "한 프로젝트 + 권한" (SPEC 클라우드-앱-연동 "프로젝트 종류" · "올리기 — 전환" · "합치기")
// with two app instances (accounts A = owner, B = member) against the in-memory fake cloud
// (e2e/fake-cloud.ts — the API_CONTRACT shapes; no running euta cloud server needed):
// A: local project + a local run → 올리기 (confirmation) → one cloud project, the run still in History ·
// B: [클라우드에서 받기] (조직 공개, 보기) → 받기 → 보기 전용 · back in the list [열기] (no second copy) ·
// B: attach a local project to A's project → refused (ORIGIN_MISMATCH, Korean) · B: [권한 요청] 실행자 ·
// A: 구성원 → 승인 · B: 실행 전용 (run yes, edit no) → a local run · A: members-only + remove B →
// B: 접근 권한 없음 (only this PC's run) → 이 PC 에서 지우기 · A: merge a diverged project (choices) and
// an identical one (nothing to pick). Screenshots of each new screen go to test-results/screens.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeCloud } from './fake-cloud.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = join(appDir, '.e2e-tmp', `one-project-${Date.now()}`);
const shotsDir = process.env.EUTA_E2E_SHOTS ?? join(appDir, 'test-results/screens');
const A = 'owner@example.com';
const B = 'member@example.com';
// Nothing listens on port 9: runs end quickly (a failed run is still a run in History).
const SITE = 'http://127.0.0.1:9';
const SCRIPT = (name: string, path = '/') => `# ${name}\nversion: 1\nname: ${name}\ntarget:\n  baseUrl: \${env.BASE_URL}\ndefaults:\n  timeout: 3s\nsteps:\n  - goto: ${path}\n`;

const fake = new FakeCloud();
const apps: ElectronApplication[] = [];
const shot = (page: Page, name: string) => page.screenshot({ path: join(shotsDir, name) });

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const executablePath = process.env.EUTA_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [appDir] }),
    cwd: appDir,
    env: { ...(process.env as Record<string, string>), EUTA_E2E: '1', EUTA_USER_DATA_DIR: join(tmpRoot, name), SHELL: '/bin/sh', EUTA_E2E_FAKE_AGENT: '1' },
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on('dialog', (d) => void d.accept());
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);
  return { app, page };
}

async function login(page: Page, email: string): Promise<void> {
  await page.getByTestId('app-settings').click();
  await page.getByTestId('cloud-server-url').fill(fake.url);
  await page.getByTestId('cloud-server-save').click();
  await page.getByTestId('cloud-login').click();
  const code = (await page.getByTestId('cloud-user-code').textContent())!.trim();
  fake.approveDevice(code, email);
  await expect(page.getByTestId('cloud-state')).toHaveAttribute('data-state', 'online', { timeout: 30_000 });
}

async function newLocalProject(page: Page, name: string): Promise<string> {
  await page.getByTestId('project-new').click();
  await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('new-project-url').fill(SITE);
  await page.getByTestId('new-project-create').click();
  await expect(page.getByTestId('project-name')).toHaveText(name);
  return (await page.getByTestId('project').getAttribute('data-project-id'))!;
}

async function importScript(app: ElectronApplication, page: Page, file: string, text: string): Promise<void> {
  const f = join(tmpRoot, 'import', file);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as unknown as typeof dialog.showOpenDialog;
  }, [f]);
  await page.getByTestId('tab-scripts').click();
  await page.getByTestId('script-import').click();
  await expect(page.locator(`[data-testid=script-row][data-path="${file}"]`)).toBeVisible();
}

/** Run a script on this PC from its row and wait until it is over. */
async function runOnPc(page: Page, file: string): Promise<void> {
  await page.getByTestId('tab-scripts').click();
  await page.locator(`[data-testid=script-row][data-path="${file}"]`).getByTestId('script-run').click();
  await page.getByTestId('run').click();
  await expect(page.getByTestId('tab-live')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('run-status')).not.toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('history-row').first()).toContainText(/실패|오류|통과|시간 초과/, { timeout: 60_000 });
}

/** Old copy-upload marker on a local project (the "diverged" state before stage 15). */
async function markUploaded(app: ElectronApplication, localId: string, projectId: string, name: string): Promise<void> {
  await app.evaluate(
    (_e, a) => {
      const t = (globalThis as unknown as { __eutaTest: { projects: { store: { setUploaded(id: string, v: unknown): void } } } }).__eutaTest;
      t.projects.store.setUploaded(a.localId, { serverUrl: a.url, projectId: a.projectId, localId: a.projectId.replace(/-/g, ''), name: a.name, at: new Date().toISOString() });
    },
    { localId, projectId, name, url: fake.url },
  );
}

const sidebar = (page: Page) => page.getByTestId('project-item');
const item = (page: Page, name: string) => page.locator('[data-testid=project-item]', { hasText: name });

test.beforeAll(async () => {
  mkdirSync(shotsDir, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  fake.addUser(A, '소유자 김');
  fake.addUser(B, '구성원 이');
  await fake.start();
});

test.afterAll(async () => {
  for (const app of apps) await app.close().catch(() => undefined);
  await fake.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('one project + permissions: convert, receive, refuse attach, request → approve, runner, access lost, merge', async () => {
  const { app: appA, page: a } = await launch('A');
  await login(a, A);

  // ── A: a local project with a script and one local run → 올리기 = 전환.
  const localId = await newLocalProject(a, '고객 포털');
  await importScript(appA, a, 'login.yaml', SCRIPT('로그인', '/login'));
  await runOnPc(a, 'login.yaml');
  await expect(sidebar(a)).toHaveCount(1);
  await a.getByTestId('tab-project').click();
  await a.getByTestId('upload-cloud').click();
  await expect(a.getByTestId('convert-dialog')).toBeVisible();
  await expect(a.getByTestId('convert-moved')).toContainText('실행 기록 1건');
  await shot(a, 'p15-1-convert-dialog.png');
  await a.getByTestId('upload-confirm').click();
  await expect(a.getByTestId('project-name')).toHaveText('☁ 고객 포털');
  await expect(a.getByTestId('upload-result')).toContainText('실행 기록 1건');
  await expect(sidebar(a)).toHaveCount(1);
  await expect(item(a, '고객 포털')).toHaveAttribute('data-cloud', '1');
  const p = fake.byName('고객 포털');
  expect(p.origin).toBe('app');
  expect(p.originLocalId).toBe(localId);
  await a.getByTestId('tab-history').click();
  await expect(a.getByTestId('history-row')).toHaveCount(1);
  await shot(a, 'p15-2-converted.png');

  // ── B: [클라우드에서 받기] → 조직 공개 (보기) → 받기 → 보기 전용; the list then says [열기].
  const { app: appB, page: b } = await launch('B');
  await login(b, B);
  await b.getByTestId('cloud-find').click();
  const rowB = b.getByTestId('cloud-projects-org').locator('[data-testid=cloud-project-row][data-name="고객 포털"]');
  await expect(rowB).toHaveAttribute('data-role', 'viewer');
  await expect(rowB.getByTestId('cloud-project-open')).toHaveAttribute('data-action', 'receive');
  await expect(rowB.getByTestId('access-request')).toBeVisible();
  await expect(rowB).toContainText('소유자 김');
  await expect(rowB).toContainText('앱에서 올림');
  await shot(b, 'p15-3-receive-list.png');
  await rowB.getByTestId('cloud-project-open').click();
  await expect(b.getByTestId('project-name')).toHaveText('☁ 고객 포털');
  await expect(b.getByTestId('readonly-badge')).toBeVisible();
  await expect(b.locator('[data-testid=script-row][data-path="login.yaml"]')).toBeVisible({ timeout: 20_000 });
  await expect(b.getByTestId('script-run')).toHaveCount(0);
  await expect(b.getByTestId('script-new')).toHaveCount(0);
  await shot(b, 'p15-4-viewer.png');
  await b.getByTestId('cloud-find').click();
  await expect(rowB.getByTestId('cloud-project-open')).toHaveAttribute('data-action', 'open');
  await rowB.getByTestId('cloud-project-open').click();
  await expect(sidebar(b)).toHaveCount(1);

  // ── B: a local project marked as uploaded to A's project → the merge is refused (not attachable).
  const bLocal = await newLocalProject(b, '내 포털');
  await markUploaded(appB, bLocal, p.id, '고객 포털');
  await item(b, '고객 포털').click();
  await item(b, '내 포털').click();
  await expect(b.getByTestId('merge-refused')).toContainText('받아서 쓰세요');
  await expect(b.getByTestId('merge-open')).toHaveCount(0);
  await shot(b, 'p15-5-attach-refused.png');

  // ── B: [권한 요청] 실행자 + memo → "요청 중".
  await item(b, '고객 포털').click();
  await b.getByTestId('access-request').click();
  await b.getByTestId('access-role-runner').click();
  await b.getByTestId('access-memo').fill('배포 전 회귀를 돌려야 합니다');
  await shot(b, 'p15-6-access-dialog.png');
  await b.getByTestId('access-send').click();
  await expect(b.getByTestId('access-pending')).toContainText('실행자');

  // ── A: 프로젝트 설정 > 구성원 → 승인 (실행자).
  await a.getByTestId('tab-project').click();
  const req = a.locator(`[data-testid=access-request-item][data-email="${B}"]`);
  await expect(req).toBeVisible({ timeout: 20_000 });
  await expect(req).toContainText('배포 전 회귀를 돌려야 합니다');
  await req.scrollIntoViewIfNeeded();
  await shot(a, 'p15-7-owner-requests.png');
  await req.getByTestId('access-approve').click();
  await expect(a.locator(`[data-testid=member-item][data-email="${B}"]`)).toHaveAttribute('data-role', 'runner');

  // ── B: the feed reflects the role → 실행 전용: run yes, edit no; a local run on this PC.
  await expect(b.getByTestId('runonly-badge')).toBeVisible({ timeout: 20_000 });
  await expect(b.getByTestId('readonly-badge')).toHaveCount(0);
  await b.getByTestId('tab-scripts').click();
  await expect(b.getByTestId('script-run')).toBeVisible();
  await expect(b.getByTestId('script-new')).toHaveCount(0);
  await expect(b.getByTestId('script-delete')).toHaveCount(0);
  await shot(b, 'p15-8-runner.png');
  await runOnPc(b, 'login.yaml');

  // ── A: members only + remove B → B's copy is locked "접근 권한 없음": only this PC's run.
  fake.setVisibility(p, 'members');
  await expect(b.getByTestId('runonly-badge')).toBeVisible();
  fake.setMember(p, B, null);
  await expect(b.getByTestId('access-lost')).toBeVisible({ timeout: 20_000 });
  await expect(b.getByTestId('access-lost-badge')).toBeVisible();
  await expect(b.getByTestId('project-locked')).toBeVisible();
  await expect(b.getByTestId('tab-history')).toHaveAttribute('aria-selected', 'true');
  await expect(b.getByTestId('history-row')).toHaveCount(1);
  await expect(b.getByTestId('tab-scripts')).toHaveCount(0);
  await expect(b.getByTestId('tab-live')).toBeVisible();
  await shot(b, 'p15-9-access-lost.png');
  await b.getByTestId('history-row').first().getByRole('button', { name: '열기', exact: true }).click();
  await expect(b.getByTestId('tab-live')).toHaveAttribute('aria-selected', 'true');
  await b.getByTestId('tab-history').click();
  await b.getByTestId('access-lost-delete').click();
  await b.getByTestId('access-lost-delete-confirm').click();
  await expect(item(b, '고객 포털')).toHaveCount(0);
  await expect(sidebar(b)).toHaveCount(1);

  // ── A: merge a diverged project (one script differs → pick) …
  const oldLocal = await newLocalProject(a, '옛 포털');
  await importScript(appA, a, 'a.yaml', SCRIPT('A'));
  await importScript(appA, a, 'b.yaml', SCRIPT('B-로컬', '/b-local'));
  const old = fake.createProject({ name: '옛 포털', ownerEmail: A, origin: 'unknown', scripts: { 'a.yaml': SCRIPT('A'), 'b.yaml': SCRIPT('B-서버', '/b-server') }, envs: [{ name: 'default', baseUrl: SITE }] });
  await markUploaded(appA, oldLocal, old.id, '옛 포털');
  await item(a, '고객 포털').click();
  await item(a, '옛 포털').click();
  await a.getByTestId('merge-open').click();
  const md = a.getByTestId('merge-dialog');
  await expect(md.locator('[data-testid=merge-script][data-path="b.yaml"]')).toBeVisible();
  await expect(a.getByTestId('merge-confirm')).toBeDisabled();
  await md.locator('[data-testid=merge-script][data-path="b.yaml"]').getByTestId('merge-choice-both').click();
  await shot(a, 'p15-10-merge-choices.png');
  await a.getByTestId('merge-confirm').click();
  await expect(a.getByTestId('project-name')).toHaveText('☁ 옛 포털');
  await expect(item(a, '옛 포털')).toHaveCount(1);
  await expect(item(a, '옛 포털')).toHaveAttribute('data-cloud', '1');
  expect(old.scripts.get('b-로컬.yaml')?.source).toBe(SCRIPT('B-로컬', '/b-local'));
  await expect(a.locator('[data-testid=script-row][data-path="b-로컬.yaml"]')).toBeVisible({ timeout: 20_000 });

  // … and an identical one: nothing to pick.
  const twinLocal = await newLocalProject(a, '쌍둥이');
  await importScript(appA, a, 'a.yaml', SCRIPT('T'));
  const twin = fake.createProject({ name: '쌍둥이', ownerEmail: A, origin: 'unknown', scripts: { 'a.yaml': SCRIPT('T') } });
  await markUploaded(appA, twinLocal, twin.id, '쌍둥이');
  await item(a, '고객 포털').click();
  await item(a, '쌍둥이').click();
  await a.getByTestId('merge-open').click();
  await expect(a.getByTestId('merge-identical')).toBeVisible();
  await expect(a.getByTestId('merge-pick-count')).toHaveText('0');
  await shot(a, 'p15-11-merge-identical.png');
  await a.getByTestId('merge-confirm').click();
  await expect(a.getByTestId('project-name')).toHaveText('☁ 쌍둥이');
  await expect(item(a, '쌍둥이')).toHaveCount(1);
  await expect(sidebar(a)).toHaveCount(3);
});
