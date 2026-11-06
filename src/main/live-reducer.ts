// Pure, order-tolerant reducer: euta events (ADR-007 envelope) -> RunView.
// Used for in-app runs (EventBus), forwarded MCP events (POST /events) and
// replays of steps.jsonl. Events are applied idempotently by `seq`, so
// duplicates, out-of-order delivery and later recovery merge cleanly.
import type { RunSource, RunView, StepView } from '../shared/types.js';
import { koSecretRule } from '../shared/secret-rules.js';

/** Loose event shape: forwarded events are untrusted JSON, so every field is checked. */
export type LooseEvent = { type: string; runId: string; seq: number; ts?: string } & Record<string, unknown>;

const LIST_CAP = 300;

export interface RunState {
  view: RunView;
  seen: Set<number>;
  /** seq of the artifact currently shown as latest screenshot. */
  latestShotSeq: number;
  /** step order key: index (or seq when index is missing). */
  stepOrder: Map<string, number>;
}

export function isLooseEvent(e: unknown): e is LooseEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.type === 'string' &&
    typeof o.runId === 'string' &&
    o.runId.length > 0 &&
    o.runId.length <= 200 &&
    typeof o.seq === 'number' &&
    Number.isInteger(o.seq) &&
    o.seq > 0
  );
}

export function createRunState(runId: string, source: RunSource): RunState {
  return {
    view: {
      runId,
      source,
      name: runId,
      status: 'unknown',
      steps: [],
      metrics: [],
      expects: [],
      consoleErrors: [],
      networkFailures: [],
      eventCount: 0,
      maxSeq: 0,
      updatedAt: Date.now(),
    },
    seen: new Set(),
    latestShotSeq: 0,
    stepOrder: new Map(),
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
// Playwright error messages carry ANSI colour codes (e.g. "\x1b[2m"); the UI shows plain text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// Secret-rule messages (placement / domain gate) are shown in Korean (SPEC 프로젝트-관리 "secrets 규칙").
const plain = (v: unknown): string | undefined => {
  const s = str(v)?.replace(ANSI, '');
  return s === undefined ? undefined : koSecretRule(s);
};
/** `manual` marker of a step.finished event ({ instruction, reason? }). */
function manualOf(v: unknown): StepView['manual'] {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const instruction = plain(m.instruction);
  if (instruction === undefined) return undefined;
  const reason = plain(m.reason);
  return { instruction, ...(reason ? { reason } : {}) };
}
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function pushCapped<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > LIST_CAP) list.splice(0, list.length - LIST_CAP);
}

function upsertStep(state: RunState, stepId: string, seq: number, patch: Partial<StepView>): StepView {
  const steps = state.view.steps;
  let step = steps.find((s) => s.stepId === stepId);
  if (!step) {
    step = { stepId, index: patch.index ?? -1, action: patch.action ?? '?', status: 'running' };
    steps.push(step);
  }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (step as unknown as Record<string, unknown>)[k] = v;
  state.stepOrder.set(stepId, step.index >= 0 ? step.index : 1e9 + seq);
  steps.sort((a, b) => (state.stepOrder.get(a.stepId) ?? 0) - (state.stepOrder.get(b.stepId) ?? 0));
  return step;
}

