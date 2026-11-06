// Step-level editor model (SPEC 스크립트-보기-편집 완료 기준): add / delete / duplicate / reorder /
// group in-out / header → serialized through the engine's rewriteScript → schema-valid, and the
// untouched parts keep their comments and order.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeStep, parseYaml, rewriteScript, scriptFromEdit, validateScriptObject, type ScriptEdit } from '@euta/core';
import {
  addStep,
  deleteStep,
  duplicateStep,
  flatten,
  fromModel,
  getStep,
  groupIn,
  groupOut,
  issueStepPath,
  moveDown,
  moveStep,
  moveUp,
  NEW_STEP_KINDS,
  setHeader,
  setStep,
  stepIdOf,
  toModel,
  toPayload,
  type EModel,
} from '../../src/shared/script-model.js';

const SRC = `# Report export — kept comment
version: 1
name: Export
target:
  baseUrl: \${env.BASE_URL}
steps:
  # open the login page
  - goto: /login
  - fill: { target: { label: 이메일 }, value: "\${secrets.USER_EMAIL}" } # email
  - group:
      name: 로그인
      steps:
        # submit
        - click: { target: { role: button, name: 로그인 } }
        - expect: { url: /dashboard }
  - measure: [web-vitals, timing]
`;

const parse = (t: string) => parseYaml(t).value as Record<string, unknown>;
const model = (): EModel => toModel(parse(SRC));
const save = (m: EModel): string => rewriteScript(SRC, toPayload(m) as ScriptEdit);
const valid = (text: string) => validateScriptObject(parse(text));
const sentences = (text: string) => (parse(text).steps as unknown[]).map((s) => describeStep(s).sentence);

