// History = local runs + cloud runs in one time order (SPEC 클라우드-앱-연동 "History · 결과 회수"). Pure —
// the renderer builds its rows with it; unit-tested. A local run this PC uploaded is shown once (the local
// row, marked "올림"), not again as its "로컬 올림" cloud twin.
import type { CloudRunItem, HistoryItem, SuiteRun } from './types.js';

export type HistoryRow =
  | { kind: 'run'; at: string; run: HistoryItem; uploadedAs?: string }
  | { kind: 'suite'; at: string; suite: SuiteRun; runs: HistoryItem[] }
  | { kind: 'cloud'; at: string; cloud: CloudRunItem };

/** Row source / runner-location labels (출처 · 실행 위치 columns). */
export function rowSource(r: HistoryRow): { source: string; location: string } {
  if (r.kind === 'cloud') return { source: `클라우드 · ${r.cloud.sourceLabel}`, location: r.cloud.runnerLocation ?? '—' };
  if (r.kind === 'suite') return { source: '이 PC · 테스트 세트', location: '이 PC' };
  const s = r.run.source === 'ai' ? 'AI' : r.run.source === 'mcp' ? 'MCP' : '앱';
  return { source: `이 PC · ${s}`, location: '이 PC' };
}

export function mergeHistory(local: { runs: HistoryItem[]; suiteRuns: SuiteRun[] }, cloud: CloudRunItem[] | undefined, uploads: Record<string, string> = {}, filter = ''): HistoryRow[] {
  const f = filter.trim().toLowerCase();
  const match = (name: string, status: string, env: string | undefined): boolean => !f || name.toLowerCase().includes(f) || status === f || (env ?? '').toLowerCase() === f;
  const isCloudFilter = f === 'cloud' || f === '클라우드';
  const out: HistoryRow[] = [];
  const bySuite = new Map<string, HistoryItem[]>();
  const uploadedCloudIds = new Set<string>();
  for (const r of local.runs) {
    if (r.suiteRunId && local.suiteRuns.some((s) => s.id === r.suiteRunId)) {
      bySuite.set(r.suiteRunId, [...(bySuite.get(r.suiteRunId) ?? []), r]);
      continue;
    }
    const up = uploads[r.id];
    if (up) uploadedCloudIds.add(up);
    if (!isCloudFilter && match(r.name, r.status, r.envName)) out.push({ kind: 'run', at: r.startedAt, run: r, ...(up ? { uploadedAs: up } : {}) });
  }
  for (const s of local.suiteRuns) {
    const runs = (bySuite.get(s.id) ?? []).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const r of runs) if (uploads[r.id]) uploadedCloudIds.add(uploads[r.id]!);
    if (isCloudFilter) continue;
    if (!f || s.suiteName.toLowerCase().includes(f) || s.status === f || s.envName.toLowerCase() === f || runs.some((r) => match(r.name, r.status, r.envName))) out.push({ kind: 'suite', at: s.startedAt, suite: s, runs });
  }
  for (const c of cloud ?? []) {
    if (uploadedCloudIds.has(c.id)) continue;
    if (!f || isCloudFilter || match(c.name, c.status, c.envName)) out.push({ kind: 'cloud', at: c.at, cloud: c });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
