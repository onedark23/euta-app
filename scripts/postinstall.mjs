// Post-install fixes for native/dev dependencies (idempotent).
// 1) Electron >= 44 downloads its binary lazily; fetch it now so `pnpm start` / E2E don't stall.
// 2) node-pty 1.1.0 prebuilds ship `spawn-helper` without the exec bit under some package
//    managers (pnpm) -> `posix_spawnp failed`. Restore it on macOS/Linux.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

try {
  const electronDir = dirname(require.resolve('electron/package.json'));
  if (!existsSync(join(electronDir, 'path.txt'))) {
    const r = spawnSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' });
    if (r.status !== 0) console.warn('[postinstall] electron binary download failed; it will be retried on first launch');
  }
} catch (e) {
  console.warn(`[postinstall] electron check skipped: ${e.message}`);
}

if (process.platform !== 'win32') {
  try {
    const prebuilds = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds');
    for (const d of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
      const helper = join(prebuilds, d, 'spawn-helper');
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    }
  } catch (e) {
    console.warn(`[postinstall] node-pty spawn-helper fix skipped: ${e.message}`);
  }
}
