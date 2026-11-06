// 테스트 세트 리포트 (SPEC 프로젝트-관리 "테스트 세트 리포트", ADR-032): one self-contained HTML file per
// set run at `suite-runs/<suiteRunId>/report.html` (next to the unchanged `<suiteRunId>.json`) — header,
// comparison with the previous run of the same set in the same environment, a per-script table and,
// for each failed script, the failing step sentence (describeStep), its error, its screenshot (embedded)
// and an optional selector-check summary. Text is masked with the project's secret values; no external
// requests (inline CSS, data: images). Electron-free.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describeStep, type CheckTargetsResult } from '@euta/core';
import type { SuiteItemStatus, SuiteRun } from '../../shared/types.js';
import { writeTextAtomic } from './fsx.js';

export const SUITE_REPORT_FILE = 'report.html';

/** `suite-runs/<id>/report.html` — a folder beside the run's JSON (old runs keep only the JSON). */
export const suiteReportPath = (suiteRunsDir: string, suiteRunId: string): string => join(suiteRunsDir, suiteRunId, SUITE_REPORT_FILE);

const FAILED = new Set(['failed', 'error']);

export interface ItemRef {
  /** 1-based position in the current run. */
  order: number;
  script: string;
}

export interface SuiteComparison {
  previousId: string;
  previousAt: string;
  previousStatus: string;
  newlyFailing: ItemRef[];
  recovered: ItemRef[];
  stillFailing: ItemRef[];
  stillPassing: ItemRef[];
}

