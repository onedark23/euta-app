// Publish a release build to GitHub Releases (SPEC 앱-배포-업데이트 "업데이트 원본", ADR-047) with the GitHub CLI.
//
//   pnpm release:github [--mac] [--win] [--linux] [--publish] [--version <v>] [--dir <release/<v>>] [--repo <owner/name>]
//
// 1. Release app-v<version> as a draft (created when missing; notes = the RELEASES.md section).
// 2. Upload the installers / update files / latest*.yml of release/<version>/<os>/ (--clobber: a re-run replaces them;
//    platforms may go up in separate runs, like release:upload).
// 3. --publish: draft → published, marked latest and NOT a prerelease — apps read
//    https://github.com/<repo>/releases/latest/download/latest*.yml, which skips prereleases (the channel is the version's
//    prerelease name instead).
//
// Auth is the GitHub CLI's (gh auth status — the account that owns the repo). No token is read or printed here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { notesFor } from './lib/release-info.mjs';
import { releaseFiles } from './release-upload.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OSES = ['mac', 'win', 'linux'];
export const DEFAULT_REPO = 'onedark23/euta-app';

/** The gh command lines for one run (pure — tested). `exists`: the release is already there. */
export function ghPlan({ repo, version, notesFile, files, publish, exists }) {
  const tag = `app-v${version}`;
  const steps = [];
  if (!exists) steps.push(['release', 'create', tag, '--repo', repo, '--draft', '--title', `euta ${version}`, '--notes-file', notesFile]);
  if (files.length) steps.push(['release', 'upload', tag, ...files, '--repo', repo, '--clobber']);
  if (publish) steps.push(['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease=false', '--latest']);
  return steps;
}

function gh(args, { quiet = false } = {}) {
  const r = spawnSync('gh', args, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (r.error) throw new Error(`gh 를 실행하지 못했습니다(GitHub CLI 설치 · 로그인 확인): ${r.error.message}`);
  return r.status ?? 1;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const version = opt('version') ?? JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
  const repo = opt('repo') ?? DEFAULT_REPO;
  const dir = resolve(appDir, opt('dir') ?? join('release', version));
  const picked = OSES.filter((o) => args.includes(`--${o}`));
  const files = releaseFiles(dir, picked.length ? picked : OSES);
  const publish = args.includes('--publish');
  if (!files.length && !publish) throw new Error(`올릴 파일이 없습니다: ${dir}/{mac,win,linux} — 먼저 pnpm release`);
  const notes = notesFor(version, readFileSync(join(appDir, 'RELEASES.md'), 'utf8'));
  if (!notes) throw new Error(`RELEASES.md 에 "## ${version}" 이 없습니다`);
  const tmp = mkdtempSync(join(tmpdir(), 'euta-release-'));
  try {
    const notesFile = join(tmp, 'notes.md');
    writeFileSync(notesFile, `${notes}\n`);
    const exists = gh(['release', 'view', `app-v${version}`, '--repo', repo], { quiet: true }) === 0;
    console.log(`GitHub ${repo} 에 ${version} 올리기 — 파일 ${files.length}개${publish ? ' + 게시' : ''}${exists ? ' (이미 있는 릴리스에 추가)' : ''}`);
    for (const step of ghPlan({ repo, version, notesFile, files, publish, exists })) {
      if (gh(step) !== 0) throw new Error(`gh ${step.slice(0, 2).join(' ')} 실패`);
    }
    console.log(publish ? `게시함 — https://github.com/${repo}/releases/tag/app-v${version}` : '올림 — 아직 초안(draft)입니다. 다른 플랫폼도 올린 뒤 --publish 로 게시하세요.');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`release:github: ${e.message}`);
    process.exit(1);
  });
}
