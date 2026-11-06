// Script detail helpers (SPEC 스크립트-보기-편집): editor validation that does not depend on
// the selected environment's secret values, and the latest-run overlay (by run.json scriptHash).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectRefs, describeStep, parseYaml, RunIndex, secretPlacementIssues, validateScript, type StepResult } from '@euta/core';
import type { ScriptRunOverlay, ValidationIssueView } from '../../shared/types.js';
import { koSecretRule } from '../../shared/secret-rules.js';

export interface EditorCheck {
  script?: Record<string, unknown>;
  issues: ValidationIssueView[];
  missingSecrets: string[];
  unstable: number;
  /** Secret-rule violations (placement) — warnings, Korean wording. */
  ruleIssues: ValidationIssueView[];
}

/** `${secrets.*}` outside fill/type values (the secret rule every local run applies), Korean wording. */
export function secretRuleIssues(text: string): ValidationIssueView[] {
  const parsed = parseYaml(text);
  if (parsed.issues.length || !parsed.value || typeof parsed.value !== 'object') return [];
  return secretPlacementIssues(parsed.value).map((i) => ({ path: i.path, message: koSecretRule(i.message) }));
}

const PLACEHOLDER = 'euta-placeholder';

/** Korean wording for the schema messages a form user can hit (duration / size text). */
function friendly(message: string): string {
  if (/must match pattern .*\(ms\|s\|m(\|h)?\)/.test(message)) return '시간 형식이 아닙니다 (예: 500, 2s, 1m)';
  if (/must match pattern .*\(b\|kb\|mb/i.test(message)) return '크기 형식이 아닙니다 (예: 512b, 10kb, 2mb)';
  return message;
}

/**
 * Validate `text` for the editor: schema + reference syntax + `vars` references block saving;
 * `${secrets.*}` / `${env.*}` values are environment matters, so missing ones are filled with a
 * placeholder and missing secret names are reported separately (a warning, names only).
 */
export function editorCheck(text: string, env: Record<string, string | undefined>, secretNames: string[]): EditorCheck {
  const parsed = parseYaml(text);
  if (parsed.issues.length) return { issues: parsed.issues, missingSecrets: [], unstable: 0, ruleIssues: [] };
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { issues: [{ path: '', message: 'script must be a YAML mapping (version, name, steps, ...)' }], missingSecrets: [], unstable: 0, ruleIssues: [] };
  }
  const refs = collectRefs(value);
  const have = new Set(secretNames);
  const secrets: Record<string, string> = {};
  const fullEnv: Record<string, string | undefined> = { ...env };
  const missing = new Set<string>();
  for (const r of refs) {
    if (r.ns === 'secrets') {
      secrets[r.key] = PLACEHOLDER;
      if (!have.has(r.key)) missing.add(r.key);
    } else if (r.ns === 'env' && (fullEnv[r.key] === undefined || fullEnv[r.key] === '')) fullEnv[r.key] = PLACEHOLDER;
  }
  const issues = validateScript(text, { env: fullEnv, secrets }).map((i) => ({ ...i, message: friendly(i.message) }));
  const steps = (value as { steps?: unknown }).steps;
  const unstable = (Array.isArray(steps) ? steps : []).reduce<number>((n, s) => n + describeStep(s).unstable, 0);
  return { script: value as Record<string, unknown>, issues, missingSecrets: [...missing].sort(), unstable, ruleIssues: secretRuleIssues(text) };
}

function flatSteps(steps: unknown, out: ScriptRunOverlay['steps'] = {}): ScriptRunOverlay['steps'] {
  for (const s of Array.isArray(steps) ? (steps as StepResult[]) : []) {
    if (!s || typeof s.stepId !== 'string') continue;
    out[s.stepId] = { status: s.status, durationMs: s.durationMs, ...(s.error ? { error: s.error } : {}), ...(s.screenshot ? { screenshot: s.screenshot } : {}), ...(s.manual ? { manual: { ...s.manual } } : {}) };
    if (s.children) flatSteps(s.children, out);
  }
  return out;
}

/** The newest run of `absPath` in `runsDir` with per-step results; hashMatch against `hash`. */
export function latestRunOverlay(runsDir: string, absPath: string, hash: string): ScriptRunOverlay | undefined {
  if (!existsSync(join(runsDir, 'index.sqlite'))) return undefined;
  let run: { id: string; dir: string; status: string; startedAt: string } | undefined;
  try {
    const want = resolve(absPath);
    run = RunIndex.with(runsDir, (idx) => idx.listRuns({ limit: 1000 }).find((r) => r.scriptPath && resolve(r.scriptPath) === want));
  } catch {
    return undefined;
  }
  if (!run) return undefined;
  let json: { scriptHash?: string; steps?: unknown; meta?: Record<string, string>; status?: string } = {};
  try {
    json = JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')) as typeof json;
  } catch {
    /* run dir gone: status only */
  }
  return {
    runId: run.id,
    status: json.status ?? run.status,
    startedAt: run.startedAt,
    ...(json.meta?.envName ? { envName: json.meta.envName } : {}),
    hashMatch: json.scriptHash === hash,
    steps: flatSteps(json.steps),
  };
}
