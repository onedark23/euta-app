// "올리기 = 전환" / "합치기" (SPEC 클라우드-앱-연동 "로컬 프로젝트를 클라우드로 올리기"): move this PC's
// data of a local project into the cloud working copy folder so History · 리포트 · 대화 · 녹화 · 작업 로그
// keep going under the one project. Synchronous on purpose — the caller runs the whole local phase in
// one block (no IPC can observe a half-moved project). Electron-free.
//   - Folders are renamed (same volume: atomic); into an existing folder, entries are moved one by one.
//   - runs/index.sqlite keeps absolute run dirs / script paths → rewritten (merged when both exist).
//   - activity/<YYYY-MM>.jsonl → appended; baselines/<envId> → renamed to the cloud env id;
//     suite-runs/<id>.json → project / suite / environment ids remapped.
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../project/fsx.js';

/** This PC's data that moves (scripts only on conversion — merge decides scripts itself). */
export const MOVED_SUBDIRS = ['runs', 'suite-runs', 'chats', 'recordings', 'tc-docs', 'activity', 'baselines', 'script-history', 'designs', 'design-reviews'] as const;

export interface MoveMaps {
  fromProjectId: string;
  toProjectId: string;
  /** Local environment id → cloud working-copy environment id. */
  envs: Record<string, string>;
  /** Local test set id → cloud working-copy test set id. */
  suites: Record<string, string>;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isEmptyDir = (p: string): boolean => isDir(p) && readdirSync(p).length === 0;

/** Move `src` to `dst`; when `dst` exists, move each entry that is not there yet (existing entries win). */
function moveInto(src: string, dst: string, onClash?: (name: string, from: string, to: string) => void): void {
  if (!existsSync(src)) return;
  if (!existsSync(dst) || isEmptyDir(dst)) {
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(join(dst, '..'), { recursive: true });
    renameSync(src, dst);
    return;
  }
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    if (!existsSync(to)) renameSync(from, to);
    else if (onClash) onClash(name, from, to);
    else if (isDir(from) && isDir(to)) moveInto(from, to);
  }
}

