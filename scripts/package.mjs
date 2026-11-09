// App packaging.
//   pnpm package                                   personal build for this machine (ADR-014): release/dist/<dir>, ad-hoc signed on macOS
//   pnpm release [--mac] [--win] [--linux] [--skip-build]
//                                                  release builds (ADR-042, SPEC 앱-배포-업데이트) into release/<version>/<os>/:
//                                                  mac arm64+x64 dmg/zip + latest-mac.yml · win x64 NSIS + latest.yml · linux x64 AppImage + latest-linux.yml
//
// Why a staging dir: @euta/core, @euta/input-os, @euta/mcp-server and @euta/tc-doc are `link:` deps into the sibling
// euta-engine repo, whose own deps live in that repo's pnpm store. electron-builder would not see them. So we
// `pnpm pack` the engine packages, install them with npm into a flat staging node_modules together with the
// runtime externals, and package that. One stage per target OS: the bundled Claude Code CLI is a per-platform
// package, and Linux needs node-pty compiled in Docker (no linux prebuild).
//
// macOS signing: ad-hoc by default (afterPack hook). EUTA_MAC_SIGN=developer-id switches to Developer ID signing
// (identity from CSC_LINK/CSC_NAME or the keychain) + hardened runtime, and notarization when APPLE_API_KEY or
// APPLE_ID is set — electron-builder's own env. The app reads the result (stage package.json `eutaBuild`) to
// pick its update path.
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_NAME, channelOf, isReleaseFile, releaseNotes } from './lib/release-info.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = resolve(appDir, '../euta-engine');
const args = process.argv.slice(2);
const release = args.includes('--release');
const skipBuild = args.includes('--skip-build');
const DOCKER_IMAGE = process.env.EUTA_BUILDER_IMAGE || 'electronuserland/builder:wine';

function run(cmd, cmdArgs, cwd, env) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}   (${cwd})`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32', ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (exit ${r.status})`);
}

const appPkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
// The exact version installed here (package.json only holds ranges — the lockfile pins them): the stage installs
// exactly these, so a release is what was tested (and playwright matches the engine and the browser cache).
const installed = (name) => {
  const f = join(appDir, 'node_modules', name, 'package.json');
  if (!existsSync(f)) throw new Error(`${name} is not installed in ${appDir} — run pnpm install`);
  return JSON.parse(readFileSync(f, 'utf8')).version;
};
const playwrightVersion = installed('playwright');
const sdkVersion = installed('@anthropic-ai/claude-agent-sdk');
const electronPkgDir = join(appDir, 'node_modules/electron');
const electronVersion = installed('electron');

const OS = {
  mac: { platform: 'darwin', archs: ['arm64', 'x64'], flag: '--mac' },
  win: { platform: 'win32', archs: ['x64'], flag: '--win' },
  linux: { platform: 'linux', archs: ['x64'], flag: '--linux' },
};
const hostOs = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const picked = ['mac', 'win', 'linux'].filter((o) => args.includes(`--${o}`));
const targets = release ? (picked.length ? picked : ['mac', 'win', 'linux']) : [hostOs];
if (release && process.platform !== 'darwin') throw new Error('release builds run on macOS (they cross-build Windows and Linux)');

const macSign = release && process.env.EUTA_MAC_SIGN === 'developer-id' ? 'developer-id' : 'adhoc';
const version = appPkg.version;
const channel = channelOf(version);
const notes = release ? releaseNotes(appDir, version) : undefined;
if (release && !notes) throw new Error(`RELEASES.md has no "## ${version}" section — write the release notes first`);
// EUTA_PACKAGE_OUT (personal): output folder (default ./release), so a test build can sit next to a running euta.app.
const outDir = resolve(appDir, release ? 'release' : process.env.EUTA_PACKAGE_OUT || 'release');

const cliPkg = (platform, arch) => `claude-agent-sdk-${platform}-${arch}`;
const cliName = (platform) => (platform === 'win32' ? 'claude.exe' : 'claude');
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

// 1. Build engine and app.
if (!existsSync(engineDir)) throw new Error(`engine repo not found: ${engineDir}`);
if (!skipBuild) {
  run('pnpm', ['-r', 'build'], engineDir);
  run('pnpm', ['exec', 'electron-vite', 'build'], appDir);
}

