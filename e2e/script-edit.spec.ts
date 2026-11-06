// E2E for in-app script view & edit (SPEC 스크립트-보기-편집 완료 기준, app side):
// detail (Korean step sentences, latest-run overlay, step screenshot) → edit (value change, add
// step, reorder, delete) → an invalid edit blocks 저장 → save (comments kept) → run passes →
// history diff → restore → "AI에게 수정 요청" (scripted test agent: read_file → save_script) →
// banner + history actor ai → outside change while editing (conflict notice) → restart keeps
// history. EUTA_E2E_EXECUTABLE runs the same flow against the packaged app (ADR-014).
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = resolve(appDir, '../euta-engine');
const tmpRoot = join(appDir, '.e2e-tmp', `edit-${Date.now()}`);
const userData = join(tmpRoot, 'userData');
const shotsDir = process.env.EUTA_E2E_SHOTS ?? join(appDir, 'test-results/screens');
// Fixture site credentials (engine packages/core/test/fixture-site/server.ts FIXTURE_USER).
const USER_EMAIL = 'qa.user@example.com';
const USER_PASSWORD = 's3cret P@ss&word!';

const SCRIPT = `# 로그인 흐름 (E2E) — 이 주석은 저장 후에도 남아야 한다
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
  # 로그인 버튼
  - click: { target: { role: button, name: 로그인 } }
    name: 로그인
  - expect: { url: /dashboard }
  - expect: { text: { target: { testId: total }, equals: "1,200" } }
`;

let fixture: ChildProcess | undefined;
let fixtureUrl = '';
let app: ElectronApplication | undefined;
let page: Page;
const fakeClaude = join(tmpRoot, 'fake-claude');

async function startFixture(): Promise<string> {
  const port = String(5300 + Math.floor(Math.random() * 500));
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

async function launch(): Promise<void> {
  const executablePath = process.env.EUTA_E2E_EXECUTABLE;
  app = await electron.launch({
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
  page = await app.firstWindow();
  page.on('dialog', (d) => void d.accept());
  await page.waitForLoadState('domcontentloaded');
}

async function stubOpenDialog(files: string[]): Promise<void> {
  await app!.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: f })) as unknown as typeof dialog.showOpenDialog;
  }, files);
}

const shot = (name: string) => page.screenshot({ path: join(shotsDir, name) });
const step = (id: string) => page.locator(`[data-testid=detail-step][data-step-id="${id}"]`);

