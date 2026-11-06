// E2E for the built app (Playwright _electron). Requires `pnpm build` first (`pnpm test:e2e`
// does it); EUTA_E2E_EXECUTABLE runs the same flow against the packaged app (ADR-014).
// SPEC 프로젝트-관리 완료 기준: create a project → two environments on the engine fixture site →
// secrets → import scripts → run per environment → History + activity log → test set (suite) from
// the Scripts tab with an always-run item → quit and
// relaunch with the same userData (everything restored) → AI chat (fake agent) in a project
// environment → MCP events / hooks / terminal → no plaintext secret under userData → delete.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = resolve(appDir, '../euta-engine');
const examples = join(engineDir, 'examples');
const tmpRoot = join(appDir, '.e2e-tmp', String(Date.now()));
const userData = join(tmpRoot, 'userData');
const shotsDir = process.env.EUTA_E2E_SHOTS ?? join(appDir, 'test-results/screens');
// Fixture site credentials (engine packages/core/test/fixture-site/server.ts FIXTURE_USER).
const USER_EMAIL = 'qa.user@example.com';
const USER_PASSWORD = 's3cret P@ss&word!';
const FAKE_KEY = 'sk-ant-e2e-NOT-A-REAL-KEY';

let fixture: ChildProcess | undefined;
let fixtureUrl = '';
let app: ElectronApplication | undefined;
let page: Page;
const fakeClaude = join(tmpRoot, 'fake-claude');

async function startFixture(): Promise<string> {
  const port = String(4300 + Math.floor(Math.random() * 500));
  fixture = spawn('pnpm', ['fixture'], { cwd: engineDir, env: { ...process.env, PORT: port }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture server did not start')), 30_000);
    fixture!.stdout!.on('data', (c: Buffer) => {
      const m = /listening on (http:\/\/\S+)/.exec(c.toString());
      if (m?.[1]) {
        clearTimeout(timer);
        resolveUrl(m[1]);
      }
    });
    fixture!.on('exit', (code) => reject(new Error(`fixture exited ${code}`)));
  });
}

function stopFixture(): void {
  if (fixture?.pid) {
    try {
      process.kill(-fixture.pid, 'SIGTERM'); // whole process group (pnpm -> tsx -> node)
    } catch {
      /* already gone */
    }
  }
}

async function launch(): Promise<void> {
  // EUTA_E2E_EXECUTABLE = packaged app binary (pnpm package) — same flow against the release build.
  const executablePath = process.env.EUTA_E2E_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [appDir] }),
    cwd: appDir,
    env: {
      ...(process.env as Record<string, string>),
      EUTA_E2E: '1',
      EUTA_USER_DATA_DIR: userData,
      // A wrong BASE_URL in the process env: passing runs prove the environment's baseUrl is used.
      BASE_URL: 'http://127.0.0.1:9/not-the-environment',
      SHELL: '/bin/sh',
      // AI chat: scripted test agent (runs euta tools for real, no model) + fake claude CLI.
      EUTA_E2E_FAKE_AGENT: '1',
      EUTA_CLAUDE_BIN: fakeClaude,
      ANTHROPIC_API_KEY: FAKE_KEY,
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
}

/** Make the next native open dialog return `files` (dialogs cannot be clicked by Playwright). */
async function stubOpenDialog(files: string[]): Promise<void> {
  await app!.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: f })) as unknown as typeof dialog.showOpenDialog;
  }, files);
}

/** Select the <option> whose text starts with `prefix`. */
async function selectStartingWith(testId: string, prefix: string): Promise<void> {
  const sel = page.getByTestId(testId);
  const value = await sel.locator('option').filter({ hasText: new RegExp(`^${prefix}`) }).first().getAttribute('value');
  await sel.selectOption(value!);
}

const shot = (name: string) => page.screenshot({ path: join(shotsDir, name) });

