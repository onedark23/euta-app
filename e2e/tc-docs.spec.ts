// E2E for TC document conversion (SPEC TC-문서-변환 완료 기준 "앱 E2E"), scripted test agent (no model):
// Scripts tab "TC 문서로 만들기" → preview edits (password line, a TC without steps, step table buttons)
// → 확정 → search + check (order numbers = queue) → AI로 변환 (the app sends one message per item —
// precondition script first — and the next item automatically; get_tc · save_script · run_script ·
// set_tc_conversion for real) → [중지] after 2 → app restart → 이어서 변환 (the first message hits the
// round-trip limit once, the same TC is sent again and the run goes on) → 분류별 test sets → run a set
// (manual steps shown as 수동 확인 필요 in Live, History and the set report) → export xlsx → the
// export reads back as the same TCs → 시연으로 변환 (TC step guide, 다음 단계, grouped draft).
// The TC document is the engine's synthetic fixture (never a customer file).
// EUTA_E2E_EXECUTABLE runs the same flow against the packaged app (ADR-014).
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTcDocument } from '@euta/tc-doc';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = resolve(appDir, '../euta-engine');
const tmpRoot = join(appDir, '.e2e-tmp', `tc-${Date.now()}`);
const userData = join(tmpRoot, 'userData');
const shotsDir = process.env.EUTA_E2E_SHOTS ?? join(appDir, 'test-results/screens');
const fixtureDoc = join(engineDir, 'packages/tc-doc/test/fixtures/block.xlsx');

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
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => undefined);
}

/** Native dialogs cannot be clicked: the next open / save dialog returns this path. */
const nextOpen = (file: string) =>
  app!.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as unknown as typeof dialog.showOpenDialog;
  }, file);
const nextSave = (file: string) =>
  app!.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as unknown as typeof dialog.showSaveDialog;
  }, file);

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

type DocState = { queue: string[]; tcs: { id: string; conversion: { status: string; script?: string; manualSteps: number } }[] };
const docState = (pid: string, docId: string) => app!.evaluate((_e, a) => (globalThis as Record<string, any>).__eutaTest.projects.tcDocs.view(a.pid, a.docId), { pid, docId }) as Promise<DocState>;
const statusOf = async (pid: string, docId: string) => Object.fromEntries((await docState(pid, docId)).tcs.map((t) => [t.id, t.conversion.status]));

const shot = (name: string) => page.screenshot({ path: join(shotsDir, name) });

let pid = '';
let docId = '';

test.beforeAll(async () => {
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });
  copyFileSync(fixtureDoc, join(tmpRoot, '메모장 QA.xlsx'));
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