test.beforeAll(async () => {
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });
  fixtureUrl = await startFixture();
  writeFileSync(fakeClaude, `#!/bin/sh\nif [ "$1 $2" = "auth status" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"e2e@example.com","subscriptionType":"max"}'; fi\n`);
  chmodSync(fakeClaude, 0o755);
  writeFileSync(join(tmpRoot, 'login-flow.yaml'), SCRIPT);
  await launch();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (fixture?.pid) {
    try {
      process.kill(-fixture.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('script view & edit: sentences, overlay, form edit, save, history, restore, AI request, outside change, restart', async () => {
  // Project + environment on the fixture site + secrets; import the script.
  await page.getByTestId('new-project-name').fill('Edit Portal');
  await page.getByTestId('new-project-url').fill(fixtureUrl);
  await page.getByTestId('new-project-create').click();
  await expect(page.getByTestId('project-name')).toHaveText('Edit Portal');
  const projectId = (await page.getByTestId('project').getAttribute('data-project-id'))!;
  const file = join(userData, 'projects', projectId, 'scripts', 'login-flow.yaml');
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
  await stubOpenDialog([join(tmpRoot, 'login-flow.yaml')]);
  await page.getByTestId('script-import').click();
  const row = page.locator('[data-testid=script-row][data-path="login-flow.yaml"]');
  await expect(row).toBeVisible();

  // 1) Detail: readable Korean step sentences, no run yet.
  await row.getByTestId('script-detail-open').click();
  const detail = page.getByTestId('script-detail');
  await expect(detail).toHaveAttribute('data-path', 'login-flow.yaml');
  await expect(page.getByTestId('detail-name')).toHaveText('로그인 흐름');
  await expect(page.getByTestId('detail-step')).toHaveCount(6);
  await expect(step('1').getByTestId('step-sentence')).toHaveText('/login 으로 이동');
  await expect(step('2').getByTestId('step-sentence')).toHaveText("'이메일' 입력란에 🔒USER_EMAIL 입력");
  await expect(step('4').getByTestId('step-title')).toHaveText('로그인');
  await expect(step('4').getByTestId('step-sentence')).toHaveText("'로그인' 버튼 클릭");
  await expect(step('6').getByTestId('step-sentence')).toHaveText("확인: [total] 글자가 '1,200' 와 같음");
  await expect(page.getByTestId('detail-last-run')).toContainText('아직 실행 기록이 없습니다');

  // 2) Run from the detail → per-step overlay (status, time) + the step screenshot.
  await page.getByTestId('detail-run').click();
  await expect(page.getByTestId('detail-last-run').locator('[data-status=passed]')).toHaveText('통과', { timeout: 120_000 });
  for (const id of ['1', '2', '3', '4', '5', '6']) await expect(step(id)).toHaveAttribute('data-status', 'passed');
  await expect(page.getByTestId('overlay-stale')).toHaveCount(0);
  await step('1').getByTestId('step-shot').click();
  await expect(page.getByTestId('shot-modal').locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await shot('e1-detail-overlay.png');
  await page.getByTestId('shot-modal').click();
  await expect(page.getByTestId('shot-modal')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(USER_PASSWORD);

  // 3) Edit: change a value (step name), add a wait step, move it up, delete the url check.
  await page.getByTestId('detail-edit').click();
  await expect(detail).toHaveAttribute('data-mode', 'edit');
  await expect(page.getByTestId('edit-save')).toBeDisabled();
  await step('4').locator('.step-main').click();
  await page.getByTestId('step-form').getByTestId('f-name').fill('로그인 버튼 누르기');
  await expect(step('4').getByTestId('step-title')).toHaveText('로그인 버튼 누르기');
  await page.getByTestId('step-add-end').selectOption('wait');
  await expect(page.getByTestId('detail-step')).toHaveCount(7);
  await expect(page.getByTestId('step-form')).toHaveAttribute('data-action', 'wait');
  await page.getByTestId('f-wait-ms').fill('300');
  await expect(step('7').getByTestId('step-sentence')).toHaveText('300ms 기다리기');
  await step('7').getByTestId('step-up').click();
  await expect(step('6').getByTestId('step-sentence')).toHaveText('300ms 기다리기');
  await step('5').getByTestId('step-del').click();
  await expect(page.getByTestId('detail-step')).toHaveCount(6);
  await expect(step('5').getByTestId('step-sentence')).toHaveText('300ms 기다리기');

  // 4) An invalid value blocks 저장 (live validation, shown on the card and at the top).
  await expect(page.getByTestId('f-wait-ms')).toBeVisible(); // the new step's form is still open
  await page.getByTestId('f-wait-ms').fill('잠깐');
  await expect(page.getByTestId('warn-issues')).toContainText('5번 단계');
  await expect(page.getByTestId('warn-issues')).toContainText('시간 형식이 아닙니다');
  await expect(step('5').getByTestId('step-issue')).toBeVisible();
  await expect(page.getByTestId('edit-save')).toBeDisabled();
  await shot('e2-edit-invalid.png');
  await page.getByTestId('f-wait-ms').fill('300');
  await expect(page.getByTestId('edit-status')).toContainText('저장할 수 있습니다');
  await expect(page.getByTestId('edit-save')).toBeEnabled();

  // Header: record options are 켬 / 실패 시만 / 끔 selects (video · trace · dom).
  await page.getByTestId('edit-header-toggle').click();
  await page.getByTestId('h-record-dom').selectOption('on-failure');
  await page.getByTestId('h-record-video').selectOption('off');

  // 5) Save: only the changed steps are rewritten; comments and order stay.
  await page.getByTestId('edit-save').click();
  await expect(detail).toHaveAttribute('data-mode', 'view');
  await expect(page.getByTestId('detail-note')).toContainText('버전 2');
  const saved = readFileSync(file, 'utf8');
  expect(saved).toContain('# 로그인 흐름 (E2E) — 이 주석은 저장 후에도 남아야 한다');
  expect(saved).toContain('  # 로그인 버튼\n  - click: { target: { role: button, name: 로그인 } }\n    name: 로그인 버튼 누르기\n');
  expect(saved).toContain('  - fill: { target: { label: 이메일 }, value: "${secrets.USER_EMAIL}" }\n');
  expect(saved).toContain('  - wait: { ms: 300 }\n');
  expect(saved).not.toContain('url: /dashboard');
  expect(saved).toMatch(/record:[\s\S]*dom: on-failure/);
  expect(saved).toMatch(/record:[\s\S]*video: false/);
  // The old run no longer matches the content.
  await expect(page.getByTestId('overlay-stale')).toBeVisible();

  // 6) Run the edited script → passes.
  await page.getByTestId('detail-run').click();
  await expect(page.getByTestId('overlay-stale')).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByTestId('detail-last-run').locator('[data-status=passed]')).toHaveText('통과');
  for (const id of ['1', '2', '3', '4', '5', '6']) await expect(step(id)).toHaveAttribute('data-status', 'passed');

  // 7) History: v1 import, v2 my save — step-sentence comparison.
  await page.getByTestId('detail-history').click();
  await expect(page.getByTestId('version-row')).toHaveCount(2);
  await expect(page.locator('[data-testid=version-row][data-version="2"]')).toHaveAttribute('data-actor', 'user');
  const cmp = page.getByTestId('compare-view');
  await expect(cmp).toHaveAttribute('data-version', '2');
  await expect(cmp).toContainText('단계 1개 추가, 1개 변경, 1개 삭제');
  await expect(cmp.locator('[data-testid=diff-row][data-kind=added]')).toContainText('300ms 기다리기');
  await expect(cmp.locator('[data-testid=diff-row][data-kind=removed]')).toContainText('확인: 주소에 /dashboard 포함');
  await expect(cmp.locator('[data-testid=diff-row][data-kind=changed]')).toContainText('로그인 버튼 누르기');
  await shot('e3-history-diff.png');

  // 8) Restore v1 (the current content stays in history as v2).
  await page.locator('[data-testid=version-row][data-version="1"]').click();
  await expect(cmp).toHaveAttribute('data-version', '1');
  await page.getByTestId('version-restore').click();
  await expect(page.getByTestId('version-row')).toHaveCount(3);
  await expect(page.locator('[data-testid=version-row][data-version="3"]')).toHaveAttribute('data-actor', 'restore');
  expect(readFileSync(file, 'utf8')).toBe(SCRIPT);

  // 9) "AI에게 수정 요청" for one step → a project chat; the test agent reads and saves for real.
  await page.getByTestId('detail-history').click(); // back to the step view
  await step('6').getByTestId('step-ai').click();
  await page.getByTestId('ai-ask-input').fill('이 단계 다음에 시간 측정 추가해줘');
  await page.getByTestId('ai-ask-send').click();
  await expect(page.getByTestId('ai-chat')).toBeVisible();
  await expect(page.locator('[data-testid=msg-user]').last()).toContainText('scriptEdit: login-flow.yaml');
  await expect(page.locator('[data-testid=msg-user]').last()).toContainText("대상 단계: 6번 — 확인: [total] 글자가 '1,200' 와 같음");
  const tools = page.getByTestId('tool-card');
  await expect(tools).toHaveCount(3, { timeout: 60_000 });
  await expect(tools.nth(0)).toHaveAttribute('data-name', 'read_file');
  await expect(tools.nth(1)).toHaveAttribute('data-name', 'save_script');
  await expect(tools.nth(2)).toHaveAttribute('data-name', 'validate_script');
  await expect(page.locator('[data-testid=msg-assistant]').last()).toContainText('바꾼 점', { timeout: 60_000 });
  await shot('e4-ai-request.png');

  // 10) Back on the detail: banner → history shows the AI version.
  await page.getByTestId('tab-scripts').click();
  await expect(page.getByTestId('ai-banner')).toBeVisible();
  await expect(page.getByTestId('detail-step')).toHaveCount(7);
  await expect(step('7').getByTestId('step-title')).toHaveText('AI 가 추가한 시간 측정');
  await page.getByTestId('ai-banner-view').click();
  await expect(page.locator('[data-testid=version-row][data-version="4"]')).toHaveAttribute('data-actor', 'ai');
  await expect(page.getByTestId('compare-view')).toHaveAttribute('data-version', '4');
  await expect(page.getByTestId('compare-view').locator('[data-testid=diff-row][data-kind=added]')).toContainText('측정: 시간');
  await shot('e5-ai-banner-history.png');

  // 11) An outside change while editing → notice; "다시 불러오기" shows the outside version.
  await page.getByTestId('detail-history').click();
  await page.getByTestId('detail-edit').click();
  await step('1').locator('.step-main').click();
  await page.getByTestId('f-url').fill('/login?from=edit');
  await expect(page.getByTestId('edit-status')).toContainText('저장할 수 있습니다');
  writeFileSync(file, readFileSync(file, 'utf8').replace('name: 로그인 흐름', 'name: 로그인 흐름 (바깥에서 수정)'));
  await expect(page.getByTestId('conflict-notice')).toBeVisible({ timeout: 20_000 });
  await shot('e6-conflict.png');
  await page.getByTestId('conflict-reload').click();
  await expect(page.getByTestId('conflict-notice')).toHaveCount(0);
  await expect(page.getByTestId('detail-name')).toHaveText('로그인 흐름 (바깥에서 수정)');
  await expect(step('1').getByTestId('step-sentence')).toHaveText('/login 으로 이동');
  await page.getByTestId('edit-cancel').click();
  await page.getByTestId('detail-history').click();
  await expect(page.getByTestId('version-row')).toHaveCount(5);
  await expect(page.locator('[data-testid=version-row][data-version="5"]')).toHaveAttribute('data-actor', 'external');

  // Activity log: script.changed (user / ai / outside) and script.restored.
  await page.getByTestId('tab-activity').click();
  await expect(page.locator('[data-testid=activity-item][data-kind="script.restored"]')).toHaveCount(1);
  await expect(page.locator('[data-testid=activity-item][data-kind="script.changed"][data-actor=ai]')).toHaveCount(1);
  await expect(page.locator('[data-testid=activity-item][data-kind="script.changed"]').first()).toContainText('login-flow.yaml');

  // 12) Restart with the same userData: the history is still there.
  await app!.close();
  await launch();
  await expect(page.getByTestId('project-name')).toHaveText('Edit Portal');
  await page.getByTestId('tab-scripts').click();
  await page.locator('[data-testid=script-row][data-path="login-flow.yaml"]').getByTestId('script-detail-open').click();
  await page.getByTestId('detail-history').click();
  await expect(page.getByTestId('version-row')).toHaveCount(5);
  await expect(page.locator('[data-testid=version-row][data-version="4"]')).toHaveAttribute('data-actor', 'ai');
  await shot('e7-after-restart.png');
});