// 2. Engine tarballs, packed once for every target.
const vendorAll = join(outDir, 'vendor');
rmSync(vendorAll, { recursive: true, force: true });
mkdirSync(vendorAll, { recursive: true });
for (const pkg of ['core', 'input-os', 'mcp-server', 'tc-doc']) run('pnpm', ['pack', '--pack-destination', vendorAll], join(engineDir, 'packages', pkg));
const tgz = (prefix) => {
  const f = readdirSync(vendorAll).find((n) => n.startsWith(prefix) && n.endsWith('.tgz'));
  if (!f) throw new Error(`packed tarball ${prefix}*.tgz not found`);
  return `file:vendor/${f}`;
};

const built = targets.map((os) => packageTarget(os));
if (release) {
  console.log('\nrelease artifacts:');
  for (const b of built) for (const f of b.files) console.log(`  ${(statSync(f).size / 1024 / 1024).toFixed(1).padStart(8)} MB  ${f}`);
}

function packageTarget(os) {
  const { platform, flag } = OS[os];
  const archs = release ? OS[os].archs : [process.arch];
  const stage = join(outDir, release ? `stage-${os}` : 'stage');
  const distDir = release ? join(outDir, version, os) : join(outDir, 'dist');
  console.log(`\n=== ${os} ${archs.join('+')} → ${distDir}`);

  // Fresh staging dir with the built app and the packed engine packages.
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(join(appDir, 'out'), join(stage, 'out'), { recursive: true });
  cpSync(vendorAll, join(stage, 'vendor'), { recursive: true });
  writeFileSync(
    join(stage, 'package.json'),
    JSON.stringify(
      {
        name: 'euta-app',
        productName: 'euta',
        version,
        description: appPkg.description,
        author: 'euta',
        type: 'module',
        main: './out/main/index.js',
        private: true,
        // Every runtime dependency of the app (package.json "dependencies") at its installed version, engine `link:`
        // packages replaced by their packed tarballs, plus playwright (dev dep, loaded at run time by the engine).
        // AI chat (ADR-015): the Agent SDK pulls the target platform's CLI package (optional dependency, same version).
        dependencies: {
          ...Object.fromEntries(
            Object.entries(appPkg.dependencies ?? {}).map(([name, v]) => [name, String(v).startsWith('link:') ? tgz(`${name.replace(/^@/, '').replace('/', '-')}-`) : installed(name)]),
          ),
          playwright: playwrightVersion,
        },
        // input-os / mcp-server / tc-doc depend on sibling engine packages by version; point them at the same tarballs.
        // playwright: the engine tarballs ask for a range — hold every copy to the installed version.
        overrides: { '@euta/core': '$@euta/core', '@euta/input-os': '$@euta/input-os', playwright: playwrightVersion },
        // Read by the app's updater (src/main/updater): how this build is signed decides the update path.
        eutaBuild: { channel, ...(platform === 'darwin' ? { macSignature: macSign } : {}) },
      },
      null,
      2,
    ),
  );

  // 3. Flat production node_modules (real files, no symlinks) for the target platform.
  const npmArgs = ['install', '--omit=dev', '--no-audit', '--no-fund', `--os=${platform}`, `--cpu=${archs[0]}`, ...(platform === 'linux' ? ['--libc=glibc'] : [])];
  if (platform === 'linux' && process.platform !== 'linux') {
    // node-pty has no linux prebuild: npm compiles it (node-gyp, N-API) inside a linux/amd64 container against the
    // Electron headers. robotjs ships a linux-x64 prebuild. The npm cache stays on the host between builds.
    const cache = join(homedir(), '.cache/euta-release/npm-linux');
    mkdirSync(cache, { recursive: true });
    run('docker', [
      'run', '--rm', '--platform', 'linux/amd64',
      '-v', `${stage}:/stage`, '-v', `${cache}:/npm-cache`, '-w', '/stage',
      '-e', 'npm_config_cache=/npm-cache', '-e', 'npm_config_runtime=electron', '-e', `npm_config_target=${electronVersion}`,
      '-e', 'npm_config_disturl=https://electronjs.org/headers',
      DOCKER_IMAGE, 'npm', ...npmArgs,
    ], appDir);
    const pty = join(stage, 'node_modules/node-pty/build/Release/pty.node');
    if (!existsSync(pty)) throw new Error(`node-pty was not compiled for linux: ${pty} missing`);
  } else {
    run('npm', npmArgs, stage);
  }
  // A mac release carries both arches in one electron-builder run (one latest-mac.yml): add the other arch's CLI
  // package (same version as the SDK), unpacked from its npm tarball; the files patterns keep one CLI per arch.
  for (const arch of archs.slice(1)) {
    const name = `@anthropic-ai/${cliPkg(platform, arch)}`;
    const dest = join(stage, 'node_modules', name);
    if (existsSync(dest)) continue;
    const tmp = join(stage, '.extra');
    mkdirSync(tmp, { recursive: true });
    run('npm', ['pack', `${name}@${sdkVersion}`, '--pack-destination', tmp], stage);
    const file = readdirSync(tmp).find((n) => n.endsWith('.tgz'));
    mkdirSync(dest, { recursive: true });
    run('tar', ['-xzf', join(tmp, file), '-C', dest, '--strip-components=1'], stage);
    rmSync(tmp, { recursive: true, force: true });
  }

  importGuard(stage);

  // node-pty prebuilds can lose the exec bit on spawn-helper (see postinstall.mjs).
  const prebuilds = join(stage, 'node_modules/node-pty/prebuilds');
  for (const d of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
    const helper = join(prebuilds, d, 'spawn-helper');
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  }

  // The SDK's bundled Claude Code CLI must be a real executable file outside the asar, one per arch.
  const cliHash = {};
  for (const arch of archs) {
    const staged = join(stage, 'node_modules/@anthropic-ai', cliPkg(platform, arch), cliName(platform));
    if (!existsSync(staged)) throw new Error(`bundled Claude Code CLI missing: ${staged}`);
    const pkgVersion = JSON.parse(readFileSync(join(dirname(staged), 'package.json'), 'utf8')).version;
    if (pkgVersion !== sdkVersion) throw new Error(`CLI package ${cliPkg(platform, arch)} ${pkgVersion} ≠ Agent SDK ${sdkVersion}`);
    if (platform !== 'win32' && (statSync(staged).mode & 0o111) === 0) chmodSync(staged, 0o755);
    cliHash[arch] = sha256(staged);
  }

  // 4. electron-builder. Native addons: node-pty / robotjs N-API prebuilds (linux: compiled above), no rebuild;
  //    node:sqlite is built in (ADR-010/013). Personal builds use the local Electron (no download); release
  //    builds let electron-builder fetch each target's Electron zip (cached).
  const configPath = join(outDir, `electron-builder.${os}.json`);
  writeFileSync(configPath, JSON.stringify(builderConfig({ platform, archs, distDir }), null, 2));
  rmSync(distDir, { recursive: true, force: true });
  const builderBin = join(appDir, 'node_modules/.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  // projectDir = stage (npm, flat node_modules). Using the pnpm app repo as projectDir makes electron-builder
  // collect the app's own dependency tree instead of the staged one.
  run(builderBin, [flag, ...archs.map((a) => `--${a}`), '--config', configPath, '--projectDir', stage, '--publish', 'never'], stage, {
    // Developer ID is opt-in: never let electron-builder pick a keychain identity for an ad-hoc build.
    ...(platform === 'darwin' && macSign !== 'developer-id' ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : {}),
  });

  // 5. Check the packed apps: signature (mac), the vendor CLI unmodified (CLAUDE.md AI policy: same bytes as the
  //    npm package) and only this arch's CLI inside.
  for (const arch of archs) {
    const unpacked = unpackedDir(distDir, platform, arch);
    const resources = platform === 'darwin' ? join(unpacked, 'euta.app/Contents/Resources') : join(unpacked, 'resources');
    if (platform === 'darwin') run('codesign', ['--verify', '--deep', '--strict', join(unpacked, 'euta.app')], appDir);
    const nm = join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai');
    const packedCli = join(nm, cliPkg(platform, arch), cliName(platform));
    if (!existsSync(packedCli) || (platform !== 'win32' && (statSync(packedCli).mode & 0o111) === 0)) throw new Error(`bundled CLI not executable in the app: ${packedCli}`);
    if (sha256(packedCli) !== cliHash[arch]) throw new Error(`bundled Claude Code CLI was modified during packaging (hash mismatch): ${packedCli}`);
    const others = readdirSync(nm).filter((n) => n.startsWith('claude-agent-sdk-') && n !== cliPkg(platform, arch));
    if (others.length) throw new Error(`other platforms' CLI packages in the ${arch} app: ${others.join(', ')}`);
    console.log(`bundled Claude Code CLI unchanged: ${packedCli}`);
  }

  if (!release) {
    if (platform === 'darwin') console.log(`\nbuilt: ${join(unpackedDir(distDir, platform, archs[0]), 'euta.app')}`);
    return { os, distDir, files: [] };
  }
  const meta = { mac: 'latest-mac.yml', win: 'latest.yml', linux: 'latest-linux.yml' }[os];
  if (!existsSync(join(distDir, meta))) throw new Error(`${meta} missing in ${distDir}`);
  const yml = readFileSync(join(distDir, meta), 'utf8');
  for (const arch of archs) if (!yml.includes(`-${os}-${arch}.`)) throw new Error(`${meta} lists no ${os}-${arch} file`);
  return { os, distDir, files: readdirSync(distDir).filter(isReleaseFile).map((n) => join(distDir, n)) };
}

/** electron-builder's unpacked app folder for one arch. */
function unpackedDir(distDir, platform, arch) {
  if (platform === 'darwin') return join(distDir, arch === 'arm64' ? 'mac-arm64' : 'mac');
  return join(distDir, `${platform === 'win32' ? 'win' : 'linux'}${arch === 'x64' ? '' : `-${arch}`}-unpacked`);
}

function builderConfig({ platform, archs, distDir }) {
  const one = `${platform}-\${arch}`; // electron-builder expands ${arch} per arch
  const devId = platform === 'darwin' && macSign === 'developer-id';
  return {
    appId: 'dev.euta.app',
    productName: 'euta',
    electronVersion,
    ...(release ? {} : { electronDist: join(electronPkgDir, 'dist') }),
    npmRebuild: false,
    // Absolute: projectDir is the stage, so the app repo's build/ is not auto-discovered (ADR-027).
    icon: join(appDir, platform === 'darwin' ? 'build/icon.svg' : 'build/icon.png'),
    directories: { output: distDir },
    files: [
      'out/**',
      'node_modules/**',
      'package.json',
      // Only this target's native prebuilds and Claude Code CLI.
      `!node_modules/@anthropic-ai/claude-agent-sdk-!(${one})/**`,
      `!node_modules/node-pty/prebuilds/!(${one})/**`,
      `!node_modules/robotjs/prebuilds/!(${one})/**`,
    ],
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
    ...(release
      ? {
          artifactName: ARTIFACT_NAME,
          // The file name stays latest*.yml: the channel is in the cloud feed URL (/updates/<channel>/), and GitHub
          // has one stream (the newest release). The app picks the feed at each check (ADR-047) — this publish
          // entry only fills the built-in app-update.yml.
          detectUpdateChannel: false,
          publish: [{ provider: 'github', owner: 'onedark23', repo: 'euta-app' }],
          releaseInfo: { releaseNotes: notes },
        }
      : {}),
    // Ad-hoc signature for the whole bundle before dmg/zip are made (Apple Silicon refuses a modified bundle).
    ...(platform === 'darwin' && !devId ? { afterPack: join(appDir, 'scripts/adhoc-sign.cjs') } : {}),
    mac: {
      target: release ? [{ target: 'dmg', arch: archs }, { target: 'zip', arch: archs }] : [{ target: 'dir' }],
      category: 'public.app-category.developer-tools',
      ...(devId
        ? {
            hardenedRuntime: true,
            entitlements: join(appDir, 'build/entitlements.mac.plist'),
            entitlementsInherit: join(appDir, 'build/entitlements.mac.plist'),
            // The bundled Claude Code CLI keeps Anthropic's own signature (vendor binary, never modified).
            signIgnore: ['claude-agent-sdk-darwin-[^/]+/claude$'],
            notarize: !!(process.env.APPLE_API_KEY || process.env.APPLE_ID),
            ...(process.env.EUTA_MAC_IDENTITY ? { identity: process.env.EUTA_MAC_IDENTITY } : {}),
          }
        : { identity: null, hardenedRuntime: false }),
    },
    dmg: { sign: false },
    win: { target: release ? [{ target: 'nsis', arch: archs }] : [{ target: 'dir' }] },
    // Per-user install, no admin prompt; electron-updater installs updates the same way.
    nsis: { oneClick: true, perMachine: false, artifactName: ARTIFACT_NAME },
    linux: {
      target: release ? [{ target: 'AppImage', arch: archs }] : [{ target: 'dir' }],
      category: 'Development',
      executableName: 'euta',
      synopsis: 'End-user test automation',
    },
    // AppImage spells the arch "x86_64"; the release file names say x64 (server classification, app, upload — ADR-041).
    // Only x64 is built for Linux.
    appImage: { artifactName: 'euta-${version}-linux-x64.${ext}' },
  };
}

/**
 * Every bare package the built main process imports must be installed in the stage (a missing one only
 * shows up as ERR_MODULE_NOT_FOUND when the packaged app starts). Runs for personal and release builds.
 */
function importGuard(stage) {
  const builtins = new Set(builtinModules);
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
