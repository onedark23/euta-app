// E2E for script authoring by demonstration (SPEC 스크립트-작성-시연녹화 완료 기준, app side).
// Scripts tab "시연으로 만들기" → the test acts as the person in the recorder's browser
// (reached through the E2E-only main-process handle __eutaTest.recorderPage(), ADR-017)
// while typing a note, marking a field sensitive and adding a checkpoint in the panel →
// stop → "AI 없이 저장" → the draft is in the library and its run passes → "AI로 정리"
// (scripted test agent: get_recording → save_script → run_script, no model) → chat,
// library, History and activity log updated → no plaintext secret under userData.
// EUTA_E2E_EXECUTABLE runs the same flow against the packaged app (ADR-014).
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = resolve(appDir, '../euta-engine');
const tmpRoot = join(appDir, '.e2e-tmp', `rec-${Date.now()}`);
const userData = join(tmpRoot, 'userData');
const shotsDir = process.env.EUTA_E2E_SHOTS ?? join(appDir, 'test-results/screens');
// Fixture site credentials (engine packages/core/test/fixture-site/server.ts FIXTURE_USER).
const USER_EMAIL = 'qa.user@example.com';
const USER_PASSWORD = 's3cret P@ss&word!';

let fixture: ChildProcess | undefined;
let fixtureUrl = '';
let app: ElectronApplication | undefined;
let page: Page;
const fakeClaude = join(tmpRoot, 'fake-claude');

async function startFixture(): Promise<string> {
  const port = String(4800 + Math.floor(Math.random() * 500));
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
  await page.waitForLoadState('domcontentloaded');
}

