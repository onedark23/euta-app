// Where app updates come from (SPEC 앱-배포-업데이트 "업데이트 원본", ADR-047): the euta cloud server this app is
// connected to when it distributes updates (`GET /api/config` → `appUpdates: true`), GitHub Releases otherwise.
// Resolved before every check. A cloud server that cannot be reached is an error for that check — never a
// silent switch to GitHub (the organization's versions and minimum app version must not get mixed up).
import type { FetchLike } from './updater.js';

export const GITHUB_REPO = 'onedark23/euta-app';
/** GitHub redirects `releases/latest/download/<name>` to the newest non-prerelease release — no API, no rate limit. */
export const GITHUB_FEED = `https://github.com/${GITHUB_REPO}/releases/latest/download/`;

export interface UpdateSource {
  kind: 'github' | 'cloud';
  /** Shown in 앱 설정: "GitHub Releases" or the server address. */
  label: string;
  /** electron-updater generic feed base (ends with "/"): latest*.yml and the files live here. */
  feedUrl: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

export const githubSource = (): UpdateSource => ({ kind: 'github', label: 'GitHub Releases', feedUrl: GITHUB_FEED });

export async function resolveUpdateSource(o: { serverUrl: string | undefined; channel: string; version: string; fetch: FetchLike }): Promise<UpdateSource> {
  const server = o.serverUrl?.trim().replace(/\/+$/, '');
  if (!server) return githubSource();
  const res = await o.fetch(`${server}/api/config`, {
    headers: { accept: 'application/json', 'x-euta-app-version': o.version },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${server}: HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { appUpdates?: unknown };
  // A server without the field (older) or without a published release → GitHub.
  if (body.appUpdates !== true) return githubSource();
  return { kind: 'cloud', label: server, feedUrl: `${server}/updates/${encodeURIComponent(o.channel)}/` };
}
