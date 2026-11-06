// TC documents of a project (SPEC TC-문서-변환 "저장"):
//   projects/<id>/tc-docs/<docId>/tc-doc.json
// The normalized TCs, precondition groups, per-TC conversion state and the conversion queue.
// Cloud projects keep this folder in their working copy too — local only, like recordings.
// Every change is one atomic JSON write.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TcConversion, TcConversionStatus, TcDoc, TcDocSummary, TcDocTc, TcInput, TcPrecondition } from '../../shared/types.js';
import { isId, newId, readJson, writeJsonAtomic } from './fsx.js';
import { InputError } from './project-store.js';

export const TC_DOC_FILE = 'tc-doc.json';
const STATUSES: readonly TcConversionStatus[] = ['pending', 'converting', 'done', 'failed', 'excluded'];
/** A queued TC leaves the queue when it reaches one of these. */
const FINAL: ReadonlySet<TcConversionStatus> = new Set(['done', 'failed', 'excluded']);

export interface TcDocCreate {
  name: string;
  source: TcDoc['source'];
  tcs: TcInput[];
  preconditions: { text: string; tcIds: string[] }[];
}

export interface ConversionPatch {
  status: TcConversionStatus;
  script?: string;
  manualSteps?: number;
  missingInfo?: string[];
  note?: string;
  chatId?: string;
  by?: TcConversion['by'];
}

export type ConversionTarget = { kind: 'tc'; tc: TcDocTc } | { kind: 'precondition'; precondition: TcPrecondition };

const clip = (v: unknown, n: number): string => String(v ?? '').trim().slice(0, n);

