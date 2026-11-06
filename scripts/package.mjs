// Personal-test packaging (ADR-014): build a runnable euta.app for this machine.
//
// Why a staging dir: @euta/core, @euta/input-os, @euta/mcp-server and @euta/tc-doc are `link:` deps into the sibling
// euta-engine repo, whose own deps live in that repo's pnpm store. electron-builder
// would not see them. So we `pnpm pack` the engine packages, install them with npm
// into a flat staging node_modules together with the runtime externals, and package
// that. Not a distribution build: ad-hoc signature (runs on this Mac), no notarization.
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = resolve(appDir, '../euta-engine');
// EUTA_PACKAGE_OUT: output folder (default ./release). Lets a test build package next to
// a euta.app that is currently running from release/dist without replacing it.
const outDir = resolve(appDir, process.env.EUTA_PACKAGE_OUT || 'release');
const stage = join(outDir, 'stage');
const vendor = join(stage, 'vendor');

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(' ')}   (${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
}

const appPkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
// The exact version installed here (package.json only holds a range): the staged app must use
// the same playwright as the engine and the browser builds already in the user cache.
const installed = (name) => {
  const f = join(appDir, 'node_modules', name, 'package.json');
  if (!existsSync(f)) throw new Error(`${name} is not installed in ${appDir} — run pnpm install`);
  return JSON.parse(readFileSync(f, 'utf8')).version;
};
const playwrightVersion = installed('playwright');

// 1. Build engine and app.
if (!existsSync(engineDir)) throw new Error(`engine repo not found: ${engineDir}`);
run('pnpm', ['-r', 'build'], engineDir);
run('pnpm', ['exec', 'electron-vite', 'build'], appDir);

// 2. Fresh staging dir with the built app and packed engine packages.
rmSync(stage, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
cpSync(join(appDir, 'out'), join(stage, 'out'), { recursive: true });
for (const pkg of ['core', 'input-os', 'mcp-server', 'tc-doc']) run('pnpm', ['pack', '--pack-destination', vendor], join(engineDir, 'packages', pkg));
const tgz = (prefix) => {
  const f = readdirSync(vendor).find((n) => n.startsWith(prefix) && n.endsWith('.tgz'));
  if (!f) throw new Error(`packed tarball ${prefix}*.tgz not found`);
  return `file:vendor/${f}`;
};

writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'euta-app',
      productName: 'euta',
      version: appPkg.version,
      description: appPkg.description,
      type: 'module',
      main: './out/main/index.js',
      private: true,
      // Every runtime dependency of the app (package.json "dependencies"), engine `link:` packages
      // replaced by their packed tarballs, plus playwright (dev dep, loaded at run time by the engine).
      // AI chat (ADR-015): the Agent SDK pulls only this platform's CLI package (optional dependency).
      dependencies: {
        ...Object.fromEntries(
          Object.entries(appPkg.dependencies ?? {}).map(([name, v]) =>
            [name, String(v).startsWith('link:') ? tgz(`${name.replace(/^@/, '').replace('/', '-')}-`) : v],
          ),
        ),
        playwright: playwrightVersion,
      },
      // input-os / mcp-server / tc-doc depend on sibling engine packages by version; point them at the same tarballs.
      // playwright: the engine tarballs ask for a range — hold every copy to the installed version.
      overrides: { '@euta/core': '$@euta/core', '@euta/input-os': '$@euta/input-os', playwright: playwrightVersion },
    },
    null,
    2,
  ),
);

// 3. Flat production node_modules (real files, no symlinks).
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], stage);

// Every bare package the built main process imports must be installed in the stage
// (a missing one only shows up as ERR_MODULE_NOT_FOUND when the packaged app starts).
{
  const builtins = new Set((await import('node:module')).builtinModules);
  const missing = new Set();
  for (const f of readdirSync(join(stage, 'out/main')).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(stage, 'out/main', f), 'utf8');
    // static `import … from "x"` / `export … from "x"` / `import "x"` at line start, and `import("x")`
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\b[^'"\n]*?(?:\bfrom\s*)?["']([^"'./][^"']*)["']/gm),
      ...src.matchAll(/\bimport\s*\(\s*["']([^"'./][^"']*)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith('node:') || builtins.has(spec) || spec === 'electron') continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!existsSync(join(stage, 'node_modules', name, 'package.json'))) missing.add(name);
    }
  }
  if (missing.size) throw new Error(`main process imports packages missing from the app: ${[...missing].join(', ')} — add them to package.json "dependencies"`);
}