/** Apply one event. Returns false when it was a duplicate or malformed. */
export function applyEvent(state: RunState, e: LooseEvent): boolean {
  if (e.runId !== state.view.runId || state.seen.has(e.seq)) return false;
  state.seen.add(e.seq);
  const v = state.view;
  v.eventCount = state.seen.size;
  v.maxSeq = Math.max(v.maxSeq, e.seq);
  v.updatedAt = Date.now();

  switch (e.type) {
    case 'run.started': {
      const script = (e.script ?? {}) as Record<string, unknown>;
      const env = (e.env ?? {}) as Record<string, unknown>;
      v.name = str(script.name) ?? v.name;
      v.scriptPath = str(script.path);
      v.kind = e.kind === 'session' ? 'session' : 'script';
      v.runDir = str(e.runDir) ?? v.runDir;
      v.startedAt = str(e.ts);
      v.browser = str(env.browser);
      v.headless = typeof env.headless === 'boolean' ? env.headless : undefined;
      v.baseUrl = str(env.baseUrl);
      if (v.status === 'unknown') v.status = 'running';
      break;
    }
    case 'run.finished': {
      const status = str(e.status);
      if (status === 'passed' || status === 'failed' || status === 'error' || status === 'running') v.status = status;
      const s = e.summary as Record<string, unknown> | undefined;
      if (s && typeof s === 'object') {
        v.summary = {
          total: num(s.total) ?? 0,
          passed: num(s.passed) ?? 0,
          failed: num(s.failed) ?? 0,
          error: num(s.error) ?? 0,
          skipped: num(s.skipped) ?? 0,
        };
      }
      v.durationMs = num(e.durationMs);
      v.error = plain(e.error) ?? v.error;
      // Steps still marked running when the run ended never finished.
      for (const st of v.steps) if (st.status === 'running') st.status = 'skipped';
      break;
    }
    case 'step.started': {
      const stepId = str(e.stepId);
      if (!stepId) break;
      if (v.status === 'unknown') v.status = 'running';
      const existing = v.steps.find((s) => s.stepId === stepId);
      upsertStep(state, stepId, e.seq, {
        index: num(e.index),
        action: str(e.action),
        name: str(e.name),
        target: str(e.target),
        // Do not downgrade a step whose finish arrived first.
        status: existing && existing.status !== 'running' ? existing.status : 'running',
      });
      break;
    }
    case 'step.finished': {
      const stepId = str(e.stepId);
      const status = str(e.status);
      if (!stepId || !(status === 'passed' || status === 'failed' || status === 'error' || status === 'skipped')) break;
      if (v.status === 'unknown') v.status = 'running';
      upsertStep(state, stepId, e.seq, {
        index: num(e.index),
        action: str(e.action),
        name: str(e.name),
        status,
        durationMs: num(e.durationMs),
        error: plain(e.error),
        optional: typeof e.optional === 'boolean' ? e.optional : undefined,
        manual: manualOf(e.manual),
      });
      break;
    }
    case 'artifact.saved': {
      const path = str(e.path);
      if (!path || e.kind !== 'screenshot') break;
      const stepId = str(e.stepId);
      if (stepId) upsertStep(state, stepId, e.seq, { screenshot: path });
      if (e.seq > state.latestShotSeq) {
        state.latestShotSeq = e.seq;
        v.latestScreenshot = path;
      }
      break;
    }
    case 'metric.recorded': {
      const name = str(e.name);
      const value = num(e.value);
      if (!name || value === undefined) break;
      pushCapped(v.metrics, { name, value, unit: str(e.unit) ?? '', stepId: str(e.stepId) });
      break;
    }
    case 'expect.evaluated': {
      pushCapped(v.expects, {
        stepId: str(e.stepId) ?? '?',
        condition: str(e.condition) ?? '?',
        expected: e.expected,
        actual: e.actual,
        passed: e.passed === true,
      });
      break;
    }
    case 'log': {
      // "validation failed:\n  path: message" (the run never launched) → shown as the run's error.
      const m = plain(e.message);
      if (e.phase === 'input' && e.level === 'error' && m && !v.error) v.error = m;
      break;
    }
    case 'console.message': {
      const level = str(e.level) ?? 'log';
      if (level !== 'error' && level !== 'pageerror' && level !== 'warning') break;
      pushCapped(v.consoleErrors, { level, text: (plain(e.text) ?? '').slice(0, 2000), stepId: str(e.stepId) });
      break;
    }
    case 'network.failed': {
      pushCapped(v.networkFailures, {
        url: (str(e.url) ?? '').slice(0, 2000),
        method: str(e.method) ?? '?',
        status: num(e.status),
        errorText: str(e.errorText),
        durationMs: num(e.durationMs),
        stepId: str(e.stepId),
      });
      break;
    }
    default:
      break; // `log` and unknown future types: counted, not rendered.
  }
  return true;
}

/** True when some seq in 1..maxSeq has not been received. */
export function hasGap(state: RunState): boolean {
  return state.seen.size < state.view.maxSeq;
}

/** Parse steps.jsonl text into events (bad lines skipped). */
export function parseEventLines(text: string): LooseEvent[] {
  const out: LooseEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as unknown;
      if (isLooseEvent(e)) out.push(e);
    } catch {
      /* partial last line while the run is writing */
    }
  }
  return out;
}
