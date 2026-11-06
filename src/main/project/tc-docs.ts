// TC document conversion, app side (SPEC TC-문서-변환): import sessions (preview · AI extraction),
// the saved documents, conversion chats (one chat, one TC at a time, a persisted queue), test set
// plans and export. Electron-free; ProjectService hosts it and index.ts maps IPC onto it.
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { exportTcDocument, groupPreconditions, parseTcDocument, scriptsToTcs, validateTcs, type Tc, type ValidateResult } from '@euta/tc-doc';
import type {
  ActivityActor,
  ActivityEvent,
  ChatView,
  ScriptEntry,
  TcDoc,
  TcDocSummary,
  TcConvertEnd,
  TcConvertProgress,
  TcDocTc,
  TcDocView,
  TcExportFormat,
  TcImportConfirm,
  TcImportView,
  TcInput,
  TcMappingView,
  TcPrecondition,
  TcSetGrouping,
  TcSetPlan,
  TcStepMapping,
} from '../../shared/types.js';
import type { ChatEngine, TurnOutcome } from '../ai/chat-engine.js';
import { InputError } from './project-store.js';
import { parseScript } from './script-history.js';
import { TcDocStore, type ConversionPatch, type ConversionTarget } from './tc-doc-store.js';

/** Largest TC document file read (bytes). */
export const TC_FILE_LIMIT = 20 * 1024 * 1024;
export const TC_EXTENSIONS = ['xlsx', 'csv', 'docx', 'md'] as const;

export interface TcDocsHost {
  /** Project folder (throws for an unknown project). */
  projectDir(projectId: string): string;
  log(projectId: string, kind: string, actor: ActivityActor, summary: string, ref?: ActivityEvent['ref']): void;
  scripts(projectId: string): ScriptEntry[];
  readScript(projectId: string, rel: string): string | undefined;
  chatEngine(projectId: string): ChatEngine;
  /** A document changed (renderer refresh). */
  docChanged?(projectId: string, docId: string): void;
  importChanged?(view: TcImportView): void;
  now?: () => Date;
}

interface ImportSession {
  view: TcImportView;
  /** Cell text of an unrecognized layout — AI extraction input; dropped with the session. */
  gridText?: string;
}

/** What a conversion / extraction chat may do with TC documents (the AI tools). */
export interface TcDocAccess {
  docs(): TcDocSummary[];
  doc(docId: string): TcDoc | undefined;
  /** get_tc: the TC, its precondition, file names; a queued TC becomes 변환 중 for this chat. */
  readTc(docId: string, tcId: string): TcRead;
  setConversion(docId: string, id: string, patch: ConversionPatch): { target: ConversionTarget; queue: string[] };
  importGrid(importId: string): { fileName: string; format: string; gridText: string; warnings: string[] } | undefined;
  saveExtraction(importId: string, tcs: unknown): ValidateResult;
}

export interface TcRead {
  doc: { id: string; name: string };
  tc: TcDocTc;
  precondition?: TcPrecondition & { file: string; tcIds: string[] };
  /** Suggested library file for this TC (`<TC ID>-<slug>.yaml`). */
  file: string;
  queue: string[];
}

const SLUG_KEEP = /[^a-z0-9가-힣]+/g;