// node-pty prebuilds can lose the exec bit on spawn-helper (see postinstall.mjs).
if (process.platform !== 'win32') {
  const prebuilds = join(stage, 'node_modules/node-pty/prebuilds');
  for (const d of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
    const helper = join(prebuilds, d, 'spawn-helper');
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  }
}

// The SDK's bundled Claude Code CLI must be a real executable file outside the asar.
const cliPkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
const cliName = process.platform === 'win32' ? 'claude.exe' : 'claude';
const stagedCli = join(stage, 'node_modules/@anthropic-ai', cliPkg, cliName);
if (!existsSync(stagedCli)) throw new Error(`bundled Claude Code CLI missing: ${stagedCli}`);
if (process.platform !== 'win32' && (statSync(stagedCli).mode & 0o111) === 0) chmodSync(stagedCli, 0o755);
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const cliHash = sha256(stagedCli);

// 4. Package with the locally downloaded Electron (no network fetch, no native rebuild:
//    node-pty and robotjs ship N-API prebuilds, node:sqlite is built in — ADR-010/013).
const electronPkgDir = join(appDir, 'node_modules/electron');
const electronVersion = JSON.parse(readFileSync(join(electronPkgDir, 'package.json'), 'utf8')).version;
const config = {
  appId: 'dev.euta.app',
  productName: 'euta',
  electronVersion,
  electronDist: join(electronPkgDir, 'dist'),
  npmRebuild: false,
  // Absolute: projectDir is the stage, so the app repo's build/ is not auto-discovered (ADR-027).
  icon: join(appDir, 'build/icon.svg'),
  directories: { output: join(outDir, 'dist') },
  files: ['out/**', 'node_modules/**', 'package.json'],
  asar: true,
  // Native addons, node-pty's spawn-helper and Playwright (spawns/reads its own files) stay on disk.
  asarUnpack: [
    '**/*.node',
    'node_modules/node-pty/**',
    'node_modules/robotjs/**',
    'node_modules/playwright-core/**',
    'node_modules/playwright/**',
    // Agent SDK CLI binary: spawned as a process, so it cannot live inside app.asar.
    'node_modules/@anthropic-ai/claude-agent-sdk-*/**',
  ],
  mac: {
    target: [{ target: 'dir' }],
    category: 'public.app-category.developer-tools',
    identity: null, // signed ad-hoc below
    hardenedRuntime: false,
  },
  win: { target: [{ target: 'dir' }] },
};
const configPath = join(outDir, 'electron-builder.config.json');
writeFileSync(configPath, JSON.stringify(config, null, 2));
const platformFlag = process.platform === 'darwin' ? '--mac' : process.platform === 'win32' ? '--win' : '--linux';
// projectDir = stage (npm, flat node_modules). Using the pnpm app repo as projectDir makes
// electron-builder collect the app's own dependency tree instead of the staged one.
const builderBin = join(appDir, 'node_modules/.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
run(builderBin, [platformFlag, '--config', configPath, '--projectDir', stage], stage);

// 5. macOS: ad-hoc sign the whole bundle so Apple Silicon accepts the modified bundle.
if (process.platform === 'darwin') {
  const distDir = join(outDir, 'dist');
  const macDir = readdirSync(distDir).find((n) => n.startsWith('mac'));
  const app = macDir && join(distDir, macDir, 'euta.app');
  if (!app || !existsSync(app)) throw new Error(`euta.app not found in ${distDir}`);
  run('codesign', ['--force', '--deep', '--sign', '-', app], appDir);
  run('codesign', ['--verify', '--deep', '--strict', app], appDir);
  // The vendor CLI must ship unmodified (CLAUDE.md AI policy): same bytes as the npm package.
  const packedCli = join(app, 'Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai', cliPkg, cliName);
  if (!existsSync(packedCli) || (statSync(packedCli).mode & 0o111) === 0) throw new Error(`bundled CLI not executable in the app: ${packedCli}`);
  if (sha256(packedCli) !== cliHash) throw new Error('bundled Claude Code CLI was modified during packaging (hash mismatch)');
  console.log(`bundled Claude Code CLI unchanged: ${packedCli}`);
  console.log(`\nbuilt: ${app}`);
}