/** Number of local runs in a runs folder (the confirmation summary). */
export function countRuns(runsDir: string): number {
  const f = join(runsDir, 'index.sqlite');
  if (!existsSync(f)) return 0;
  const db = new DatabaseSync(f, { readOnly: true });
  try {
    return Number((db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n);
  } finally {
    db.close();
  }
}

const RUN_COLS = 'id, kind, name, script_path, status, started_at, finished_at, duration_ms, dir, browser, total, passed, failed, errors, skipped';

/**
 * Runs: the folders move, and index.sqlite rows point at the new place. With an index on both sides
 * (merge), the moved runs are inserted into the working copy's index.
 */
function moveRuns(srcRoot: string, dstRoot: string): number {
  const src = join(srcRoot, 'runs');
  const dst = join(dstRoot, 'runs');
  if (!existsSync(src)) return 0;
  const srcIdx = join(src, 'index.sqlite');
  const dstIdx = join(dst, 'index.sqlite');
  const moved = countRuns(src);
  const both = existsSync(srcIdx) && existsSync(dstIdx);
  if (!both) {
    moveInto(src, dst);
    if (existsSync(dstIdx)) rewriteIndex(dstIdx, srcRoot, dstRoot);
    return moved;
  }
  // Both sides have runs: copy the rows (paths rewritten) into the working copy's index first (the
  // local index is read in place, with its WAL), then move the run folders — never the index files.
  const db = new DatabaseSync(dstIdx);
  try {
    db.exec(`ATTACH DATABASE '${srcIdx.replace(/'/g, "''")}' AS l`);
    const pre = `${srcRoot}/`;
    const nxt = `${dstRoot}/`;
    db.exec('BEGIN');
    const fresh = '(SELECT id FROM l.runs WHERE id NOT IN (SELECT id FROM main.runs))';
    db.prepare(`INSERT INTO main.steps SELECT * FROM l.steps WHERE run_id IN ${fresh}`).run();
    db.prepare(`INSERT INTO main.metrics SELECT * FROM l.metrics WHERE run_id IN ${fresh}`).run();
    db.prepare(
      `INSERT INTO main.runs (${RUN_COLS}) SELECT id, kind, name, CASE WHEN substr(script_path, 1, length(:pre)) = :pre THEN :nxt || substr(script_path, length(:pre) + 1) ELSE script_path END, status, started_at, finished_at, duration_ms, CASE WHEN substr(dir, 1, length(:pre)) = :pre THEN :nxt || substr(dir, length(:pre) + 1) ELSE dir END, browser, total, passed, failed, errors, skipped FROM l.runs WHERE id NOT IN (SELECT id FROM main.runs)`,
    ).run({ pre, nxt });
    db.exec('COMMIT');
    db.exec('DETACH DATABASE l');
  } finally {
    db.close();
  }
  for (const name of readdirSync(src)) {
    if (name.startsWith('index.sqlite')) continue;
    if (!existsSync(join(dst, name))) renameSync(join(src, name), join(dst, name));
  }
  rmSync(src, { recursive: true, force: true });
  return moved;
}

/** index.sqlite rows: absolute paths under the old project folder → the new folder. */
export function rewriteIndex(indexFile: string, fromRoot: string, toRoot: string): void {
  const db = new DatabaseSync(indexFile);
  try {
    const pre = `${fromRoot}/`;
    const nxt = `${toRoot}/`;
    db.prepare('UPDATE runs SET dir = :nxt || substr(dir, length(:pre) + 1) WHERE substr(dir, 1, length(:pre)) = :pre').run({ pre, nxt });
    db.prepare('UPDATE runs SET script_path = :nxt || substr(script_path, length(:pre) + 1) WHERE substr(script_path, 1, length(:pre)) = :pre').run({ pre, nxt });
  } finally {
    db.close();
  }
}

/**
 * Move this PC's data of `srcRoot` (a local project folder) into `dstRoot` (the cloud working copy).
 * `scripts` also moves when `withScripts` (conversion: the server got the same text). Returns the
 * number of runs moved. The source folder keeps only what was not moved (the caller removes it).
 */
export function moveLocalData(srcRoot: string, dstRoot: string, maps: MoveMaps, o: { withScripts: boolean }): { runs: number } {
  mkdirSync(dstRoot, { recursive: true });
  // Baselines are per environment: rename to the cloud environment ids first.
  const bl = join(srcRoot, 'baselines');
  if (isDir(bl)) {
    for (const envId of readdirSync(bl)) {
      const to = maps.envs[envId];
      if (to && to !== envId && !existsSync(join(bl, to))) renameSync(join(bl, envId), join(bl, to));
    }
  }
  // Test set runs record the project / set / environment ids.
  const sr = join(srcRoot, 'suite-runs');
  if (isDir(sr)) {
    for (const f of readdirSync(sr)) {
      if (!f.endsWith('.json')) continue;
      const r = readJson<Record<string, unknown>>(join(sr, f));
      if (!r) continue;
      if (r.projectId === maps.fromProjectId) r.projectId = maps.toProjectId;
      if (typeof r.suiteId === 'string' && maps.suites[r.suiteId]) r.suiteId = maps.suites[r.suiteId];
      if (typeof r.envId === 'string' && maps.envs[r.envId]) r.envId = maps.envs[r.envId];
      writeJsonAtomic(join(sr, f), r);
    }
  }
  const runs = moveRuns(srcRoot, dstRoot);
  for (const sub of MOVED_SUBDIRS) {
    if (sub === 'runs') continue;
    const onClash =
      sub === 'activity'
        ? (name: string, from: string, to: string) => {
            if (name.endsWith('.jsonl')) appendFileSync(to, readFileSync(from));
          }
        : undefined;
    moveInto(join(srcRoot, sub), join(dstRoot, sub), onClash);
  }
  if (o.withScripts) moveInto(join(srcRoot, 'scripts'), join(dstRoot, 'scripts'), () => undefined);
  return { runs };
}