/** File-name part from a title: lowercase letters, digits and Hangul (NFC), dash-joined, ≤ 40 chars. */
export function tcSlug(title: string): string {
  return title.normalize('NFC').toLowerCase().replace(SLUG_KEEP, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}

const safeId = (id: string): string => id.normalize('NFC').replace(/[^A-Za-z0-9가-힣_-]+/g, '-').replace(/^-+|-+$/g, '') || 'TC';

/** `<TC ID>-<slug>.yaml` (SPEC 변환 규칙). */
export function tcFileName(tc: { id: string; title: string }): string {
  const slug = tcSlug(tc.title);
  return `${safeId(tc.id)}${slug ? `-${slug}` : ''}.yaml`;
}

/** `pre-<n>-<slug>.yaml` for a precondition group `pre-<n>`. */
export function preFileName(p: { id: string; text: string }): string {
  const slug = tcSlug(p.text.split('\n')[0] ?? '');
  return `${safeId(p.id)}${slug ? `-${slug}` : ''}.yaml`;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const stepsOf = (v: unknown): unknown[] => (isObj(v) && Array.isArray(v.steps) ? v.steps : []);

/** Manual steps in a parsed script (groups included). */
function manualIn(steps: unknown[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (!isObj(s)) continue;
    if ('manual' in s) {
      const m = s.manual;
      out.push(typeof m === 'string' ? m : isObj(m) && typeof m.instruction === 'string' ? m.instruction : '');
    } else if (isObj(s.group)) out.push(...manualIn(stepsOf(s.group)));
  }
  return out;
}

export function countManualSteps(source: string | undefined): number {
  if (source === undefined) return 0;
  return manualIn(stepsOf(parseScript(source))).length;
}

/** TC step → script group ("<no>. …") with automated / manual / missing marks (TC 줄 펼치기). */
export function mappingFor(tc: TcDocTc, source: string | undefined): Omit<TcMappingView, 'tcId' | 'script' | 'exists'> {
  const top = stepsOf(source === undefined ? undefined : parseScript(source));
  const groups = top.flatMap((s) => (isObj(s) && isObj(s.group) && typeof s.group.name === 'string' ? [{ name: s.group.name, steps: stepsOf(s.group) }] : []));
  const used = new Set<string>();
  const steps: TcStepMapping[] = tc.steps.map((st) => {
    const g = groups.find((x) => !used.has(x.name) && new RegExp(`^\\s*${st.no}\\s*[.)]\\s`).test(`${x.name} `));
    if (!g) return { no: st.no, action: st.action, ...(st.expected ? { expected: st.expected } : {}), kind: 'missing', manual: [] };
    used.add(g.name);
    const manual = manualIn(g.steps);
    const auto = g.steps.filter((s) => isObj(s) && !('manual' in s)).length;
    const kind = manual.length && auto ? 'partial' : manual.length ? 'manual' : 'auto';
    return { no: st.no, action: st.action, ...(st.expected ? { expected: st.expected } : {}), group: g.name, kind, manual };
  });
  const ungrouped = top.filter((s) => !(isObj(s) && isObj(s.group))).length;
  return { steps, ungrouped };
}

/** The engine's TC shape of a stored TC (original text, for export). */
export function engineTc(t: TcDocTc): Tc {
  return {
    id: t.id,
    title: t.title,
    ...(t.category ? { category: t.category } : {}),
    ...(t.description ? { description: t.description } : {}),
    ...(t.precondition ? { precondition: t.precondition } : {}),
    ...(t.screens?.length ? { screens: [...t.screens] } : {}),
    steps: t.steps.map((s) => ({ no: s.no, action: s.action, ...(s.expected ? { expected: s.expected } : {}) })),
  };
}

/**
 * Test sets from a document (SPEC "테스트 세트 만들기 ④"): 문서 전체 → 1 · 분류별 → one per category ·
 * 체크한 TC → 1. Each set: the precondition scripts its TCs use first, then the TC scripts in document
 * order. TCs not converted (or whose script is gone) are left out and listed.
 */
export function planTestSets(doc: TcDoc, mode: TcSetGrouping, checked: readonly string[], exists: (rel: string) => boolean): TcSetPlan {
  const pool = mode === 'checked' ? doc.tcs.filter((t) => checked.includes(t.id)) : doc.tcs;
  const groups: { key: string; name: string; category?: string; tcs: TcDocTc[] }[] = [];
  if (mode === 'category') {
    for (const t of pool) {
      const cat = t.category?.trim() || '분류 없음';
      let g = groups.find((x) => x.category === cat);
      if (!g) groups.push((g = { key: `cat:${cat}`, name: `${doc.name} · ${cat}`, category: cat, tcs: [] }));
      g.tcs.push(t);
    }
  } else groups.push({ key: mode, name: mode === 'all' ? doc.name : `${doc.name} · 선택한 TC`, tcs: [...pool] });
  const skipped: TcSetPlan['skipped'] = [];
  const sets: TcSetPlan['sets'] = [];
  for (const g of groups) {
    const ok: TcDocTc[] = [];
    for (const t of g.tcs) {
      const s = t.conversion.script;
      if (t.conversion.status !== 'done') skipped.push({ tcId: t.id, title: t.title, reason: t.conversion.status === 'excluded' ? '제외' : '변환 안 됨' });
      else if (!s || !exists(s)) skipped.push({ tcId: t.id, title: t.title, reason: '스크립트 없음' });
      else ok.push(t);
    }
    if (!ok.length) continue;
    const pre: string[] = [];
    for (const t of ok) {
      const p = doc.preconditions.find((x) => x.id === t.preconditionId);
      if (p?.script && p.status === 'done' && exists(p.script) && !pre.includes(p.script)) pre.push(p.script);
    }
    const tcScripts = ok.map((t) => t.conversion.script!).filter((s, i, a) => a.indexOf(s) === i && !pre.includes(s));
    sets.push({ key: g.key, name: g.name, ...(g.category ? { category: g.category } : {}), scripts: [...pre, ...tcScripts], tcIds: ok.map((t) => t.id), preconditionScripts: pre });
  }
  return { sets, skipped };
}

const newImportId = (): string => randomBytes(8).toString('hex');

/** The next message of an auto conversion: the queue head, or its precondition script first. */
export type ConvertItem = { kind: 'tc'; tc: TcDocTc } | { kind: 'precondition'; tc: TcDocTc; pre: TcPrecondition };

const FINAL_STATUS = new Set(['done', 'failed', 'excluded']);

/** Queue head (done / excluded TCs are passed over); a precondition that is not final yet comes first. */
export function nextConvertItem(d: TcDoc): ConvertItem | undefined {
  for (const id of d.queue) {
    const tc = d.tcs.find((t) => t.id === id);
    if (!tc || tc.conversion.status === 'done' || tc.conversion.status === 'excluded') continue;
    const pre = d.preconditions.find((p) => p.id === tc.preconditionId);
    return pre && !FINAL_STATUS.has(pre.status) ? { kind: 'precondition', tc, pre } : { kind: 'tc', tc };
  }
  return undefined;
}

/** The item reached done · failed · excluded (a TC also when it left the queue). */
export function itemFinished(d: TcDoc, item: ConvertItem): boolean {
  if (item.kind === 'precondition') return FINAL_STATUS.has(d.preconditions.find((p) => p.id === item.pre.id)?.status ?? 'done');
  const tc = d.tcs.find((t) => t.id === item.tc.id);
  return !tc || !d.queue.includes(tc.id) || FINAL_STATUS.has(tc.conversion.status);
}

/** Judging rule repeated in every item message (SPEC "AI 변환" 3, 2026-11-05). */
export const STRICT_EXPECT_KO =
  '기대 결과는 TC 문장대로 판정합니다 — 사이트가 문서와 달라도 판정을 사이트에 맞춰 느슨하게 바꾸지 않습니다(띄어쓰기 허용 · 부분 일치로 바꾸기 등 포함). 그대로 두어 실패로 기록하고 그 차이를 note 에 적으세요. 대상을 찾는 선택자는 실제 화면에 맞춥니다.';

/** The 2026-11-05 field comparison guidance (SPEC "AI 변환" 3), repeated in every TC message. */
export const TC_RULES_KO = [
  '- 버튼 · 옵션 · 칩 문구는 정규식 · 부분 일치로 바꾸지 않습니다. 글자 일치가 필요하면 `^…$` 전체 일치.',
  '- "기억 → 같은지 확인" 은 시험 데이터 값을 vars 로 고정해 자동 판정합니다. 그럴 수 없을 때만 그 비교 한 곳을 manual 로 — 판정 없이 "적어 둔다" 만 하는 manual 은 만들지 않습니다. 판정을 약하게 바꿨으면 note 에 적습니다.',
  '- 데이터를 바꾸는 TC 는 "첫 행" 대신 이름(같으면 생성 일시)으로 대상을 특정하고, 다른 TC 사전 조건용 데이터는 쓰지 않습니다. 바꾼 값은 끝에서 원래 값으로 되돌린 것까지 확인합니다.',
  '- 개수 판정은 TC 가 가리키는 영역 안으로 범위를 좁힙니다. 대상 · 조건에는 스키마에 있는 키만 씁니다(모르면 get_schema).',
];

/** One AI message = one queue item (SPEC "AI 변환", 2026-11-05). `attempt` 2 = the same item again after a message that did not finish it. */
export function itemPrompt(d: TcDoc, item: ConvertItem, o: { n: number; total: number; attempt: number; redo?: boolean; extra?: string }): string {
  const retry =
    o.attempt > 1
      ? [
          '',
          `(재시도 ${o.attempt}/2) 앞 메시지가 왕복 한도에 닿았거나 결과를 기록하지 못하고 끝나 이 항목이 끝나지 않았습니다. 이미 저장한 스크립트가 있으면 read_file 로 읽고 이어서 마무리하세요. 이번에도 통과시키지 못하면 failed 와 원인 한 줄(note)로 기록하세요.`,
        ]
      : [];
  const tail = [...retry, ...(o.redo ? ['', '이전에 변환한 결과를 다시 만드는 요청입니다 (같은 파일을 덮어써도 됩니다).'] : []), ...(o.extra ? ['', `덧붙일 말: ${o.extra}`] : [])];
  if (item.kind === 'precondition') {
    const users = d.tcs.filter((t) => t.preconditionId === item.pre.id).map((t) => t.id);
    return [
      `TC 문서 "${d.name}" 자동 변환 (${o.n} / ${o.total}) — 이 메시지에서는 사전 조건 스크립트 하나만 만듭니다 (다음 TC ${item.tc.id} 가 씁니다).`,
      `tcConvert: ${d.id} ${item.pre.id}`,
      `사전 조건 ${item.pre.id}: ${item.pre.text}`,
      `파일: ${item.pre.script ?? preFileName(item.pre)}`,
      `이 사전 조건을 쓰는 TC: ${users.join(', ')}`,
      '이 상태를 만드는 스크립트를 위 파일로 save_script → validate_script → run_script 하고, set_tc_conversion { docId, id: "' + item.pre.id + '", status, script } 로 기록한 뒤 한 줄로 보고하고 끝내세요. 만든 상태(이름 등)는 vars 의 고정 이름으로 둡니다. TC 변환은 앱이 다음 메시지로 보냅니다.',
      ...tail,
    ].join('\n');
  }
  const pre = d.preconditions.find((p) => p.id === item.tc.preconditionId);
  return [
    `TC 문서 "${d.name}" 자동 변환 (${o.n} / ${o.total}) — 이 메시지에서는 TC 하나만 변환합니다.`,
    `tcConvert: ${d.id} ${item.tc.id}`,
    `TC: ${item.tc.id} ${item.tc.title}`,
    ...(pre ? [`사전 조건 ${pre.id}: ${pre.status === 'done' && pre.script ? `스크립트 ${pre.script} (완료)` : `${STATUS_KO[pre.status] ?? pre.status} — TC 스크립트는 각자 로그인부터 시작합니다`}`] : []),
    'get_tc 로 읽고 실제 화면에서 대상을 확인한 뒤 save_script → validate_script → run_script(실패하면 원인을 찾아 최대 3번 고침) → set_tc_conversion 으로 결과를 남기고 한 줄로 보고한 뒤 끝내세요. 다음 항목은 앱이 보냅니다.',
    STRICT_EXPECT_KO,
    ...TC_RULES_KO,
    ...tail,
  ].join('\n');
}

interface AutoRun {
  projectId: string;
  docId: string;
  docName: string;
  chatId: string;
  total: number;
  done: number;
  current?: TcConvertProgress['current'];
  stopping: boolean;
  redo: boolean;
  extra: string;
}

const END_KO: Record<TcConvertEnd['reason'], string> = { empty: '대기열을 모두 마쳤습니다', stopped: '중지했습니다', limit: '자동으로 진행할 개수에 닿았습니다', error: '오류로 멈췄습니다' };

export class TcDocs {
  private readonly imports = new Map<string, ImportSession>();
  /** One auto conversion per document at a time: `<projectId>/<docId>` → its run (removed when the run stops). */
  private readonly runs = new Map<string, AutoRun>();
  /** How the last run of a document stopped (memory only). */
  private readonly ended = new Map<string, TcConvertEnd>();

  constructor(private readonly h: TcDocsHost) {}

  /** Projects whose stale 변환 중 marks were released in this app run. */
  private readonly released = new Set<string>();

  store(projectId: string): TcDocStore {
    const st = new TcDocStore(`${this.h.projectDir(projectId)}/tc-docs`, this.h.now);
    // First use in this app run: no conversion can be running yet, so a leftover 변환 중 is from a quit mid-turn.
    if (!this.released.has(projectId)) {
      this.released.add(projectId);
      st.releaseAll();
    }
    return st;
  }

  // ---- import (① ②) ----------------------------------------------------------------

  /** Read a file and detect its layout; the original bytes are not kept. */
  importFile(projectId: string, filePath: string): TcImportView {
    this.h.projectDir(projectId);
    const ext = extname(filePath).slice(1).toLowerCase();
    if (!(TC_EXTENSIONS as readonly string[]).includes(ext)) throw new InputError('xlsx · csv · docx · md 파일만 가져올 수 있습니다');
    if (statSync(filePath).size > TC_FILE_LIMIT) throw new InputError('파일이 너무 큽니다 (20MB 까지)');
    const fileName = basename(filePath);
    const r = parseTcDocument(new Uint8Array(readFileSync(filePath)), fileName);
    const importId = newImportId();
    const view: TcImportView = {
      importId,
      projectId,
      fileName,
      format: r.format,
      layout: r.layout,
      tcs: r.tcs as TcInput[],
      warnings: r.warnings,
      status: r.layout === 'unknown' || !r.tcs.length ? 'needs-ai' : 'ready',
    };
    this.imports.set(importId, { view, ...(r.gridText ? { gridText: r.gridText } : {}) });
    return structuredClone(view);
  }

  importView(importId: string): TcImportView | undefined {
    const s = this.imports.get(importId);
    return s && structuredClone(s.view);
  }

  private session(importId: string): ImportSession {
    const s = this.imports.get(importId);
    if (!s) throw new InputError('가져오기가 끝났거나 없습니다 — 파일을 다시 고르세요');
    return s;
  }

  private emitImport(s: ImportSession): void {
    this.h.importChanged?.(structuredClone(s.view));
  }

  /** `unknown` layout: a new project chat reads the grid (get_tc_import) and submits TCs (save_tc_extraction). */
  extractWithAi(projectId: string, importId: string, envId?: string): ChatView {
    const s = this.session(importId);
    if (s.view.projectId !== projectId) throw new InputError('다른 프로젝트의 가져오기입니다');
    if (!s.gridText) throw new InputError('AI 가 읽을 표(격자)가 없습니다 — 표가 있는 문서인지 확인하세요');
    const engine = this.h.chatEngine(projectId);
    const chat = engine.create(envId || undefined);
    s.view.status = 'extracting';
    s.view.chatId = chat.id;
    this.emitImport(s);
    const prompt = [
      `TC 문서 "${s.view.fileName}" 의 양식을 앱이 알아보지 못했습니다. 표(격자)에서 TC 를 읽어 정리해 주세요.`,
      `tcExtract: ${importId}`,
      'get_tc_import 로 격자 텍스트를 읽고, TC 마다 ID · 제목 · 분류 · 설명 · 사전 조건 · 단계(번호 · 절차 · 기대 결과)를 정리해 save_tc_extraction 으로 제출하세요. 오류가 돌아오면 고쳐서 다시 제출하세요.',
    ].join('\n');
    void engine.send(chat.id, prompt).catch(() => undefined);
    return engine.get(chat.id) ?? chat;
  }

  cancelImport(importId: string): void {
    this.imports.delete(importId);
  }

  /** [확정]: store the TCs as the person left them; the import (and its grid text) is dropped. */
  confirmImport(projectId: string, importId: string, c: TcImportConfirm): TcDoc {
    const s = this.session(importId);
    if (s.view.projectId !== projectId) throw new InputError('다른 프로젝트의 가져오기입니다');
    const tcs = (c.tcs ?? []).map((t) => ({ ...t, steps: (t.steps ?? []).map((st, i) => ({ ...st, no: i + 1 })) }));
    const v = validateTcs(tcs);
    if (!v.ok) throw new InputError(`TC 를 확인하세요: ${v.issues.slice(0, 5).map((i) => `${i.path} ${i.message}`).join('; ')}`);
    const groups = Array.isArray(c.preconditions) ? c.preconditions.map((g) => ({ text: String(g.text ?? ''), tcIds: Array.isArray(g.tcIds) ? g.tcIds.map(String) : [] })) : groupPreconditions(v.tcs);
    const doc = this.store(projectId).create({
      name: c.name || s.view.fileName.replace(/\.[^.]+$/, ''),
      source: { fileName: s.view.fileName, format: s.view.format, layout: s.view.layout, importedAt: '', ...(s.view.extractedByAi ? { extractedByAi: true } : {}) },
      tcs: v.tcs as TcInput[],
      preconditions: groups,
    });
    this.imports.delete(importId);
    this.h.log(projectId, 'tcdoc.imported', 'user', `TC 문서 가져오기: ${doc.name} (${s.view.fileName}, TC ${doc.tcs.length}개, 사전 조건 ${doc.preconditions.length}개${s.view.extractedByAi ? ', AI 추출' : ''})`, { tcDocId: doc.id });
    this.h.docChanged?.(projectId, doc.id);
    return doc;
  }

  // ---- documents --------------------------------------------------------------------

  list(projectId: string): TcDocSummary[] {
    return this.store(projectId).list();
  }

  view(projectId: string, docId: string): TcDocView {
    const d = this.store(projectId).require(docId);
    const byPath = new Map(this.h.scripts(projectId).map((s) => [s.path, s]));
    const scripts: TcDocView['scripts'] = {};
    const refs = [...d.tcs.map((t) => t.conversion.script), ...d.preconditions.map((p) => p.script)].filter((x): x is string => !!x);
    for (const r of refs) {
      const e = byPath.get(r);
      scripts[r] = { exists: !!e, ...(e?.name ? { name: e.name } : {}), ...(e?.lastRun ? { lastRun: { status: e.lastRun.status, startedAt: e.lastRun.startedAt } } : {}) };
    }
    const key = `${projectId}/${docId}`;
    const run = this.runs.get(key);
    const end = this.ended.get(key);
    return { ...d, scripts, ...(run ? { activeChatId: run.chatId, progress: progressOf(run) } : {}), ...(end ? { lastRun: { ...end } } : {}) };
  }

  rename(projectId: string, docId: string, name: string): TcDoc {
    const d = this.store(projectId).rename(docId, name);
    this.h.docChanged?.(projectId, docId);
    return d;
  }

  delete(projectId: string, docId: string): void {
    const d = this.store(projectId).require(docId);
    this.store(projectId).delete(docId);
    this.h.log(projectId, 'tcdoc.deleted', 'user', `TC 문서 삭제: ${d.name} (스크립트는 남김)`, { tcDocId: docId });
    this.h.docChanged?.(projectId, docId);
  }

  setQueue(projectId: string, docId: string, tcIds: string[]): TcDoc {
    const d = this.store(projectId).setQueue(docId, tcIds);
    this.h.docChanged?.(projectId, docId);
    return d;
  }

  /** [제외] / [포함]: a TC left out of conversion (and test sets), or back to 대기. */
  exclude(projectId: string, docId: string, tcId: string, excluded: boolean): TcDoc {
    const { doc } = this.store(projectId).setConversion(docId, tcId, excluded ? { status: 'excluded', note: '사람이 변환에서 뺌' } : { status: 'pending' });
    this.h.docChanged?.(projectId, docId);
    return doc;
  }

  mapping(projectId: string, docId: string, tcId: string): TcMappingView {
    const d = this.store(projectId).require(docId);
    const tc = d.tcs.find((t) => t.id === tcId);
    if (!tc) throw new InputError('TC not found');
    const script = tc.conversion.script;
    const source = script ? this.h.readScript(projectId, script) : undefined;
    return { tcId, ...(script ? { script } : {}), exists: source !== undefined, ...mappingFor(tc, source) };
  }

  // ---- conversion (③) -----------------------------------------------------------------

  /**
   * [AI로 변환] (tcIds = checked, in check order → the new queue) · [다시 변환] (redo: those TCs back
   * to 대기 first) · [이어서 변환] (no tcIds: the remaining queue). One new chat; the app sends one
   * message per queue item and the next item when a message ends (auto conversion, `limit` TCs at most).
   */
  convert(projectId: string, docId: string, o: { tcIds?: string[]; redo?: boolean; envId?: string; message?: string; limit?: number } = {}): ChatView {
    const st = this.store(projectId);
    st.require(docId);
    // One auto conversion per document: a second start would work the same queue in a second chat.
    if (this.activeChat(projectId, docId)) throw new InputError('이 문서의 변환 채팅이 이미 진행 중입니다 — 끝나거나 멈춘 뒤 다시 시작하세요');
    if (o.redo && o.tcIds?.length) st.reset(docId, o.tcIds);
    let d = o.tcIds?.length ? st.setQueue(docId, o.tcIds) : st.require(docId);
    // TCs already converted are not redone unless asked ([다시 변환]).
    const todo = d.queue.filter((id) => {
      const t = d.tcs.find((x) => x.id === id);
      return t && t.conversion.status !== 'done' && t.conversion.status !== 'excluded';
    });
    if (todo.length !== d.queue.length) d = st.setQueue(docId, todo);
    if (!d.queue.length) throw new InputError('변환할 TC 가 없습니다 — 변환할 TC 를 체크하세요 (이미 완료된 TC 는 [다시 변환])');
    const limit = Math.floor(Number(o.limit));
    const total = limit >= 1 ? Math.min(limit, d.queue.length) : d.queue.length;
    const engine = this.h.chatEngine(projectId);
    const chat = engine.create(o.envId || undefined);
    const key = `${projectId}/${docId}`;
    const run: AutoRun = { projectId, docId, docName: d.name, chatId: chat.id, total, done: 0, stopping: false, redo: !!o.redo, extra: String(o.message ?? '').trim().slice(0, 4000) };
    this.runs.set(key, run);
    this.ended.delete(key);
    this.h.log(projectId, 'tcdoc.converted', 'user', `TC 변환 요청${o.redo ? ' (다시 변환)' : ''}: ${d.name} — 자동 진행 ${total}개 / 대기열 ${d.queue.length}개 (${d.queue.join(', ')})`, { tcDocId: d.id, chatId: chat.id });
    // The first message goes out synchronously (the returned chat is already busy).
    void this.drive(run, engine).catch(() => undefined);
    this.h.docChanged?.(projectId, docId);
    return engine.get(chat.id) ?? chat;
  }

  /**
   * The auto conversion loop: one message per item; after each message the item's state decides —
   * finished → next · round-trip limit (or ended without a record) → the same item once more, a second
   * time → 실패 ("두 번 시도에도 끝나지 않음") · Stop → stop · other errors → stop (the item stays 대기,
   * releaseChat). Also stops when the queue is empty or `total` TCs are finished.
   */
  private async drive(run: AutoRun, engine: ChatEngine): Promise<void> {
    const st = this.store(run.projectId);
    const key = `${run.projectId}/${run.docId}`;
    let last: string | undefined;
    let attempt = 0;
    let reason: TcConvertEnd['reason'] = 'empty';
    let message: string | undefined;
    try {
      for (;;) {
        if (run.stopping) {
          reason = 'stopped';
          break;
        }
        const d = st.get(run.docId);
        const item = d && nextConvertItem(d);
        if (!d || !item) {
          reason = 'empty';
          break;
        }
        if (run.done >= run.total) {
          reason = 'limit';
          break;
        }
        const id = item.kind === 'tc' ? item.tc.id : item.pre.id;
        attempt = id === last ? attempt + 1 : 1;
        last = id;
        run.current = { tcId: item.tc.id, title: item.tc.title, ...(item.kind === 'precondition' ? { precondition: item.pre.id, preconditionText: item.pre.text.split('\n')[0]!.slice(0, 60) } : {}), attempt };
        // 변환 중 from the moment its message goes out (the turn end puts an unfinished item back to 대기).
        st.setConversion(run.docId, id, { status: 'converting', chatId: run.chatId });
        this.h.docChanged?.(run.projectId, run.docId);
        let out: TurnOutcome;
        try {
          out = await engine.send(run.chatId, itemPrompt(d, item, { n: Math.min(run.done + 1, run.total), total: run.total, attempt, redo: run.redo, extra: run.extra }));
        } catch (e) {
          reason = 'error';
          message = (e as Error).message;
          break;
        }
        const after = st.get(run.docId);
        const finished = !after || itemFinished(after, item);
        if (finished && item.kind === 'tc') run.done++;
        if (out.kind === 'aborted' || run.stopping) {
          reason = 'stopped';
          break;
        }
        if (finished) continue;
        if (out.kind === 'error') {
          reason = 'error';
          message = out.message ?? out.subtype;
          break;
        }
        // The round-trip bound (or a message that ended without recording the item): once more, then 실패.
        const why = out.kind === 'max-turns' ? '왕복 한도에 닿아' : '결과를 기록하지 않고 끝나';
        if (attempt < 2) {
          engine.note(run.chatId, 'info', `${id}: ${why} 같은 항목을 한 번 더 보냅니다.`);
          continue;
        }
        const note = '두 번 시도에도 끝나지 않음';
        st.setConversion(run.docId, id, { status: 'failed', note, chatId: run.chatId, by: 'ai' });
        if (item.kind === 'tc') run.done++;
        this.h.log(run.projectId, 'tcdoc.converted', 'ai', `TC 변환 실패: ${run.docName} / ${item.kind === 'tc' ? `${item.tc.id} ${item.tc.title}` : `사전 조건 ${id}`} — ${note}`, { tcDocId: run.docId, ...(item.kind === 'tc' ? { tcId: id } : {}), chatId: run.chatId });
        engine.note(run.chatId, 'info', `${id}: ${why} 두 번 시도에도 끝나지 않아 실패로 두고 다음 항목으로 갑니다.`);
      }
    } finally {
      this.runs.delete(key);
      // An item marked 변환 중 whose message never ran (send threw) has no turn end to release it.
      try {
        st.releaseChat(run.chatId);
      } catch {
        /* project folder gone */
      }
      const end: TcConvertEnd = { reason, done: run.done, total: run.total, ...(message ? { message: message.slice(0, 300) } : {}), at: (this.h.now?.() ?? new Date()).toISOString() };
      this.ended.set(key, end);
      let left = 0;
      try {
        left = st.get(run.docId)?.queue.length ?? 0;
      } catch {
        /* project folder gone */
      }
      engine.note(run.chatId, reason === 'error' ? 'error' : 'info', `TC 자동 변환: ${END_KO[reason]} — ${run.done} / ${run.total} 마침${left ? `, 대기열 ${left}개 남음 (TC 문서 화면의 [이어서 변환])` : ''}${message ? ` · ${message.slice(0, 300)}` : ''}`);
      this.h.docChanged?.(run.projectId, run.docId);
    }
  }

  /** [중지]: stop the document's auto conversion (the running message is aborted; the queue stays). */
  stopConvert(projectId: string, docId: string): void {
    const run = this.runs.get(`${projectId}/${docId}`);
    if (!run) throw new InputError('진행 중인 자동 변환이 없습니다');
    run.stopping = true;
    this.h.docChanged?.(projectId, docId);
    this.h.chatEngine(projectId).stop(run.chatId);
  }

  /** Auto conversions running in a project (chat screen progress). */
  progress(projectId: string): TcConvertProgress[] {
    return [...this.runs.values()].filter((r) => r.projectId === projectId).map(progressOf);
  }

  /** Is this chat driven by an auto conversion (the person's own messages wait until it stops)? */
  autoChat(projectId: string, chatId: string): boolean {
    return [...this.runs.values()].some((r) => r.projectId === projectId && r.chatId === chatId);
  }

  /** A chat turn ended: TCs it left in 변환 중 go back to 대기 (queue kept); an extraction that never submitted waits again. */
  chatTurnEnded(projectId: string, chatId: string): void {
    let changed: string[] = [];
    try {
      changed = this.store(projectId).releaseChat(chatId);
    } catch {
      /* project folder gone */
    }
    for (const id of changed) this.h.docChanged?.(projectId, id);
    for (const s of this.imports.values()) {
      if (s.view.chatId === chatId && s.view.status === 'extracting') {
        s.view.status = s.view.tcs.length ? 'ready' : 'needs-ai';
        this.emitImport(s);
      }
    }
  }

  /** The document's conversion chat while its auto conversion runs (between messages too). */
  activeChat(projectId: string, docId: string): string | undefined {
    return this.runs.get(`${projectId}/${docId}`)?.chatId;
  }

  /** Tool access for one chat of a project. */
  access(projectId: string, chatId: string): TcDocAccess {
    const st = () => this.store(projectId);
    const self = this;
    return {
      docs: () => st().list(),
      doc: (docId) => st().get(docId),
      readTc(docId, tcId) {
        let d = st().require(docId);
        let tc = d.tcs.find((t) => t.id === tcId);
        if (!tc) throw new InputError(`TC "${tcId}" not found in document ${docId}. TCs: ${d.tcs.map((t) => t.id).join(', ')}`);
        if (d.queue.includes(tc.id) && (tc.conversion.status === 'pending' || tc.conversion.status === 'failed')) {
          d = st().setConversion(docId, tc.id, { status: 'converting', chatId }).doc;
          tc = d.tcs.find((t) => t.id === tcId)!;
          self.h.docChanged?.(projectId, docId);
        }
        const p = d.preconditions.find((x) => x.id === tc!.preconditionId);
        return {
          doc: { id: d.id, name: d.name },
          tc: structuredClone(tc),
          ...(p ? { precondition: { ...structuredClone(p), file: p.script ?? preFileName(p), tcIds: d.tcs.filter((t) => t.preconditionId === p.id).map((t) => t.id) } } : {}),
          // Redo: the script it already has (overwrite); else <TC ID>-<slug>.yaml.
          file: tc.conversion.script && self.h.readScript(projectId, tc.conversion.script) !== undefined ? tc.conversion.script : tcFileName(tc),
          queue: [...d.queue],
        };
      },
      setConversion(docId, id, patch) {
        const p: ConversionPatch = { ...patch, chatId };
        if (p.script && p.manualSteps === undefined) p.manualSteps = countManualSteps(self.h.readScript(projectId, p.script));
        if (p.script && self.h.readScript(projectId, p.script) === undefined) throw new InputError(`script not found in the library: ${p.script} — save_script it first`);
        const r = st().setConversion(docId, id, { ...p, by: 'ai' });
        const name = r.target.kind === 'tc' ? `${r.target.tc.id} ${r.target.tc.title}` : `사전 조건 ${r.target.precondition.id}`;
        if (p.status !== 'converting') {
          const c = r.target.kind === 'tc' ? r.target.tc.conversion : undefined;
          self.h.log(
            projectId,
            'tcdoc.converted',
            'ai',
            `TC 변환 ${STATUS_KO[p.status]}: ${r.doc.name} / ${name}${p.script ? ` → ${p.script}` : ''}${c?.manualSteps ? ` · 수동 ${c.manualSteps}` : ''}${c?.missingInfo.length ? ` · 정보 부족 ${c.missingInfo.length}` : ''}${p.note ? ` — ${p.note}` : ''}`,
            { tcDocId: docId, ...(r.target.kind === 'tc' ? { tcId: r.target.tc.id } : {}), chatId, ...(p.script ? { script: p.script } : {}) },
          );
        }
        self.h.docChanged?.(projectId, docId);
        return { target: r.target, queue: [...r.doc.queue] };
      },
      importGrid(importId) {
        const s = self.imports.get(importId);
        if (!s || s.view.projectId !== projectId || !s.gridText) return undefined;
        return { fileName: s.view.fileName, format: s.view.format, gridText: s.gridText, warnings: s.view.warnings.map((w) => w.message) };
      },
      saveExtraction(importId, tcs) {
        const s = self.imports.get(importId);
        if (!s || s.view.projectId !== projectId) return { ok: false, issues: [{ path: 'importId', message: 'no import in progress with this id (it was confirmed or cancelled)' }] };
        const v = validateTcs(tcs);
        if (!v.ok) return v;
        if (!v.tcs.length) return { ok: false, issues: [{ path: 'tcs', message: 'no TCs — submit at least one TC' }] };
        s.view.tcs = v.tcs as TcInput[];
        s.view.status = 'ready';
        s.view.extractedByAi = true;
        s.view.warnings = v.tcs.filter((t) => !t.steps.length).map((t) => ({ code: 'no-steps', message: `${t.id}: 단계가 없습니다`, tcId: t.id }));
        self.emitImport(s);
        return v;
      },
    };
  }

  // ---- test sets (④) · export (⑤) -------------------------------------------------------

  planSets(projectId: string, docId: string, mode: TcSetGrouping, checked: string[] = []): TcSetPlan {
    const d = this.store(projectId).require(docId);
    const have = new Set(this.h.scripts(projectId).map((s) => s.path));
    return planTestSets(d, mode, checked, (p) => have.has(p));
  }

  /** The document as its original TC text (SPEC: scripts from a TC document use the original TC sentences). */
  exportDoc(projectId: string, docId: string, format: TcExportFormat): { name: string; bytes: Uint8Array } {
    const d = this.store(projectId).require(docId);
    const tcs = d.tcs.map(engineTc);
    const preconditions = d.preconditions.map((p) => ({ id: p.id, text: p.text, tcIds: d.tcs.filter((t) => t.preconditionId === p.id).map((t) => t.id) }));
    return { name: d.name, bytes: exportTcDocument({ name: d.name, tcs, preconditions }, format) };
  }

  /**
   * Scripts (a test set, checked scripts) → TCs: a script made from a TC document exports that TC's
   * original text; a precondition script is not a TC (its sentence is the TCs' precondition); any
   * other script is described from its steps (scriptsToTcs).
   */
  exportScripts(projectId: string, paths: string[], name: string, format: TcExportFormat): { name: string; bytes: Uint8Array; count: number } {
    const docs = this.store(projectId).all();
    const tcs: Tc[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      const fromDoc = docs.flatMap((d) => d.tcs.filter((t) => t.conversion.script === p)).at(0);
      if (fromDoc) {
        if (!seen.has(fromDoc.id)) tcs.push(engineTc(fromDoc));
        seen.add(fromDoc.id);
        continue;
      }
      if (docs.some((d) => d.preconditions.some((x) => x.script === p))) continue;
      const source = this.h.readScript(projectId, p);
      if (source === undefined) continue;
      const [tc] = scriptsToTcs([{ path: p, source }]);
      if (!tc) continue;
      let id = tc.id;
      for (let n = 2; seen.has(id); n++) id = `${tc.id}-${n}`;
      seen.add(id);
      tcs.push({ ...tc, id });
    }
    if (!tcs.length) throw new InputError('내보낼 스크립트가 없습니다');
    return { name, bytes: exportTcDocument({ name, tcs, preconditions: groupPreconditions(tcs) }, format), count: tcs.length };
  }
}

function progressOf(r: AutoRun): TcConvertProgress {
  return { docId: r.docId, docName: r.docName, chatId: r.chatId, done: r.done, total: r.total, ...(r.current ? { current: { ...r.current } } : {}), ...(r.stopping ? { stopping: true } : {}) };
}

const STATUS_KO: Record<string, string> = { pending: '대기', converting: '변환 중', done: '완료', failed: '실패', excluded: '제외' };
