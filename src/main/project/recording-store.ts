// Demonstration recordings of a project (SPEC 스크립트-작성-시연녹화 "녹화 저장"):
//   projects/<id>/recordings/<recordingId>/recording.json + shots/<seq>.png
// The engine recorder writes the folder when a recording stops; this store lists,
// renames, deletes and post-hoc marks events sensitive (atomic JSON writes).
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { markRecordingSensitive, RECORDING_FILE, type Recording } from '@euta/core';
import type { RecordingSummary } from '../../shared/types.js';
import { isId, newId, readJson, writeJsonAtomic } from './fsx.js';
import { InputError } from './project-store.js';

export class RecordingStore {
  constructor(readonly root: string) {}

  dir(id: string): string {
    if (!isId(id)) throw new InputError('invalid recording id');
    return join(this.root, id);
  }

  /** A fresh id and its (created) folder. */
  allocate(): { id: string; dir: string } {
    for (;;) {
      const id = newId(12);
      const dir = join(this.root, id);
      if (existsSync(dir)) continue;
      mkdirSync(dir, { recursive: true });
      return { id, dir };
    }
  }

  get(id: string): Recording | undefined {
    if (!isId(id)) return undefined;
    const r = readJson<Recording>(join(this.root, id, RECORDING_FILE));
    return r && r.version === 1 && Array.isArray(r.events) ? r : undefined;
  }

  require(id: string): Recording {
    const r = this.get(id);
    if (!r) throw new InputError('recording not found');
    return r;
  }

  list(): RecordingSummary[] {
    if (!existsSync(this.root)) return [];
    const out: RecordingSummary[] = [];
    for (const n of readdirSync(this.root)) {
      const r = this.get(n);
      if (r) out.push(summarize(r));
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private save(r: Recording): void {
    writeJsonAtomic(join(this.dir(r.id), RECORDING_FILE), r);
  }

  rename(id: string, name: string): Recording {
    const n = String(name ?? '').trim();
    if (!n || n.length > 80) throw new InputError('name must be 1–80 characters');
    const r = this.require(id);
    r.name = n;
    this.save(r);
    return r;
  }

  delete(id: string): void {
    const d = this.dir(id);
    if (!existsSync(d)) throw new InputError('recording not found');
    rmSync(d, { recursive: true, force: true });
  }

  /** Mark a fill event sensitive after the fact: value deleted, screenshots that may show it removed. */
  markSensitive(id: string, seq: number): Recording {
    const r = this.require(id);
    const out = markRecordingSensitive(r, seq);
    for (const rel of out.deletedShots) rmSync(this.file(id, rel), { force: true });
    this.save(r);
    return r;
  }

  /** Absolute path of a file inside the recording folder (no traversal), or throws. */
  file(id: string, rel: string): string {
    const root = resolve(this.dir(id));
    const p = resolve(root, rel);
    if (!p.startsWith(root + sep) || rel.split(/[\\/]/).some((s) => s.startsWith('.'))) throw new InputError('invalid recording file');
    return p;
  }
}

export function summarize(r: Recording): RecordingSummary {
  return {
    id: r.id,
    name: r.name,
    ...(r.envId ? { envId: r.envId } : {}),
    startUrl: r.startUrl,
    startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    events: r.events.length,
    checkpoints: r.events.filter((e) => e.kind === 'checkpoint').length,
    notes: r.notes.length + r.events.filter((e) => e.note).length,
    sensitive: r.events.filter((e) => e.sensitive).length,
    ...(r.tcRef ? { tcRef: { ...r.tcRef } } : {}),
  };
}
