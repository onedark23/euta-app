// Upload a release build to euta cloud (API_CONTRACT 단계 17, SPEC 앱-배포-업데이트 "업데이트 배포").
//
//   EUTA_ADMIN_TOKEN=euta_… pnpm release:upload [--mac] [--win] [--linux] [--publish]
//                                               [--version <v>] [--dir <release/<v>>] [--server <url>]
//
// 1. POST /api/admin/app-releases { version, notes }  (draft; notes = the RELEASES.md section)
//    409 VERSION_EXISTS → continue only when that version is still a draft (platforms may go up in separate runs).
// 2. PUT  /api/admin/app-releases/<version>/files/<name>  for each installer / update file / latest*.yml of
//    release/<version>/<os>/ (streamed; size and sha512 checked against the server's answer).
// 3. --publish: POST /api/admin/app-releases/<version>/publish — the channel's latest*.yml switch to this version.
//
// The admin token comes from the environment only and is never printed or logged.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isReleaseFile, notesFor } from './lib/release-info.mjs';

const OSES = ['mac', 'win', 'linux'];

/** One HTTP request; `file` streams a file as the body. Resolves { status, json }. */
function send(server, token, method, path, { json, file } = {}) {
  const url = new URL(path, `${server}/`);
  const body = json !== undefined ? Buffer.from(JSON.stringify(json)) : undefined;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
    ...(file ? { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size } : {}),
  };
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers });
  return new Promise((res, rej) => {
    req.on('response', (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = undefined;
        }
        res({ status: r.statusCode ?? 0, json: parsed });
      });
      r.on('error', rej);
    });
    // Never include the request (headers) in the error: only what went wrong.
    req.on('error', (e) => rej(new Error(`${method} ${url.pathname}: ${e.message}`)));
    if (file) createReadStream(file).on('error', rej).pipe(req);
    else req.end(body);
  });
}

const errText = (r) => {
  const e = r.json?.error ?? r.json;
  return `HTTP ${r.status}${e?.code ? ` ${e.code}` : ''}${e?.message ? ` — ${e.message}` : ''}`;
};

function sha512(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha512');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest()))
      .on('error', rej);
  });
}

/** The release files of release/<version>/<os>/ for the chosen OSes. */
export function releaseFiles(dir, oses = OSES) {
  const out = [];
  for (const os of oses) {
    const d = join(dir, os);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d).sort()) if (isReleaseFile(n) && statSync(join(d, n)).isFile()) out.push(join(d, n));
  }
  return out;
}

/**
 * Create (or continue) the draft, PUT the files, optionally publish. `log` gets one line per step.
 * Throws with a readable message (never the token).
 */
export async function uploadRelease({ server, token, version, notes, files, publish = false, log = console.log }) {
  if (!token) throw new Error('EUTA_ADMIN_TOKEN 이 없습니다 — 관리자 계정의 읽기·쓰기 개인 토큰을 환경 변수로 주세요');
  server = server.replace(/\/+$/, '');
  const names = new Set();
  for (const f of files) {
    const n = basename(f);
    if (!/^[A-Za-z0-9._-]+$/.test(n)) throw new Error(`올릴 수 없는 파일 이름: ${n}`);
    if (names.has(n)) throw new Error(`같은 이름의 파일이 두 번: ${n}`);
    names.add(n);
  }

  const created = await send(server, token, 'POST', '/api/admin/app-releases', { json: { version, notes } });
  if (created.status === 201) log(`draft ${version} 만듦 (채널 ${created.json?.channel ?? '?'})`);
  else if (created.status === 409) {
    const list = await send(server, token, 'GET', '/api/admin/app-releases');
    if (list.status !== 200) throw new Error(`릴리스 목록을 읽지 못했습니다: ${errText(list)}`);
    const cur = (list.json?.releases ?? []).find((r) => r.version === version);
    if (cur?.status !== 'draft') throw new Error(`${version} 은 이미 게시되었습니다 — 버전을 올려서 다시 빌드하세요`);
    log(`draft ${version} 이 이미 있어 이어서 올립니다 (올라가 있는 파일 ${cur.files?.length ?? 0}개)`);
  } else throw new Error(`draft 를 만들지 못했습니다: ${errText(created)}`);

  for (const f of files) {
    const name = basename(f);
    const size = statSync(f).size;
    const local = await sha512(f);
    let r;
    for (let attempt = 1; ; attempt++) {
      try {
        r = await send(server, token, 'PUT', `/api/admin/app-releases/${encodeURIComponent(version)}/files/${encodeURIComponent(name)}`, { file: f });
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        log(`  ${name}: 다시 시도 (${e.message})`);
      }
    }
    if (r.status !== 201 && r.status !== 200) throw new Error(`${name} 올리기 실패: ${errText(r)}`);
    const remote = String(r.json?.sha512 ?? '');
    if (r.json?.size !== size || (remote !== local.toString('hex') && remote !== local.toString('base64'))) throw new Error(`${name}: 서버가 받은 크기·sha512 가 다릅니다 (${r.json?.size} B)`);
    log(`  ${name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  }

  if (!publish) {
    log(`올림 — 아직 게시 전입니다(draft). 다른 플랫폼도 올린 뒤 --publish 로 게시하세요.`);
    return { version, published: false };
  }
  const pub = await send(server, token, 'POST', `/api/admin/app-releases/${encodeURIComponent(version)}/publish`, { json: {} });
  if (pub.status !== 200) throw new Error(`게시하지 못했습니다: ${errText(pub)}`);
  log(`게시함 — ${version} (${pub.json?.publishedAt ?? ''})`);
  return { version, published: true, publishedAt: pub.json?.publishedAt };
}

async function main() {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const version = opt('version') ?? JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
  const dir = resolve(appDir, opt('dir') ?? join('release', version));
  const picked = OSES.filter((o) => args.includes(`--${o}`));
  const files = releaseFiles(dir, picked.length ? picked : OSES);
  if (!files.length && !args.includes('--publish')) throw new Error(`올릴 파일이 없습니다: ${dir}/{mac,win,linux} — 먼저 pnpm release`);
  const notes = notesFor(version, readFileSync(join(appDir, 'RELEASES.md'), 'utf8'));
  if (!notes) throw new Error(`RELEASES.md 에 "## ${version}" 이 없습니다`);
  // The cloud server this release goes to (a mirror — GitHub is pnpm release:github). No default (ADR-047).
  const server = (opt('server') ?? process.env.EUTA_UPDATE_SERVER ?? '').replace(/\/+$/, '');
  if (!server) throw new Error('올릴 서버 주소가 없습니다 — --server https://<euta cloud> 또는 EUTA_UPDATE_SERVER');
  console.log(`${server} 에 ${version} 올리기 — 파일 ${files.length}개${args.includes('--publish') ? ' + 게시' : ''}`);
  await uploadRelease({ server, token: process.env.EUTA_ADMIN_TOKEN, version, notes, files, publish: args.includes('--publish') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`release:upload: ${e.message}`);
    process.exit(1);
  });
}