export class TcDocStore {
  constructor(
    readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(id: string): string {
    if (!isId(id)) throw new InputError('invalid TC document id');
    return join(this.root, id, TC_DOC_FILE);
  }

  get(id: string): TcDoc | undefined {
    if (!isId(id)) return undefined;
    const d = readJson<TcDoc>(this.file(id));
    return d && d.version === 1 && Array.isArray(d.tcs) ? d : undefined;
  }

  require(id: string): TcDoc {
    const d = this.get(id);
    if (!d) throw new InputError('TC 문서를 찾을 수 없습니다');
    return d;
  }

  list(): TcDocSummary[] {
    if (!existsSync(this.root)) return [];
    const out: TcDocSummary[] = [];
    for (const n of readdirSync(this.root)) {
      const d = this.get(n);
      if (d) out.push(summarizeDoc(d));
    }
    return out.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }

  all(): TcDoc[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .map((n) => this.get(n))
      .filter((d): d is TcDoc => !!d);
  }

  save(d: TcDoc): void {
    writeJsonAtomic(this.file(d.id), d);
  }

  create(input: TcDocCreate): TcDoc {
    const name = clip(input.name, 120);
    if (!name) throw new InputError('문서 이름을 입력하세요');
    if (!input.tcs.length) throw new InputError('TC 가 하나도 없습니다');
    let id: string;
    do id = newId(12);
    while (existsSync(join(this.root, id)));
    const at = this.now().toISOString();
    const known = new Set(input.tcs.map((t) => t.id));
    const preconditions: TcPrecondition[] = [];
    const preOf = new Map<string, string>();
    for (const g of input.preconditions) {
      const tcIds = g.tcIds.filter((t) => known.has(t) && !preOf.has(t));
      const text = clip(g.text, 4000);
      if (!tcIds.length || !text) continue;
      const p: TcPrecondition = { id: `pre-${preconditions.length + 1}`, text, status: 'pending' };
      preconditions.push(p);
      for (const t of tcIds) preOf.set(t, p.id);
    }
    const tcs: TcDocTc[] = input.tcs.map((t) => ({
      id: t.id,
      title: t.title,
      ...(t.category ? { category: t.category } : {}),
      ...(t.description ? { description: t.description } : {}),
      ...(t.precondition ? { precondition: t.precondition } : {}),
      ...(preOf.has(t.id) ? { preconditionId: preOf.get(t.id)! } : {}),
      ...(t.screens?.length ? { screens: [...t.screens] } : {}),
      steps: t.steps.map((s) => ({ no: s.no, action: s.action, ...(s.expected ? { expected: s.expected } : {}) })),
      conversion: { status: 'pending', manualSteps: 0, missingInfo: [], updatedAt: at },
    }));
    const d: TcDoc = { version: 1, id, name, source: { ...input.source, importedAt: at }, preconditions, tcs, queue: [] };
    mkdirSync(join(this.root, id), { recursive: true });
    this.save(d);
    return d;
  }

  rename(id: string, name: string): TcDoc {
    const n = clip(name, 120);
    if (!n) throw new InputError('문서 이름을 입력하세요');
    const d = this.require(id);
    d.name = n;
    this.save(d);
    return d;
  }

  delete(id: string): void {
    this.require(id);
    rmSync(join(this.root, id), { recursive: true, force: true });
  }

  /** The conversion queue = the checked TCs in check order (unknown ids dropped, no duplicates). */
  setQueue(id: string, tcIds: readonly string[]): TcDoc {
    const d = this.require(id);
    const known = new Set(d.tcs.map((t) => t.id));
    d.queue = [...new Set(tcIds.map(String))].filter((t) => known.has(t));
    this.save(d);
    return d;
  }

  /** [다시 변환]: back to 대기 (script reference kept until a new one is recorded). */
  reset(id: string, tcIds: readonly string[]): TcDoc {
    const d = this.require(id);
    const at = this.now().toISOString();
    for (const t of d.tcs) {
      if (!tcIds.includes(t.id)) continue;
      t.conversion = { ...t.conversion, status: 'pending', updatedAt: at };
      delete t.conversion.note;
      delete t.conversion.chatId;
    }
    this.save(d);
    return d;
  }

  /**
   * Record a conversion state for a TC or a precondition group (set_tc_conversion, recording
   * draft, [제외]). A queued TC that reaches 완료 · 실패 · 제외 leaves the queue.
   */
  setConversion(docId: string, targetId: string, patch: ConversionPatch): { doc: TcDoc; target: ConversionTarget } {
    if (!STATUSES.includes(patch.status)) throw new InputError(`unknown status: ${String(patch.status)}`);
    const d = this.require(docId);
    const at = this.now().toISOString();
    const tc = d.tcs.find((t) => t.id === targetId);
    if (tc) {
      const c: TcConversion = {
        status: patch.status,
        manualSteps: Math.max(0, Math.floor(Number(patch.manualSteps ?? (patch.script === undefined ? tc.conversion.manualSteps : 0)) || 0)),
        missingInfo: (patch.missingInfo ?? tc.conversion.missingInfo).map((m) => clip(m, 500)).filter(Boolean).slice(0, 50),
        updatedAt: at,
      };
      const script = patch.script ?? tc.conversion.script;
      if (script) c.script = script;
      if (patch.note) c.note = clip(patch.note, 500);
      const chatId = patch.chatId ?? (patch.status === 'converting' ? tc.conversion.chatId : undefined);
      if (chatId) c.chatId = chatId;
      if (patch.by ?? tc.conversion.by) c.by = patch.by ?? tc.conversion.by;
      tc.conversion = c;
      if (FINAL.has(patch.status)) d.queue = d.queue.filter((q) => q !== tc.id);
      this.save(d);
      return { doc: d, target: { kind: 'tc', tc } };
    }
    const pre = d.preconditions.find((p) => p.id === targetId);
    if (!pre) throw new InputError(`no TC or precondition "${targetId}" in this document`);
    pre.status = patch.status;
    pre.updatedAt = at;
    if (patch.script) pre.script = patch.script;
    if (patch.note) pre.note = clip(patch.note, 500);
    else delete pre.note;
    if (patch.chatId) pre.chatId = patch.chatId;
    this.save(d);
    return { doc: d, target: { kind: 'precondition', precondition: pre } };
  }

  /**
   * A conversion chat turn ended (finished, stopped or failed): TCs it left in 변환 중 go back to
   * 대기 and stay in the queue, so [이어서 변환] picks them up. Returns the documents changed.
   */
  releaseChat(chatId: string): string[] {
    const changed: string[] = [];
    const at = this.now().toISOString();
    for (const d of this.all()) {
      let touched = false;
      for (const t of d.tcs) {
        if (t.conversion.status === 'converting' && t.conversion.chatId === chatId) {
          t.conversion = { ...t.conversion, status: 'pending', updatedAt: at };
          touched = true;
        }
      }
      for (const p of d.preconditions) {
        if (p.status === 'converting' && p.chatId === chatId) {
          p.status = p.script ? 'done' : 'pending';
          touched = true;
        }
      }
      if (touched) {
        this.save(d);
        changed.push(d.id);
      }
    }
    return changed;
  }

  /**
   * After an app restart no conversion chat is running: anything still marked 변환 중 (the app
   * quit mid-turn) goes back to 대기 and stays in the queue. Returns the documents changed.
   */
  releaseAll(): string[] {
    const changed: string[] = [];
    const at = this.now().toISOString();
    for (const d of this.all()) {
      let touched = false;
      for (const t of d.tcs) {
        if (t.conversion.status === 'converting') {
          t.conversion = { ...t.conversion, status: 'pending', updatedAt: at };
          touched = true;
        }
      }
      for (const p of d.preconditions) {
        if (p.status === 'converting') {
          p.status = p.script ? 'done' : 'pending';
          touched = true;
        }
      }
      if (touched) {
        this.save(d);
        changed.push(d.id);
      }
    }
    return changed;
  }

  /** Keep script references when a library script is renamed (or drop them when deleted). */
  renameScriptRefs(from: string, to: string | undefined): string[] {
    const changed: string[] = [];
    for (const d of this.all()) {
      let touched = false;
      for (const t of d.tcs) {
        if (t.conversion.script !== from) continue;
        if (to) t.conversion.script = to;
        else delete t.conversion.script;
        touched = true;
      }
      for (const p of d.preconditions) {
        if (p.script !== from) continue;
        if (to) p.script = to;
        else delete p.script;
        touched = true;
      }
      if (touched) {
        this.save(d);
        changed.push(d.id);
      }
    }
    return changed;
  }
}

export function summarizeDoc(d: TcDoc): TcDocSummary {
  return {
    id: d.id,
    name: d.name,
    fileName: d.source.fileName,
    importedAt: d.source.importedAt,
    tcCount: d.tcs.length,
    done: d.tcs.filter((t) => t.conversion.status === 'done').length,
    failed: d.tcs.filter((t) => t.conversion.status === 'failed').length,
    queued: d.queue.length,
  };
}
