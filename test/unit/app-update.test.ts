// App updates (SPEC 앱-배포-업데이트, ADR-042): channel from the version, prerelease-aware compare, which
// update path a build takes (signed vs ad-hoc), the updater state machine against a fake backend / fake
// releases API, the cloud client's version header and 426 parsing, and the release-notes helper.
import { describe, expect, it } from 'vitest';
import { channelOf, compareVersions, filesFromMeta, metaFileOf, pickInstaller, updateMode, type ReleaseDto } from '../../src/shared/app-version.js';
import { AppUpdater, notesText, type UpdaterBackend } from '../../src/main/updater.js';
import { GITHUB_FEED, githubSource, resolveUpdateSource, type UpdateSource } from '../../src/main/update-source.js';
import { CloudClient, isAppTooOld, minVersionOf } from '../../src/main/cloud/client.js';
import type { BusyWork, UpdateView } from '../../src/shared/types.js';
// @ts-expect-error — plain ESM build script, no types
import { channelOf as scriptChannelOf, isReleaseFile, notesFor } from '../../scripts/lib/release-info.mjs';
// @ts-expect-error — plain ESM build script, no types
import { ghPlan } from '../../scripts/release-github.mjs';

describe('version rules', () => {
  it('channel = prerelease name', () => {
    expect(channelOf('0.1.0-alpha.1')).toBe('alpha');
    expect(channelOf('0.2.0-beta.3')).toBe('beta');
    expect(channelOf('1.0.0')).toBe('stable');
    expect(channelOf('1.0.0-rc')).toBe('rc');
    // The build script uses the same rule (it names the update URL).
    for (const v of ['0.1.0-alpha.1', '0.2.0-beta.3', '1.0.0']) expect(scriptChannelOf(v)).toBe(channelOf(v));
  });

  it('compares SemVer with prerelease identifiers', () => {
    const asc = ['0.1.0-alpha.1', '0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta', '0.1.0-beta.1', '0.1.0', '0.1.1-alpha.1', '0.2.0-alpha.1', '1.0.0'];
    for (let i = 0; i < asc.length - 1; i++) {
      expect(compareVersions(asc[i]!, asc[i + 1]!), `${asc[i]} < ${asc[i + 1]}`).toBeLessThan(0);
      expect(compareVersions(asc[i + 1]!, asc[i]!)).toBeGreaterThan(0);
    }
    expect(compareVersions('0.1.0-alpha.1', '0.1.0-alpha.1+build.5')).toBe(0);
    expect(() => compareVersions('latest', '0.1.0')).toThrow();
  });

  it('update path: signed vs ad-hoc mac, Windows, Linux AppImage, development', () => {
    expect(updateMode({ platform: 'darwin', packaged: true, macSignature: 'adhoc' })).toBe('manual');
    expect(updateMode({ platform: 'darwin', packaged: true })).toBe('manual'); // unknown = ad-hoc
    expect(updateMode({ platform: 'darwin', packaged: true, macSignature: 'developer-id' })).toBe('auto');
    expect(updateMode({ platform: 'win32', packaged: true })).toBe('auto');
    expect(updateMode({ platform: 'linux', packaged: true, appImage: true })).toBe('auto');
    expect(updateMode({ platform: 'linux', packaged: true, appImage: false })).toBe('manual');
    expect(updateMode({ platform: 'darwin', packaged: false, macSignature: 'developer-id' })).toBe('off');
  });

  it('picks this machine’s installer from a release', () => {
    const f = (platform: 'mac' | 'win' | 'linux', arch: 'arm64' | 'x64', kind: 'installer' | 'update' | 'meta', name: string) => ({ platform, arch, kind, name, size: 1, url: `/updates/alpha/${name}` });
    const rel: ReleaseDto = {
      version: '0.1.0-alpha.2',
      publishedAt: '',
      notes: '',
      files: [f('mac', 'arm64', 'update', 'euta-0.1.0-alpha.2-mac-arm64.zip'), f('mac', 'arm64', 'installer', 'euta-0.1.0-alpha.2-mac-arm64.dmg'), f('mac', 'x64', 'installer', 'euta-0.1.0-alpha.2-mac-x64.dmg'), f('win', 'x64', 'installer', 'euta-0.1.0-alpha.2-win-x64.exe')],
    };
    expect(pickInstaller(rel, 'darwin', 'arm64')?.name).toBe('euta-0.1.0-alpha.2-mac-arm64.dmg');
    expect(pickInstaller(rel, 'darwin', 'x64')?.name).toBe('euta-0.1.0-alpha.2-mac-x64.dmg');
    expect(pickInstaller(rel, 'win32', 'x64')?.name).toBe('euta-0.1.0-alpha.2-win-x64.exe');
    expect(pickInstaller(rel, 'linux', 'x64')).toBeUndefined();
    expect(pickInstaller({ ...rel, files: rel.files.filter((x) => x.arch === 'x64') }, 'darwin', 'arm64')?.name).toBe('euta-0.1.0-alpha.2-mac-x64.dmg');
  });

  it('release notes section and release file names (build/upload scripts)', () => {
    const md = '# notes\n\n## 0.1.0-alpha.2\n\n- 둘째\n- 고침\n\n## 0.1.0-alpha.1\n\n- 첫 배포\n';
    expect(notesFor('0.1.0-alpha.2', md)).toBe('- 둘째\n- 고침');
    expect(notesFor('0.1.0-alpha.1', md)).toBe('- 첫 배포');
    expect(notesFor('0.1.0-alpha.3', md)).toBeUndefined();
    for (const n of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'euta-0.1.0-alpha.1-mac-arm64.dmg', 'euta-0.1.0-alpha.1-mac-arm64.zip', 'euta-0.1.0-alpha.1-mac-arm64.zip.blockmap', 'euta-0.1.0-alpha.1-win-x64.exe', 'euta-0.1.0-alpha.1-linux-x64.AppImage']) expect(isReleaseFile(n), n).toBe(true);
    for (const n of ['builder-debug.yml', 'builder-effective-config.yaml', 'mac-arm64', 'win-unpacked', 'euta-0.1.0-alpha.1-win-x64.exe.__uninstaller.exe']) expect(isReleaseFile(n), n).toBe(false);
  });

  it('electron-updater release notes → text', () => {
    expect(notesText(' - a\n')).toBe('- a');
    expect(notesText([{ version: '1', note: 'x' }, { version: '0', note: 'y' }])).toBe('x\n\ny');
    expect(notesText(null)).toBeUndefined();
  });
});

