// Test set report (ADR-032): previous-run selection, comparison buckets (same plan by position,
// changed plan by script + occurrence), failing step lookup, rendering (masking, no external
// requests, embedded screenshot), and buildSuiteReport over a fake run folder (selector check
// summary, timeout skipped gracefully).
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckTargetsResult } from '@euta/core';
import { buildSuiteReport, compareSuiteRuns, failingStep, previousSuiteRun, renderSuiteReport, stepById, suiteReportPath } from '../../src/main/project/suite-report.js';
import type { SuiteRun } from '../../src/shared/types.js';

const run = (id: string, startedAt: string, items: [string, SuiteRun['items'][number]['status']][], o: Partial<SuiteRun> = {}): SuiteRun => ({
  id,
  projectId: 'p1',
  suiteId: 's1',
  suiteName: 'smoke',
  envId: 'e1',
  envName: 'dev',
  stopOnFailure: false,
  startedAt,
  finishedAt: startedAt.replace(/:00\.000Z$/, ':30.000Z'),
  status: 'failed',
  items: items.map(([script, status]) => ({ script, status })),
  ...o,
});

describe('suite report', () => {
  it('previous run = newest finished run of the same set and environment, before this one', () => {
    const cur = run('c', '2026-10-23T10:00:00.000Z', [['a.yaml', 'passed']]);
    const list = [
      run('x1', '2026-10-23T09:00:00.000Z', [['a.yaml', 'failed']]),
      run('x2', '2026-10-23T09:30:00.000Z', [['a.yaml', 'failed']], { envId: 'e2' }),
      run('x3', '2026-10-23T09:40:00.000Z', [['a.yaml', 'failed']], { status: 'running' }),
      run('x4', '2026-10-23T09:50:00.000Z', [['a.yaml', 'failed']], { suiteId: 'other' }),
      run('x5', '2026-10-23T11:00:00.000Z', [['a.yaml', 'failed']]),
      cur,
    ];
    expect(previousSuiteRun(list, cur)?.id).toBe('x1');
    expect(previousSuiteRun([cur], cur)).toBeUndefined();
  });

  it('compares by position when the plan is the same, else by script + occurrence', () => {
    const prev = run('p', '2026-10-23T09:00:00.000Z', [
      ['a.yaml', 'passed'],
      ['b.yaml', 'failed'],
      ['b.yaml', 'skipped'],
      ['c.yaml', 'failed'],
      ['d.yaml', 'passed'],
    ]);
    const cur = run('c', '2026-10-23T10:00:00.000Z', [
      ['a.yaml', 'failed'],
      ['b.yaml', 'failed'],
      ['b.yaml', 'passed'],
      ['c.yaml', 'passed'],
      ['d.yaml', 'passed'],
    ]);
    const c = compareSuiteRuns(cur, prev);
    expect(c.newlyFailing).toEqual([{ order: 1, script: 'a.yaml' }]);
    expect(c.stillFailing).toEqual([{ order: 2, script: 'b.yaml' }]);
    expect(c.recovered).toEqual([{ order: 4, script: 'c.yaml' }]);
    expect(c.stillPassing).toEqual([{ order: 5, script: 'd.yaml' }]);
    // 3rd item: passed after "skipped" → in no bucket.

    // Changed plan (an item added at the front): matched by script + occurrence; a new script that fails is "새로 실패".
    const moved = run('m', '2026-10-23T11:00:00.000Z', [
      ['new.yaml', 'error'],
      ['c.yaml', 'failed'],
      ['b.yaml', 'passed'],
      ['b.yaml', 'failed'],
      ['a.yaml', 'skipped'],
    ]);
    const m = compareSuiteRuns(moved, prev);
    expect(m.newlyFailing).toEqual([
      { order: 1, script: 'new.yaml' },
      { order: 4, script: 'b.yaml' },
    ]);
    expect(m.stillFailing).toEqual([{ order: 2, script: 'c.yaml' }]);
    expect(m.recovered).toEqual([{ order: 3, script: 'b.yaml' }]);
    expect(m.stillPassing).toEqual([]);
  });

  it('finds the deepest failed step and its raw step (groups, download triggers)', () => {
    const steps = [
      { stepId: '1', status: 'passed' },
      { stepId: '2', status: 'failed', children: [{ stepId: '2.1', status: 'passed' }, { stepId: '2.2', status: 'failed' }] },
    ];
    expect(failingStep(steps)?.stepId).toBe('2.2');
    expect(failingStep([{ stepId: '1', status: 'error' }])?.stepId).toBe('1');
    expect(failingStep([{ stepId: '1', status: 'passed' }])).toBeUndefined();
    const script = { steps: [{ goto: '/' }, { group: { name: 'g', steps: [{ click: 'a' }, { fill: { target: 'b', value: 'x' } }] } }, { expectDownload: { trigger: { click: 'dl' } } }] };
    expect(stepById(script, '2.2')).toEqual({ fill: { target: 'b', value: 'x' } });
    expect(stepById(script, '3.1')).toEqual({ click: 'dl' });
    expect(stepById(script, '9')).toBeUndefined();
  });

  it('renders a self-contained page: masked text, no external URLs, comparison and failure sections', () => {
    const r = run('c', '2026-10-23T10:00:00.000Z', [
      ['a.yaml', 'failed'],
      ['b.yaml', 'passed'],
    ]);
    const html = renderSuiteReport(
      {
        run: r,
        projectName: 'Portal',
        items: [
          { order: 1, script: 'a.yaml', name: 'Login', status: 'failed', runId: 'r1', durationMs: 1200, reportHref: '../../runs/r1/report.html', failure: { stepId: '2', sentence: "'로그인' 버튼 클릭", error: 'boom TOPSECRET', screenshot: 'data:image/png;base64,AAAA' } },
          { order: 2, script: 'b.yaml', status: 'passed', alwaysRun: true },
        ],
        comparison: { previousId: 'p', previousAt: '2026-10-23T09:00:00.000Z', previousStatus: 'passed', newlyFailing: [{ order: 1, script: 'a.yaml' }], recovered: [], stillFailing: [], stillPassing: [{ order: 2, script: 'b.yaml' }] },
      },
      (s) => s.replaceAll('TOPSECRET', '***'),
    );
    expect(html).not.toContain('TOPSECRET');
    expect(html).toContain('boom ***');
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).toContain('data-testid="sr-newly-failing" data-count="1"');
    expect(html).toContain('<b>Login</b><span class="mut small">a.yaml</span>');
    expect(html).toContain("'로그인' 버튼 클릭");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('href="../../runs/r1/report.html"');
    expect(html).toContain('항상 실행');
    expect(html).toContain('1/2');
    expect(renderSuiteReport({ run: r, projectName: 'P', items: [] })).toContain('지난 실행이 없습니다');
  });

  it('buildSuiteReport reads the run folder: step sentence, error, embedded screenshot, selector check (and skips a slow one)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'euta-sr-'));
    const runs = join(root, 'runs');
    const suiteRuns = join(root, 'suite-runs');
    const mkRun = (id: string, dom: boolean) => {
      const dir = join(runs, id);
      mkdirSync(join(dir, 'screenshots'), { recursive: true });
      if (dom) mkdirSync(join(dir, 'dom'));
      writeFileSync(join(dir, 'screenshots', '002.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(join(dir, 'report.html'), '<html></html>');
      writeFileSync(
        join(dir, 'run.json'),
        JSON.stringify({
          name: 'Login flow',
          status: 'failed',
          durationMs: 2100,
          script: { steps: [{ goto: '/login' }, { click: { target: { role: 'button', name: '로그인' } } }] },
          steps: [
            { stepId: '1', action: 'goto', status: 'passed' },
            { stepId: '2', action: 'click', status: 'failed', error: 'timeout pw=hunter2', screenshot: 'screenshots/002.png' },
          ],
        }),
      );
      return dir;
    };
    const dirs: Record<string, string> = { r1: mkRun('r1', true), r2: mkRun('r2', true) };
    const cur = run('cur1234567', '2026-10-23T10:00:00.000Z', [
      ['login.yaml', 'failed'],
      ['login.yaml', 'failed'],
      ['other.yaml', 'skipped'],
    ]);
    cur.items[0]!.runId = 'r1';
    cur.items[1]!.runId = 'r2';
    const prev = run('prev123456', '2026-10-23T09:00:00.000Z', [
      ['login.yaml', 'passed'],
      ['login.yaml', 'failed'],
      ['other.yaml', 'passed'],
    ]);
    let calls = 0;
    const check = async (source: string, runDir: string): Promise<CheckTargetsResult> => {
      calls++;
      expect(JSON.parse(source)).toHaveProperty('steps');
      if (runDir === dirs.r2) return new Promise(() => undefined); // never settles → skipped by the timeout
      return {
        scriptMatchesRun: false,
        source: 'dom',
        summary: { ok: 1, missing: 1, ambiguous: 0, present: 0, dynamic: 0, 'no-snapshot': 0, skipped: 0 },
        steps: [{ stepId: '2', step: '…', use: 'click', target: { role: 'button', name: '로그인' }, count: 0, verdict: 'missing' }],
      };
    };
    const file = await buildSuiteReport({
      run: cur,
      projectName: 'Portal',
      history: [prev, cur],
      runDir: (id) => dirs[id],
      names: new Map([['other.yaml', 'Other script']]),
      suiteRunsDir: suiteRuns,
      redact: (s) => s.replaceAll('hunter2', '***'),
      check,
      checkTimeoutMs: 200,
    });
    expect(file).toBe(suiteReportPath(suiteRuns, cur.id));
    expect(file).toBe(join(suiteRuns, cur.id, 'report.html'));
    const html = readFileSync(file, 'utf8');
    expect(calls).toBe(2);
    expect(html).toContain("'로그인' 버튼");
    expect(html).toContain('timeout pw=***');
    expect(html).not.toContain('hunter2');
    expect(html).toContain('src="data:image/png;base64,iVBORw=="');
    expect(html).toContain('href="../../runs/r1/report.html"');
    expect(html).toContain('<b>Other script</b>');
    expect(html.match(/data-testid="sr-check"/g)).toHaveLength(1);
    expect(html).toContain('없음 1');
    expect(html).toContain('data-testid="sr-newly-failing" data-count="1"');
    expect(html).toContain('data-testid="sr-still-failing" data-count="1"');
  });
});