/** Newest finished run of the same set in the same environment that started before `cur`. */
export function previousSuiteRun(runs: SuiteRun[], cur: SuiteRun): SuiteRun | undefined {
  return runs
    .filter((r) => r.id !== cur.id && r.suiteId === cur.suiteId && r.envId === cur.envId && r.status !== 'running' && r.startedAt < cur.startedAt)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

/**
 * Items of `cur` against `prev`. Same script list (same order) → matched by position; otherwise by
 * script path + occurrence (2nd `a.yaml` ↔ 2nd `a.yaml`). Only items that ran now are bucketed:
 * failed now & not failed before (passed · skipped · absent) = 새로 실패, passed now & failed before = 회복,
 * failed both = 계속 실패, passed both = 그대로 통과. Skipped now, or passed now after not running, is left out.
 */
export function compareSuiteRuns(cur: SuiteRun, prev: SuiteRun): SuiteComparison {
  const samePlan = cur.items.length === prev.items.length && cur.items.every((it, i) => it.script === prev.items[i]!.script);
  const occ = (items: SuiteRun['items']): Map<string, SuiteItemStatus> => {
    const n = new Map<string, number>();
    const out = new Map<string, SuiteItemStatus>();
    for (const it of items) {
      const k = (n.get(it.script) ?? 0) + 1;
      n.set(it.script, k);
      out.set(`${it.script}#${k}`, it.status);
    }
    return out;
  };
  const prevBy = occ(prev.items);
  const seen = new Map<string, number>();
  const out: SuiteComparison = { previousId: prev.id, previousAt: prev.startedAt, previousStatus: prev.status, newlyFailing: [], recovered: [], stillFailing: [], stillPassing: [] };
  cur.items.forEach((it, i) => {
    const k = (seen.get(it.script) ?? 0) + 1;
    seen.set(it.script, k);
    const before = samePlan ? prev.items[i]!.status : prevBy.get(`${it.script}#${k}`);
    const ref = { order: i + 1, script: it.script };
    const nowFail = FAILED.has(it.status);
    const wasFail = !!before && FAILED.has(before);
    if (nowFail) (wasFail ? out.stillFailing : out.newlyFailing).push(ref);
    else if (it.status === 'passed' && wasFail) out.recovered.push(ref);
    else if (it.status === 'passed' && before === 'passed') out.stillPassing.push(ref);
  });
  return out;
}

// ---- run folder reading ----------------------------------------------------------------------------

interface StepJson {
  stepId: string;
  action?: string;
  name?: string;
  status: string;
  error?: string;
  screenshot?: string;
  children?: StepJson[];
  manual?: { instruction: string; reason?: string };
}

/** Manual steps of a run (groups included): reached ones (no error) = "수동 확인 필요". */
export function manualSteps(steps: StepJson[] | undefined, out: NonNullable<SuiteReportItem['manual']> = []): NonNullable<SuiteReportItem['manual']> {
  for (const s of steps ?? []) {
    if (s.manual) out.push({ stepId: s.stepId, ...(s.name ? { name: s.name } : {}), instruction: s.manual.instruction, ...(s.manual.reason ? { reason: s.manual.reason } : {}), reached: !s.error, ...(s.error ? { error: s.error } : {}) });
    if (s.children) manualSteps(s.children, out);
  }
  return out;
}

interface RunJsonLite {
  name?: string;
  status?: string;
  durationMs?: number;
  error?: string;
  steps?: StepJson[];
  script?: { steps?: unknown[] };
}

/** The deepest failed/error step (a failed group → its failed child). */
export function failingStep(steps: StepJson[] | undefined): StepJson | undefined {
  for (const s of steps ?? []) {
    if (!FAILED.has(s.status)) continue;
    return failingStep(s.children) ?? s;
  }
  return undefined;
}

/** Raw step object of a script by engine step id ("3", "4.2" — 1-based; groups nest). */
export function stepById(script: { steps?: unknown[] } | undefined, stepId: string): unknown {
  let list: unknown = script?.steps;
  let step: unknown;
  for (const part of stepId.split('.')) {
    const i = Number(part) - 1;
    if (!Array.isArray(list) || !Number.isInteger(i) || i < 0) return undefined;
    step = list[i];
    const o = step && typeof step === 'object' ? (step as Record<string, unknown>) : undefined;
    const g = o?.group as { steps?: unknown } | undefined;
    const d = o?.expectDownload as { trigger?: unknown } | undefined;
    list = g?.steps ?? (d?.trigger ? [d.trigger] : undefined);
  }
  return step;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const MAX_SHOT_BYTES = 4 * 1024 * 1024;

function dataUri(runDir: string, rel: string | undefined): string | undefined {
  if (!rel) return undefined;
  const abs = join(runDir, rel);
  if (!abs.startsWith(runDir + sep)) return undefined;
  const ext = rel.split('.').pop()?.toLowerCase() ?? '';
  if (!MIME[ext] || !existsSync(abs)) return undefined;
  try {
    const buf = readFileSync(abs);
    return buf.length > MAX_SHOT_BYTES ? undefined : `data:${MIME[ext]};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

const VERDICT_KO: Record<string, string> = {
  ok: '정상',
  missing: '없음',
  ambiguous: '여러 개',
  present: '보임(숨김이어야 함)',
  dynamic: '변함(통과로 봄)',
  'no-snapshot': '스냅샷 없음',
  skipped: '점검 안 함',
};

export interface SelectorCheckSummary {
  /** "정상 3 · 없음 1" */
  counts: string;
  /** Targets of the failing step: "대상 → 판정 (n개)". */
  failingStep: string[];
}

export function summarizeCheck(r: CheckTargetsResult, stepId: string | undefined): SelectorCheckSummary {
  const counts = Object.entries(r.summary)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${VERDICT_KO[v] ?? v} ${n}`)
    .join(' · ');
  const target = (t: unknown) => (typeof t === 'string' ? t : JSON.stringify(t));
  const failing = r.steps.filter((s) => s.stepId === stepId).map((s) => `${target(s.target)} → ${VERDICT_KO[s.verdict] ?? s.verdict}${s.count !== undefined ? ` (${s.count}개)` : ''}${s.candidates?.length ? ` · 후보 ${s.candidates.map((c) => target(c.target)).join(', ')}` : ''}`);
  return { counts: counts || '대상 없음', failingStep: failing };
}

export type SelectorCheck = (source: string, runDir: string) => Promise<CheckTargetsResult>;

export interface SuiteReportItem {
  order: number;
  script: string;
  name?: string;
  status: SuiteItemStatus;
  alwaysRun?: boolean;
  runId?: string;
  durationMs?: number;
  /** Link to the script's own report, relative to the set report. */
  reportHref?: string;
  /** `manual` steps (SPEC TC-문서-변환): reached = 수동 확인 필요, else not reached after a failure. */
  manual?: { stepId: string; name?: string; instruction: string; reason?: string; reached: boolean; error?: string }[];
  failure?: {
    stepId?: string;
    title?: string;
    sentence?: string;
    error?: string;
    screenshot?: string;
    check?: SelectorCheckSummary;
  };
}

export interface SuiteReportData {
  run: SuiteRun;
  projectName: string;
  items: SuiteReportItem[];
  comparison?: SuiteComparison;
}

export interface BuildSuiteReportOptions {
  run: SuiteRun;
  projectName: string;
  /** Every saved run of the set's project (for the previous run). */
  history: SuiteRun[];
  /** Run folder of an item's run id. */
  runDir(runId: string): string | undefined;
  /** Library names (path → `name:`) for items that never ran. */
  names: Map<string, string | undefined>;
  /** Where the report is written (`suite-runs/`). */
  suiteRunsDir: string;
  /** Mask secret values in text. */
  redact(text: string): string;
  /** Optional selector check on failed items with `dom/` snapshots (skipped on error / timeout). */
  check?: SelectorCheck;
  checkTimeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((res) => {
    const t = setTimeout(() => res(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      () => {
        clearTimeout(t);
        res(undefined);
      },
    );
  });
}

const MAX_CHECKED = 5;

/** Read the item runs, compare with the previous run, render and write the report. Returns its path. */
export async function buildSuiteReport(o: BuildSuiteReportOptions): Promise<string> {
  const file = suiteReportPath(o.suiteRunsDir, o.run.id);
  const reportDir = dirname(file);
  let checked = 0;
  const items: SuiteReportItem[] = [];
  for (const [i, it] of o.run.items.entries()) {
    const dir = it.runId ? o.runDir(it.runId) : undefined;
    let rj: RunJsonLite | undefined;
    if (dir) {
      try {
        rj = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunJsonLite;
      } catch {
        rj = undefined;
      }
    }
    const item: SuiteReportItem = {
      order: i + 1,
      script: it.script,
      status: it.status,
      ...((rj?.name ?? o.names.get(it.script)) ? { name: rj?.name ?? o.names.get(it.script) } : {}),
      ...(it.alwaysRun ? { alwaysRun: true } : {}),
      ...(it.runId ? { runId: it.runId } : {}),
      ...(typeof rj?.durationMs === 'number' ? { durationMs: rj.durationMs } : {}),
      ...(dir && existsSync(join(dir, 'report.html')) ? { reportHref: relative(reportDir, join(dir, 'report.html')).split(sep).map(encodeURIComponent).join('/') } : {}),
    };
    const manual = manualSteps(rj?.steps);
    if (manual.length) item.manual = manual;
    if (FAILED.has(it.status)) {
      const step = failingStep(rj?.steps);
      const raw = step ? stepById(rj?.script, step.stepId) : undefined;
      const d = raw !== undefined ? describeStep(raw) : undefined;
      item.failure = {
        ...(step ? { stepId: step.stepId } : {}),
        ...(d?.title ? { title: d.title } : step?.name ? { title: step.name } : {}),
        ...(d ? { sentence: d.sentence } : step?.action ? { sentence: step.action } : {}),
        ...((step?.error ?? rj?.error) ? { error: step?.error ?? rj?.error } : {}),
        ...(dir && step ? { screenshot: dataUri(dir, step.screenshot) } : {}),
      };
      if (!item.failure.screenshot) delete item.failure.screenshot;
      if (o.check && dir && rj?.script && existsSync(join(dir, 'dom')) && checked < MAX_CHECKED) {
        checked++;
        const r = await withTimeout(o.check(JSON.stringify(rj.script), dir), o.checkTimeoutMs ?? 20_000);
        if (r) item.failure.check = summarizeCheck(r, step?.stepId);
      }
    }
    items.push(item);
  }
  const prev = previousSuiteRun(o.history, o.run);
  const html = renderSuiteReport({ run: o.run, projectName: o.projectName, items, ...(prev ? { comparison: compareSuiteRuns(o.run, prev) } : {}) }, o.redact);
  writeTextAtomic(file, html);
  return file;
}

// ---- rendering ---------------------------------------------------------------------------------------

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const STATUS_KO: Record<string, string> = { passed: '통과', failed: '실패', error: '오류', skipped: '건너뜀', pending: '대기', running: '실행 중' };

const ms = (n: number | undefined): string => (n === undefined ? '' : n >= 60_000 ? `${Math.floor(n / 60_000)}분 ${Math.round((n % 60_000) / 1000)}초` : n >= 1000 ? `${(n / 1000).toFixed(1)}초` : `${Math.round(n)}ms`);
const time = (iso: string | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const CSS = `
:root{--bg:#fff;--fg:#1d2330;--mut:#667085;--line:#e4e7ec;--card:#f8f9fb;--pass:#127a3a;--fail:#b42318;--err:#9a3412;--skip:#667085;--new:#b42318;--rec:#127a3a;--manual:#6941c6}
@media (prefers-color-scheme:dark){:root{--bg:#12151c;--fg:#e6e9ef;--mut:#98a2b3;--line:#2a303c;--card:#1a1f29;--pass:#4ade80;--fail:#f87171;--err:#fb923c;--skip:#98a2b3;--new:#f87171;--rec:#4ade80;--manual:#b69cf5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:28px 0 10px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:15px;margin:0 0 6px}
.mut{color:var(--mut)}.small{font-size:12px}.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;color:#fff;vertical-align:middle}
.passed{background:var(--pass)}.failed{background:var(--fail)}.error{background:var(--err)}.skipped,.pending,.running{background:var(--skip)}.manual{background:var(--manual)}.card.man>b{color:var(--manual)}
.meta{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--mut)}.meta b{color:var(--fg);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.card>b{display:block;font-size:20px}.card ul{margin:4px 0 0;padding-left:18px;font-size:13px}.card.new>b{color:var(--new)}.card.rec>b{color:var(--rec)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:6px 8px}th{color:var(--mut);font-weight:600}
td.num{text-align:right;white-space:nowrap}.tag{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 6px;font-size:12px;color:var(--mut)}
.fail{border:1px solid var(--line);border-left:4px solid var(--fail);border-radius:8px;padding:12px 14px;margin:0 0 14px;background:var(--card)}
.sentence{font-size:15px;margin:4px 0}pre{white-space:pre-wrap;word-break:break-word;margin:6px 0;background:var(--bg);border:1px solid var(--line);padding:8px;border-radius:6px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace}
img.shot{display:block;max-width:min(100%,720px);max-height:480px;border:1px solid var(--line);border-radius:6px;margin-top:8px}a{color:inherit}a.btn{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:2px 10px;text-decoration:none;font-size:12px;white-space:nowrap}
.script b{font-weight:600}.script .mut{margin-left:6px}
`;

export function renderSuiteReport(d: SuiteReportData, redact: (s: string) => string = (s) => s): string {
  const t = (s: unknown) => esc(redact(String(s ?? '')));
  const r = d.run;
  const passed = d.items.filter((i) => i.status === 'passed').length;
  const failed = d.items.filter((i) => FAILED.has(i.status)).length;
  const skipped = d.items.filter((i) => i.status === 'skipped').length;
  const dur = r.finishedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : undefined;
  const byOrder = new Map(d.items.map((i) => [i.order, i]));
  const label = (it: { script: string; name?: string } | undefined, script: string) =>
    it?.name ? `<span class="script"><b>${t(it.name)}</b><span class="mut small">${t(script)}</span></span>` : `<span class="script"><b>${t(script)}</b></span>`;
  const refList = (refs: ItemRef[]) => (refs.length ? `<ul>${refs.map((x) => `<li>${x.order}. ${label(byOrder.get(x.order), x.script)}</li>`).join('')}</ul>` : '');
  // "수동 확인 필요 N" counts every manual step (reached or not), like the engine report and the web.
  const manualCount = d.items.reduce((n, i) => n + (i.manual?.length ?? 0), 0);
  const manualRows = d.items
    .flatMap((i) =>
      (i.manual ?? []).map(
        (m) =>
          `<tr data-testid="sr-manual" data-reached="${m.reached ? '1' : '0'}"><td class="num">${i.order}</td><td>${label(i, i.script)}</td><td>${m.name ? `${t(m.name)}<br>` : ''}${m.reached ? '<span class="badge manual">수동 확인 필요</span>' : `<span class="badge skipped">건너뜀</span> <span class="mut small">${t(m.error ?? '')}</span>`}</td><td>수동 확인: ${t(m.instruction)}${m.reason ? `<div class="mut small">이유: ${t(m.reason)}</div>` : ''}</td></tr>`,
      ),
    )
    .join('\n');
  const c = d.comparison;
  const compare = c
    ? `<p class="mut small">지난 실행: ${t(time(c.previousAt))} · <span class="badge ${t(c.previousStatus)}">${t(STATUS_KO[c.previousStatus] ?? c.previousStatus)}</span> (같은 테스트 세트 · 같은 환경)</p>
<div class="grid" data-testid="sr-compare">
<div class="card new" data-testid="sr-newly-failing" data-count="${c.newlyFailing.length}">새로 실패<b>${c.newlyFailing.length}</b>${refList(c.newlyFailing)}</div>
<div class="card rec" data-testid="sr-recovered" data-count="${c.recovered.length}">회복<b>${c.recovered.length}</b>${refList(c.recovered)}</div>
<div class="card" data-testid="sr-still-failing" data-count="${c.stillFailing.length}">계속 실패<b>${c.stillFailing.length}</b>${refList(c.stillFailing)}</div>
<div class="card" data-testid="sr-still-passing" data-count="${c.stillPassing.length}">그대로 통과<b>${c.stillPassing.length}</b>${refList(c.stillPassing)}</div>
</div>`
    : `<p class="mut" data-testid="sr-compare-none">같은 테스트 세트 · 같은 환경의 지난 실행이 없습니다.</p>`;
  const rows = d.items
    .map(
      (i) => `<tr data-testid="sr-item" data-status="${t(i.status)}"><td class="num">${i.order}</td><td>${label(i, i.script)}</td><td><span class="badge ${t(i.status)}">${t(STATUS_KO[i.status] ?? i.status)}</span>${i.manual?.length ? ` <span class="badge manual" data-testid="sr-item-manual">수동 확인 ${i.manual.length}</span>` : ''}</td><td class="num">${ms(i.durationMs)}</td><td>${i.alwaysRun ? '<span class="tag">항상 실행</span>' : ''}</td><td>${i.reportHref ? `<a class="btn" href="${esc(i.reportHref)}" data-testid="sr-item-report">리포트</a>` : ''}</td></tr>`,
    )
    .join('\n');
  const failures = d.items
    .filter((i) => i.failure)
    .map((i) => {
      const f = i.failure!;
      return `<section class="fail" data-testid="sr-failure" data-order="${i.order}">
<h3>${i.order}. ${label(i, i.script)} <span class="badge ${t(i.status)}">${t(STATUS_KO[i.status] ?? i.status)}</span></h3>
${f.stepId ? `<div class="mut small">실패한 단계 ${t(f.stepId)}${f.title ? ` · ${t(f.title)}` : ''}</div>` : '<div class="mut small">실패한 단계 정보 없음 (실행 전 오류)</div>'}
${f.sentence ? `<div class="sentence" data-testid="sr-step-sentence">${t(f.sentence)}</div>` : ''}
${f.error ? `<pre data-testid="sr-error">${t(f.error)}</pre>` : ''}
${f.screenshot ? `<img class="shot" data-testid="sr-shot" alt="${t(`${i.order}번 스크립트 ${f.stepId ?? ''}단계 스크린샷`)}" src="${f.screenshot}">` : '<div class="mut small">이 단계의 스크린샷이 없습니다.</div>'}
${f.check ? `<div class="small" data-testid="sr-check"><b>선택자 점검</b> <span class="mut">(이 실행의 DOM 스냅샷에 스크립트의 대상을 대 봄)</span> 전체: ${t(f.check.counts)}${f.check.failingStep.length ? `<div>실패한 단계의 대상:</div><ul>${f.check.failingStep.map((x) => `<li>${t(x)}</li>`).join('')}</ul>` : '<div class="mut">실패한 단계에는 대상(선택자)이 없습니다.</div>'}</div>` : ''}
</section>`;
    })
    .join('\n');
  const flags = [r.cancelled ? '취소됨' : '', r.interrupted ? '앱 종료로 중단' : '', r.stopOnFailure ? '실패 시 중단' : ''].filter(Boolean);
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>테스트 세트 리포트 — ${t(r.suiteName)}</title><style>${CSS}</style></head>
<body><main data-testid="suite-report" data-status="${t(r.status)}">
<h1>테스트 세트: ${t(r.suiteName)} <span class="badge ${t(r.status)}" data-testid="sr-status">${t(STATUS_KO[r.status] ?? r.status)}</span></h1>
<div class="meta"><span>프로젝트 <b>${t(d.projectName)}</b></span><span>환경 <b>${t(r.envName)}</b></span><span>실행 위치 <b>이 PC</b></span><span>시작 <b>${t(time(r.startedAt))}</b></span>${r.finishedAt ? `<span>끝 <b>${t(time(r.finishedAt))}</b></span>` : ''}${dur !== undefined ? `<span>소요 <b>${ms(dur)}</b></span>` : ''}${flags.length ? `<span>${t(flags.join(' · '))}</span>` : ''}</div>
<h2>요약</h2>
<div class="grid" data-testid="sr-summary">
<div class="card">통과<b data-testid="sr-passed">${passed}/${d.items.length}</b></div><div class="card">실패·오류<b>${failed}</b></div><div class="card">건너뜀<b>${skipped}</b></div>${manualCount ? `<div class="card man" data-testid="sr-manual-count">수동 확인 필요<b>${manualCount}</b></div>` : ''}
</div>
<h2>지난 실행 대비</h2>
${compare}
<h2>스크립트별 결과</h2>
<table><tr><th class="num">#</th><th>스크립트</th><th>상태</th><th class="num">소요</th><th>항상 실행</th><th>개별 리포트</th></tr>
${rows}
</table>
${manualCount ? `<h2>수동 확인 필요</h2>\n<p class="mut small">사람이 확인해야 하는 단계입니다(자동으로 실행하지 않음). 실패 뒤라 도달하지 못한 단계는 건너뜀으로 표시합니다.</p>\n<table><tr><th class="num">#</th><th>스크립트</th><th>단계</th><th>확인할 내용</th></tr>\n${manualRows}\n</table>` : ''}
<h2>실패 상세</h2>
${failures || '<p class="mut">실패한 스크립트가 없습니다.</p>'}
<p class="mut small">euta 테스트 세트 리포트 · ${t(r.id)}</p>
</main></body></html>
`;
}