/** A report window opened by `click` (sandboxed BrowserWindow, ADR-032). */
async function openReportWindow(click: () => Promise<void>): Promise<Page> {
  const [w] = await Promise.all([app!.waitForEvent('window'), click()]);
  await w.waitForLoadState('domcontentloaded');
  return w;
}

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
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });
  fixtureUrl = await startFixture();
  // Fake `claude` for the auth chip (never the real CLI in tests).
  writeFileSync(fakeClaude, `#!/bin/sh\nif [ "$1 $2" = "auth status" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"e2e@example.com","subscriptionType":"max"}'; fi\n`);
  chmodSync(fakeClaude, 0o755);
  await launch();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  stopFixture();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('projects: environments, secrets, scripts, runs, test set, restart, AI chat, terminal, delete', async () => {
  // 0) Window + main process facts.
  const facts = await app!.evaluate(({ app: a }) => {
    const t = (globalThis as Record<string, any>).__eutaTest;
    return { name: a.getName(), versions: process.versions, sqlite: typeof process.getBuiltinModule('node:sqlite')?.DatabaseSync, serverUrl: t.serverUrl as string, cli: t.claudeExecutable as string | undefined };
  });
  console.log(`electron ${facts.versions.electron} / node ${facts.versions.node} / app name ${facts.name}`);
  expect(facts.sqlite).toBe('function');
  expect(facts.cli && existsSync(facts.cli)).toBeTruthy();
  if (process.env.EUTA_E2E_EXECUTABLE) expect(facts.cli).toContain('app.asar.unpacked');
  expect(await page.evaluate(() => typeof (globalThis as any).require === 'undefined' && typeof (globalThis as any).process === 'undefined')).toBe(true);

  // 1) First run: guidance to create a project.
  await expect(page.getByTestId('new-project')).toContainText('새 프로젝트 만들기');
  await page.getByTestId('new-project-name').fill('Fixture Portal');
  await page.getByTestId('new-project-url').fill(fixtureUrl);
  await page.getByTestId('new-project-create').click();
  await expect(page.getByTestId('project-name')).toHaveText('Fixture Portal');
  const projectId = (await page.getByTestId('project').getAttribute('data-project-id'))!;
  await expect(page.locator(`[data-testid=project-item][data-project-id="${projectId}"]`)).toBeVisible();

  // 2) Two environments pointing at the fixture site; 3) secrets (write-only).
  await page.getByTestId('tab-project').click();
  const first = page.getByTestId('env-card').first();
  await first.getByTestId('env-name').fill('dev');
  await first.getByTestId('env-save').click();
  await expect(page.locator('[data-testid=env-card][data-env-name=dev]')).toBeVisible();
  await page.getByTestId('env-add-name').fill('staging');
  await page.getByTestId('env-add-url').fill(fixtureUrl.replace('127.0.0.1', 'localhost'));
  await page.getByTestId('env-add').click();
  const stg = page.locator('[data-testid=env-card][data-env-name=staging]');
  await expect(stg).toBeVisible();
  for (const name of ['dev', 'staging']) {
    const card = page.locator(`[data-testid=env-card][data-env-name=${name}]`);
    for (const [k, v] of [
      ['USER_EMAIL', USER_EMAIL],
      ['USER_PASSWORD', USER_PASSWORD],
    ] as const) {
      await card.getByTestId('secret-name').fill(k);
      await card.getByTestId('secret-value').fill(v);
      await card.getByTestId('secret-save').click();
      await expect(card.locator(`[data-testid=secret-item][data-name=${k}]`)).toBeVisible();
      await expect(card.getByTestId('secret-value')).toHaveValue('');
    }
  }
  expect(await page.locator('body').innerText()).not.toContain(USER_PASSWORD);
  await shot('p1-project-settings.png');

  // 4) Import scripts into the library (native dialog stubbed in main).
  await page.getByTestId('tab-scripts').click();
  await stubOpenDialog([join(examples, 'login-download.yaml'), join(examples, 'failing.yaml')]);
  await page.getByTestId('script-import').click();
  await expect(page.locator('[data-testid=script-row][data-path="login-download.yaml"]')).toBeVisible();
  await expect(page.locator('[data-testid=script-row][data-path="failing.yaml"]')).toContainText('Deliberately failing');

  // 5) Run the same script in each environment.
  const runIds: Record<string, string> = {};
  for (const name of ['dev', 'staging']) {
    await page.locator('[data-testid=script-row][data-path="login-download.yaml"]').getByTestId('script-run').click();
    await expect(page.getByTestId('run-script')).toHaveValue('login-download.yaml');
    await selectStartingWith('run-env', `${name} — `);
    await expect(page.getByTestId('run-env-info')).toContainText('USER_EMAIL, USER_PASSWORD');
    await page.getByTestId('headless').setChecked(true);
    await page.getByTestId('run').click();
    const detail = page.getByTestId('run-detail');
    await expect(detail).toBeVisible();
    await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'passed', { timeout: 120_000 });
    runIds[name] = (await detail.getAttribute('data-run-id'))!;
    await page.getByTestId('tab-scripts').click();
  }
  expect(runIds.dev).not.toBe(runIds.staging);
  await page.getByTestId('tab-live').click();
  await expect(page.getByTestId('screenshot')).toBeVisible();
  await shot('p2-live.png');

  // 6) History (per environment) and the activity log.
  await page.getByTestId('tab-history').click();
  await page.getByTestId('history-refresh').click();
  await expect(page.locator(`[data-testid=history-row][data-run-id="${runIds.dev!}"]`)).toHaveAttribute('data-env', 'dev');
  await expect(page.locator(`[data-testid=history-row][data-run-id="${runIds.staging!}"]`)).toHaveAttribute('data-env', 'staging');
  await expect(page.locator(`[data-testid=history-row][data-run-id="${runIds.staging!}"] [data-status=passed]`)).toHaveText('통과');
  await page.getByTestId('tab-activity').click();
  await expect(page.locator('[data-testid=activity-item][data-kind="run.finished"]')).toHaveCount(2);
  for (const k of ['project.created', 'env.created', 'secret.set', 'script.imported', 'run.started']) await expect(page.locator(`[data-testid=activity-item][data-kind="${k}"]`).first()).toBeVisible();
  await expect(page.locator('[data-testid=activity-item][data-kind="run.finished"]').first()).toContainText('@ staging → passed');
  expect(await page.getByTestId('activity-list').innerText()).not.toContain(USER_PASSWORD);
  await shot('p3-activity.png');
  // Clicking a run entry opens it in Live.
  await page.locator('[data-testid=activity-item][data-kind="run.finished"]').first().click();
  await expect(page.getByTestId('run-detail')).toHaveAttribute('data-run-id', runIds.staging!);

  // 7) Test set (internal name suite) from the Scripts tab: check two scripts → "테스트 세트에 넣기" (new
  //    set) → edit: one more item, reorder, "항상 실행" on the last, staging, 실패 시 중단 → run →
  //    the first item fails, the next is skipped, the always-run item still runs → History groups it.
  await page.getByTestId('tab-scripts').click();
  await expect(page.getByTestId('scripts-view')).toBeVisible();
  for (const p of ['failing.yaml', 'login-download.yaml']) await page.locator(`[data-testid=script-row][data-path="${p}"]`).getByTestId('script-pick').check();
  await page.getByTestId('put-into-set-target').selectOption('__new__');
  await page.getByTestId('put-into-set-name').fill('smoke');
  await page.getByTestId('put-into-set-ok').click();
  await expect(page.getByTestId('scripts-note')).toContainText('테스트 세트 “smoke” 에 2개를 넣었습니다');
  await page.getByTestId('scripts-view-sets').click();
  // "+ 새 테스트 세트" → name → straight into editing; then delete it again.
  await page.getByTestId('testset-new').click();
  await page.getByTestId('testset-new-name').fill('scratch');
  await page.getByTestId('testset-new-create').click();
  const scratch = page.locator('[data-testid=testset-card][data-name=scratch]');
  await expect(scratch.getByTestId('testset-editor')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await scratch.getByTestId('testset-delete').click();
  await expect(scratch).toHaveCount(0);
  const setCard = page.locator('[data-testid=testset-card][data-name=smoke]');
  await expect(setCard.getByTestId('testset-item')).toHaveCount(2);
  await setCard.getByTestId('testset-edit').click();
  // Scripts are shown and picked by name (path small), with search + multi-check.
  await expect(setCard.getByTestId('testset-editor')).toContainText('Deliberately failing');
  const pick = (path: string) => setCard.locator(`[data-testid=testset-picker-item][data-path="${path}"]`);
  await setCard.getByTestId('testset-picker-search').fill('deliberately');
  await expect(setCard.getByTestId('testset-picker-item')).toHaveCount(1);
  await expect(pick('failing.yaml')).toContainText('들어 있음');
  await setCard.getByTestId('testset-picker-search').fill('');
  // Checked items rise to the top in check order, numbered.
  await pick('login-download.yaml').locator('input').check();
  await pick('failing.yaml').locator('input').check();
  await expect(setCard.getByTestId('testset-picker-item').nth(0)).toHaveAttribute('data-path', 'login-download.yaml');
  await expect(setCard.getByTestId('testset-picker-item').nth(0)).toHaveAttribute('data-order', '1');
  await expect(setCard.getByTestId('testset-picker-item').nth(1)).toHaveAttribute('data-path', 'failing.yaml');
  await expect(setCard.getByTestId('testset-picker-item').nth(1)).toHaveAttribute('data-order', '2');
  await expect(setCard.getByTestId('testset-add')).toHaveText('선택한 2개 추가');
  await shot('p4-testset-picker.png');
  await pick('login-download.yaml').locator('input').uncheck();
  await expect(pick('failing.yaml')).toHaveAttribute('data-order', '1');
  await expect(setCard.getByTestId('testset-add')).toHaveText('선택한 1개 추가');
  await setCard.getByTestId('testset-add').click();
  await expect(setCard.getByTestId('testset-picker-search')).toHaveValue('');
  const items = setCard.getByTestId('testset-edit-item');
  await expect(items).toHaveCount(3);
  await items.nth(2).getByTestId('testset-up').click(); // failing, failing, login-download
  await expect(items.nth(2)).toHaveAttribute('data-path', 'login-download.yaml');
  await items.nth(2).getByTestId('testset-always').click();
  await expect(items.nth(2).getByTestId('testset-always')).toBeChecked();
  await setCard.getByTestId('testset-env').selectOption({ label: 'staging' });
  await setCard.getByTestId('testset-stop').click();
  await expect(setCard.getByTestId('testset-stop')).toBeChecked();
  await setCard.getByTestId('testset-edit').click();
  await expect(setCard.getByTestId('testset-item')).toHaveCount(3);
  await expect(setCard.getByTestId('testset-item').nth(2)).toHaveAttribute('data-always', '1');
  await expect(setCard.getByTestId('testset-item').nth(0)).toHaveAttribute('data-always', '0');
  await expect(setCard).toContainText('실패 시 중단');
  await setCard.getByTestId('testset-run').click();
  // Live groups the set (ADR-032): set header (name · env · done/total · elapsed · 취소) + items; the running item is unfolded.
  await page.getByTestId('tab-live').click();
  const setView = page.getByTestId('set-detail');
  await expect(setView).toBeVisible();
  await expect(setView.getByTestId('set-head')).toContainText('테스트 세트: smoke');
  await expect(setView.getByTestId('set-head')).toContainText('staging');
  await expect(setView.getByTestId('set-item')).toHaveCount(3);
  await expect(setView.getByTestId('set-item').nth(0)).toContainText('Deliberately failing');
  await expect(setView.getByTestId('set-item').nth(2)).toContainText('항상 실행');
  const runningItem = setView.locator('[data-testid=set-item][data-status=running]');
  await expect(runningItem).toHaveAttribute('data-open', '1', { timeout: 60_000 });
  await expect(runningItem.getByTestId('run-detail')).toBeVisible();
  await expect(setView.getByTestId('set-cancel')).toBeVisible();
  await expect(setView.getByTestId('set-progress')).toContainText(/\d\/3/);
  await shot('p6-live-set-running.png');
  await expect(setView).toHaveAttribute('data-status', 'failed', { timeout: 180_000 });
  // Finished: items folded (click to unfold), 취소 gone, [리포트] shown.
  await expect(setView.locator('[data-testid=set-item][data-open="1"]')).toHaveCount(0);
  await expect(setView.getByTestId('set-cancel')).toHaveCount(0);
  await setView.getByTestId('set-item').nth(0).getByTestId('set-item-toggle').click();
  await expect(setView.getByTestId('set-item').nth(0)).toHaveAttribute('data-open', '1');
  await expect(setView.getByTestId('set-item').nth(0).getByTestId('run-detail')).toBeVisible();
  await expect(setView.getByTestId('set-item').nth(1)).toHaveAttribute('data-status', 'skipped');
  await expect(page.locator('[data-testid=live-set-item]')).toHaveCount(1);
  await shot('p6-live-set-done.png');
  // The set report: summary, per-script table, failure detail (step sentence + error + screenshot), no previous run yet.
  const report1 = await openReportWindow(() => setView.getByTestId('set-report').click());
  await expect(report1.getByTestId('suite-report')).toHaveAttribute('data-status', 'failed');
  await expect(report1.getByTestId('sr-passed')).toHaveText('1/3');
  await expect(report1.getByTestId('sr-item')).toHaveCount(3);
  await expect(report1.getByTestId('sr-item').nth(0)).toContainText('Deliberately failing');
  await expect(report1.getByTestId('sr-item').nth(2)).toContainText('항상 실행');
  await expect(report1.getByTestId('sr-compare-none')).toBeVisible();
  const fail1 = report1.getByTestId('sr-failure');
  await expect(fail1).toHaveCount(1);
  await expect(fail1.getByTestId('sr-step-sentence')).toContainText('존재하지 않는 제목');
  await expect(fail1.getByTestId('sr-error')).not.toBeEmpty();
  await expect(fail1.getByTestId('sr-shot')).toBeVisible();
  expect(await fail1.getByTestId('sr-shot').evaluate((i) => (i as unknown as { naturalWidth: number; src: string }).naturalWidth > 100 && (i as unknown as { src: string }).src.startsWith('data:image/'))).toBe(true);
  expect(await report1.locator('body').innerText()).not.toContain(USER_PASSWORD);
  await report1.screenshot({ path: join(shotsDir, 'p6-suite-report-1.png'), fullPage: true });
  // A script's own report link opens that run's report in its own window (navigation stays blocked).
  const runReport = await openReportWindow(() => report1.getByTestId('sr-item-report').first().click({ noWaitAfter: true }));
  await expect(runReport.locator('body')).toContainText('스텝 타임라인');
  await expect(runReport.locator('h1')).toContainText('Deliberately failing');
  await runReport.close();
  await report1.close();
  await page.getByTestId('tab-scripts').click();
  await expect(setCard.getByTestId('testset-progress')).toHaveAttribute('data-status', 'failed', { timeout: 180_000 });
  const prog = setCard.getByTestId('testset-progress-item');
  await expect(prog).toHaveCount(3);
  await expect(prog.nth(0)).toHaveAttribute('data-status', 'failed');
  await expect(prog.nth(1)).toHaveAttribute('data-status', 'skipped');
  await expect(prog.nth(2)).toHaveAttribute('data-status', 'passed');
  await expect(setCard.getByTestId('testset-latest')).toHaveAttribute('data-status', 'failed');
  await expect(setCard.getByTestId('testset-latest')).toContainText('1/3 통과');
  await expect(setCard.getByTestId('testset-first-fail')).toHaveAttribute('data-path', 'failing.yaml');
  await expect(setCard.getByTestId('testset-first-fail')).toContainText('Deliberately failing');
  await shot('p4-testset.png');
  // The Run tab and project settings no longer have a suite area.
  await page.getByTestId('tab-run').click();
  await expect(page.getByTestId('suite-runner')).toHaveCount(0);
  await page.getByTestId('tab-project').click();
  await expect(page.getByTestId('suite-card')).toHaveCount(0);
  await page.getByTestId('tab-history').click();
  await page.getByTestId('history-refresh').click();
  const suiteRow = page.getByTestId('history-suite').first();
  await expect(suiteRow).toHaveAttribute('data-status', 'failed');
  await expect(suiteRow).toContainText('테스트 세트: smoke');
  await expect(suiteRow).toContainText('항상 실행 1');
  await suiteRow.click();
  await expect(page.locator('[data-testid=history-row].nested')).toHaveCount(2);
  expect(await page.locator('body').innerText()).not.toContain('스위트');
  await shot('p4-history-suite.png');
  // The History set row opens the same report.
  const reportH = await openReportWindow(() => suiteRow.getByTestId('history-suite-report').click());
  await expect(reportH.getByTestId('suite-report')).toContainText('테스트 세트: smoke');
  await reportH.close();

  // 7b) Second run with one item's outcome changed (실패 시 중단 off → item 2 runs and fails): the report
  //     compares with the previous run of the same set in the same environment.
  await page.getByTestId('tab-scripts').click();
  await setCard.getByTestId('testset-edit').click();
  await setCard.getByTestId('testset-stop').click();
  await expect(setCard.getByTestId('testset-stop')).not.toBeChecked();
  await setCard.getByTestId('testset-edit').click();
  await setCard.getByTestId('testset-run').click();
  await expect(setCard.getByTestId('testset-progress-item').nth(1)).toHaveAttribute('data-status', 'failed', { timeout: 180_000 });
  await expect(setCard.getByTestId('testset-progress')).toHaveAttribute('data-status', 'failed', { timeout: 180_000 });
  await expect(setCard.getByTestId('testset-report')).toBeVisible();
  await shot('p6-testset-card-report.png');
  const report2 = await openReportWindow(() => setCard.getByTestId('testset-report').click());
  await expect(report2.getByTestId('sr-newly-failing')).toHaveAttribute('data-count', '1');
  await expect(report2.getByTestId('sr-newly-failing')).toContainText('2. Deliberately failing');
  await expect(report2.getByTestId('sr-still-failing')).toHaveAttribute('data-count', '1');
  await expect(report2.getByTestId('sr-still-passing')).toHaveAttribute('data-count', '1');
  await expect(report2.getByTestId('sr-failure')).toHaveCount(2);
  await report2.screenshot({ path: join(shotsDir, 'p6-suite-report-2.png'), fullPage: true });
  await report2.close();

  // 앱 설정 "화면 테마" (SPEC UI-디자인-시스템): saved in app.json, applied by main as nativeTheme.themeSource.
  await page.getByTestId('app-settings').click();
  await page.getByTestId('app-theme-dark').click();
  await expect.poll(() => app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');

  // 8) Quit and relaunch with the same userData: everything is still there.
  await app!.close();
  await launch();
  await expect(page.getByTestId('project-name')).toHaveText('Fixture Portal'); // last project reopens
  expect(await app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark'); // theme kept across restart
  await page.getByTestId('tab-project').click();
  for (const name of ['dev', 'staging']) {
    const card = page.locator(`[data-testid=env-card][data-env-name=${name}]`);
    await expect(card.locator('[data-testid=secret-item]')).toHaveCount(2);
  }
  await page.getByTestId('tab-scripts').click();
  await page.getByTestId('scripts-view-sets').click();
  await expect(page.locator('[data-testid=testset-card][data-name=smoke] [data-testid=testset-item]')).toHaveCount(3);
  await expect(page.locator('[data-testid=testset-card][data-name=smoke] [data-testid=testset-item]').nth(2)).toHaveAttribute('data-always', '1');
  await expect(page.locator('[data-testid=testset-card][data-name=smoke] [data-testid=testset-latest]')).toHaveAttribute('data-status', 'failed');
  await page.getByTestId('scripts-view-scripts').click();
  await expect(page.getByTestId('script-row')).toHaveCount(2);
  await expect(page.locator('[data-testid=script-row][data-path="login-download.yaml"] [data-status=passed]')).toHaveText('통과');
  await page.getByTestId('tab-history').click();
  await page.getByTestId('history-refresh').click();
  await expect(page.locator(`[data-testid=history-row][data-run-id="${runIds.dev!}"]`)).toBeVisible();
  await expect(page.getByTestId('history-suite')).toHaveCount(2);
  await page.getByTestId('tab-activity').click();
  await expect(page.locator('[data-testid=activity-item][data-kind="suite.finished"]')).toHaveCount(2);
  await shot('p5-after-restart.png');

  // 9) AI chat (test agent) runs in the selected project environment.
  await page.getByTestId('tab-ai').click();
  await expect(page.getByTestId('ai-chat')).toBeVisible();
  await expect(page.getByTestId('auth-chip')).toHaveAttribute('data-status', 'signed-in');
  await expect(page.getByTestId('auth-env-warning')).toContainText('ANTHROPIC_API_KEY');
  expect(await page.getByTestId('ai-chat').innerText()).not.toContain(FAKE_KEY);
  await expect(page.getByTestId('ai-workdir')).toContainText(join('projects', projectId, 'scripts'));
  await selectStartingWith('ai-env', 'staging');
  await page.getByTestId('chat-input').fill('login-download.yaml 실행해줘');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('msg-user')).toContainText('login-download.yaml 실행해줘');
  const card = page.getByTestId('tool-card');
  await expect(card).toHaveAttribute('data-name', 'run_script');
  await expect(card).toHaveAttribute('data-status', 'done', { timeout: 120_000 });
  await expect(card.locator('[data-status=passed]')).toHaveText('통과');
  await expect(page.locator('[data-testid=msg-assistant]').last()).toContainText('실행 결과: passed');
  await shot('p6-ai-chat.png');
  await card.getByTestId('tool-open-live').click();
  const aiRunId = (await page.getByTestId('run-detail').getAttribute('data-run-id'))!;
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'passed');
  await expect(page.locator(`[data-testid=live-run-item][data-run-id="${aiRunId}"]`)).toContainText('AI');
  await page.getByTestId('tab-history').click();
  await page.getByTestId('history-refresh').click();
  const aiRow = page.locator(`[data-testid=history-row][data-run-id="${aiRunId}"]`);
  await expect(aiRow).toHaveAttribute('data-env', 'staging');
  await expect(aiRow).toContainText('AI');
  await page.getByTestId('tab-activity').click();
  await expect(page.locator('[data-testid=activity-item][data-kind="chat.turn"]')).toContainText('login-download.yaml 실행해줘 · 도구: run_script');
  await expect(page.locator('[data-testid=activity-item][data-kind="chat.started"]')).toHaveCount(1);
  await page.getByTestId('activity-actor').selectOption('ai');
  await expect(page.locator('[data-testid=activity-item][data-actor=ai][data-kind="run.finished"]')).toContainText('@ staging → passed');

  // 10) External MCP events for a run under this project's runs folder show up in its Live.
  const { serverUrl, token } = await app!.evaluate(() => {
    const t = (globalThis as Record<string, any>).__eutaTest;
    return { serverUrl: t.serverUrl as string, token: t.token as string };
  });
  const mcpRunId = '20260929-120000_mcp-synthetic_c0ffee';
  const mcpRunDir = join(userData, 'projects', projectId, 'runs', mcpRunId);
  let seq = 0;
  const ev = (type: string, p: Record<string, unknown>) => ({ type, runId: mcpRunId, seq: ++seq, ts: new Date().toISOString(), ...p });
  const events = [
    ev('run.started', { kind: 'session', script: { name: 'MCP synthetic session' }, env: { browser: 'chromium', headless: false }, runDir: mcpRunDir }),
    ev('step.started', { stepId: '1', index: 0, action: 'goto', step: { goto: '/' } }),
    ev('step.finished', { stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 321 }),
    ev('run.finished', { status: 'passed', summary: { total: 1, passed: 1, failed: 0, error: 0, skipped: 0 }, durationMs: 900 }),
  ];
  const post = (path: string, body: unknown, auth = token) =>
    fetch(`${serverUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
  expect((await post('/events', { source: 'euta-mcp', protocol: 1, events }, 'wrong')).status).toBe(401);
  expect((await post('/events', { source: 'euta-mcp', protocol: 1, pid: 4242, sentAt: new Date().toISOString(), events })).status).toBe(204);
  await page.getByTestId('tab-live').click();
  const mcpItem = page.locator(`[data-testid=live-run-item][data-run-id="${mcpRunId}"]`);
  await expect(mcpItem).toContainText('MCP');
  await mcpItem.click();
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'passed');
  await page.getByTestId('tab-activity').click();
  await page.getByTestId('activity-actor').selectOption('mcp');
  await expect(page.locator('[data-testid=activity-item][data-actor=mcp][data-kind="run.finished"]')).toContainText('MCP synthetic session');

  // 11) Advanced terminal: hooks panel + shell with EUTA_RUNS_DIR = this project's runs folder.
  await page.getByTestId('tab-ai').click();
  await page.getByTestId('ai-advanced-toggle').click();
  await expect(page.getByTestId('ai-advanced')).toBeVisible();
  const sid = 'e2e-session-1';
  for (const h of [
    { session_id: sid, hook_event_name: 'SessionStart', source: 'startup', cwd: '/tmp/project' },
    { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'Run the login test' },
    { session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_euta_euta__run_script', tool_use_id: 'tu1', tool_input: { path: 'x.yaml' } },
    { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_euta_euta__run_script', tool_use_id: 'tu1', tool_response: { status: 'passed' } },
  ]) {
    const r = await post('/hooks/claude', h);
    expect(r.status).toBe(204);
  }
  await expect(page.getByTestId('hook-session')).toHaveAttribute('data-session-id', sid);
  await expect(page.locator('[data-testid=hook-entry][data-euta="1"] [data-status=done]')).toHaveText('완료');
  await page.getByTestId('term-shell').click();
  await expect(page.getByTestId('term-running')).toContainText('shell');
  await page.getByTestId('terminal').click();
  await page.keyboard.type('echo eu""ta-pty-ok; printenv EUTA_RUNS_DIR | sed "s#.*/projects/#RUNS:projects/#"\n');
  const rows = page.locator('[data-testid=terminal] .xterm-rows');
  await expect(rows).toContainText('euta-pty-ok');
  await expect(rows).toContainText(`RUNS:projects/${projectId}/runs`);
  await shot('p7-terminal.png');

  // 12) No secret value in plain text anywhere under userData (vault.json included).
  const files = allFiles(userData);
  expect(files.some((f) => f.endsWith('vault.json'))).toBe(true);
  expect(files.filter((f) => f.endsWith('.json') && f.includes(join('projects', projectId, 'chats'))).length).toBe(1);
  const needles = [USER_PASSWORD, USER_EMAIL, encodeURIComponent(USER_PASSWORD), Buffer.from(USER_PASSWORD).toString('base64')];
  const hits: string[] = [];
  for (const f of files) {
    const buf = readFileSync(f);
    for (const n of needles) if (buf.includes(Buffer.from(n))) hits.push(`${f.slice(userData.length)} (${n.slice(0, 4)}…)`);
  }
  console.log(`plaintext secret scan: ${files.length} files under userData, ${hits.length} hits`);
  expect(hits).toEqual([]);

  // 13) Delete the project (confirmation by typing its name).
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-delete').click();
  await expect(page.getByTestId('project-delete-confirm')).toBeDisabled();
  await page.getByTestId('project-delete-input').fill('Fixture Portal');
  await page.getByTestId('project-delete-confirm').click();
  await expect(page.getByTestId('new-project')).toBeVisible();
  await expect(page.getByTestId('project-item')).toHaveCount(0);
  expect(existsSync(join(userData, 'projects', projectId))).toBe(false);
  expect(JSON.parse(readFileSync(join(userData, 'vault.json'), 'utf8')).entries).toEqual({});
  await shot('p8-deleted.png');
  console.log(`screenshots: ${shotsDir}`);
});
