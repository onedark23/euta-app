// App version rules (SPEC 앱-배포-업데이트 · API_CONTRACT 단계 17): channel = prerelease name, SemVer
// precedence with prerelease identifiers. Pure — used by the main process updater and the cloud client.

/** `0.1.0-alpha.3` → alpha, `1.0.0-beta.1` → beta, no prerelease → stable. */
export function channelOf(version: string): string {
  const m = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version.trim());
  return m?.[1] ? m[1].replace(/-.*$/, '').toLowerCase() : 'stable';
}

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

function parse(v: string): Parsed | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

export function isVersion(v: unknown): v is string {
  return typeof v === 'string' && !!parse(v);
}

/**
 * SemVer 2.0 precedence: < 0 when a < b, 0 when equal, > 0 when a > b. A prerelease is lower than its release
 * (`0.1.0-alpha.9` < `0.1.0`); numeric identifiers compare as numbers (`alpha.10` > `alpha.9`). Build metadata
 * is ignored. Throws on a string that is not a version.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`not a version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i]! - pb.core[i]!;
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export type UpdateMode = 'auto' | 'manual' | 'off';

/**
 * How this app updates (SPEC "업데이트 방식"): electron-updater downloads in the background where it can install
 * (Windows NSIS, Linux AppImage, Developer-ID-signed macOS); an ad-hoc-signed Mac or a non-AppImage Linux only
 * learns about the new version and opens the installer download. Development runs do not check.
 */
export function updateMode(o: { platform: string; packaged: boolean; macSignature?: string; appImage?: boolean }): UpdateMode {
  if (!o.packaged) return 'off';
  if (o.platform === 'win32') return 'auto';
  if (o.platform === 'darwin') return o.macSignature === 'developer-id' ? 'auto' : 'manual';
  if (o.platform === 'linux') return o.appImage ? 'auto' : 'manual';
  return 'off';
}

/** One file of a release (`GET /api/app/releases`). */
export interface ReleaseFileDto {
  platform: 'mac' | 'win' | 'linux';
  /** null for the update metadata (latest*.yml). */
  arch: 'arm64' | 'x64' | null;
  kind: 'installer' | 'update' | 'meta';
  name: string;
  size: number;
  url: string;
}

export interface ReleaseDto {
  version: string;
  publishedAt: string;
  notes: string;
  files: ReleaseFileDto[];
}

/** The installer of this machine in a release (an Intel build runs on Apple silicon too, not the other way). */
export function pickInstaller(release: ReleaseDto, platform: string, arch: string): ReleaseFileDto | undefined {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform === 'linux' ? 'linux' : undefined;
  const mine = release.files.filter((f) => f.platform === os && f.kind === 'installer');
  return mine.find((f) => f.arch === arch) ?? (os === 'mac' && arch === 'arm64' ? mine.find((f) => f.arch === 'x64') : undefined);
}

/** electron-updater metadata file of a platform (`latest-mac.yml` · `latest.yml` · `latest-linux.yml`). */
export function metaFileOf(platform: string): string {
  return platform === 'darwin' ? 'latest-mac.yml' : platform === 'win32' ? 'latest.yml' : 'latest-linux.yml';
}

const RELEASE_NAME = /-(mac|win|linux)-(arm64|x64)\.(dmg|exe|AppImage|zip)$/;

/**
 * The files a parsed `latest*.yml` lists (`files[].url`), as release files resolved against the feed (ADR-047 —
 * the notice path reads the same metadata as the updater, from GitHub or a cloud server alike). Platform and
 * arch come from the build's file names (`euta-<version>-<mac|win|linux>-<arm64|x64>.<ext>`). A Mac update zip
 * without its dmg listed gets the dmg next to it (same name, `.dmg`) — the build always makes both.
 */
export function filesFromMeta(meta: { files?: unknown }, feedUrl: string): ReleaseFileDto[] {
  const urls = Array.isArray(meta.files) ? meta.files.map((f) => (f && typeof f === 'object' ? (f as { url?: unknown }).url : undefined)).filter((u): u is string => typeof u === 'string') : [];
  const names = new Set(urls);
  for (const u of urls) if (/-mac-(arm64|x64)\.zip$/.test(u)) names.add(u.replace(/\.zip$/, '.dmg'));
  const out: ReleaseFileDto[] = [];
  for (const u of names) {
    const m = RELEASE_NAME.exec(u);
    if (!m) continue;
    const name = u.split('/').pop()!;
    out.push({ platform: m[1] as ReleaseFileDto['platform'], arch: m[2] as 'arm64' | 'x64', kind: m[3] === 'zip' ? 'update' : 'installer', name, size: 0, url: new URL(u, feedUrl).toString() });
  }
  return out;
}