const idle: BusyWork = { runs: 0, recording: false, chats: 0 };

const CLOUD: UpdateSource = { kind: 'cloud', label: 'https://euta.example', feedUrl: 'https://euta.example/updates/alpha/' };

function makeUpdater(o: { mode: 'auto' | 'manual'; backend?: UpdaterBackend; fetch?: (url: string, init: RequestInit) => Promise<Response>; busy?: () => BusyWork; platform?: string; arch?: string; source?: () => Promise<UpdateSource> }) {
  const emitted: UpdateView[] = [];
  const opened: string[] = [];
  const u = new AppUpdater({
    version: '0.1.0-alpha.1',
    channel: 'alpha',
    mode: o.mode,
    platform: o.platform ?? 'darwin',
    arch: o.arch ?? 'arm64',
    source: o.source ?? (async () => CLOUD),
    ...(o.backend ? { backend: o.backend } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    busy: o.busy ?? (() => idle),
    emit: (v) => emitted.push(v),
    openExternal: (url) => opened.push(url),
    now: () => new Date('2026-10-30T09:00:00Z'),
  });
  return { u, emitted, opened };
}

function fakeBackend(version: string | null, opts: { failDownload?: boolean } = {}) {
  const calls = { check: 0, download: 0, install: 0, feeds: [] as string[] };
  const b: UpdaterBackend = {
    setFeed: (url) => void calls.feeds.push(url),
    check: async () => {
      calls.check++;
      return version ? { version, notes: '- 고침' } : null;
    },
    download: async () => {
      calls.download++;
      if (opts.failDownload) throw new Error('sha512 checksum mismatch');
    },
    install: () => void calls.install++,
  };
  return { b, calls };
}

describe('AppUpdater', () => {
  it('auto: newer version → download in the background → "준비됨"; restart installs only on request', async () => {
    const { b, calls } = fakeBackend('0.1.0-alpha.2');
    const { u, emitted } = makeUpdater({ mode: 'auto', backend: b });
    const v = await u.check();
    expect(v.available).toEqual({ version: '0.1.0-alpha.2', notes: '- 고침', ready: true });
    expect(v.lastCheck).toEqual({ at: '2026-10-30T09:00:00.000Z', result: 'available' });
    expect(emitted.some((e) => e.available && !e.available.ready)).toBe(true); // downloading first
    expect(calls).toMatchObject({ check: 1, download: 1, install: 0 });
    expect(calls.feeds).toEqual(['https://euta.example/updates/alpha/']);
    expect(v.source).toBe('https://euta.example');
    // Same version again: no second download.
    await u.check();
    expect(calls.download).toBe(1);
    expect(u.restart()).toEqual({ restarting: true });
    expect(calls.install).toBe(1);
  });

  it('auto: no newer version / same version / download failure are quiet', async () => {
    const same = makeUpdater({ mode: 'auto', backend: fakeBackend('0.1.0-alpha.1').b });
    expect((await same.u.check()).lastCheck?.result).toBe('latest');
    const none = makeUpdater({ mode: 'auto', backend: fakeBackend(null).b });
    expect((await none.u.check()).available).toBeUndefined();
    const fail = makeUpdater({ mode: 'auto', backend: fakeBackend('0.1.0-alpha.2', { failDownload: true }).b });
    const v = await fail.u.check();
    expect(v.lastCheck).toMatchObject({ result: 'error', message: 'sha512 checksum mismatch' });
    expect(v.available?.ready).toBe(false);
    expect(() => fail.u.restart()).toThrow(/no update ready/);
  });

  it('busy work: restart asks first; "끊고 업데이트" forces; "끝나면 업데이트" waits, then asks again (no auto restart)', async () => {
    let busy: BusyWork = { runs: 2, recording: true, chats: 1 };
    const { b, calls } = fakeBackend('0.1.0-alpha.2');
    const { u } = makeUpdater({ mode: 'auto', backend: b, busy: () => busy });
    await u.check();
    expect(u.restart()).toEqual({ restarting: false, busy: { runs: 2, recording: true, chats: 1 } });
    expect(calls.install).toBe(0);
    expect(u.restartWhenIdle().waiting).toBe(true);
    busy = idle;
    await new Promise((r) => setTimeout(r, 3_300));
    expect(u.state().waiting).toBeUndefined();
    expect(calls.install).toBe(0); // the notice asks again; nothing restarts by itself
    busy = { runs: 1, recording: false, chats: 0 };
    expect(u.restart(true)).toEqual({ restarting: true });
    expect(calls.install).toBe(1);
    u.dispose();
  });

  it('manual (ad-hoc Mac): the feed’s latest-mac.yml → notice with this Mac’s dmg; [내려받기] opens it', async () => {
    const urls: string[] = [];
    const headers: Record<string, string>[] = [];
    let yml = [
      'version: 0.1.0-alpha.3',
      'files:',
      '  - url: euta-0.1.0-alpha.3-mac-arm64.zip',
      '    sha512: x',
      '  - url: euta-0.1.0-alpha.3-mac-x64.zip',
      '    sha512: x',
      '  - url: euta-0.1.0-alpha.3-mac-x64.dmg',
      '    sha512: x',
      'path: euta-0.1.0-alpha.3-mac-arm64.zip',
      'releaseNotes: |-',
      '  - 셋째',
      '',
    ].join('\n');
    const fetch = async (url: string, init: RequestInit) => {
      urls.push(url);
      headers.push(init.headers as Record<string, string>);
      return new Response(yml, { status: 200 });
    };
    const { u, opened } = makeUpdater({ mode: 'manual', fetch });
    const v = await u.check();
    expect(urls).toEqual(['https://euta.example/updates/alpha/latest-mac.yml']);
    expect(headers[0]!['x-euta-app-version']).toBe('0.1.0-alpha.1');
    // arm64 dmg is not listed: it sits next to its zip (the build always makes both).
    expect(v.available).toEqual({ version: '0.1.0-alpha.3', notes: '- 셋째', ready: false, downloadUrl: 'https://euta.example/updates/alpha/euta-0.1.0-alpha.3-mac-arm64.dmg' });
    expect(v.source).toBe('https://euta.example');
    expect(u.openDownload()).toBe(true);
    expect(opened).toEqual(['https://euta.example/updates/alpha/euta-0.1.0-alpha.3-mac-arm64.dmg']);
    expect(() => u.restart()).toThrow(); // manual builds never self-install
    // GitHub: the same file under releases/latest/download/.
    const gh = makeUpdater({ mode: 'manual', fetch, arch: 'x64', source: async () => githubSource() });
    expect((await gh.u.check()).available?.downloadUrl).toBe(`${GITHUB_FEED}euta-0.1.0-alpha.3-mac-x64.dmg`);
    expect(urls.at(-1)).toBe(`${GITHUB_FEED}latest-mac.yml`);
    // Same version → nothing offered.
    yml = 'version: 0.1.0-alpha.1\nfiles: []\n';
    expect((await makeUpdater({ mode: 'manual', fetch }).u.check()).available).toBeUndefined();
    // Feed down → quiet error, nothing offered.
    const down = makeUpdater({ mode: 'manual', fetch: async () => new Response('', { status: 503 }) });
    expect((await down.u.check()).lastCheck).toMatchObject({ result: 'error', message: 'latest-mac.yml: HTTP 503' });
  });

  it('source is resolved on every check; a source failure is a quiet error (no switch)', async () => {
    const { b, calls } = fakeBackend('0.1.0-alpha.2');
    let src: UpdateSource | Error = CLOUD;
    const { u } = makeUpdater({ mode: 'auto', backend: b, source: async () => { if (src instanceof Error) throw src; return src; } });
    await u.check();
    src = githubSource();
    expect((await u.check()).source).toBe('GitHub Releases');
    expect(calls.feeds).toEqual(['https://euta.example/updates/alpha/', GITHUB_FEED]);
    src = new Error('https://euta.example: HTTP 502');
    const v = await u.check();
    expect(v.lastCheck).toMatchObject({ result: 'error', message: 'https://euta.example: HTTP 502' });
    expect(calls.check).toBe(2); // the backend was not asked
  });

  it('off (development run): never checks', async () => {
    let called = false;
    const { u } = makeUpdater({ mode: 'auto', backend: { setFeed: () => undefined, check: async () => ((called = true), null), download: async () => undefined, install: () => undefined } });
    const off = new AppUpdater({ version: '0.1.0-alpha.1', channel: 'alpha', mode: 'off', platform: 'darwin', arch: 'arm64', source: async () => githubSource(), busy: () => idle, emit: () => undefined, openExternal: () => undefined });
    expect((await off.check()).lastCheck).toBeUndefined();
    expect(called).toBe(false);
    u.dispose();
  });
});

describe('update source (ADR-047)', () => {
  const answer = (status: number, body: unknown) => async (url: string, init: RequestInit) => {
    seen.push({ url, version: (init.headers as Record<string, string>)['x-euta-app-version'] });
    return new Response(JSON.stringify(body), { status });
  };
  const seen: { url: string; version: string | undefined }[] = [];
  const base = { channel: 'alpha', version: '0.1.0-alpha.1' };

  it('no server → GitHub, without asking anyone', async () => {
    expect(await resolveUpdateSource({ ...base, serverUrl: undefined, fetch: answer(200, {}) })).toEqual(githubSource());
    expect(await resolveUpdateSource({ ...base, serverUrl: '  ', fetch: answer(200, {}) })).toEqual(githubSource());
    expect(seen).toEqual([]);
  });

  it('server distributes updates → its /updates/<channel>/; otherwise (or an older server) → GitHub', async () => {
    expect(await resolveUpdateSource({ ...base, serverUrl: 'https://cloud.example/', fetch: answer(200, { appUpdates: true }) })).toEqual({ kind: 'cloud', label: 'https://cloud.example', feedUrl: 'https://cloud.example/updates/alpha/' });
    expect(seen.at(-1)).toEqual({ url: 'https://cloud.example/api/config', version: '0.1.0-alpha.1' });
    expect(await resolveUpdateSource({ ...base, serverUrl: 'https://cloud.example', fetch: answer(200, { appUpdates: false }) })).toEqual(githubSource());
    expect(await resolveUpdateSource({ ...base, serverUrl: 'https://cloud.example', fetch: answer(200, { signUpMode: 'email' }) })).toEqual(githubSource());
  });

  it('server unreachable or failing → error, never GitHub', async () => {
    await expect(resolveUpdateSource({ ...base, serverUrl: 'https://cloud.example', fetch: answer(503, {}) })).rejects.toThrow('https://cloud.example: HTTP 503');
    await expect(resolveUpdateSource({ ...base, serverUrl: 'https://cloud.example', fetch: async () => { throw new TypeError('fetch failed'); } })).rejects.toThrow('fetch failed');
  });

  it('latest*.yml files → release files (name rule, dmg next to a Mac zip, relative to the feed)', () => {
    expect(metaFileOf('darwin')).toBe('latest-mac.yml');
    expect(metaFileOf('win32')).toBe('latest.yml');
    expect(metaFileOf('linux')).toBe('latest-linux.yml');
    const files = filesFromMeta({ files: [{ url: 'euta-1.0.0-mac-arm64.zip' }, { url: 'euta-1.0.0-linux-x64.AppImage' }, { url: 'other.txt' }, 'bad'] }, GITHUB_FEED);
    expect(files.map((f) => [f.platform, f.arch, f.kind, f.url])).toEqual([
      ['mac', 'arm64', 'update', `${GITHUB_FEED}euta-1.0.0-mac-arm64.zip`],
      ['linux', 'x64', 'installer', `${GITHUB_FEED}euta-1.0.0-linux-x64.AppImage`],
      ['mac', 'arm64', 'installer', `${GITHUB_FEED}euta-1.0.0-mac-arm64.dmg`],
    ]);
    expect(filesFromMeta({}, GITHUB_FEED)).toEqual([]);
  });

  it('release:github plan — draft, upload, then publish as latest and not a prerelease', () => {
    const plan = ghPlan({ repo: 'o/r', version: '0.1.0-alpha.2', notesFile: '/t/n.md', files: ['/r/a.dmg', '/r/latest-mac.yml'], publish: true, exists: false });
    expect(plan).toEqual([
      ['release', 'create', 'app-v0.1.0-alpha.2', '--repo', 'o/r', '--draft', '--title', 'euta 0.1.0-alpha.2', '--notes-file', '/t/n.md'],
      ['release', 'upload', 'app-v0.1.0-alpha.2', '/r/a.dmg', '/r/latest-mac.yml', '--repo', 'o/r', '--clobber'],
      ['release', 'edit', 'app-v0.1.0-alpha.2', '--repo', 'o/r', '--draft=false', '--prerelease=false', '--latest'],
    ]);
    expect(ghPlan({ repo: 'o/r', version: '1.0.0', notesFile: 'n', files: ['/r/x.exe'], publish: false, exists: true })).toEqual([['release', 'upload', 'app-v1.0.0', '/r/x.exe', '--repo', 'o/r', '--clobber']]);
  });
});

describe('cloud client: app version header and 426', () => {
  it('sends X-Euta-App-Version on requests and the SSE connect; parses APP_TOO_OLD', async () => {
    const seen: Record<string, string>[] = [];
    const c = new CloudClient(
      'http://cloud.test',
      () => 'tok',
      async (_url, init) => {
        seen.push(init.headers as Record<string, string>);
        return new Response(JSON.stringify({ code: 'APP_TOO_OLD', minVersion: '0.2.0' }), { status: 426 });
      },
      '0.1.0-alpha.1',
    );
    const e = await c.me().catch((x: unknown) => x);
    expect(isAppTooOld(e)).toBe(true);
    expect(e).toMatchObject({ status: 426, code: 'APP_TOO_OLD' });
    expect(minVersionOf(e as never)).toBe('0.2.0');
    const s = await c
      .events('p', null, new AbortController().signal)
      .next()
      .catch((x: unknown) => x);
    expect(isAppTooOld(s)).toBe(true);
    expect(seen.map((h) => h['x-euta-app-version'])).toEqual(['0.1.0-alpha.1', '0.1.0-alpha.1']);
    expect(seen[1]!.accept).toBe('text/event-stream');
    // The `{ error: {...} }` envelope works too.
    const c2 = new CloudClient('http://cloud.test', () => 'tok', async () => new Response(JSON.stringify({ error: { code: 'APP_TOO_OLD', message: 'old', details: { minVersion: '0.3.0' } } }), { status: 426 }), '0.1.0');
    const e2 = await c2.me().catch((x: unknown) => x);
    expect(minVersionOf(e2 as never)).toBe('0.3.0');
  });
});
