// Shared by the release build (scripts/package.mjs) and the upload (scripts/release-upload.mjs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Release channel = the version's prerelease name (`0.1.0-alpha.3` → alpha, none → stable). */
export function channelOf(version) {
  const m = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(String(version));
  return m ? m[1].replace(/-.*$/, '').toLowerCase() : 'stable';
}

/** The "## <version>" section of RELEASES.md (trimmed), or undefined. */
export function notesFor(version, markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || undefined;
}

export function releaseNotes(appDir, version) {
  return notesFor(version, readFileSync(join(appDir, 'RELEASES.md'), 'utf8'));
}

/** Release artifact names (electron-builder `artifactName`): euta-<version>-<mac|win|linux>-<arm64|x64>.<ext>. */
export const ARTIFACT_NAME = 'euta-${version}-${os}-${arch}.${ext}';

/** Files of a release build folder that go to the update server (installers, update files, metadata). */
export function isReleaseFile(name) {
  return /^latest(-mac|-linux)?\.yml$/.test(name) || /^euta-[0-9A-Za-z.+-]+-(mac|win|linux)-(arm64|x64)\.(dmg|zip|exe|AppImage)(\.blockmap)?$/.test(name);
}
