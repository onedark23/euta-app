// SPEC 앱-배포-업데이트 앱 E2E (ADR-042) against a fake update server + fake euta cloud (e2e/fake-cloud.ts):
//  1. ad-hoc Mac path (EUTA_E2E_UPDATE_MODE=manual): [업데이트 확인] → source = this server (/api/config appUpdates)
//     → its latest*.yml → "새 버전 x — [내려받기]"
//     + [바뀐 것]; [내려받기] opens this Mac's dmg; 앱 설정 shows version · channel · last check.
//  2. 426 APP_TOO_OLD: the server raises MIN_APP_VERSION → after a restart the cloud project is locked as
//     "업데이트 필요" with [업데이트]; a local project still runs on this PC; X-Euta-App-Version on every request.
//  3. updater path (EUTA_E2E_UPDATE_MODE=auto): electron-updater reads latest*.yml from the fake feed for real
//     (download / install stubbed — an unsigned dev app cannot install) → "준비됨 — [다시 시작해서 업데이트]";
//     a run in progress → "진행 중인 작업이 끊깁니다" → [끝나면 업데이트] waits, then [끊고 업데이트].
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeCloud } from './fake-cloud.js';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = join(appDir, '.e2e-tmp', `update-${Date.now()}`);
const shotsDir = process.env.EUTA_E2E_SHOTS ?? join(appDir, 'test-results/screens');
const A = 'owner@example.com';
const NEXT = '0.1.0-alpha.2';
const NOTES = '- 둘째 알파: 업데이트 알림을 고쳤습니다\n- 클라우드 잠금 안내 문구';
const SCRIPT = (name: string) => `# ${name}\nversion: 1\nname: ${name}\ntarget:\n  baseUrl: \${env.BASE_URL}\ndefaults:\n  timeout: 8s\nsteps:\n  - goto: /slow\n`;

const fake = new FakeCloud();
const apps: ElectronApplication[] = [];
const shot = (page: Page, name: string) => page.screenshot({ path: join(shotsDir, name) });
const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const meta = os === 'mac' ? 'latest-mac.yml' : os === 'win' ? 'latest.yml' : 'latest-linux.yml';

/** A site that never answers: a run against it stays "running" until its 8 s timeout. */
let slow: Server;
let site = '';

async function launch(name: string, mode: 'manual' | 'auto'): Promise<{ app: ElectronApplication; page: Page }> {
  const executablePath = process.env.EUTA_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [appDir] }),
    cwd: appDir,
    env: {
      ...(process.env as Record<string, string>),
      EUTA_E2E: '1',
      EUTA_USER_DATA_DIR: join(tmpRoot, name),
      EUTA_E2E_UPDATE_MODE: mode,
      EUTA_UPDATE_SERVER: fake.url,
      SHELL: '/bin/sh',
    },
  });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function close(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => undefined);
  apps.splice(apps.indexOf(app), 1);
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

async function newLocalProject(app: ElectronApplication, page: Page, name: string): Promise<void> {
  await page.getByTestId('project-new').click();
  await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('new-project-url').fill(site);
  await page.getByTestId('new-project-create').click();
  await expect(page.getByTestId('project-name')).toHaveText(name);
  const f = join(tmpRoot, 'import', `${name}.yaml`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, SCRIPT(name));
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as unknown as typeof dialog.showOpenDialog;
  }, [f]);
  await page.getByTestId('tab-scripts').click();
  await page.getByTestId('script-import').click();
  await expect(page.locator(`[data-testid=script-row][data-path="${name}.yaml"]`)).toBeVisible();
}

/** Start a run of the project's script on this PC (it hangs on the slow site until its timeout). */
async function startRun(page: Page, name: string): Promise<void> {
  await page.getByTestId('tab-scripts').click();
  await page.locator(`[data-testid=script-row][data-path="${name}.yaml"]`).getByTestId('script-run').click();
  await page.getByTestId('run').click();
  await expect(page.getByTestId('tab-live')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'running');
}

const testApi = (app: ElectronApplication, key: 'installRequests' | 'lastExternalUrl') =>
  app.evaluate((_e, k) => ((globalThis as unknown as { __eutaTest: Record<string, () => unknown> }).__eutaTest[k] as () => unknown)(), key);