/** Run `fn` against the recorder's Playwright page in the main process (the "person"). */
async function person(fn: string, arg: Record<string, string> = {}): Promise<void> {
  await app!.evaluate(
    async (_electron, { fn: body, arg: a }) => {
      const p = (globalThis as Record<string, any>).__eutaTest.recorderPage();
      if (!p) throw new Error('no active recorder');
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      await new Function('p', 'a', `return (async () => { ${body} })();`)(p, a);
    },
    { fn, arg },
  );
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

const shot = (name: string) => page.screenshot({ path: join(shotsDir, name) });

test.beforeAll(async () => {
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });
  fixtureUrl = await startFixture();
  writeFileSync(fakeClaude, `#!/bin/sh\nif [ "$1 $2" = "auth status" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"e2e@example.com","subscriptionType":"max"}'; fi\n`);
  chmodSync(fakeClaude, 0o755);
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

test('demonstration recording: record → AI 없이 저장 → run → AI로 정리', async () => {
  // Project with one environment on the fixture site and its secrets.
  await page.getByTestId('new-project-name').fill('Recorder Portal');
  await page.getByTestId('new-project-url').fill(fixtureUrl);
  await page.getByTestId('new-project-create').click();
  await expect(page.getByTestId('project-name')).toHaveText('Recorder Portal');
  const projectId = (await page.getByTestId('project').getAttribute('data-project-id'))!;
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

  // AI tab entry + "말로 시키기" examples.
  await page.getByTestId('tab-ai').click();
  await expect(page.getByTestId('chat-example')).toHaveCount(3);
  await page.getByTestId('chat-example').first().click();
  await expect(page.getByTestId('chat-input')).toHaveValue('로그인해서 보고서를 PDF로 내보내기 테스트 만들어줘');
  await page.getByTestId('chat-input').fill('');
  await page.getByTestId('ai-record').click();
  await expect(page.getByTestId('rec-start')).toBeVisible();
  await page.getByTestId('rec-start').getByRole('button', { name: '취소' }).click();

  // 1) Scripts tab → 시연으로 만들기 → environment / start path / name.
  await page.getByTestId('tab-scripts').click();
  await page.getByTestId('script-record').click();
  await page.getByTestId('rec-start-path').fill('/login');
  await page.getByTestId('rec-start-name').fill('Login demo');
  await page.getByTestId('rec-start-go').click();
  const panel = page.getByTestId('rec-panel');
  await expect(panel).toHaveAttribute('data-status', 'recording', { timeout: 60_000 });
  const recordingId = (await panel.getAttribute('data-recording-id'))!;
  await expect(page.locator('[data-testid=rec-row][data-kind=navigate]')).toHaveCount(1);

  // 2) The person logs in; the panel marks the email sensitive, adds a note and a checkpoint.
  await person(`await p.getByLabel('이메일').pressSequentially(a.email, { delay: 5 });`, { email: USER_EMAIL });
  const emailRow = page.locator('[data-testid=rec-row][data-kind=fill]').first();
  await expect(emailRow).toContainText(USER_EMAIL);
  await emailRow.getByTestId('rec-row-sensitive').click();
  await expect(emailRow).toContainText('민감');
  await expect(emailRow).not.toContainText(USER_EMAIL);
  await person(`await p.getByLabel('비밀번호').pressSequentially(a.pw, { delay: 5 });`, { pw: USER_PASSWORD });
  await expect(page.locator('[data-testid=rec-row][data-kind=fill]').nth(1)).toContainText('민감');
  await page.getByTestId('rec-note').fill('여기서 로그인');
  await page.getByTestId('rec-note').press('Enter');
  await expect(page.getByTestId('rec-memo')).toContainText('여기서 로그인');
  await person(`await p.getByRole('button', { name: '로그인' }).click(); await p.waitForURL(/dashboard/);`);
  await expect(page.locator('[data-testid=rec-row][data-kind=navigate]')).toHaveCount(2);
  await page.getByTestId('rec-cp-kind').selectOption('textEquals');
  await page.getByTestId('rec-checkpoint').click();
  await expect(page.getByTestId('rec-checkpoint-armed')).toBeVisible();
  await person(`await p.getByTestId('total').click();`);
  const cp = page.locator('[data-testid=rec-row][data-kind=checkpoint]');
  await expect(cp).toContainText('텍스트 같음');
  await expect(cp.getByTestId('rec-row-expected-value')).toHaveText('1,200');
  await expect(page.getByTestId('rec-checkpoint-armed')).toHaveCount(0);
  expect(await panel.innerText()).not.toContain(USER_PASSWORD);
  await shot('r1-recording-panel.png');

  // 3) Stop → "AI 없이 저장" → the draft is in the library; its run passes.
  await page.getByTestId('rec-stop').click();
  await expect(panel).toHaveAttribute('data-status', 'stopped', { timeout: 30_000 });
  await expect(page.getByTestId('rec-result')).toBeVisible();
  await expect(page.getByTestId('rec-missing')).toHaveCount(0); // USER_EMAIL / USER_PASSWORD exist in the vault
  await page.getByTestId('rec-save').click();
  await expect(page.getByTestId('rec-saved')).toHaveAttribute('data-path', 'login-demo.yaml');
  await shot('r2-saved.png');
  const draftRow = page.locator('[data-testid=script-row][data-path="login-demo.yaml"]');
  await expect(draftRow).toBeVisible();
  await expect(page.locator(`[data-testid=recording-row][data-id="${recordingId}"]`)).toContainText('Login demo');
  const draftText = readFileSync(join(userData, 'projects', projectId, 'scripts', 'login-demo.yaml'), 'utf8');
  expect(draftText).toContain('${secrets.USER_PASSWORD}');
  expect(draftText).toContain('${secrets.USER_EMAIL}');
  expect(draftText).toContain('equals: 1,200');
  await draftRow.getByTestId('script-run').click();
  await expect(page.getByTestId('run-script')).toHaveValue('login-demo.yaml');
  await page.getByTestId('headless').setChecked(true);
  await page.getByTestId('run').click();
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'passed', { timeout: 120_000 });
  const draftRunId = (await page.getByTestId('run-detail').getAttribute('data-run-id'))!;

  // 4) "AI로 정리" → a new project chat; the test agent calls get_recording → save_script → run_script.
  await page.getByTestId('rec-tidy-msg').fill('결제 단계는 없어요');
  await page.getByTestId('rec-tidy').click();
  await expect(page.getByTestId('ai-chat')).toBeVisible();
  await expect(page.locator('[data-testid=msg-user]').last()).toContainText(`recordingId: ${recordingId}`);
  const cards = page.getByTestId('tool-card');
  await expect(cards).toHaveCount(3, { timeout: 60_000 });
  await expect(cards.nth(0)).toHaveAttribute('data-name', 'get_recording');
  await expect(cards.nth(1)).toHaveAttribute('data-name', 'save_script');
  await expect(cards.nth(2)).toHaveAttribute('data-name', 'run_script');
  await expect(cards.nth(2)).toHaveAttribute('data-status', 'done', { timeout: 120_000 });
  await expect(page.locator('[data-testid=msg-assistant]').last()).toContainText('login-demo-ai.yaml 실행 결과: passed');
  expect(await page.getByTestId('ai-chat').innerText()).not.toContain(USER_PASSWORD);
  await shot('r3-ai-tidy.png');
  await cards.nth(2).getByTestId('tool-open-live').click();
  const aiRunId = (await page.getByTestId('run-detail').getAttribute('data-run-id'))!;
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'passed');

  // 5) Library, History and the activity log.
  await page.getByTestId('tab-scripts').click();
  await expect(page.locator('[data-testid=script-row][data-path="login-demo-ai.yaml"]')).toBeVisible();
  await page.getByTestId('tab-history').click();
  await page.getByTestId('history-refresh').click();
  await expect(page.locator(`[data-testid=history-row][data-run-id="${draftRunId}"] [data-status=passed]`)).toHaveText('통과');
  await expect(page.locator(`[data-testid=history-row][data-run-id="${aiRunId}"]`)).toContainText('AI');
  await page.getByTestId('tab-activity').click();
  for (const k of ['recording.started', 'recording.finished']) await expect(page.locator(`[data-testid=activity-item][data-kind="${k}"]`)).toHaveCount(1);
  await expect(page.locator('[data-testid=activity-item][data-kind="recording.converted"]')).toHaveCount(2);
  await expect(page.locator('[data-testid=activity-item][data-kind="recording.finished"]')).toContainText('체크포인트 1개');
  await expect(page.locator('[data-testid=activity-item][data-kind="chat.turn"]')).toContainText('get_recording, save_script, run_script');
  await shot('r4-activity.png');

  // 6) Recording files: recording.json + masked shots; no plaintext secret anywhere under userData.
  const recDir = join(userData, 'projects', projectId, 'recordings', recordingId);
  expect(existsSync(join(recDir, 'recording.json'))).toBe(true);
  expect(readdirSync(join(recDir, 'shots')).length).toBeGreaterThan(0);
  const files = allFiles(userData);
  const needles = [USER_PASSWORD, USER_EMAIL, encodeURIComponent(USER_PASSWORD), Buffer.from(USER_PASSWORD).toString('base64')];
  const hits: string[] = [];
  for (const f of files) {
    const buf = readFileSync(f);
    for (const n of needles) if (buf.includes(Buffer.from(n))) hits.push(`${f.slice(userData.length)} (${n.slice(0, 4)}…)`);
  }
  console.log(`plaintext secret scan: ${files.length} files under userData (recording ${recordingId}), ${hits.length} hits`);
  expect(hits).toEqual([]);

  // 7) Deleting the recording from the library also closes its panel (no stale panel → "recording not found").
  await page.getByTestId('tab-scripts').click();
  const panelOpen = await page.getByTestId('rec-panel').isVisible();
  page.once('dialog', (d) => void d.accept());
  await page.locator(`[data-testid=recording-row][data-id="${recordingId}"] [data-testid=recording-delete]`).click();
  await expect(page.getByTestId('rec-panel')).toHaveCount(0);
  await expect.poll(() => existsSync(recDir)).toBe(false);
  console.log(`recording delete: panel was ${panelOpen ? 'open' : 'closed'} before delete, now gone`);
});