test('TC document: import → preview → 확정 → AI로 변환 → Stop → restart → 이어서 변환 → sets → run → export', async () => {
  await page.getByTestId('new-project-name').fill('Memo QA');
  await page.getByTestId('new-project-url').fill(fixtureUrl);
  await page.getByTestId('new-project-create').click();
  await expect(page.getByTestId('project-name')).toHaveText('Memo QA');
  pid = (await page.getByTestId('project').getAttribute('data-project-id'))!;
  // Runs of the agent and of the sets stay off-screen.
  await app!.evaluate((_e, id) => (globalThis as Record<string, any>).__eutaTest.projects.update(id, { browser: { engine: 'chromium', headless: true } }), pid);

  // 1) Scripts tab → "TC 문서로 만들기" (next to 시연으로 만들기) → file picker → preview.
  await page.getByTestId('tab-scripts').click();
  await expect(page.getByTestId('script-tc-import')).toBeVisible();
  await nextOpen(join(tmpRoot, '메모장 QA.xlsx'));
  await page.getByTestId('script-tc-import').click();
  const preview = page.getByTestId('tc-preview');
  await expect(preview).toBeVisible();
  await expect(page.getByTestId('tc-preview-layout')).toHaveAttribute('data-layout', 'block');
  await expect(page.getByTestId('tc-preview-name')).toHaveValue('메모장 QA');
  await expect(page.getByTestId('tc-preview-item')).toHaveCount(4);
  await expect(page.getByTestId('tc-preview-confirm')).toBeDisabled(); // NOTE-03 has no steps
  await shot('t1-preview.png');

  // 2) Preview edits: the password line, NOTE-03 (no steps) out, SHARE-01's step table.
  await page.locator('[data-testid=tc-preview-item][data-id="NOTE-02"]').click();
  await expect(page.getByTestId('tc-preview-warning').first()).toContainText('비밀번호');
  await expect(page.getByTestId('tc-pre-group')).toHaveCount(3);
  await page.getByTestId('tc-field-precondition').fill('메모장 웹에 로그인한 상태');
  await expect(page.getByTestId('tc-preview-warning')).toHaveCount(0);
  await expect(page.getByTestId('tc-pre-group')).toHaveCount(2); // NOTE-02 joined the login group
  await page.locator('[data-testid=tc-preview-item][data-id="NOTE-03"]').click();
  await page.getByTestId('tc-preview-remove').click();
  await expect(page.getByTestId('tc-preview-item')).toHaveCount(3);
  await page.locator('[data-testid=tc-preview-item][data-id="SHARE-01"]').click();
  await expect(page.getByTestId('tc-preview-warning').first()).toContainText('다시 매깁니다');
  await expect(page.getByTestId('tc-step-row')).toHaveCount(4);
  await page.getByTestId('tc-step-add').click();
  await page.getByTestId('tc-step-action').nth(4).fill('공유 창이 닫혔는지 본다.');
  await page.getByTestId('tc-step-up').nth(4).click(); // the new step goes one up (4th)
  await expect(page.getByTestId('tc-step-action').nth(3)).toHaveValue('공유 창이 닫혔는지 본다.');
  await page.getByTestId('tc-step-delete').nth(3).click();
  await expect(page.getByTestId('tc-step-row')).toHaveCount(4);
  await page.getByTestId('tc-step-expected').nth(3).fill('공유 창이 사라진다.');
  await expect(page.getByTestId('tc-preview-confirm')).toBeEnabled();
  await shot('t2-preview-edited.png');
  await page.getByTestId('tc-preview-confirm').click();

  // 3) The document detail: search + check → checked rows on top in check order with numbers.
  const detail = page.getByTestId('tc-detail');
  await expect(detail).toBeVisible();
  await expect(page.getByTestId('tc-detail-name')).toHaveText('메모장 QA');
  docId = (await detail.getAttribute('data-doc-id'))!;
  await expect(page.getByTestId('tc-row')).toHaveCount(3);
  await page.getByTestId('tc-search').fill('공유');
  await expect(page.getByTestId('tc-row')).toHaveCount(1);
  await page.locator('[data-testid=tc-row][data-id="SHARE-01"] [data-testid=tc-check]').check();
  await page.getByTestId('tc-search').fill('');
  await page.locator('[data-testid=tc-row][data-id="NOTE-02"] [data-testid=tc-check]').check();
  await page.locator('[data-testid=tc-row][data-id="NOTE-01"] [data-testid=tc-check]').check();
  await expect(page.getByTestId('tc-row')).toHaveCount(3);
  expect(await page.getByTestId('tc-row').evaluateAll((rows) => rows.map((r) => `${r.getAttribute('data-id')}:${r.getAttribute('data-order')}`))).toEqual(['SHARE-01:1', 'NOTE-02:2', 'NOTE-01:3']);
  await shot('t3-detail-checked.png');
  const saved = JSON.parse(readFileSync(join(userData, 'projects', pid, 'tc-docs', docId, 'tc-doc.json'), 'utf8')) as { tcs: { id: string; precondition?: string; steps: unknown[] }[] };
  expect(saved.tcs.map((t) => [t.id, t.steps.length])).toEqual([
    ['NOTE-01', 3],
    ['NOTE-02', 2],
    ['SHARE-01', 4],
  ]);
  expect(JSON.stringify(saved)).not.toContain('abcd1234');
  expect(readdirSync(join(userData, 'projects', pid, 'tc-docs', docId))).toEqual(['tc-doc.json']); // no original file

  // 4) AI로 변환 → the queue dialog → a new chat; the test agent converts one TC at a time.
  await page.getByTestId('tc-convert-ai').click();
  await expect(page.getByTestId('tc-convert')).toBeVisible();
  expect(await page.locator('[data-testid=tc-convert-queue] li').evaluateAll((l) => l.map((x) => x.getAttribute('data-id')))).toEqual(['SHARE-01', 'NOTE-02', 'NOTE-01']);
  await expect(page.getByTestId('tc-convert-limit')).toHaveValue('3'); // 자동으로 진행할 개수: the whole queue by default
  await expect(page.getByTestId('tc-convert-usage')).toContainText('AI 메시지 1개');
  await page.getByTestId('tc-convert-message').fill('pauseBetween: 15000');
  await shot('t4-convert-dialog.png');
  await page.getByTestId('tc-convert-start').click();
  await expect(page.getByTestId('ai-chat')).toBeVisible();
  // One message per item: SHARE-01's precondition script first.
  await expect(page.locator('[data-testid=msg-user]').first()).toContainText(`tcConvert: ${docId} pre-2`);
  await expect(page.getByTestId('chat-tc-progress')).toContainText('/ 3');
  await expect(page.getByTestId('chat-input')).toBeDisabled();
  // While it runs, the document cannot start a second conversion; the screen shows n / N + [중지].
  await page.getByTestId('tab-scripts').click();
  await expect(page.getByTestId('tc-converting')).toBeVisible();
  const detailProgress = page.getByTestId('tc-converting').getByTestId('tc-progress-text');
  await expect(detailProgress).toContainText('/ 3 진행 중');
  await expect(page.getByTestId('tc-auto-stop')).toBeVisible();
  await expect(page.getByTestId('tc-convert-ai')).toBeDisabled();
  await expect(detailProgress).toHaveAttribute('data-current', 'SHARE-01', { timeout: 60_000 });
  await shot('t4b-detail-progress.png');
  await page.getByTestId('tab-ai').click();
  // [중지] after 2 TCs (the agent waits at the end of each TC message).
  await expect.poll(async () => Object.values(await statusOf(pid, docId)).filter((s) => s === 'done').length, { timeout: 180_000 }).toBe(2);
  await expect(page.locator('[data-testid=msg-user]')).toHaveCount(4); // pre-2 · SHARE-01 · pre-1 · NOTE-02
  await shot('t5-chat-two-done.png');
  await page.getByTestId('chat-tc-stop').click();
  await expect(page.getByTestId('chat-tc-progress')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('chat-stop')).toHaveCount(0, { timeout: 30_000 });
  expect(await statusOf(pid, docId)).toEqual({ 'SHARE-01': 'done', 'NOTE-02': 'done', 'NOTE-01': 'pending' });
  expect((await docState(pid, docId)).queue).toEqual(['NOTE-01']);
  await expect(page.locator('[data-testid=msg-user]')).toHaveCount(4); // NOTE-01 was never sent

  // 5) Restart the app: the queue survives → 이어서 변환 in a new chat.
  await app!.close();
  await launch();
  await expect(page.getByTestId('project-name')).toHaveText('Memo QA');
  await page.getByTestId('tab-scripts').click();
  await page.getByTestId('scripts-view-tcdocs').click();
  await expect(page.getByTestId('tc-doc-row')).toHaveCount(1);
  await page.getByTestId('tc-doc-open').click();
  await expect(page.getByTestId('tc-convert-resume')).toHaveText(/이어서 변환 \(1\)/);
  await expect(page.locator('[data-testid=tc-row][data-id="NOTE-01"]')).toHaveAttribute('data-order', '1');
  await expect(page.locator('[data-testid=tc-row][data-id="SHARE-01"]')).toHaveAttribute('data-status', 'done');
  await shot('t6-after-restart.png');
  await expect(page.getByTestId('tc-last-run')).toHaveCount(0); // memory only: gone after a restart
  await page.getByTestId('tc-convert-resume').click();
  // The first NOTE-01 message ends at the round-trip limit: the app sends the same TC once more.
  await page.getByTestId('tc-convert-message').fill('pauseBetween: 0\nfakeMaxTurnsOnce: NOTE-01');
  await page.getByTestId('tc-convert-start').click();
  await expect(page.getByTestId('ai-chat')).toBeVisible();
  await expect.poll(async () => Object.values(await statusOf(pid, docId)), { timeout: 180_000 }).toEqual(['done', 'done', 'done']);
  await expect(page.getByTestId('chat-stop')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('[data-testid=msg-user]')).toHaveCount(2);
  await expect(page.locator('[data-testid=msg-user]').nth(1)).toContainText('(재시도 2/2)');
  await expect(page.locator('[data-testid=msg-notice]').filter({ hasText: '왕복 한도' }).first()).toBeVisible();
  await expect(page.locator('[data-testid=msg-notice]').filter({ hasText: '한 번 더 보냅니다' })).toHaveCount(1);
  await expect(page.locator('[data-testid=msg-notice]').filter({ hasText: '대기열을 모두 마쳤습니다' })).toHaveCount(1);
  await shot('t6b-chat-limit-retry.png');

  // 6) Detail: every TC done; a row's step mapping (자동 / 수동) and the precondition scripts.
  await page.getByTestId('tab-scripts').click();
  await expect(page.getByTestId('tc-detail-done')).toHaveText('완료 3');
  await page.locator('[data-testid=tc-row][data-id="SHARE-01"] [data-testid=tc-expand]').click();
  const map = page.getByTestId('tc-map-row');
  await expect(map).toHaveCount(4);
  expect(await map.evaluateAll((r) => r.map((x) => x.getAttribute('data-kind')))).toEqual(['auto', 'manual', 'manual', 'manual']);
  await expect(page.getByTestId('tc-missing')).toContainText('정보 없음');
  await expect(page.locator('[data-testid=tc-precondition][data-status=done]')).toHaveCount(2);
  await page.getByTestId('tc-uncheck').click();
  await shot('t7-detail-done.png');

  // 7) 테스트 세트 만들기 → 분류별 → two sets, precondition script first.
  await page.getByTestId('tc-make-sets').click();
  await page.getByTestId('tc-sets-category').check();
  const plans = page.getByTestId('tc-sets-plan');
  await expect(plans).toHaveCount(2);
  await expect(plans.nth(0)).toHaveAttribute('data-name', '메모장 QA · Editor');
  await expect(plans.nth(0)).toHaveAttribute('data-count', '3');
  await expect(plans.nth(0).locator('li').first()).toContainText('사전 조건');
  await shot('t8-sets-dialog.png');
  await page.getByTestId('tc-sets-create').click();
  await expect(page.getByTestId('tc-note-banner')).toContainText('테스트 세트');
  await page.getByTestId('tc-show-sets').click();
  const editorSet = page.locator('[data-testid=testset-card][data-name="메모장 QA · Editor"]');
  await expect(editorSet).toBeVisible();
  await expect(page.locator('[data-testid=testset-card][data-name="메모장 QA · Sharing"]')).toBeVisible();
  await expect(editorSet.getByTestId('testset-item')).toHaveCount(3);

  // 8) Run the set → passes; manual steps are "수동 확인 필요" (Live, History, the set report).
  await editorSet.getByTestId('testset-run').click();
  await expect(editorSet.getByTestId('testset-progress')).toHaveAttribute('data-status', 'passed', { timeout: 180_000 });
  await shot('t9-set-run.png');
  await page.getByTestId('tab-live').click();
  // Live groups the set; its items carry the manual count, an opened item shows the badge per step.
  await page.locator('[data-testid=live-set-item]').first().click();
  await expect(page.locator('[data-testid=set-item] [data-testid=set-item-manual]').first()).toBeVisible();
  await page.locator('[data-testid=set-item]').nth(2).getByTestId('set-item-toggle').click();
  const manualRow = page.locator('[data-testid=step-row][data-manual=reached]').first();
  await expect(manualRow).toBeVisible({ timeout: 30_000 });
  await expect(manualRow.getByTestId('manual-badge')).toHaveText('수동 확인 필요');
  await expect(manualRow.getByTestId('manual-note')).toContainText('수동 확인:');
  await expect(page.getByTestId('run-manual-count')).toBeVisible();
  await shot('t10-live-manual.png');
  await page.getByTestId('tab-history').click();
  await page.getByTestId('history-refresh').click();
  await expect(page.getByTestId('history-manual').first()).toBeVisible();
  await shot('t11-history-manual.png');
  const suiteDir = join(userData, 'projects', pid, 'suite-runs');
  await expect.poll(() => (existsSync(suiteDir) ? readdirSync(suiteDir, { recursive: true }).filter((f) => String(f).endsWith('report.html')).length : 0), { timeout: 30_000 }).toBe(1);
  const reportFile = readdirSync(suiteDir, { recursive: true }).map(String).find((f) => f.endsWith('report.html'))!;
  const report = readFileSync(join(suiteDir, reportFile), 'utf8');
  expect(report).toMatch(/data-testid="sr-manual-count">수동 확인 필요<b>\d+<\/b>/);
  expect(report).toContain('수동 확인: ');

  // 9) Export the document as xlsx → it reads back as the same TCs; a test set as md.
  await page.getByTestId('tab-scripts').click();
  await page.getByTestId('scripts-view-tcdocs').click();
  await page.getByTestId('tc-doc-open').click();
  await page.getByTestId('tc-export-open').click();
  const out = join(tmpRoot, 'export.xlsx');
  await nextSave(out);
  await page.getByTestId('tc-export-save').click();
  await expect(page.getByTestId('tc-export-saved')).toHaveAttribute('data-path', out);
  await shot('t12-export.png');
  await page.getByTestId('tc-export-close').click();
  const docJson = JSON.parse(readFileSync(join(userData, 'projects', pid, 'tc-docs', docId, 'tc-doc.json'), 'utf8')) as { tcs: Record<string, unknown>[] };
  const strip = (t: Record<string, unknown>) => {
    const { conversion: _c, preconditionId: _p, ...rest } = t;
    return rest;
  };
  expect(parseTcDocument(new Uint8Array(readFileSync(out)), 'export.xlsx').tcs).toEqual(docJson.tcs.map(strip));
  // Re-import through the app: the same TCs in the preview, then cancel.
  await nextOpen(out);
  await page.getByTestId('tc-back').click();
  await page.getByTestId('tc-import').click();
  await expect(page.getByTestId('tc-preview-item')).toHaveCount(3);
  await expect(page.getByTestId('tc-preview-layout')).toHaveAttribute('data-layout', 'block');
  await page.getByTestId('tc-preview-cancel').click();
  await page.getByTestId('scripts-view-sets').click();
  await nextSave(join(tmpRoot, 'set.md'));
  await editorSet.getByTestId('testset-export').click();
  await page.getByTestId('tc-export-md').check();
  await page.getByTestId('tc-export-save').click();
  await expect(page.getByTestId('tc-export-saved')).toBeVisible();
  await page.getByTestId('tc-export-close').click();
  const md = readFileSync(join(tmpRoot, 'set.md'), 'utf8');
  expect(md).toContain('새 메모 만들기'); // original TC text, not step sentences
  expect(md.match(/^### /gm)).toHaveLength(2); // the precondition script is not a TC (its sentence is each TC's 사전 조건)

  // 10) Activity log.
  await page.getByTestId('tab-activity').click();
  for (const k of ['tcdoc.imported', 'tcdoc.exported']) await expect(page.locator(`[data-testid=activity-item][data-kind="${k}"]`).first()).toBeVisible();
  await expect(page.locator('[data-testid=activity-item][data-kind="tcdoc.converted"]').first()).toBeVisible();
});

test('시연으로 변환: TC step guide → 다음 단계 → grouped draft', async () => {
  await page.getByTestId('tab-scripts').click();
  await page.getByTestId('scripts-view-tcdocs').click();
  await page.getByTestId('tc-doc-open').click();
  await page.locator('[data-testid=tc-row][data-id="NOTE-01"] [data-testid=tc-check]').check();
  await page.getByTestId('tc-convert-record').click();
  await expect(page.getByTestId('rec-start-tc')).toContainText('새 메모 만들기');
  await page.getByTestId('rec-start-path').fill('/login');
  await page.getByTestId('rec-start-go').click();
  const panel = page.getByTestId('rec-panel');
  await expect(panel).toHaveAttribute('data-status', 'recording', { timeout: 60_000 });
  const guide = page.getByTestId('tc-guide');
  await expect(guide).toHaveAttribute('data-current', '1');
  await expect(page.getByTestId('tc-guide-expected')).toContainText('메모 목록이 보인다.');
  await shot('t13-guide.png');

  // Step 1 has an expected result: [다음 단계] without a checkpoint asks once → 확인 걸기 → the person clicks.
  await page.getByTestId('tc-guide-next').click();
  await expect(page.getByTestId('tc-guide-ask')).toBeVisible();
  await shot('t14-guide-ask.png');
  await page.getByTestId('tc-guide-ask-check').click();
  await expect(page.getByTestId('rec-checkpoint-armed')).toBeVisible();
  await person(`await p.getByRole('heading', { name: '로그인' }).click();`);
  await expect(page.locator('[data-testid=rec-row][data-kind=checkpoint]')).toHaveCount(1);
  await page.getByTestId('tc-guide-next').click();
  await expect(guide).toHaveAttribute('data-current', '2');
  // Step 2: an action, then 건너뛰기 at the question (its expected result stays a manual check).
  await person(`await p.getByLabel('이메일').pressSequentially('memo@example.com', { delay: 5 });`);
  await expect(page.locator('[data-testid=rec-row][data-kind=fill]')).toHaveCount(1);
  await page.getByTestId('tc-guide-next').click();
  await page.getByTestId('tc-guide-ask-skip').click();
  await expect(guide).toHaveAttribute('data-current', '3');
  // Step 3 (last, no expected result): an action → 마지막 단계 끝내기.
  await person(`await p.getByRole('button', { name: '로그인' }).hover();await p.getByLabel('비밀번호').click();`);
  await expect(page.getByTestId('tc-guide-next')).toHaveText(/마지막 단계 끝내기/);
  await page.getByTestId('tc-guide-next').click();
  await expect(guide).toHaveAttribute('data-current', 'done');
  await shot('t15-guide-done.png');
  await page.getByTestId('rec-stop').click();
  await expect(panel).toHaveAttribute('data-status', 'stopped', { timeout: 30_000 });
  await page.getByTestId('rec-save').click();
  const savedPath = (await page.getByTestId('rec-saved').getAttribute('data-path'))!;
  expect(savedPath).toMatch(/^NOTE-01-새-메모-만들기(-2)?\.yaml$/);
  await shot('t16-rec-saved.png');
  const yaml = readFileSync(join(userData, 'projects', pid, 'scripts', savedPath), 'utf8');
  expect(yaml).toContain('TC ID: NOTE-01');
  expect(yaml).toContain('name: 1. 메모 목록 화면을 연다.');
  expect(yaml).toContain("name: 2. '새 메모' 버튼을 누른다.");
  expect(yaml).toContain('instruction: 빈 편집기가 열린다.');
  expect(yaml).toMatch(/visible:\s*\n?\s*role: heading/);
  const st = await docState(pid, docId);
  expect(st.tcs.find((t) => t.id === 'NOTE-01')!.conversion).toMatchObject({ status: 'done', script: savedPath, manualSteps: 1 });
});

test('다시 변환 of 3 TCs runs automatically to the end (one message per TC, progress on both screens)', async () => {
  await page.getByTestId('tab-scripts').click();
  await page.getByTestId('scripts-view-tcdocs').click();
  if (!(await page.getByTestId('tc-detail').isVisible())) await page.getByTestId('tc-doc-open').click();
  await expect(page.getByTestId('tc-detail')).toBeVisible();
  for (const id of ['NOTE-01', 'NOTE-02', 'SHARE-01']) {
    const box = page.locator(`[data-testid=tc-row][data-id="${id}"] [data-testid=tc-check]`);
    if (!(await box.isChecked())) await box.check();
  }
  await page.getByTestId('tc-convert-redo').click();
  await expect(page.getByTestId('tc-convert-queue').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('tc-convert-limit')).toHaveValue('3');
  await page.getByTestId('tc-convert-message').fill('pauseBetween: 2500');
  await page.getByTestId('tc-convert-start').click();
  await expect(page.getByTestId('ai-chat')).toBeVisible();
  const chatId = (await docState(pid, docId).then((d) => (d as unknown as { activeChatId?: string }).activeChatId))!;
  expect(chatId).toBeTruthy();
  await expect(page.getByTestId('chat-tc-progress')).toBeVisible();
  await expect(page.getByTestId('chat-tc-progress').getByTestId('tc-progress-text')).toHaveAttribute('data-done', '1', { timeout: 120_000 });
  await shot('t17-chat-progress.png');
  await page.getByTestId('tab-scripts').click();
  await expect(page.getByTestId('tc-converting').getByTestId('tc-progress-text')).toBeVisible();
  await shot('t18-detail-progress.png');
  // Runs on its own until the queue is empty — no clicks in between.
  await expect(page.getByTestId('tc-last-run')).toHaveAttribute('data-reason', 'empty', { timeout: 240_000 });
  await expect(page.getByTestId('tc-last-run')).toContainText('3 / 3');
  expect(await statusOf(pid, docId)).toEqual({ 'NOTE-01': 'done', 'NOTE-02': 'done', 'SHARE-01': 'done' });
  expect((await docState(pid, docId)).queue).toEqual([]);
  await shot('t19-detail-finished.png');
  const chat = (await app!.evaluate((_e, a) => (globalThis as Record<string, any>).__eutaTest.projects.chatEngine(a.pid).get(a.chatId), { pid, chatId })) as { items: { kind: string; text?: string }[] };
  const sent = chat.items.filter((i) => i.kind === 'user').map((i) => /tcConvert: \w+ (\S+)/.exec(i.text ?? '')?.[1]);
  expect(sent).toHaveLength(3); // preconditions are done already: one message per TC
  expect(new Set(sent)).toEqual(new Set(['NOTE-01', 'NOTE-02', 'SHARE-01']));
});
