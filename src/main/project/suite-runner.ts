// Suites (화면 이름 "테스트 세트"): run scripts one after another (serial — OS input / screen use
// must not overlap), optional stop-on-failure, cancel skips the remaining scripts (the running one
// finishes: the engine has no abort API). "항상 실행" items still run after a stop or a cancel
// (cleanup scripts, ADR-031). One SuiteRun JSON per execution, rewritten
// after every item so a crash leaves a partial record.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunHandle } from '@euta/core';
import type { Environment, Suite, SuiteItemStatus, SuiteRun } from '../../shared/types.js';
import { isId, newId, readJson, writeJsonAtomic } from './fsx.js';

const RANK: Record<string, number> = { passed: 0, failed: 1, error: 2 };

/** Worst status of the executed (non-skipped) items; `error` when nothing ran. */
export function suiteStatus(items: SuiteRun['items']): 'passed' | 'failed' | 'error' {
  const ran = items.filter((i) => i.status === 'passed' || i.status === 'failed' || i.status === 'error');
  if (!ran.length) return 'error';
  return ran.reduce<'passed' | 'failed' | 'error'>((w, i) => ((RANK[i.status] ?? 0) > RANK[w]! ? (i.status as 'failed' | 'error') : w), 'passed');
}

export interface SuiteRunDeps {
  /** suite-runs/ folder of the project. */
  dir: string;
  /** Start one script (library-relative path). May throw (missing file etc.). */
  start(script: string, suiteRunId: string): RunHandle;
  onUpdate?(run: SuiteRun): void;
  now?: () => Date;
}

export interface SuiteExecution {
  run: SuiteRun;
  cancel(): void;
  done: Promise<SuiteRun>;
}

export function startSuite(projectId: string, suite: Suite, env: Environment, d: SuiteRunDeps): SuiteExecution {
  const now = d.now ?? (() => new Date());
  const run: SuiteRun = {
    id: newId(12),
    projectId,
    suiteId: suite.id,
    suiteName: suite.name,
    envId: env.id,
    envName: env.name,
    stopOnFailure: suite.stopOnFailure,
    startedAt: now().toISOString(),
    status: 'running',
    items: suite.scripts.map((script) => ({ script, status: 'pending' as SuiteItemStatus, ...(suite.alwaysRun?.includes(script) ? { alwaysRun: true } : {}) })),
  };
  let cancelled = false;
  const file = join(d.dir, `${run.id}.json`);
  const save = (): void => {
    try {
      writeJsonAtomic(file, run);
    } catch {
      /* disk errors: keep going in memory */
    }
    try {
      d.onUpdate?.(structuredClone(run));
    } catch {
      /* listener errors are not the suite's problem */
    }
  };
  save();

  const done = (async () => {
    let stop = false;
    for (const item of run.items) {
      if ((cancelled || stop) && !item.alwaysRun) {
        item.status = 'skipped';
        continue;
      }
      item.status = 'running';
      try {
        const h = d.start(item.script, run.id);
        item.runId = h.runId;
        save();
        const r = await h.result;
        item.status = r.status === 'passed' ? 'passed' : r.status === 'failed' ? 'failed' : 'error';
      } catch {
        item.status = 'error';
      }
      if (item.status !== 'passed' && run.stopOnFailure) stop = true;
      save();
    }
    run.status = suiteStatus(run.items);
    if (cancelled) run.cancelled = true;
    run.finishedAt = now().toISOString();
    save();
    return structuredClone(run);
  })();

  return {
    run,
    cancel: () => {
      cancelled = true;
    },
    done,
  };
}

/** Saved suite runs, newest first. A run left `running` by an app quit is closed as interrupted. */
export function listSuiteRuns(dir: string, limit = 200): SuiteRun[] {
  if (!existsSync(dir)) return [];
  const out: SuiteRun[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^([a-z0-9]+)\.json$/.exec(f);
    if (!m || !isId(m[1])) continue;
    const r = readJson<SuiteRun>(join(dir, f));
    if (!r || r.id !== m[1] || !Array.isArray(r.items)) continue;
    out.push(r);
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

export function reviveSuiteRun(r: SuiteRun, active: boolean): SuiteRun {
  if (r.status !== 'running' || active) return r;
  for (const i of r.items) if (i.status === 'running' || i.status === 'pending') i.status = 'skipped';
  return { ...r, status: suiteStatus(r.items), interrupted: true };
}
