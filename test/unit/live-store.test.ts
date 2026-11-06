import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveStore, acceptRunDir } from '../../src/main/live-store.js';
import type { RunView } from '../../src/shared/types.js';

const RUN = '20260929-010203_demo_abc123';

function events(runDir: string): Record<string, unknown>[] {
  let seq = 0;
  const e = (type: string, p: Record<string, unknown>) => ({ type, runId: RUN, seq: ++seq, ts: new Date().toISOString(), ...p });
  return [
    e('run.started', { kind: 'script', script: { name: 'Demo' }, env: { browser: 'chromium', headless: true }, runDir }),
    e('step.started', { stepId: '1', index: 0, action: 'goto', step: { goto: '/' } }),
    e('artifact.saved', { kind: 'screenshot', path: 'screenshots/000-1-goto.png', stepId: '1' }),
    e('metric.recorded', { name: 'responseTime', value: 120, unit: 'ms', stepId: '1' }),
    e('step.finished', { stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 130 }),
    e('step.started', { stepId: '2', index: 1, action: 'expect', step: {} }),
    e('expect.evaluated', { stepId: '2', condition: 'title', expected: 'A', actual: 'B', passed: false }),
    e('console.message', { level: 'error', text: 'boom' }),
    e('console.message', { level: 'log', text: 'ignored' }),
    e('network.failed', { url: 'http://x/api', method: 'GET', status: 500 }),
    e('step.finished', { stepId: '2', index: 1, action: 'expect', status: 'failed', durationMs: 5, error: 'title mismatch' }),
    e('run.finished', { status: 'failed', summary: { total: 2, passed: 1, failed: 1, error: 0, skipped: 0 }, durationMs: 200 }),
  ];
}

describe('LiveStore', () => {
  const dirs: string[] = [];
  const tmpRunDir = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'euta-live-'));
    dirs.push(root);
    const d = join(root, RUN);
    mkdirSync(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('builds a run view from forwarded events', () => {
    const dir = tmpRunDir();
    const store = new LiveStore({ throttleMs: 0 });
    const updates: RunView[] = [];
    store.onUpdate((v) => updates.push(structuredClone(v)));
    expect(store.ingest(events(dir), 'mcp')).toBe(12);
    const v = store.get(RUN)!;
    expect(v.source).toBe('mcp');
    expect(v.name).toBe('Demo');
    expect(v.status).toBe('failed');
    expect(v.runDir).toBe(dir);
    expect(v.steps.map((s) => [s.stepId, s.status])).toEqual([['1', 'passed'], ['2', 'failed']]);
    expect(v.steps[0]?.screenshot).toBe('screenshots/000-1-goto.png');
    expect(v.latestScreenshot).toBe('screenshots/000-1-goto.png');
    expect(v.metrics).toHaveLength(1);
    expect(v.expects[0]?.passed).toBe(false);
    expect(v.consoleErrors.map((c) => c.text)).toEqual(['boom']);
    expect(v.networkFailures[0]?.status).toBe(500);
    expect(v.summary?.failed).toBe(1);
    expect(updates.length).toBeGreaterThan(0);
  });

  it('handles out-of-order and duplicate delivery', () => {
    const dir = tmpRunDir();
    const store = new LiveStore({ throttleMs: 0 });
    const evs = events(dir).reverse();
    store.ingest(evs, 'mcp');
    expect(store.ingest(evs, 'mcp')).toBe(0); // all duplicates
    const v = store.get(RUN)!;
    expect(v.status).toBe('failed');
    expect(v.steps.map((s) => [s.stepId, s.status])).toEqual([['1', 'passed'], ['2', 'failed']]);
    expect(v.eventCount).toBe(12);
  });

  it('recovers missing events from steps.jsonl in the run dir', () => {
    const dir = tmpRunDir();
    const all = events(dir);
    writeFileSync(join(dir, 'steps.jsonl'), all.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const store = new LiveStore({ throttleMs: 0, recoveryDelayMs: 60_000 });
    // Deliver only run.started and run.finished: steps 2..11 are missing.
    store.ingest([all[0], all[11]], 'mcp');
    expect(store.get(RUN)!.steps).toHaveLength(0);
    expect(store.recover(RUN)).toBe(true);
    const v = store.get(RUN)!;
    expect(v.steps).toHaveLength(2);
    expect(v.recovered).toBe(true);
    expect(v.eventCount).toBe(12);
    store.dispose();
  });

  it('ignores malformed events and untrusted run dirs', () => {
    const store = new LiveStore({ throttleMs: 0 });
    expect(store.ingest([null, 1, 'x', { type: 'log' }, { type: 'log', runId: RUN, seq: -1 }, { type: 'log', runId: RUN, seq: 1.5 }], 'mcp')).toBe(0);
    store.ingest([{ type: 'run.started', runId: RUN, seq: 1, runDir: '/etc', script: { name: 'x' }, env: {} }], 'mcp');
    expect(store.get(RUN)!.runDir).toBeUndefined();
    expect(acceptRunDir(RUN, `/tmp/runs/${RUN}`)).toBe(`/tmp/runs/${RUN}`);
    expect(acceptRunDir(RUN, `runs/${RUN}`)).toBeUndefined();
    expect(acceptRunDir(RUN, '/tmp/runs/other')).toBeUndefined();
  });

  it('strips ANSI colour codes from step errors', () => {
    const store = new LiveStore({ throttleMs: 0 });
    store.ingest([{ type: 'step.finished', runId: RUN, seq: 1, stepId: '1', index: 0, action: 'click', status: 'failed', durationMs: 1, error: 'Timeout\n\x1b[2m  - waiting for x\x1b[22m' }], 'mcp');
    expect(store.get(RUN)!.steps[0]?.error).toBe('Timeout\n  - waiting for x');
  });

  it('keeps the trusted run dir for app runs', () => {
    const dir = tmpRunDir();
    const store = new LiveStore({ throttleMs: 0 });
    store.registerAppRun(RUN, dir);
    store.ingest(events('/somewhere/else/' + RUN), 'app');
    expect(store.get(RUN)!.runDir).toBe(dir);
    expect(store.get(RUN)!.source).toBe('app');
  });
});