describe('editor model → rewriteScript', () => {
  it('round-trips an untouched model byte for byte', () => {
    expect(save(model())).toBe(SRC);
    expect(fromModel(model())).toEqual(parse(SRC));
    expect(scriptFromEdit(toPayload(model()) as ScriptEdit)).toEqual(parse(SRC));
  });

  it('changing a value rewrites only that step', () => {
    const m = model();
    const fill = getStep(m, [1])!;
    const out = save(setStep(m, [1], { fill: { ...(fill.step.fill as object), value: '${secrets.ADMIN_EMAIL}' } }));
    expect(out).toBe(SRC.replace('USER_EMAIL', 'ADMIN_EMAIL'));
  });

  it('adds every new-step kind at a position; result validates', () => {
    let m = model();
    for (const k of NEW_STEP_KINDS) if (k.kind !== 'group') m = addStep(m, [m.steps.length], k.make());
    m = addStep(m, [0], { goto: '/start' });
    const out = save(m);
    const issues = valid(out);
    expect(issues).toEqual([]);
    expect(sentences(out)[0]).toBe('/start 으로 이동');
    expect(out).toContain('# open the login page\n  - goto: /login');
    expect(out).toContain('# Report export — kept comment');
  });

  it('a filled-in new step is valid and written compactly', () => {
    const m = addStep(model(), [4], { expect: { text: { target: { testId: 'total' }, equals: '1,200' } }, name: '합계 확인' });
    const out = save(m);
    expect(valid(out)).toEqual([]);
    expect(out).toContain('  - expect: { text: { target: { testId: total }, equals: "1,200" } }\n    name: 합계 확인\n');
    expect(out.slice(0, out.indexOf('  - measure'))).toBe(SRC.slice(0, SRC.indexOf('  - measure')));
  });

  it('deletes and duplicates', () => {
    const del = save(deleteStep(model(), [1]));
    expect(del).not.toContain('fill');
    expect(del).toContain('# open the login page');
    const dup = save(duplicateStep(model(), [0]));
    expect(sentences(dup).slice(0, 2)).toEqual(['/login 으로 이동', '/login 으로 이동']);
    expect(valid(dup)).toEqual([]);
    expect(getStep(duplicateStep(model(), [2]), [3])!.children).toHaveLength(2);
  });

  it('reorders (drag target index, up, down); moved steps keep their comments', () => {
    const out = save(moveStep(model(), [0], 3));
    expect(sentences(out)).toEqual(["'이메일' 입력란에 🔒USER_EMAIL 입력", '묶음: 로그인 (단계 2개)', '측정: Web Vitals · 시간', '/login 으로 이동']);
    expect(out).toMatch(/# open the login page\n {2}- goto: \/login\n$/);
    expect(valid(out)).toEqual([]);
    expect(sentences(save(moveDown(model(), [0])))[1]).toBe('/login 으로 이동');
    expect(sentences(save(moveUp(model(), [1])))[0]).toBe("'이메일' 입력란에 🔒USER_EMAIL 입력");
    const m0 = model();
    expect(moveUp(m0, [0])).toBe(m0); // no-op at the top
    const inner = save(moveUp(model(), [2, 1]));
    expect(inner).toMatch(/- expect: \{ url: \/dashboard \}\n\s+# submit\n\s+- click/);
  });

  it('group in / out: into the group above, wrapped in a new group, and back out', () => {
    // fill → the step above is not a group: wrapped in a new one.
    const wrapped = groupIn(model(), [1], '입력 묶음');
    expect(getStep(wrapped, [1])!.step).toEqual({ group: { name: '입력 묶음' } });
    expect(valid(save(wrapped))).toEqual([]);
    // measure → into the 로그인 group above it.
    const into = groupIn(model(), [3]);
    const out = save(into);
    expect(valid(out)).toEqual([]);
    const g = (parse(out).steps as Record<string, any>[])[2]!.group;
    expect(g.steps.map((s: object) => Object.keys(s)[0])).toEqual(['click', 'expect', 'measure']);
    expect(out).toContain('        - measure: [web-vitals, timing]\n');
    // The group's first child out → right below the group; its comment travels along.
    const outOf = save(groupOut(model(), [2, 0]));
    expect(sentences(outOf)).toEqual(['/login 으로 이동', "'이메일' 입력란에 🔒USER_EMAIL 입력", '묶음: 로그인 (단계 1개)', "'로그인' 버튼 클릭", '측정: Web Vitals · 시간']);
    expect(outOf).toMatch(/ {2}# submit\n {2}- click/);
    expect(valid(outOf)).toEqual([]);
    const top = model();
    expect(groupOut(top, [0])).toBe(top); // already top level
  });

  it('header info (name, description, defaults, record, vars, browser) keeps the steps verbatim', () => {
    const m = model();
    const out = save(
      setHeader(m, {
        ...m.header,
        name: 'Export v2',
        description: '보고서 내보내기',
        defaults: { timeout: '10s', settle: 'network-idle', input: 'browser' },
        record: { video: false, screenshots: 'on-failure' },
        vars: { reportName: 'Monthly' },
        browser: { engine: 'chromium', viewport: { width: 1280, height: 800 } },
      }),
    );
    expect(valid(out)).toEqual([]);
    expect(out.slice(out.indexOf('steps:'))).toBe(SRC.slice(SRC.indexOf('steps:')));
    expect(parse(out)).toMatchObject({ name: 'Export v2', vars: { reportName: 'Monthly' }, defaults: { timeout: '10s' } });
    expect(out.startsWith('# Report export — kept comment\n')).toBe(true);
  });

  it('a new group gets steps added inside it', () => {
    let m = addStep(model(), [4], NEW_STEP_KINDS.find((k) => k.kind === 'group')!.make());
    m = addStep(m, [4, 0], { wait: { ms: 200 } });
    const out = save(m);
    expect(valid(out)).toEqual([]);
    expect((parse(out).steps as Record<string, any>[])[4]).toEqual({ group: { name: '새 묶음', steps: [{ wait: { ms: 200 } }] } });
  });

  it('paths, ids and issue mapping', () => {
    expect(flatten(model()).map((f) => [stepIdOf(f.path), f.depth])).toEqual([
      ['1', 0],
      ['2', 0],
      ['3', 0],
      ['3.1', 1],
      ['3.2', 1],
      ['4', 0],
    ]);
    expect(issueStepPath('steps[2].group.steps[0].click.target')).toEqual([2, 0]);
    expect(issueStepPath('steps[4]')).toEqual([4]);
    expect(issueStepPath('name')).toBeUndefined();
  });

  it('works on the shipped examples (edit one step → only it changes)', () => {
    const p = resolve(import.meta.dirname, '../../../euta-engine/examples/login-download.yaml');
    const text = readFileSync(p, 'utf8');
    const m = toModel(parse(text));
    const out = rewriteScript(text, toPayload(setStep(m, [0], { goto: '/signin' })) as ScriptEdit);
    expect(out).toBe(text.replace('  - goto: /login', '  - goto: /signin'));
  });
});