test.beforeAll(async () => {
  mkdirSync(shotsDir, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  slow = createServer(() => undefined); // never answers
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
  site = `http://127.0.0.1:${(slow.address() as { port: number }).port}`;
  fake.addUser(A, '소유자 김');
  await fake.start();
  const file = (arch: string, ext: string) => ({ platform: os, arch, kind: ext === 'zip' ? 'update' : 'installer', name: `euta-${NEXT}-${os}-${arch}.${ext}`, size: 1234, url: `${fake.url}/updates/alpha/${NEXT}/euta-${NEXT}-${os}-${arch}.${ext}` });
  const ext = os === 'mac' ? 'dmg' : os === 'win' ? 'exe' : 'AppImage';
  fake.appReleases = {
    channel: 'alpha',
    releases: [
      { version: NEXT, publishedAt: '2026-10-30T09:00:00Z', notes: NOTES, files: [file('arm64', ext), file('x64', ext), ...(os === 'mac' ? [file('arm64', 'zip')] : []), { platform: os, arch: null, kind: 'meta', name: meta, size: 300, url: `${fake.url}/updates/alpha/${NEXT}/${meta}` }] },
      { version: '0.1.0-alpha.1', publishedAt: '2026-10-29T09:00:00Z', notes: '- 첫 배포', files: [] },
    ],
  };
  // electron-updater generic provider feed (the update file itself is never fetched — download is stubbed).
  const zip = `euta-${NEXT}-${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.${os === 'mac' ? 'zip' : ext}`;
  fake.updateFiles.set(
    `/updates/alpha/${meta}`,
    `version: ${NEXT}\nfiles:\n  - url: ${zip}\n    sha512: ${'A'.repeat(86)}==\n    size: 1234\npath: ${zip}\nsha512: ${'A'.repeat(86)}==\nreleaseDate: '2026-10-30T09:00:00.000Z'\nreleaseNotes: |-\n${NOTES.split('\n').map((l) => `  ${l}`).join('\n')}\n`,
  );
});

test.afterAll(async () => {
  for (const app of apps) await app.close().catch(() => undefined);
  await fake.stop();
  slow?.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('ad-hoc Mac path: new version notice → [내려받기] · [바뀐 것]; 426 locks cloud projects, local runs fine', async () => {
  const { app, page } = await launch('manual', 'manual');
  await login(page, A);
  // Settings: version, channel, not checked yet (first background check is 30 s after start).
  await expect(page.getByTestId('update-settings')).toHaveAttribute('data-mode', 'manual');
  await expect(page.getByTestId('update-version')).toHaveText('0.1.0-alpha.1');
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
  await page.getByTestId('update-check').click();
  await expect(page.getByTestId('update-last-check')).toHaveAttribute('data-result', 'available');
  await expect(page.getByTestId('update-last-check')).toContainText(`새 버전 ${NEXT}`);
  await expect(page.getByTestId('update-source')).toHaveText(fake.url);
  const banner = page.getByTestId('update-banner');
  await expect(banner).toHaveAttribute('data-mode', 'manual');
  await expect(banner).toContainText(`새 버전 ${NEXT}`);
  await expect(banner.getByTestId('update-restart')).toHaveCount(0); // no self-install on an ad-hoc Mac
  await page.getByTestId('update-settings').scrollIntoViewIfNeeded();
  await shot(page, 'p17-1-manual-notice-settings.png');
  await banner.getByTestId('update-notes').click();
  await expect(page.getByTestId('update-notes-dialog')).toContainText('둘째 알파');
  await shot(page, 'p17-2-notes.png');
  await page.getByTestId('update-notes-close').click();
  await banner.getByTestId('update-download').click();
  await expect.poll(() => testApi(app, 'lastExternalUrl')).toBe(`${fake.url}/updates/alpha/euta-${NEXT}-${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.${os === 'mac' ? 'dmg' : os === 'win' ? 'exe' : 'AppImage'}`);

  // A cloud project and a local one.
  fake.createProject({ name: '공유 포털', ownerEmail: A, scripts: { 'login.yaml': SCRIPT('로그인') }, envs: [{ name: 'dev', baseUrl: site }] });
  await page.getByTestId('cloud-find').click();
  await page.getByTestId('cloud-projects-mine').locator('[data-testid=cloud-project-row][data-name="공유 포털"]').getByTestId('cloud-project-open').click();
  await expect(page.getByTestId('project-name')).toHaveText('☁ 공유 포털');
  await expect(page.locator('[data-testid=script-row][data-path="login.yaml"]')).toBeVisible({ timeout: 20_000 });
  await newLocalProject(app, page, '로컬 사이트');
  // Every device-token request carried this app's version (incl. the SSE feeds).
  expect(fake.appVersions.length).toBeGreaterThan(3);
  expect(fake.appVersions.filter((l) => !l.endsWith('→ 0.1.0-alpha.1'))).toEqual([]);
  expect(fake.appVersions.some((l) => /\/events → /.test(l))).toBe(true);

  // The server raises MIN_APP_VERSION; next start → 426 → cloud locked, local fine.
  fake.minVersion = '0.2.0';
  await close(app);
  const second = await launch('manual', 'manual');
  const p2 = second.page;
  await expect(p2.getByTestId('cloud-chip')).toHaveAttribute('data-state', 'app_too_old', { timeout: 20_000 });
  const cloudItem = p2.locator('[data-testid=project-item]', { hasText: '공유 포털' });
  await expect(cloudItem.getByTestId('project-update-needed')).toBeVisible();
  await cloudItem.click();
  const lock = p2.getByTestId('cloud-update-needed');
  await expect(lock).toBeVisible();
  await expect(lock).toContainText('최소 0.2.0');
  await shot(p2, 'p17-3-cloud-locked.png');
  // [업데이트] on an ad-hoc Mac = check (nothing known yet after the restart) → installer download.
  await lock.getByTestId('cloud-update-button').click();
  await expect.poll(() => testApi(second.app, 'lastExternalUrl')).toContain(`/euta-${NEXT}-`);
  // The local project still runs on this PC.
  await p2.locator('[data-testid=project-item]', { hasText: '로컬 사이트' }).click();
  await expect(p2.getByTestId('project-name')).toHaveText('로컬 사이트');
  await startRun(p2, '로컬 사이트');
  await expect(p2.getByTestId('run-status')).not.toHaveAttribute('data-status', 'running', { timeout: 30_000 });
  await shot(p2, 'p17-4-local-run-while-locked.png');
  await close(second.app);
  fake.minVersion = undefined;
});

test('updater path: "준비됨 — [다시 시작해서 업데이트]"; a running run asks first (끝나면 업데이트 · 끊고 업데이트)', async () => {
  const { app, page } = await launch('auto', 'auto');
  await newLocalProject(app, page, '느린 사이트');
  await page.getByTestId('app-settings').click();
  await expect(page.getByTestId('update-settings')).toHaveAttribute('data-mode', 'auto');
  await page.getByTestId('update-check').click();
  const banner = page.getByTestId('update-banner');
  await expect(banner).toHaveAttribute('data-mode', 'auto', { timeout: 20_000 });
  await expect(banner).toContainText(`새 버전 ${NEXT} 준비됨`);
  await expect(page.getByTestId('update-last-check')).toContainText('준비됨');
  await shot(page, 'p17-5-ready.png');
  await banner.getByTestId('update-notes').click();
  await expect(page.getByTestId('update-notes-dialog')).toContainText('클라우드 잠금 안내 문구'); // from latest*.yml releaseNotes
  await page.getByTestId('update-notes-close').click();

  // A run in progress → asked first; "끝나면 업데이트" waits and does not restart by itself.
  await page.locator('[data-testid=project-item]', { hasText: '느린 사이트' }).click();
  await startRun(page, '느린 사이트');
  await banner.getByTestId('update-restart').click();
  const dialog = page.getByTestId('update-busy-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('update-busy-list')).toContainText('이 PC 실행 1개');
  await shot(page, 'p17-6-busy-confirm.png');
  await page.getByTestId('update-when-idle').click();
  await expect(banner).toContainText('끝나면 다시 알려 드립니다');
  await shot(page, 'p17-7-waiting.png');
  await expect(page.getByTestId('run-status')).not.toHaveAttribute('data-status', 'running', { timeout: 30_000 });
  await expect(banner.getByTestId('update-restart')).toBeVisible({ timeout: 10_000 }); // asks again
  expect(await testApi(app, 'installRequests')).toBe(0);

  // Another run → "끊고 업데이트" restarts now (the stubbed install is recorded instead of quitting).
  await startRun(page, '느린 사이트');
  await banner.getByTestId('update-restart').click();
  await page.getByTestId('update-force').click();
  await expect.poll(() => testApi(app, 'installRequests')).toBe(1);
  await close(app);
});
