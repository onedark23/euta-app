// Runs history from the engine's index.sqlite (RunIndex, node:sqlite — ADR-003), plus the
// app metadata the run recorded in run.json `meta` (project / environment / suite run).
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { RunIndex } from '@euta/core';
import type { HistoryItem } from '../shared/types.js';

const metaCache = new Map<string, Record<string, string> | null>();

/**
 * run.json `meta` (written once at run start; cached per run dir). run.json starts with
 * the base fields, so only the head of the file is read.
 */
export function readRunMeta(runDir: string): Record<string, string> | undefined {
  const hit = metaCache.get(runDir);
  if (hit !== undefined) return hit ?? undefined;
  let meta: Record<string, string> | undefined;
  try {
    const fd = openSync(join(runDir, 'run.json'), 'r');
    try {
      const buf = Buffer.alloc(16 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, n).toString('utf8');
      const m = /"meta"\s*:\s*(\{[^{}]*\})/.exec(head);
      if (m) {
        const v = JSON.parse(m[1]!) as Record<string, unknown>;
        meta = Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    meta = undefined;
  }
  if (metaCache.size > 5000) metaCache.clear();
  metaCache.set(runDir, meta ?? null);
  return meta;
}

const manualCache = new Map<string, number>();

/** Manual steps of a finished run (run.json steps, groups included; cached — finished runs do not change). */
export function readManualCount(runDir: string): number {
  const hit = manualCache.get(runDir);
  if (hit !== undefined) return hit;
  let n = 0;
  try {
    const j = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as { steps?: unknown[] };
    const walk = (steps: unknown[] | undefined): void => {
      for (const s of steps ?? []) {
        if (!s || typeof s !== 'object') continue;
        const o = s as { manual?: unknown; children?: unknown[] };
        if (o.manual) n++;
        if (Array.isArray(o.children)) walk(o.children);
      }
    };
    walk(j.steps);
  } catch {
    n = 0;
  }
  if (manualCache.size > 5000) manualCache.clear();
  manualCache.set(runDir, n);
  return n;
}

export function listHistory(runsDir: string, q: { limit?: number; status?: string; name?: string } = {}): HistoryItem[] {
  if (!existsSync(join(runsDir, 'index.sqlite'))) return [];
  return RunIndex.with(runsDir, (idx) =>
    idx.listRuns({ limit: q.limit ?? 200, ...(q.status ? { status: q.status } : {}), ...(q.name ? { name: q.name } : {}) }).map((r) => {
      const meta = r.status === 'running' ? undefined : readRunMeta(r.dir);
      const manual = r.status === 'running' || !r.skipped ? 0 : readManualCount(r.dir);
      return {
        id: r.id,
        kind: r.kind,
        name: r.name,
        status: r.status,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        total: r.total,
        passed: r.passed,
        failed: r.failed,
        errors: r.errors,
        skipped: r.skipped,
        dir: r.dir,
        hasReport: existsSync(join(r.dir, 'report.html')),
        ...(r.scriptPath ? { scriptPath: r.scriptPath } : {}),
        ...(meta?.envId ? { envId: meta.envId } : {}),
        ...(meta?.envName ? { envName: meta.envName } : {}),
        ...(meta?.suiteRunId ? { suiteRunId: meta.suiteRunId } : {}),
        ...(meta?.source ? { source: meta.source } : {}),
        ...(manual ? { manual } : {}),
      };
    }),
  );
}

export function findRunDir(runsDir: string, runId: string): { id: string; dir: string } | undefined {
  if (!existsSync(join(runsDir, 'index.sqlite'))) return undefined;
  const r = RunIndex.with(runsDir, (idx) => idx.findRun(runId));
  return r ? { id: r.id, dir: r.dir } : undefined;
}
